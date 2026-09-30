/**
 * Who a task belongs to.
 *
 * The `tasks` table has no `user_id` column — a task is attributed through
 * its session lineage: `tasks.session_id` → `sessions.parent_session_id`
 * (repeatedly) → the top-most session, whose `session_user` / `user_id`
 * names the human who triggered the work.
 *
 * This is the same walk the task result notification has always used to
 * decide who gets the answer (it lived inline in
 * `runtime-composition.ts:resolveTargetUserIdForTask`). It is extracted here
 * because the API now has to answer the SAME question for authorization: the
 * user who receives a task's result is exactly the user allowed to read and
 * kill it. Two implementations of that rule would drift, and a drifting
 * authorization rule is a bug with consequences.
 *
 * Returns null — never a guess — when the chain does not end in a numeric
 * user. That is the normal case for cronjob / heartbeat / consolidation
 * tasks: they are system work with no human origin. Callers decide what
 * null means for them (delivery falls back to the first user; the API
 * treats it as "admin only").
 */
import type { Database } from './database.js'

/** How far the lineage walk follows `parent_session_id` before giving up. */
const MAX_SESSION_LINEAGE_DEPTH = 10

/**
 * How many task→parent-task hops the owner walk follows before giving up.
 * A chain of delegating tasks this deep does not exist in practice (the
 * task tree caps its own depth at 6); the limit is here so malformed or
 * cyclic `trigger_source_id` data cannot turn an authorization check into
 * an unbounded loop.
 */
const MAX_TASK_PARENT_HOPS = 8

/**
 * Strictly parse a numeric user id. `Number.parseInt` is too lax
 * (`parseInt('3abc', 10) === 3`) and would silently attribute a task to the
 * wrong user when `session_user` is a non-numeric username or a malformed
 * string that happens to start with digits. Reject anything that isn't a
 * pure integer literal.
 */
export function parseStrictUserId(value: string | number | null | undefined): number | null {
  if (value == null) return null
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null
  }
  const trimmed = value.trim()
  if (!/^-?\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * The user a task session belongs to, or null when the lineage does not end
 * in a numeric user (system task, unknown session, broken chain, or a task
 * that has no session yet).
 *
 * User-id precedence when both columns are populated:
 *   1. `session_user` — the canonical identity written by
 *      `SessionManager.getOrCreateSession`; for web/telegram users this is
 *      `String(userId)`.
 *   2. `user_id` — only populated for sessions recovered by the legacy
 *      migration, a best-effort backfill.
 */
export function resolveTaskOwnerUserId(
  db: Database,
  taskSessionId: string | null | undefined,
): number | null {
  if (!taskSessionId) return null

  let currentId: string | null = taskSessionId
  let safety = MAX_SESSION_LINEAGE_DEPTH
  const seen = new Set<string>()
  while (currentId && safety-- > 0) {
    // A cyclic parent chain would otherwise burn the whole depth budget.
    if (seen.has(currentId)) return null
    seen.add(currentId)

    const row = db.prepare(
      'SELECT parent_session_id, user_id, session_user FROM sessions WHERE id = ?',
    ).get(currentId) as {
      parent_session_id: string | null
      user_id: number | null
      session_user: string | null
    } | undefined
    if (!row) return null
    if (!row.parent_session_id) {
      const parsedSessionUser = parseStrictUserId(row.session_user)
      if (parsedSessionUser !== null) return parsedSessionUser
      return parseStrictUserId(row.user_id)
    }
    currentId = row.parent_session_id
  }
  return null
}

/**
 * The minimum a task row has to expose for the owner walk. Kept structural
 * so callers can pass a full `Task` (the API does) without this module
 * depending on the task types.
 */
export interface TaskOwnershipLineage {
  id: string
  triggerType: string
  triggerSourceId: string | null
  sessionId: string | null
}

/** The three columns the walk needs, for one task id. */
function loadTaskLineage(db: Database, taskId: string): TaskOwnershipLineage | null {
  const row = db.prepare(
    'SELECT id, trigger_type, trigger_source_id, session_id FROM tasks WHERE id = ?',
  ).get(taskId) as {
    id: string
    trigger_type: string
    trigger_source_id: string | null
    session_id: string | null
  } | undefined
  if (!row) return null
  return {
    id: row.id,
    triggerType: row.trigger_type,
    triggerSourceId: row.trigger_source_id,
    sessionId: row.session_id,
  }
}

/**
 * The user a TASK belongs to — session lineage first, then the task-parent
 * edge.
 *
 * Why the second hop exists: a task that a task delegates
 * (`create_task` inside a background run) gets a session of its own, and
 * the background task tools deliberately pass `parentSessionId = null`
 * (see FOLLOWUPS: fixing that link would also move where the sub-task's
 * RESULT is delivered). So the sub-task's session chain ends immediately
 * and `resolveTaskOwnerUserId` answers null — which the API read as
 * "system work, admins only" and answered 404 to the very user who started
 * the chain. Measured on the live database:
 *
 *   parent 1acb92bd… → session 5527bf30… → parent_session 5a8d1817…
 *                      (interactive, session_user '2')            → owner 2
 *   child  cef64106… → session d9d707ff… → parent_session NULL,
 *                      session_user NULL, user_id NULL            → null
 *
 * The child's only link to its origin is `tasks.trigger_source_id`, which
 * holds the parent task's id when `trigger_type = 'agent'` (the same edge
 * `resolveTaskStrandId` climbs for the strand). This walk follows it and
 * asks the session question again for the parent.
 *
 * It does NOT widen access: every hop still ends in a real session whose
 * root names a numeric user. A chain that resolves to nobody stays null —
 * the caller keeps answering 404 — and a chain that resolves to another
 * user resolves to THAT user, not to the requester.
 */
export function resolveTaskOwnerUserIdForTask(
  db: Database,
  task: TaskOwnershipLineage,
): number | null {
  let current: TaskOwnershipLineage | null = task
  const seen = new Set<string>()

  for (let hop = 0; current && hop <= MAX_TASK_PARENT_HOPS; hop++) {
    // A cycle in `trigger_source_id` (only reachable through bad data) must
    // not spin, and must not be answered with a guess.
    if (seen.has(current.id)) return null
    seen.add(current.id)

    const direct = resolveTaskOwnerUserId(db, current.sessionId)
    if (direct !== null) return direct

    // Only `agent` tasks carry a parent TASK id here. For `cronjob` the
    // column holds a cronjob id, for `heartbeat` a marker string — following
    // those would be a type confusion, so they end the walk.
    const parentId = current.triggerType === 'agent'
      ? (current.triggerSourceId?.trim() || null)
      : null
    if (!parentId) return null

    current = loadTaskLineage(db, parentId)
  }

  return null
}
