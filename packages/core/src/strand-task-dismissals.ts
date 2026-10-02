/**
 * Acknowledged ("dismissed") entries of a strand's activity list (W6c).
 *
 * The activity list of a strand (`GET /api/strands/:id/tasks`) is built from
 * the `tasks` table on every read, so a finished task comes back forever.
 * The user can now acknowledge a finished task: it leaves the default view
 * of every client (web today, the app once it reads the field) and can be
 * brought back.
 *
 * Storage: one additive table, no column on `tasks`. A dismissal belongs to
 * the strand view, not to the task (the same task row could in principle be
 * reachable from two strands through the session edge), and keeping it out
 * of `tasks` leaves every existing writer and reader of that table alone.
 * Creating the table is idempotent; an install without it simply has no
 * dismissals.
 */
import type { Database } from './database.js'

export function ensureStrandTaskDismissalTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strand_task_dismissals (
      strand_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      dismissed_at TEXT NOT NULL,
      PRIMARY KEY (strand_id, task_id)
    );
  `)
}

/** Hard cap on ids per call, the same as the tree's node cap. */
export const MAX_DISMISS_IDS = 200

/** `task_id -> dismissed_at` (ISO 8601) for one strand. */
export function listStrandTaskDismissals(db: Database, strandId: string): Map<string, string> {
  const rows = db.prepare('SELECT task_id, dismissed_at FROM strand_task_dismissals WHERE strand_id = ?')
    .all(strandId) as { task_id: string; dismissed_at: string }[]
  return new Map(rows.map(row => [row.task_id, row.dismissed_at]))
}

/**
 * Mark ids as dismissed. An id that is already dismissed keeps its first
 * timestamp (idempotent: a retried request changes nothing).
 */
export function dismissStrandTasks(db: Database, strandId: string, taskIds: string[], at: string): void {
  if (taskIds.length === 0) return
  const insert = db.prepare('INSERT OR IGNORE INTO strand_task_dismissals (strand_id, task_id, dismissed_at) VALUES (?, ?, ?)')
  db.transaction(() => { for (const id of taskIds) insert.run(strandId, id, at) })()
}

/** Bring ids back into the default view. Unknown ids are a no-op. */
export function undismissStrandTasks(db: Database, strandId: string, taskIds: string[]): void {
  if (taskIds.length === 0) return
  const remove = db.prepare('DELETE FROM strand_task_dismissals WHERE strand_id = ? AND task_id = ?')
  db.transaction(() => { for (const id of taskIds) remove.run(strandId, id) })()
}

/** Drop every dismissal of a strand (strand deletion). */
export function clearStrandTaskDismissals(db: Database, strandId: string): void {
  db.prepare('DELETE FROM strand_task_dismissals WHERE strand_id = ?').run(strandId)
}
