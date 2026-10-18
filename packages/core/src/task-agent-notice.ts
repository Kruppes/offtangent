/** Legacy notices are archival queries only. Automatic delivery is origin-strand
 * or feed-only (task-outcome.ts), NEVER the next turn of a persona. */
import type { Database } from './database.js'
import { TaskStore } from './task-store.js'
import { resolveTaskOwnerUserIdForTask } from './task-ownership.js'
import { insertFeedItemDeduped } from './feed-store.js'
import { buildTaskFeedItem } from './task-feed.js'

/** Outcome that is owed to a persona. */
export interface PendingTaskNotice {
  id: string
  name: string
  status: string
  resultStatus: string | null
  completedAt: string | null
  summary: string | null
  errorMessage: string | null
  handoff: string | null
}

export interface PendingNoticeQuery {
  agentId: string
  /** Outcomes older than this are dropped as stale (default 24 h). */
  maxAgeMs?: number
  /** Maximum outcomes per block (default 5). */
  limit?: number
  /** Injected clock for tests. */
  now?: number
}

/** Chars of a single summary that reach the block. */
const MAX_SUMMARY_CHARS = 1200
const DEFAULT_MAX_AGE_MS = 24 * 3600_000
const DEFAULT_LIMIT = 5

function sqlTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

/** Outcomes of `agentId` that were never announced, oldest first. */
export function listPendingTaskNotices(db: Database, query: PendingNoticeQuery): PendingTaskNotice[] {
  const now = query.now ?? Date.now()
  const cutoff = sqlTimestamp(now - (query.maxAgeMs ?? DEFAULT_MAX_AGE_MS))
  const rows = db.prepare(`
    SELECT id, name, status, result_status, completed_at, result_summary, error_message, handoff
    FROM tasks
    WHERE agent_notified_at IS NULL
      AND trigger_type = 'cronjob'
      AND status IN ('completed', 'failed')
      AND (result_status IS NULL OR result_status != 'silent')
      AND COALESCE(agent_id, 'main') = ?
      AND COALESCE(completed_at, created_at) >= ?
    ORDER BY COALESCE(completed_at, created_at) ASC
    LIMIT ?
  `).all(query.agentId, cutoff, query.limit ?? DEFAULT_LIMIT) as Array<{
    id: string
    name: string
    status: string
    result_status: string | null
    completed_at: string | null
    result_summary: string | null
    error_message: string | null
    handoff: string | null
  }>

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    status: row.status,
    resultStatus: row.result_status,
    completedAt: row.completed_at,
    summary: row.result_summary,
    errorMessage: row.error_message,
    handoff: row.handoff,
  }))
}

/** Mark outcomes as announced so they are never delivered twice. */
export function markTaskNoticesDelivered(db: Database, ids: string[], now: number = Date.now()): void {
  if (ids.length === 0) return
  const stmt = db.prepare('UPDATE tasks SET agent_notified_at = ? WHERE id = ?')
  const ts = sqlTimestamp(now)
  for (const id of ids) stmt.run(ts, id)
}

/**
 * Stale outcomes that will never be announced (too old to be useful) are
 * closed out, so they cannot surface days later after a quiet period.
 */
export function expireStaleTaskNotices(db: Database, query: { maxAgeMs?: number; now?: number } = {}): number {
  const now = query.now ?? Date.now()
  const cutoff = sqlTimestamp(now - (query.maxAgeMs ?? DEFAULT_MAX_AGE_MS))
  const result = db.prepare(`
    UPDATE tasks SET agent_notified_at = ?
    WHERE agent_notified_at IS NULL
      AND status IN ('completed', 'failed')
      AND COALESCE(completed_at, created_at) < ?
  `).run(sqlTimestamp(now), cutoff)
  return typeof result.changes === 'number' ? result.changes : 0
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…[truncated]`
}

/** Render the notices as one prompt block, or null when there is nothing. */
export function formatPendingTaskNoticeBlock(notices: PendingTaskNotice[]): string | null {
  if (notices.length === 0) return null
  const parts = notices.map(notice => {
    const body = notice.summary?.trim()
      || notice.errorMessage?.trim()
      || '(no result text)'
    const handoff = notice.handoff?.trim() ? `\nHandoff: ${truncate(notice.handoff, 600)}` : ''
    return `- ${notice.name} (${notice.id}) — ${notice.resultStatus ?? notice.status}`
      + `${notice.completedAt ? ` at ${notice.completedAt} UTC` : ''}\n`
      + `${truncate(body, MAX_SUMMARY_CHARS)}${handoff}`
  })
  return `<background_task_results>
These scheduled background tasks finished while no run of yours was active, so
you are seeing them now, before the message below. They are results you did not
write — verify before acting, and only mention them if they matter to the user.
${parts.join('\n\n')}
</background_task_results>`
}

/**
 * List + format + mark, in one step. Returns null when nothing is pending.
 * Best effort: any DB problem returns null instead of breaking the turn.
 */
/** @deprecated Persona-wide prompt delivery is forbidden. Kept as a safe compatibility no-op. */
export function consumePendingTaskNotices(_db: Database, _query: PendingNoticeQuery): string | null {
  return null
}

/** Lossless/idempotent boot migration; unknown owners are quarantined, not guessed. */
export function archivePendingTaskNotices(db: Database): { delivered: number; quarantined: number } {
  const rows = db.prepare("SELECT id FROM tasks WHERE agent_notified_at IS NULL AND trigger_type = 'cronjob' AND status IN ('completed','failed') AND (result_status IS NULL OR result_status != 'silent')").all() as Array<{ id: string }>
  const store = new TaskStore(db)
  let delivered = 0
  let quarantined = 0
  db.transaction(() => {
    for (const row of rows) {
      const task = store.getById(row.id)
      if (!task) continue
      // Existing feed rows already carry the authorized recipient. Do not
      // duplicate them or rebroadcast a historical outcome.
      const existing = db.prepare('SELECT id FROM feed_items WHERE task_id = ? LIMIT 1').get(task.id)
      const owner = resolveTaskOwnerUserIdForTask(db, task)
      if (!existing && owner === null) { quarantined++; continue }
      if (!existing) insertFeedItemDeduped(db, {
        ...buildTaskFeedItem(task, { userId: String(owner), strandId: null }),
        dedupeKey: `legacy-task-notice:${task.id}`,
      })
      markTaskNoticesDelivered(db, [task.id])
      delivered++
    }
    if (quarantined) {
      // Metadata-only operator notice; never disclose ownerless task contents
      // to an arbitrary first user. Original rows remain retrievable by admin.
      const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as Array<{ id: number }>
      for (const admin of admins) insertFeedItemDeduped(db, {
        userId: String(admin.id), kind: 'system', title: 'Archived task notices need ownership classification',
        body: 'Some legacy outcomes have no trustworthy owner. They remain preserved in the task archive and are not injected into any strand.',
        dedupeKey: 'context-isolation:ownerless-notices:v1',
      })
    }
  })()
  return { delivered, quarantined }
}
