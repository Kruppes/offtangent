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
 * Two paths now, decided from the task's own data (see
 * `resolveTaskStrandOrigin`):
 *
 *  * **Strand origin** (user/agent trigger with an interactive session in its
 *    lineage): unchanged behaviour — the injection runs, the result is
 *    persisted in that strand, the doorbell rings once. In addition a feed
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
  type Database,
  type Task,
  type TaskNotificationEvent,
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
  /** The formatted `<task_injection>` payload (only used on the strand path). */
  injection: string
  userId: number
  agentId: string
  durationMinutes: number
}

export interface TaskOutcomeResult {
  target: 'strand' | 'feed'
  /** The session the result was delivered into, on the strand path. */
  strandId: string | null
  /** The feed item that was written, on both paths. */
  feedItemId: string | null
}

export function routeTaskOutcome(deps: TaskOutcomeDeps, input: TaskOutcomeInput): TaskOutcomeResult {
  const { task, userId, agentId, durationMinutes } = input
  const logger = deps.logger ?? console
  const strandOrigin = resolveTaskStrandOrigin(deps.db, task)

  if (strandOrigin) {
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
