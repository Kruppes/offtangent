/**
 * Where the outcome of a background task is delivered (SPEC 2.9, 10.4).
 *
 * Before the feed, every finished task was injected as a chat turn into an
 * interactive session — and when the user had none open, `resolveInjection
 * SessionId` minted one. Cronjobs, heartbeats and nightly runs therefore
 * produced titleless strands that contained nothing but `✅ Task completed`
 * rows, flooded the strand list and were offered to the capture router as
 * candidates.
 *
 * Three paths now, decided from the task's own data:
 *
 *  * **Live task parent** (agent trigger with a task-parent edge): deliver
 *    into that task first (steer/resume). No separate strand injection,
 *    feed item, Telegram message or doorbell for the same result.
 *  * **Strand origin** (interactive session lineage, or a stopped task parent
 *    whose own task lineage reaches a strand): the injection runs, the result
 *    is persisted in that strand, the doorbell rings once. In addition a feed
 *    item of kind `task_result` / `task_question` carrying `strand_id` is
 *    written.
 *  * **No strand origin** (cronjob, heartbeat, consolidation): a feed item
 *    and nothing else. No injection, so no interactive session is created and
 *    no LLM turn runs on the result. The row is still persisted under the
 *    task's OWN session (type `task`/`heartbeat`, never a strand) so chat
 *    history and search keep working, and Telegram still gets the plain
 *    result — the injection response used to be what reached Telegram, and
 *    dropping it silently would have deleted the notification.
 *
 * Push: the doorbell is rung on the strand path only, exactly once, by the
 * same `sendTaskDoorbell` call as before. The feed path deliberately does not
 * ring: `PushDoorbell` addresses a strand the app opens, and a feed item has
 * none. That keeps "one event, at most one ring" true in both directions.
 */
import {
  buildTaskFeedItem,
  deliverTaskNotification,
  resolveTaskStrandOrigin,
  resolveTaskStrandId,
  taskOwnerAgentId,
  MAX_TASK_TREE_DEPTH,
  TaskStore,
  type Database,
  type Task,
  type TaskNotificationEvent,
  type TaskRuntimeTaskBoundary,
  type TelegramDeliveryMode,
} from '@axiom/core'
import type { ChatEventBus } from './chat-event-bus.js'
import { publishFeedItem } from './feed-publish.js'

export interface TaskOutcomeLogger {
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
}

export interface TaskOutcomeDeps {
  db: Database
  chatEventBus?: ChatEventBus | null
  logger?: TaskOutcomeLogger
  telegramDeliveryMode: TelegramDeliveryMode
  hasActiveWebSocket: (userId: number) => boolean
  /**
   * Start the LLM injection in the supplied lineage strand. This callback
   * cannot override the persistence, feed or push target.
   */
  injectIntoStrand: (input: {
    task: Task
    injection: string
    userId: number
    agentId: string
    strandId: string
  }) => void
  /** Steer a live parent (or resume a paused one). False means fall back to its origin strand. */
  deliverToParent?: (input: {
    parentTask: Task
    task: Task
    injection: string
    agentId: string
  }) => boolean | Promise<boolean>
  /**
   * Deliver the plain result to Telegram. Only used on the feed path, where
   * no injection response exists to carry it. Returns undefined when the user
   * has no bot/chat.
   */
  sendTelegram?: (input: { userId: number; agentId: string; task: Task; durationMinutes: number }) => ((message: string) => Promise<boolean>) | undefined
  /** Ring the doorbell for a strand-bound result. Called at most once. */
  ringDoorbell?: (input: { userId: number; sessionId: string; agentId: string; type: TaskNotificationEvent['type'] }) => void
}

export interface TaskOutcomeInput {
  task: Task
  /** The formatted `<task_injection>` payload for the task parent or strand. */
  injection: string
  userId: number
  agentId: string
  durationMinutes: number
}

export interface TaskOutcomeResult {
  target: 'parent' | 'strand' | 'feed'
  /** The origin strand if known (the parent itself receives a parent-target result). */
  strandId: string | null
  /** The feed item written on a strand or feed delivery path. */
  feedItemId: string | null
}

