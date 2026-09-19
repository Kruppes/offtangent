/**
 * Task-result rows that predate the card format (SPEC 7.10 / task cards).
 *
 * `persistTaskResultMessage` writes a capped card today: headline, at most
 * three lines of report, and `result*` preview fields in
 * `chat_messages.metadata`. Rows written before that carry the entire report
 * in `content` and no preview fields at all — measured on the live database on
 * 2026-09-15, the longest one is 20,342 characters, and every client that
 * loads that strand's history downloads and renders all of it.
 *
 * There is no migration and no schema change for those rows: everything the
 * card needs is derivable from what the row already holds, so the server
 * derives it when it serves the row, and the stored column stays exactly as it
 * is. That keeps the change reversible (delete this file and the old rows are
 * back, verbatim) and keeps the full report reachable — it lives in
 * `tasks.result_summary` and the expanded card fetches it via
 * `GET /api/tasks/:id`.
 *
 * Deliberately conservative: a row is only shortened when the full report is
 * still fetchable, i.e. when its task row still exists and holds a non-empty
 * `result_summary`. For an orphaned row (task deleted, retention swept) the
 * message IS the last copy of the report, and shortening it in the response
 * would hide text the user can no longer get anywhere else.
 */
import type { Database } from '@axiom/core'
import { deriveTaskResultCard } from '@axiom/core'

/** Metadata keys the derived card fills in, mirroring `persistTaskResultMessage`. */
export interface DerivedTaskResultMetadata {
  resultPreview: string
  resultTruncated: boolean
  resultFullLength: number
  resultBodyKind: string
  /** Marks the card as derived on read, so a client can tell it from a stored one. */
  resultPreviewDerived: true
}

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * Is this a task-result row without a stored preview? Rows written by the
 * current code carry `resultPreview` and are left alone.
 */
function needsDerivation(metadata: Record<string, unknown> | null): metadata is Record<string, unknown> {
  if (!metadata) return false
  if (metadata.type !== 'task_result') return false
  const preview = metadata.resultPreview
  return typeof preview !== 'string' || preview.trim() === ''
}

/**
 * Task ids whose full report is still fetchable via `GET /api/tasks/:id`.
 *
 * `tasks` has no `user_id` column (tasks are not user-scoped in this schema,
 * and neither is `GET /api/tasks/:id`), so the id is the whole lookup. The
 * message rows this runs on are already scoped to the caller by the history
 * query, and nothing from the task row is copied into the response — only the
 * yes/no of "the full report is still there".
 */
function fetchableTaskIds(db: Database, taskIds: string[]): Set<string> {
  const unique = [...new Set(taskIds)]
  if (unique.length === 0) return new Set()
  const placeholders = unique.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT id FROM tasks
      WHERE id IN (${placeholders})
        AND result_summary IS NOT NULL AND TRIM(result_summary) <> ''`,
  ).all(...unique) as Array<{ id: string }>
  return new Set(rows.map(row => row.id))
}

/**
 * Replace the wall of text with the card, for every legacy task-result row in
 * a batch of history rows. Rows of any other kind are returned untouched, and
 * the returned objects are copies — nothing is written back to the database.
 */
export function withDerivedTaskResultPreviews<T extends Record<string, unknown>>(
  db: Database,
  rows: T[],
): T[] {
  const candidates = new Map<number, { metadata: Record<string, unknown>; taskId: string }>()
  rows.forEach((row, index) => {
    const metadata = parseMetadata(row.metadata)
    if (!needsDerivation(metadata)) return
    const taskId = typeof metadata.taskId === 'string' ? metadata.taskId : ''
    if (!taskId) return
    candidates.set(index, { metadata, taskId })
  })
  if (candidates.size === 0) return rows

  const fetchable = fetchableTaskIds(db, [...candidates.values()].map(entry => entry.taskId))

  return rows.map((row, index) => {
    const candidate = candidates.get(index)
    if (!candidate || !fetchable.has(candidate.taskId)) return row
    const content = typeof row.content === 'string' ? row.content : ''
    const derived = deriveTaskResultCard(content, candidate.taskId)
    if (!derived) return row

    const metadata: Record<string, unknown> & DerivedTaskResultMetadata = {
      ...candidate.metadata,
      resultPreview: derived.preview.preview,
      resultTruncated: true,
      resultFullLength: derived.preview.fullLength,
      resultBodyKind: derived.preview.bodyKind,
      resultPreviewDerived: true,
    }
    return { ...row, content: derived.content, metadata: JSON.stringify(metadata) }
  })
}
