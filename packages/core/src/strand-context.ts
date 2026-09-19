/**
 * strand-context.ts: the strand turn context by token budget (SPEC 11.3).
 *
 * A turn is built from, top to bottom: the persona prefix (system prompt),
 * strand notes (latest structured summary), an index of older messages as
 * digest lines, capped FTS retrieval over those older messages, the
 * verbatim recency window, and the new user message. Items 2 to 4 are
 * computed per turn from the database and are prepended to the user text
 * as a `<strand_context>` block; the block is stripped from the stored
 * transcript after the turn so it never accumulates.
 *
 * Evidence: TRACE (arXiv:2608.06503) for keeping the newest turns verbatim,
 * ContextBench (arXiv:2602.05892) for capping retrieval, Progressive
 * Disclosure (arXiv:2607.17598) for a single retrieval level.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Database } from './database.js'
import { estimateTokens, extractTopicTags } from './session-store.js'
import { formatMessageDigest, RECALLED_MARKER } from './message-digest.js'
import type { DigestableMessage } from './message-digest.js'
import { sanitizeHistoryBoundaries } from './message-history.js'
import { getLatestSessionSummary } from './session-summary-store.js'
import type { SessionSummary } from './session-summary-schema.js'
import { loadHeuristics } from './heuristics.js'

export const STRAND_CONTEXT_OPEN = '<strand_context>'
export const STRAND_CONTEXT_CLOSE = '</strand_context>'

export interface StrandRow {
  id: number
  role: 'user' | 'assistant'
  content: string
}

/** Rough token estimate for one in memory agent message (chars / 4 over its content). */
export function estimateMessageTokens(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content
  if (typeof content === 'string') return estimateTokens(content)
  if (Array.isArray(content)) {
    let n = 0
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (typeof b.text === 'string') n += estimateTokens(b.text)
      else if (typeof b.thinking === 'string') n += estimateTokens(b.thinking)
      else if (b.type === 'image') n += 1000
      else n += estimateTokens(JSON.stringify(b))
    }
    return n
  }
  return estimateTokens(JSON.stringify(content ?? ''))
}

export interface TrimResult {
  messages: AgentMessage[]
  droppedCount: number
  keptTokens: number
  /**
   * Index in the input where the kept window starts (before boundary repair).
   * Callers that keep their own cut position (background tasks, SPEC 11.3
   * applied to the task loop) need the position, not just the slice.
   */
  startIndex: number
}

/**
 * Keep the newest messages that fit the token budget. Walks from the end,
 * then repairs the cut so no tool result is left without its call
 * (`sanitizeHistoryBoundaries`) and the window starts on a user message
 * when one exists inside the kept range.
 */
export function trimMessagesToBudget(messages: readonly AgentMessage[], budgetTokens: number): TrimResult {
  if (messages.length === 0) return { messages: [], droppedCount: 0, keptTokens: 0, startIndex: 0 }
  let tokens = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(messages[i])
    if (tokens + t > budgetTokens && start < messages.length) break
    tokens += t
    start = i
  }
  if (start === 0) return { messages: [...messages], droppedCount: 0, keptTokens: tokens, startIndex: 0 }

  // Prefer to open the window on a user message so the model never sees an
  // assistant turn answering something that is not there.
  let s = start
  while (s < messages.length && (messages[s] as { role?: string }).role !== 'user') s++
  if (s >= messages.length) s = start

  const cut = messages.slice(s)
  const sanitized = sanitizeHistoryBoundaries(cut)
  const kept = sanitized.messages
  return {
    messages: kept,
    droppedCount: messages.length - kept.length,
    keptTokens: kept.reduce((n, m) => n + estimateMessageTokens(m), 0),
    startIndex: s,
  }
}

/** Number of user turns in an in memory transcript. */
export function countUserTurns(messages: readonly AgentMessage[]): number {
  let n = 0
  for (const m of messages) if ((m as { role?: string }).role === 'user') n++
  return n
}

/**
 * Load the user and assistant rows of a strand from the database, oldest
 * first. The trailing user row is dropped when it is the message being
 * answered right now (already persisted by the transport before the turn).
 */
