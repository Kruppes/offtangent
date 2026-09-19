/**
 * resurface.ts: first class resumption (SPEC 2.6, 6.3). A deterministic
 * heuristic, no ranking model: a strand is eligible when it has content, is
 * not archived, not in the now set, not snoozed, and its last activity is
 * between `minDays` and `maxDays` ago. Ordering is a small score (open
 * questions in the summary, tag overlap with the now set, pinned) and then
 * recency. The reason names the strongest signal.
 */
import type { Database } from './database.js'
import { getLatestSessionSummary } from './session-summary-store.js'
import { renderSummaryMarkdown } from './session-summary-schema.js'
import { getNowSet, getStrandTags, snoozedStrandIds } from './strand-store.js'
import { toIsoUtc } from './timestamps.js'

export type ResurfaceReason = 'dormant' | 'tag_match' | 'unanswered'

export interface ResurfaceItem {
  strandId: string
  title: string | null
  personaId: string
  tags: string[]
  lastActivity: string
  summary: string
  reason: ResurfaceReason
}

export interface ResurfaceOptions {
  limit?: number
  /** Last activity must be at least this many days ago (default 3). */
  minDays?: number
  /** And at most this many days ago (default 30). */
  maxDays?: number
}

interface Row {
  id: string
  agent_id: string | null
  title: string | null
  pinned: number
  started_at: string
  last_activity: string | null
}

/** Does the last user message end with a question and has no assistant answer after it? */
function hasOpenQuestion(db: Database, strandId: string): boolean {
  const last = db.prepare(
    `SELECT role, content FROM chat_messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 1`,
  ).get(strandId) as { role: string; content: string } | undefined
  return !!last && last.role === 'user' && /\?\s*$/.test(last.content.trim())
}

export function listResurfaceItems(db: Database, userId: string, options: ResurfaceOptions = {}): ResurfaceItem[] {
  const limit = Math.min(20, Math.max(1, Math.trunc(options.limit ?? 5)))
  const minDays = options.minDays ?? 3
  const maxDays = options.maxDays ?? 30
  const nowSet = getNowSet(db, userId)
  const snoozed = snoozedStrandIds(db, userId)
  const nowTags = new Set(nowSet.flatMap(id => getStrandTags(db, id)))

  const rows = db.prepare(
    `SELECT id, agent_id, title, pinned, started_at, last_activity FROM sessions
     WHERE type = 'interactive' AND archived = 0 AND message_count > 0
       AND (session_user = ? OR CAST(user_id AS TEXT) = ?)
       AND COALESCE(last_activity, started_at) <= datetime('now', ?)
       AND COALESCE(last_activity, started_at) >= datetime('now', ?)
     ORDER BY COALESCE(last_activity, started_at) DESC LIMIT 200`,
  ).all(userId, userId, `-${minDays} days`, `-${maxDays} days`) as Row[]

  const scored: Array<{ item: ResurfaceItem; score: number }> = []
  for (const row of rows) {
    if (nowSet.includes(row.id) || snoozed.has(row.id)) continue
    const tags = getStrandTags(db, row.id)
    const latest = getLatestSessionSummary(db, row.id)
    const summary = latest ? renderSummaryMarkdown(latest.summary).replace(/\s+/g, ' ').trim().slice(0, 240) : ''
    const openItems = latest ? latest.summary.open.length : 0
    const unanswered = openItems > 0 || hasOpenQuestion(db, row.id)
    const tagMatch = tags.some(t => nowTags.has(t))

    let score = 0
    let reason: ResurfaceReason = 'dormant'
    if (tagMatch) { score += 2; reason = 'tag_match' }
    if (unanswered) { score += 3; reason = 'unanswered' }
    if (row.pinned) score += 1

    scored.push({
      score,
      item: {
        strandId: row.id,
        title: row.title ?? null,
        personaId: row.agent_id ?? 'main',
        tags,
        lastActivity: toIsoUtc(row.last_activity ?? row.started_at),
        summary,
        reason,
      },
    })
  }

  scored.sort((a, b) => b.score - a.score || (a.item.lastActivity < b.item.lastActivity ? 1 : -1))
  return scored.slice(0, limit).map(s => s.item)
}
