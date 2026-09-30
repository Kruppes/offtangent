/**
 * task-agent-notice.ts: the last mile for task outcomes that never reach a
 * strand (W5/P3).
 *
 * ## The incident (2026-09-17, 16:17)
 *
 * A cronjob task (`w4-deploy-verify-20260917`) completed, the feed item was
 * written — and the agent never learned about it. The user wrote at 16:22,
 * a run started, and the result was still nowhere in the context.
 *
 * The cause is NOT the W4 durable queue or its sweeper: those never saw the
 * result. `routeTaskOutcome` asks `resolveTaskStrandOrigin`, which returns
 * null for `trigger_type='cronjob'` by design (SPEC 2.9 — cronjob results
 * must not mint strands or start LLM turns), and takes the feed-only path:
 * feed item + Telegram, no injection, therefore no queue row, therefore
 * nothing for the sweeper to re-deliver. Verified on the production DB:
 * `SELECT COUNT(*) FROM task_injections` = 0 while the feed carried the
 * `cron_report` row for that exact minute.
 *
 * ## The fix
 *
 * Keep the design decision (a cronjob still never starts a turn on its own)
 * and close the gap on the other side: the outcome is owed to the persona,
 * and the next run of that persona pays the debt. `consumePendingTaskNotices`
 * returns a compact block of the outcomes that were never announced and marks
 * them announced in the same step; `AgentCore` prepends it to the next user
 * message, so the agent reads the cronjob result BEFORE it answers the user.
 *
 * Scope is deliberately narrow:
 *  * only `trigger_type='cronjob'` — heartbeat/consolidation runs are internal
 *    plumbing, announcing them would be noise;
 *  * only `result_status != 'silent'` — silent means "do not tell anyone";
 *  * bounded by age and count, and each summary is truncated;
 *  * `agent_notified_at` is backfilled in the migration, so a deploy never
 *    replays yesterday's cronjobs.
 */

import type { Database } from './database.js'

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
export function consumePendingTaskNotices(db: Database, query: PendingNoticeQuery): string | null {
  try {
    const notices = listPendingTaskNotices(db, query)
    if (notices.length === 0) return null
    const block = formatPendingTaskNoticeBlock(notices)
    markTaskNoticesDelivered(db, notices.map(n => n.id), query.now ?? Date.now())
    return block
  } catch {
    return null
  }
}