export function loadStrandRows(db: Database, sessionId: string, currentUserText?: string): StrandRow[] {
  const rows = db.prepare(
    `SELECT id, role, content FROM chat_messages
     WHERE session_id = ? AND role IN ('user','assistant') AND content != ''
     ORDER BY id ASC`,
  ).all(sessionId) as StrandRow[]
  const last = rows[rows.length - 1]
  if (last && last.role === 'user' && currentUserText !== undefined && last.content === currentUserText) {
    rows.pop()
  }
  return rows
}

/**
 * Split the strand rows into the part the in memory transcript already
 * covers (the last `userTurnsInMemory` user rows and everything after the
 * first of them) and the older part that is only in the database.
 */
export function splitRowsOutsideMemory(rows: StrandRow[], userTurnsInMemory: number): { older: StrandRow[]; covered: StrandRow[] } {
  if (userTurnsInMemory <= 0) return { older: rows, covered: [] }
  let seen = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') {
      seen++
      if (seen === userTurnsInMemory) {
        return { older: rows.slice(0, i), covered: rows.slice(i) }
      }
    }
  }
  return { older: [], covered: rows }
}

export interface RetrievedRow extends StrandRow {
  truncated: boolean
}

/**
 * One level of FTS retrieval over the older rows of this strand, capped.
 * Keywords come from the new user message; hits are returned verbatim up
 * to `maxChars` with their id, so a cut hit is still reloadable.
 */
export function retrieveOlderRows(
  db: Database,
  sessionId: string,
  queryText: string,
  olderIds: ReadonlySet<number>,
  limit: number,
  maxChars: number,
): RetrievedRow[] {
  if (limit <= 0 || olderIds.size === 0) return []
  const keywords = extractTopicTags([queryText]).filter(k => k.length > 2)
  if (keywords.length === 0) return []
  const ftsQuery = keywords.map(k => `"${k.replace(/"/g, '')}"`).join(' OR ')
  try {
    const rows = db.prepare(
      `SELECT cm.id, cm.role, cm.content
       FROM chat_messages_fts fts
       JOIN chat_messages cm ON cm.id = fts.rowid
       WHERE chat_messages_fts MATCH ? AND cm.session_id = ? AND cm.role IN ('user','assistant')
       ORDER BY rank
       LIMIT ?`,
    ).all(ftsQuery, sessionId, Math.max(limit * 4, limit)) as StrandRow[]
    const hits: RetrievedRow[] = []
    for (const r of rows) {
      if (!olderIds.has(r.id)) continue
      const truncated = r.content.length > maxChars
      hits.push({ ...r, content: truncated ? r.content.slice(0, maxChars) : r.content, truncated })
      if (hits.length >= limit) break
    }
    return hits
  } catch {
    return []
  }
}

function renderNotes(summary: SessionSummary): string[] {
  const lines: string[] = []
  if (summary.goal) lines.push(`Goal: ${summary.goal}`)
  if (summary.decisions.length) lines.push('Decisions:', ...summary.decisions.map(d => `- ${d}`))
  if (summary.open.length) lines.push('Open:', ...summary.open.map(o => `- ${o}`))
  if (summary.artifacts.length) lines.push(`Artifacts: ${summary.artifacts.join(', ')}`)
  if (summary.next.length) lines.push(`Next: ${summary.next.join('; ')}`)
  return lines
}

export interface StrandContextParts {
  notes: SessionSummary | null
  older: StrandRow[]
  retrieved: RetrievedRow[]
  indexLines: number
}

/**
 * Render the block. Returns null when there is nothing to say (short
 * strand, everything in memory), so short strands pay nothing.
 */
