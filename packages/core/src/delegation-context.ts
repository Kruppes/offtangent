/**
 * delegation-context.ts: what a delegation receives besides its brief
 * (SPEC 10.8 and 11.6).
 *
 * `clean`    brief only. For evaluation and critique (Cognition 22.04.2026:
 *            an empty context reviewer finds more and worse bugs).
 * `selected` brief plus an explicit selection: the strand summary, up to
 *            ten messages by id, a memory query. Nothing is passed by
 *            similarity; the selection is inspectable on the task.
 * `fork`     brief plus the verbatim strand window under the token budget.
 *            For decisions that depend on the history.
 *
 * The block is prepended to the task prompt, so `tasks.prompt` shows what
 * was passed in and a wrong delegation is diagnosable from the row.
 */

import type { Database } from './database.js'
import type { TaskContextMode } from './task-store.js'
import { getLatestSessionSummary } from './session-summary-store.js'
import { renderSummaryMarkdown } from './session-summary-schema.js'
import { queryMemoriesFts, estimateTokens, extractTopicTags } from './session-store.js'
import { RECALLED_MARKER, formatMessageDigest } from './message-digest.js'
import { loadStrandRows } from './strand-context.js'
import { loadHeuristics } from './heuristics.js'

export interface DelegationContextSelection {
  strandSummary?: boolean
  messageIds?: number[]
  memoryQuery?: string
}

export interface BuildDelegationContextOptions {
  db: Database
  mode: TaskContextMode
  /** The strand the delegation starts from; without it only `clean` is possible. */
  parentSessionId: string | null
  /** Persona for memory scoping */
  agentId?: string
  selection?: DelegationContextSelection
  /** Token budget for the assembled block (SPEC 10.8, default 8k) */
  budgetTokens?: number
}

export interface DelegationContextResult {
  block: string | null
  mode: TaskContextMode
  droppedMessageIds: number[]
  tokens: number
}

export const MAX_SELECTED_MESSAGES = 10
export const DEFAULT_DELEGATION_BUDGET_TOKENS = 8000

/**
 * A brief under `delegation.minBriefChars` (default 200) that names no
 * context is the pattern that produces tasks which re read the whole
 * workspace (SPEC 10.8).
 */
export function briefTooThin(brief: string, mode: TaskContextMode, selection?: DelegationContextSelection, minChars: number = loadHeuristics().delegation.minBriefChars): boolean {
  if (minChars <= 0) return false
  if (brief.trim().length >= minChars) return false
  if (mode === 'fork') return false
  if (mode === 'selected' && selection && (selection.strandSummary || (selection.messageIds?.length ?? 0) > 0 || selection.memoryQuery)) return false
  return true
}

export function buildDelegationContext(options: BuildDelegationContextOptions): DelegationContextResult {
  const { db, mode, parentSessionId } = options
  const budget = options.budgetTokens ?? DEFAULT_DELEGATION_BUDGET_TOKENS
  const dropped: number[] = []
  if (mode === 'clean' || !parentSessionId) {
    return { block: null, mode: parentSessionId ? mode : 'clean', droppedMessageIds: dropped, tokens: 0 }
  }

  const sections: string[] = []
  let tokens = 0
  const push = (text: string): boolean => {
    const t = estimateTokens(text)
    if (tokens + t > budget) return false
    sections.push(text)
    tokens += t
    return true
  }

  if (mode === 'selected') {
    const sel = options.selection ?? {}
    if (sel.strandSummary) {
      const summary = getLatestSessionSummary(db, parentSessionId)
      if (summary) push(`<strand_summary>\n${renderSummaryMarkdown(summary.summary)}\n</strand_summary>`)
    }
    if (sel.memoryQuery?.trim()) {
      const keywords = extractTopicTags([sel.memoryQuery])
      const facts = queryMemoriesFts(db, keywords.length ? keywords : sel.memoryQuery.split(/\s+/), 10, options.agentId)
      if (facts.length) push(`<memory_facts>\n${facts.map(f => `${RECALLED_MARKER} ${f.content}`).join('\n')}\n</memory_facts>`)
    }
    const ids = (sel.messageIds ?? []).filter(id => Number.isInteger(id) && id > 0)
    if (ids.length > 0) {
      const wanted = ids.slice(0, MAX_SELECTED_MESSAGES)
      dropped.push(...ids.slice(MAX_SELECTED_MESSAGES))
      const placeholders = wanted.map(() => '?').join(',')
      const rows = db.prepare(
        `SELECT id, role, content FROM chat_messages WHERE session_id = ? AND id IN (${placeholders}) AND role IN ('user','assistant') ORDER BY id ASC`,
      ).all(parentSessionId, ...wanted) as Array<{ id: number; role: string; content: string }>
      const found = new Set(rows.map(r => r.id))
      dropped.push(...wanted.filter(id => !found.has(id)))
      // Last in, first out when over budget: newest ids are dropped first.
      const lines: string[] = []
      for (const r of rows) {
        const line = `${RECALLED_MARKER} [msg:${r.id}] ${r.role === 'user' ? 'User' : 'Assistant'}: ${r.content}`
        if (tokens + estimateTokens(lines.concat(line).join('\n')) > budget) {
          dropped.push(r.id)
          continue
        }
        lines.push(line)
      }
      if (lines.length) push(`<selected_messages>\n${lines.join('\n')}\n</selected_messages>`)
    }
  }

  if (mode === 'fork') {
    const rows = loadStrandRows(db, parentSessionId)
    const summary = getLatestSessionSummary(db, parentSessionId)
    if (summary) push(`<strand_summary>\n${renderSummaryMarkdown(summary.summary)}\n</strand_summary>`)
    // Newest first until the budget is spent, then rendered oldest first.
    // A small reserve keeps room for the index of what fell out.
    const indexReserve = 300
    const kept: typeof rows = []
    let used = tokens
    for (let i = rows.length - 1; i >= 0; i--) {
      const t = estimateTokens(rows[i].content) + 8
      if (used + t > budget - indexReserve) break
      kept.unshift(rows[i])
      used += t
    }
    const olderCount = rows.length - kept.length
    if (olderCount > 0) {
      const older = rows.slice(0, olderCount).slice(-20)
      const index = `<earlier_messages>\n${RECALLED_MARKER} ${olderCount} earlier messages are not included; reload with recall_message(message_id).\n${older.map(r => formatMessageDigest({ id: r.id, role: r.role, content: r.content })).join('\n')}\n</earlier_messages>`
      sections.push(index)
      used += estimateTokens(index)
    }
    if (kept.length) {
      const lines = kept.map(r => `${RECALLED_MARKER} [msg:${r.id}] ${r.role === 'user' ? 'User' : 'Assistant'}: ${r.content}`)
      sections.push(`<strand_window>\n${lines.join('\n')}\n</strand_window>`)
    }
    tokens = used
  }

  if (sections.length === 0) return { block: null, mode, droppedMessageIds: dropped, tokens: 0 }
  const block = [
    `<delegation_context mode="${mode}" strand="${parentSessionId}">`,
    'Context passed by the delegating persona. It is a selection, not the whole history; use recall_message(message_id) to load anything it refers to.',
    ...sections,
    '</delegation_context>',
  ].join('\n')
  return { block, mode, droppedMessageIds: dropped, tokens }
}
