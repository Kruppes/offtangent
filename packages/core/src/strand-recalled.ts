/**
 * strand-recalled.ts: which older messages the agent actually pulled back
 * into a strand's prompt (web redesign W5b, context panel).
 *
 * Two persisted sources, both rows of `tool_calls` with the strand as
 * `session_id`, so no new table is needed:
 *
 * - `recall_message`: the agent reloaded one message verbatim. The tool
 *   result is stored as JSON; a successful call carries
 *   `details.messageId` (errors and "not found" do not).
 * - `strand_context`: the per-turn metric row of the strand window
 *   (SPEC 12.2). Since W5b its output carries `retrievedIds`, the older rows
 *   the FTS retrieval put into `<retrieved_messages>`. Rows written before
 *   simply have no such field and contribute nothing.
 *
 * Only messages of strands the user owns are returned (the recall tool may
 * read across strands of the same user, never across users). Content is cut
 * to a short plain excerpt; the full text stays one click away.
 */
import type { Database } from './database.js'
import { toIsoUtc } from './timestamps.js'

export type RecalledSource = 'recall' | 'context'

export interface RecalledMessage {
  messageId: number
  /** Strand of the recalled message (usually this one, can be another own strand). */
  strandId: string
  role: string
  excerpt: string
  /** ISO 8601 UTC time of the (latest) recall. */
  recalledAt: string
  source: RecalledSource
}

export const RECALLED_DEFAULT_LIMIT = 20
export const RECALLED_EXCERPT_CHARS = 160
/** Metric rows read per source; older recalls are not interesting for the panel. */
const SCAN_ROWS = 200

function excerptOf(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > RECALLED_EXCERPT_CHARS ? `${flat.slice(0, RECALLED_EXCERPT_CHARS - 1)}…` : flat
}

function positiveId(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

export function listRecalledMessages(
  db: Database,
  userId: number | string,
  strandId: string,
  limit = RECALLED_DEFAULT_LIMIT,
): RecalledMessage[] {
  const latest = new Map<number, { at: string; source: RecalledSource; order: number }>()
  const note = (id: number | null, at: string, source: RecalledSource, order: number) => {
    if (id === null) return
    const known = latest.get(id)
    if (!known || order > known.order) latest.set(id, { at, source, order })
  }

  const recalls = db.prepare(
    `SELECT id, timestamp, json_extract(output, '$.details.messageId') AS mid
       FROM tool_calls
      WHERE session_id = ? AND tool_name = 'recall_message' AND status = 'success'
        AND json_valid(output)
      ORDER BY id DESC
      LIMIT ?`,
  ).all(strandId, SCAN_ROWS) as Array<{ id: number; timestamp: string; mid: unknown }>
  for (const row of recalls) note(positiveId(row.mid), row.timestamp, 'recall', row.id)

  const contexts = db.prepare(
    `SELECT id, timestamp, json_extract(output, '$.retrievedIds') AS ids
       FROM tool_calls
      WHERE session_id = ? AND tool_name = 'strand_context'
        AND json_valid(output) AND json_type(output, '$.retrievedIds') = 'array'
      ORDER BY id DESC
      LIMIT ?`,
  ).all(strandId, SCAN_ROWS) as Array<{ id: number; timestamp: string; ids: string | null }>
  for (const row of contexts) {
    let ids: unknown
    try { ids = JSON.parse(row.ids ?? '[]') } catch { continue }
    if (!Array.isArray(ids)) continue
    for (const id of ids) note(positiveId(id), row.timestamp, 'context', row.id)
  }

  if (latest.size === 0) return []
  const ordered = [...latest.entries()].sort((a, b) => b[1].order - a[1].order || b[0] - a[0])
  const cap = Math.max(1, Math.min(limit, 100))
  const user = String(userId)
  const lookup = db.prepare(
    `SELECT cm.id AS id, cm.session_id AS strandId, cm.role AS role, cm.content AS content
       FROM chat_messages cm
       JOIN sessions s ON s.id = cm.session_id
      WHERE cm.id = ?
        AND (s.session_user = ? OR CAST(s.user_id AS TEXT) = ?)`,
  )
  const out: RecalledMessage[] = []
  for (const [messageId, hit] of ordered) {
    if (out.length >= cap) break
    const row = lookup.get(messageId, user, user) as
      { id: number; strandId: string; role: string; content: string | null } | undefined
    if (!row) continue
    out.push({
      messageId: row.id,
      strandId: row.strandId,
      role: row.role,
      excerpt: excerptOf(row.content ?? ''),
      recalledAt: toIsoUtc(hit.at),
      source: hit.source,
    })
  }
  return out
}