export function buildStrandContextBlock(parts: StrandContextParts): string | null {
  const sections: string[] = []

  if (parts.notes) {
    const notes = renderNotes(parts.notes)
    if (notes.length) sections.push(['<strand_notes>', ...notes, '</strand_notes>'].join('\n'))
  }

  if (parts.older.length > 0) {
    const shown = parts.older.slice(-parts.indexLines)
    const dropped = parts.older.length - shown.length
    const lines = shown.map(r => formatMessageDigest({ id: r.id, role: r.role, content: r.content } as DigestableMessage))
    sections.push([
      '<earlier_messages>',
      `${RECALLED_MARKER} ${parts.older.length} earlier messages of this strand are not in your context. Reload any of them verbatim with recall_message(message_id).`,
      ...(dropped > 0 ? [`(${dropped} oldest not listed)`] : []),
      ...lines,
      '</earlier_messages>',
    ].join('\n'))
  }

  if (parts.retrieved.length > 0) {
    const lines = parts.retrieved.map(r => {
      const label = r.role === 'user' ? 'User' : 'Assistant'
      const tail = r.truncated ? ` [cut, recall_message(${r.id}) for the rest]` : ''
      return `${RECALLED_MARKER} [msg:${r.id}] ${label}: ${r.content}${tail}`
    })
    sections.push(['<retrieved_messages>', ...lines, '</retrieved_messages>'].join('\n'))
  }

  if (sections.length === 0) return null
  return [STRAND_CONTEXT_OPEN, ...sections, STRAND_CONTEXT_CLOSE].join('\n')
}

/**
 * Assemble the block for one turn. `messagesInMemory` is the (already
 * trimmed) transcript the runtime will send.
 */
export interface StrandContextStats {
  olderCount: number
  indexed: number
  retrieved: number
  hasNotes: boolean
  blockChars: number
}

export function assembleStrandContextWithStats(
  db: Database,
  sessionId: string,
  userText: string,
  messagesInMemory: readonly AgentMessage[],
): { block: string | null; stats: StrandContextStats } {
  const h = loadHeuristics().strand
  const rows = loadStrandRows(db, sessionId, userText)
  const { older } = splitRowsOutsideMemory(rows, countUserTurns(messagesInMemory))
  const notes = getLatestSessionSummary(db, sessionId)?.summary ?? null
  const olderIds = new Set(older.map(r => r.id))
  const retrieved = retrieveOlderRows(db, sessionId, userText, olderIds, h.retrievalHits, h.retrievalChars)
  const block = buildStrandContextBlock({ notes, older, retrieved, indexLines: h.indexLines })
  return {
    block,
    stats: {
      olderCount: older.length,
      indexed: Math.min(older.length, h.indexLines),
      retrieved: retrieved.length,
      hasNotes: notes !== null,
      blockChars: block?.length ?? 0,
    },
  }
}

export function assembleStrandContext(
  db: Database,
  sessionId: string,
  userText: string,
  messagesInMemory: readonly AgentMessage[],
): string | null {
  return assembleStrandContextWithStats(db, sessionId, userText, messagesInMemory).block
}

/**
 * Remove a `<strand_context>` block from the front of the last user
 * message so the transcript never accumulates per turn context.
 */
export function stripStrandContextFromLastUserMessage(messages: readonly AgentMessage[]): AgentMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown }
    if (m.role !== 'user') continue
    const stripText = (text: string): string | null => {
      if (!text.startsWith(STRAND_CONTEXT_OPEN)) return null
      const end = text.indexOf(STRAND_CONTEXT_CLOSE)
      if (end < 0) return null
      return text.slice(end + STRAND_CONTEXT_CLOSE.length).replace(/^\n+/, '')
    }
    if (typeof m.content === 'string') {
      const t = stripText(m.content)
      if (t === null) return null
      const out = [...messages]
      out[i] = { ...(messages[i] as object), content: t } as unknown as AgentMessage
      return out
    }
    if (Array.isArray(m.content)) {
      const blocks = m.content as Array<Record<string, unknown>>
      const idx = blocks.findIndex(b => b && b.type === 'text' && typeof b.text === 'string')
      if (idx < 0) return null
      const t = stripText(blocks[idx].text as string)
      if (t === null) return null
      const newBlocks = [...blocks]
      newBlocks[idx] = { ...blocks[idx], text: t }
      const out = [...messages]
      out[i] = { ...(messages[i] as object), content: newBlocks } as unknown as AgentMessage
      return out
    }
    return null
  }
  return null
}