export async function routeTaskOutcome(deps: TaskOutcomeDeps, input: TaskOutcomeInput): Promise<TaskOutcomeResult> {
  const { task, userId, durationMinutes } = input
  const logger = deps.logger ?? console
  // A child created inside a task records its caller as trigger_source_id, even
  // when its session has no parent_session_id. Deliver to the caller first;
  // only after it has stopped do we follow that task edge back to a strand.
  const parent = task.triggerType === 'agent' && task.triggerSourceId && task.triggerSourceId !== task.id
    ? new TaskStore(deps.db).getById(task.triggerSourceId)
    : null
  let agentId = parent ? taskOwnerAgentId(parent) : taskOwnerAgentId(task)
  if (parent && (parent.status === 'running' || parent.status === 'paused') && deps.deliverToParent) {
    let delivered = false
    try {
      delivered = await deps.deliverToParent({ parentTask: parent, task, injection: input.injection, agentId })
    } catch (err) {
      logger.error(`[task-outcome] Failed to deliver task ${task.id} to parent ${parent.id}:`, err)
    }
    if (delivered) {
      // The caller handles the result; don't also post it as an independent
      // completion in the strand/feed. Its own eventual result remains visible.
      return { target: 'parent', strandId: resolveTaskStrandId(deps.db, parent), feedItemId: null }
    }
  }
  // The persona that answers in the strand is the owner of the ancestor whose
  // OWN session lineage reaches that strand, not of the nearest stopped
  // parent: in main strand -> root(main) -> P1(bob, delegated by main) ->
  // P2(bob) -> child, P2's owner is bob, but the strand is Main's.
  const anchor = parent ? resolveStrandAnchor(deps.db, parent) : null
  const strandOrigin = parent ? (anchor?.strandId ?? null) : resolveTaskStrandOrigin(deps.db, task)
  if (anchor) agentId = taskOwnerAgentId(anchor.task)

  if (strandOrigin) {
    // A user may have changed the orchestrator since this worker started.
    // Keep the task's execution identity intact, but inject through the strand's current owner.
    const current = deps.db.prepare("SELECT agent_id FROM sessions WHERE id = ? AND (user_id = ? OR (user_id IS NULL AND session_user = ?)) AND type = 'interactive'")
      .get(strandOrigin, userId, String(userId)) as { agent_id: string | null } | undefined
    if (current) agentId = current.agent_id ?? 'main'
    const sessionId = strandOrigin
    deps.injectIntoStrand({
      task,
      injection: input.injection,
      userId,
      agentId,
      strandId: strandOrigin,
    })

    deliverTaskNotification({
      db: deps.db,
      userId,
      task,
      durationMinutes,
      targetSessionId: sessionId,
      telegramDeliveryMode: deps.telegramDeliveryMode,
      hasActiveWebSocket: deps.hasActiveWebSocket,
      broadcastEvent: event => {
        broadcastTaskEvent(deps, event)
        deps.ringDoorbell?.({ userId: event.userId, sessionId, agentId, type: event.type })
      },
    }).catch(err => {
      logger.error(`[task-outcome] Failed to deliver task ${task.id} into strand ${sessionId}:`, err)
    })

    const item = publishFeedItem(
      { db: deps.db, chatEventBus: deps.chatEventBus, logger },
      userId,
      buildTaskFeedItem(task, { userId: String(userId), strandId: sessionId, agentId }),
    )
    return { target: 'strand', strandId: sessionId, feedItemId: item?.id ?? null }
  }

  // Feed only. Persist under the task's own session explicitly — never the
  // lineage, so a background task that somehow carries a parent session can
  // still not write into a strand.
  const item = publishFeedItem(
    { db: deps.db, chatEventBus: deps.chatEventBus, logger },
    userId,
    buildTaskFeedItem(task, { userId: String(userId), strandId: null, agentId }),
  )

  deliverTaskNotification({
    db: deps.db,
    userId,
    task,
    durationMinutes,
    targetSessionId: task.sessionId ?? undefined,
    telegramDeliveryMode: deps.telegramDeliveryMode,
    hasActiveWebSocket: deps.hasActiveWebSocket,
    sendTelegram: deps.sendTelegram?.({ userId, agentId, task, durationMinutes }),
    // No doorbell: there is no strand for the app to open.
    broadcastEvent: event => broadcastTaskEvent(deps, event),
  }).catch(err => {
    logger.error(`[task-outcome] Failed to deliver task ${task.id} to the feed:`, err)
  })

  return { target: 'feed', strandId: null, feedItemId: item?.id ?? null }
}

/**
 * Hand a sub-task result to its live parent: steer a running one, resume a
 * paused one. Returns false whenever the parent will NOT read the text, so
 * the caller falls back to the origin strand instead of losing the result.
 *
 * `resume` answers true even when the parent's max duration already passed
 * while it was paused — the runner then aborts it synchronously and the
 * message is never sent to its agent. Only a parent that is actually running
 * after the resume counts as delivered.
 */
export async function deliverSubtaskResultToParent(
  runtime: Pick<TaskRuntimeTaskBoundary, 'isPaused' | 'isRunning' | 'resume' | 'steer'>,
  parentTask: Pick<Task, 'id' | 'status'>,
  childTaskId: string,
  payload: string,
): Promise<boolean> {
  const text = `<subtask_result task_id="${childTaskId}">\n${payload}\n</subtask_result>\nThis is the result of your sub-task. Continue your task with it.`
  if (parentTask.status === 'paused') {
    if (!runtime.isPaused(parentTask.id)) return false
    const resumed = await runtime.resume(parentTask.id, text)
    return resumed && runtime.isRunning(parentTask.id)
  }
  return runtime.steer?.(parentTask.id, text).delivered ?? false
}

/**
 * Same walk as `resolveTaskStrandId` (session lineage first, then the
 * task-parent edge; cycle-safe and bounded identically), but it also returns
 * the ancestor whose own session lineage reached the strand, so the caller
 * can answer with that ancestor's persona.
 */
function resolveStrandAnchor(db: Database, start: Task): { strandId: string; task: Task } | null {
  const store = new TaskStore(db)
  let current: Task | null = start
  const seen = new Set<string>()
  for (let hop = 0; current && hop <= MAX_TASK_TREE_DEPTH + 1; hop++) {
    if (seen.has(current.id)) return null
    seen.add(current.id)
    const direct = resolveTaskStrandOrigin(db, current)
    if (direct) return { strandId: direct, task: current }
    const parentId: string | null = current.triggerType === 'agent' ? current.triggerSourceId : null
    if (!parentId) return null
    current = store.getById(parentId)
  }
  return null
}

/** The task event as the bus carried it before the feed existed, unchanged. */
function broadcastTaskEvent(deps: TaskOutcomeDeps, event: TaskNotificationEvent): void {
  deps.chatEventBus?.broadcast({
    type: event.type,
    userId: event.userId,
    source: 'task',
    taskId: event.taskId,
    taskName: event.taskName,
    taskSummary: event.taskSummary,
    taskSummaryTruncated: event.taskSummaryTruncated,
    taskSummaryFullLength: event.taskSummaryFullLength,
    taskDurationMinutes: event.taskDurationMinutes,
    taskTokensUsed: event.taskTokensUsed,
    taskTriggerType: event.taskTriggerType,
  })
}
