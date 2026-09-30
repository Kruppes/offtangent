/**
 * Where the result of a background task goes (SPEC 2.9, 10.4).
 *
 * Before the feed existed, EVERY unsolicited result was injected as a system
 * message into an interactive session — and when the user had none open, one
 * was minted for it. That is what produced the titleless strands that only
 * ever contained `✅ Task completed` rows and then flooded both the strand
 * list and the router's candidate set.
 *
 * The rule now:
 *
 *  * A task with a **strand origin** (the user started it from a strand, so
 *    the task session has an interactive ancestor) keeps behaving exactly as
 *    before: the result is injected into that strand. A `task_result` /
 *    `task_question` feed item carrying `strand_id` is written in addition,
 *    so the feed stays the single place for "something finished" even when
 *    the strand is not open.
 *  * A task **without** a strand origin (cronjob, heartbeat, consolidation,
 *    anything that did not start with a user question) gets a feed item and
 *    nothing else. No strand, and above all no freshly minted interactive
 *    session.
 *
 * The origin is read from the data, never guessed: `tasks.session_id` is the
 * task's own session, and `sessions.parent_session_id` links it to the
 * session that triggered it (`getParentSessionId` in the task tools writes
 * the user's interactive session there). Conservative on top of that:
 * `cronjob`, `heartbeat` and `consolidation` triggers never resolve to a
 * strand even if a lineage exists.
 */
import type { Database } from './database.js'
import type { FeedItemKind, InsertFeedItemInput } from './feed-store.js'
import type { Task } from './task-store.js'

/** Trigger types that may deliver into a strand at all. */
const STRAND_CAPABLE_TRIGGERS = new Set(['user', 'agent'])

/** Guard against a cyclic `parent_session_id` chain. */
const MAX_LINEAGE_DEPTH = 10

/**
 * The interactive strand a task originated from, or null when it has none.
 *
 * Walks `sessions.parent_session_id` upwards from the task's own session and
 * returns the first ancestor (or the task session itself) whose `type` is
 * `interactive`. Returns null for cronjob/heartbeat/consolidation triggers,
 * for tasks without a session, and for any lineage that never reaches an
 * interactive session.
 */
export function resolveTaskStrandOrigin(db: Database, task: Task): string | null {
  if (!STRAND_CAPABLE_TRIGGERS.has(task.triggerType)) return null
  if (!task.sessionId) return null

  let currentId: string | null = task.sessionId
  let depth = MAX_LINEAGE_DEPTH
  while (currentId && depth-- > 0) {
    const row = db.prepare('SELECT id, type, parent_session_id FROM sessions WHERE id = ?')
      .get(currentId) as { id: string; type: string | null; parent_session_id: string | null } | undefined
    if (!row) return null
    if ((row.type ?? 'interactive') === 'interactive') return row.id
    currentId = row.parent_session_id
  }
  return null
}

/**
 * The feed kind for a finished task. A question is always `task_question`
 * (what it is matters more than where it came from); otherwise the trigger
 * decides: cronjob -> `cron_report`, heartbeat -> `heartbeat`, consolidation
 * -> `system`, user/agent -> `task_result`.
 */
export function feedKindForTask(task: Task): FeedItemKind {
  if ((task.resultStatus ?? task.status) === 'question') return 'task_question'
  switch (task.triggerType) {
    case 'cronjob': return 'cron_report'
    case 'heartbeat': return 'heartbeat'
    case 'consolidation': return 'system'
    default: return 'task_result'
  }
}

/** Label for the feed card. The kind is carried separately, so no emoji here. */
export function feedTitleForTask(task: Task): string {
  const status = task.resultStatus ?? task.status
  if (status === 'question') return `Question: ${task.name}`
  if (status === 'failed') return `Failed: ${task.name}`
  return task.name
}

export interface TaskFeedItemOptions {
  /** The user id as a string (same convention as `captures.user_id`). */
  userId: string
  /** The strand the result was also delivered into, when there is one. */
  strandId?: string | null
  /** Persona the task belongs to; falls back to `tasks.agent_id`. */
  agentId?: string | null
}

/** The feed row for a finished (or pausing) task. */
export function buildTaskFeedItem(task: Task, options: TaskFeedItemOptions): InsertFeedItemInput {
  return {
    userId: options.userId,
    kind: feedKindForTask(task),
    title: feedTitleForTask(task),
    body: task.resultSummary ?? task.errorMessage ?? null,
    agentId: options.agentId ?? task.agentId ?? null,
    taskId: task.id,
    strandId: options.strandId ?? null,
  }
}
