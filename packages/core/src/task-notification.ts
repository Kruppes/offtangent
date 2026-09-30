import type { Database } from './database.js'
import type { Task } from './task-store.js'
import {
  buildTaskResultContent,
  buildTaskResultPreview,
  taskResultMoreLine,
  taskStatusEmoji,
  type TaskResultPreview,
} from './contracts/task-result-card.js'

/**
 * Status emoji for task result formatting
 */
function statusEmoji(status: string): string {
  return taskStatusEmoji(status)
}

/**
 * The preview of a task report — headline, capped body, truncation marker.
 * One helper for all three delivery paths (Telegram, chat row, broadcast) so
 * the user sees the same three lines everywhere.
 */
function previewOf(task: Task): TaskResultPreview {
  return buildTaskResultPreview({
    taskId: task.id,
    name: task.name,
    status: task.resultStatus ?? task.status,
    resultSummary: task.resultSummary,
    errorMessage: task.errorMessage,
  })
}

/**
 * Format a task result for Telegram notification
 */
export function formatTaskTelegramMessage(task: Task, durationMinutes: number): string {
  const emoji = statusEmoji(task.resultStatus ?? task.status)
  const totalTokens = task.promptTokens + task.completionTokens
  const statusLabel = task.resultStatus ?? task.status
  const preview = previewOf(task)

  const lines: string[] = [
    `${emoji} <b>Task ${statusLabel}: ${escapeHtml(task.name)}</b>`,
    '',
  ]

  // Telegram gets the same capped preview as the strand: a chat app is the
  // worst place for a six-kilobyte report, and the full text is one tap away
  // in the task card (or `/task <id>`).
  if (preview.preview) {
    lines.push(escapeHtml(preview.preview))
    if (preview.truncated) {
      lines.push('')
      lines.push(`<i>${escapeHtml(taskResultMoreLine(preview, task.id))}</i>`)
    }
    lines.push('')
  }

  const details: string[] = []
  if (durationMinutes > 0) {
    details.push(`⏱ ${durationMinutes}min`)
  }
  if (totalTokens > 0) {
    details.push(`🔤 ${formatTokenCount(totalTokens)} tokens`)
  }
  if (details.length > 0) {
    lines.push(details.join('  •  '))
  }

  return lines.join('\n')
}

/**
 * Format token count for display (e.g., 12345 -> "12.3k")
 */
function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return String(count)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Resolve the session ID under which a task result notification should be
 * persisted. Walks the task's session lineage:
 *
 * - If the task's session has a `parent_session_id`, use the parent
 *   (typically the user's interactive session that triggered the task).
 * - Otherwise fall back to the task's own session (cronjob, heartbeat,
 *   consolidation — background tasks without an interactive trigger).
 * - Returns `null` when the task has no `session_id` at all (legacy
 *   pre-migration rows). Callers decide whether to skip persistence
 *   entirely or route to a caller-provided fallback session; throwing
 *   from this helper would corrupt task completion state because the
 *   error propagates into `TaskRunner.notifyTaskComplete`'s catch path
 *   and re-marks a completed task as failed.
 *
 * Replaces the legacy `task-result-<taskId>` pseudo-session IDs — when
 * non-null, the returned value is always a real session id.
 */
export function resolveTaskNotificationSessionId(db: Database, task: Task): string | null {
  if (!task.sessionId) return null

  const row = db.prepare(
    'SELECT parent_session_id FROM sessions WHERE id = ?'
  ).get(task.sessionId) as { parent_session_id: string | null } | undefined

  return row?.parent_session_id ?? task.sessionId
}

/**
 * Persist a task result to the chat_messages table so it appears in web chat history.
 *
 * When `sessionId` is not provided, the target session is resolved via
 * `resolveTaskNotificationSessionId` (parent interactive session, or the
 * task's own session as fallback).
 */
export function persistTaskResultMessage(
  db: Database,
  userId: number,
  task: Task,
  durationMinutes: number,
  sessionId?: string,
): void {
  const preview = previewOf(task)
  // The message stream gets the card, not the wall: headline, up to three
  // lines of report, and a pointer to the rest. The full report is NOT lost —
  // it stays in `tasks.result_summary` and is fetched by the expanded card via
  // GET /api/tasks/:id.
  const content = buildTaskResultContent({
    taskId: task.id,
    name: task.name,
    status: task.resultStatus ?? task.status,
    resultSummary: task.resultSummary,
    errorMessage: task.errorMessage,
  })

  const metadata = JSON.stringify({
    type: 'task_result',
    taskId: task.id,
    taskName: task.name,
    taskStatus: task.status,
    taskResultStatus: task.resultStatus,
    triggerType: task.triggerType,
    durationMinutes,
    resultPreview: preview.preview,
    resultTruncated: preview.truncated,
    resultFullLength: preview.fullLength,
    resultBodyKind: preview.bodyKind,
    promptTokens: task.promptTokens,
    completionTokens: task.completionTokens,
    estimatedCost: task.estimatedCost,
    toolCallCount: task.toolCallCount,
  })

  const resolvedSessionId = sessionId ?? resolveTaskNotificationSessionId(db, task)
  if (!resolvedSessionId) {
    // No session available — skip persistence rather than invent a synthetic
    // pseudo-session ID. The task notification still reaches the user via
    // broadcast / Telegram delivery.
    console.warn(
      `[task-notification] Skipping persist for task ${task.id}: no session_id available (legacy task?)`,
    )
    return
  }

  db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(resolvedSessionId, userId, 'system', content, metadata, task.agentId ?? 'main')
}

export type TelegramDeliveryMode = 'auto' | 'always'

/**
 * Live metrics for a periodic task heartbeat. Produced by the task runner
 * and threaded through the notification layer so the UI and Telegram do
 * not have to regex-parse the `<task_status>` XML payload.
 */
export interface TaskStatusUpdateDetails {
  taskName: string
  runtimeMinutes: number
  toolCallCount: number
  totalTokens: number
}

/**
 * Format token count for display (e.g., 12345 -> "12.3k"). Mirrors the
 * private helper used for task-result rendering.
 */
function formatTokenCountShort(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

/**
 * Human-readable single-line summary of a task heartbeat, used as the
 * `chat_messages.content` value so the row renders sensibly both when a
 * legacy client lacks the dedicated status-update card and when it is
 * returned verbatim in search results.
 */
export function formatTaskStatusUpdateContent(
  taskName: string,
  details: TaskStatusUpdateDetails,
): string {
  const tokens = formatTokenCountShort(details.totalTokens)
  return `⏱ Task running: ${taskName} — ${details.runtimeMinutes} min • ${details.toolCallCount} tool calls • ~${tokens} tokens`
}

/**
 * HTML-formatted Telegram payload for a task heartbeat. Uses only tags
 * that Telegram's Bot API recognises (`<b>`, `<code>`) so the primary
 * HTML send path actually succeeds instead of falling back to plain text
 * on every tick.
 */
export function formatTaskStatusUpdateTelegramHtml(
  task: Task,
  details: TaskStatusUpdateDetails,
): string {
  const tokens = formatTokenCountShort(details.totalTokens)
  return [
    `🔄 <b>Task progress:</b> ${escapeHtml(details.taskName)}`,
    `⏱ ${details.runtimeMinutes} min  •  🔧 ${details.toolCallCount} tool calls  •  🔤 ~${tokens} tokens`,
    '',
    `<code>/kill_task ${escapeHtml(task.id)}</code>`,
  ].join('\n')
}

/**
 * Persist a periodic `<task_status>` update to the chat_messages table
 * under the target session (resolved via the task's session lineage when
 * no explicit session id is provided).
 *
 * The message is stored with `role='system'` and a metadata tag of
 * `{ type: 'task_status_update' }` so it can be filtered out of
 * conversation history if it should not count as a user-facing turn.
 * Structured metrics are stored alongside so the web UI can rehydrate a
 * dedicated progress card on reload instead of showing raw XML.
 *
 * Unlike `persistTaskResultMessage`, this helper intentionally does NOT
 * invoke the LLM — status updates are ephemeral progress signals, not
 * chat turns that the parent agent should respond to.
 */
export function persistTaskStatusUpdateMessage(
  db: Database,
  userId: number,
  task: Task,
  content: string,
  details: TaskStatusUpdateDetails,
  sessionId?: string,
): void {
  const metadata = JSON.stringify({
    type: 'task_status_update',
    taskId: task.id,
    taskName: task.name,
    triggerType: task.triggerType,
    runtimeMinutes: details.runtimeMinutes,
    toolCallCount: details.toolCallCount,
    totalTokens: details.totalTokens,
  })

  const resolvedSessionId = sessionId ?? resolveTaskNotificationSessionId(db, task)
  if (!resolvedSessionId) {
    console.warn(
      `[task-notification] Skipping status-update persist for task ${task.id}: no session_id available (legacy task?)`,
    )
    return
  }

  db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(resolvedSessionId, userId, 'system', content, metadata, task.agentId ?? 'main')
}

export interface TaskStatusUpdateEvent {
  type: 'task_status_update'
  userId: number
  taskId: string
  taskName: string
  taskTriggerType: string
  /** Human-readable single-line summary — also used as the persisted `content`. */
  content: string
  /** Structured live metrics for UI rendering. */
  details: TaskStatusUpdateDetails
}

export interface TaskStatusUpdateOptions {
  db: Database
  userId: number
  task: Task
  /** Structured live metrics from the task runner. */
  details: TaskStatusUpdateDetails
  /** Pre-resolved target session id (parent interactive session) */
  targetSessionId?: string
  /** Telegram delivery mode (same semantics as task-result delivery) */
  telegramDeliveryMode: TelegramDeliveryMode
  /** Check if the user has an active WebSocket connection */
  hasActiveWebSocket: (userId: number) => boolean
  /**
   * Send a Telegram message. Receives a pre-formatted HTML payload using
   * only Telegram-supported tags. Returns true on success.
   */
  sendTelegram?: (html: string) => Promise<boolean>
  /** Broadcast a chat event for connected web clients */
  broadcastEvent?: (event: TaskStatusUpdateEvent) => void
}

/**
 * Deliver a periodic task status update:
 *   1. Persist to `chat_messages` as a `system` row so it shows up in
 *      history (filtered out of LLM context via metadata tag).
 *   2. Broadcast via ChatEventBus so connected web clients render it live.
 *   3. Optionally send via Telegram (respecting `telegramDeliveryMode`).
 *
 * Never invokes the LLM — status updates are progress signals, not chat
 * turns.
 *
 * Error handling: persist and broadcast failures propagate to the caller
 * (they indicate a real bug — DB schema drift, bus misconfiguration —
 * and should fail loudly). Only the Telegram path is caught locally
 * because it is an external-service boundary where transient failures
 * should not tear down the scheduled heartbeat.
 */
export async function deliverTaskStatusUpdate(options: TaskStatusUpdateOptions): Promise<{
  persisted: boolean
  telegramSent: boolean
  broadcastSent: boolean
}> {
  const {
    db,
    userId,
    task,
    details,
    targetSessionId,
    telegramDeliveryMode,
    hasActiveWebSocket,
    sendTelegram,
    broadcastEvent,
  } = options

  const content = formatTaskStatusUpdateContent(details.taskName, details)

  // Persist: fail-fast. A throw here propagates to the caller's
  // `.catch()` which logs it — this is intentional so a schema or
  // session-lineage bug surfaces immediately instead of silently
  // swallowing every tick.
  persistTaskStatusUpdateMessage(db, userId, task, content, details, targetSessionId)
  const persisted = true

  // Broadcast: fail-fast. Broadcast errors mean the event bus itself is
  // broken; silently masking them would make the feature look like it
  // works when the UI receives nothing.
  let broadcastSent = false
  if (broadcastEvent) {
    broadcastEvent({
      type: 'task_status_update',
      userId,
      taskId: task.id,
      taskName: task.name,
      taskTriggerType: task.triggerType,
      content,
      details,
    })
    broadcastSent = true
  }

  // Telegram: external-service boundary — catch so transient network or
  // API-rate-limit failures don't nuke the heartbeat schedule, but still
  // log every failure so operators notice sustained problems.
  let telegramSent = false
  if (sendTelegram) {
    const shouldSendTelegram =
      telegramDeliveryMode === 'always' ||
      (telegramDeliveryMode === 'auto' && !hasActiveWebSocket(userId))
    if (shouldSendTelegram) {
      const html = formatTaskStatusUpdateTelegramHtml(task, details)
      try {
        telegramSent = await sendTelegram(html)
      } catch (err) {
        console.error(`[task-notification] Failed to send Telegram status update for task ${task.id}:`, err)
      }
    }
  }

  return { persisted, telegramSent, broadcastSent }
}


export interface TaskNotificationOptions {
  db: Database
  /** The user ID (Axiom numeric ID) this notification is for */
  userId: number
  /** The completed/failed/paused task */
  task: Task
  /** Duration in minutes */
  durationMinutes: number
  /** Telegram delivery mode from settings */
  telegramDeliveryMode: TelegramDeliveryMode
  /** Check if user has active WebSocket connection */
  hasActiveWebSocket: (userId: number) => boolean
  /** Send Telegram message. Returns true on success. */
  sendTelegram?: (message: string) => Promise<boolean>
  /** Broadcast a task event to all connected web clients */
  broadcastEvent?: (event: TaskNotificationEvent) => void
  /**
   * Optional pre-resolved target session ID for the persisted chat_messages
   * row. When omitted, it is resolved via `resolveTaskNotificationSessionId`.
   */
  targetSessionId?: string
}

export interface TaskNotificationEvent {
  type: 'task_completed' | 'task_failed' | 'task_question'
  userId: number
  taskId: string
  taskName: string
  /**
   * The CAPPED preview (see `contracts/task-result-card.ts`), not the full
   * report — a live client renders the same card the persisted row does, and
   * pushing kilobytes through the socket only to hide them again is waste.
   */
  taskSummary: string
  /** True when `taskSummary` is a preview; the card then offers "show all". */
  taskSummaryTruncated: boolean
  /** Length of the full report in characters (0 when there is none). */
  taskSummaryFullLength: number
  taskDurationMinutes: number
  taskTokensUsed: number
  taskTriggerType: string
}

/**
 * Deliver a task result notification:
 * 1. Always persist to chat_messages
 * 2. Broadcast via ChatEventBus for connected web clients
 * 3. Conditionally send Telegram notification
 */
export async function deliverTaskNotification(options: TaskNotificationOptions): Promise<{
  persisted: boolean
  telegramSent: boolean
  broadcastSent: boolean
}> {
  const {
    db,
    userId,
    task,
    durationMinutes,
    telegramDeliveryMode,
    hasActiveWebSocket,
    sendTelegram,
    broadcastEvent,
  } = options

  // 1. Always persist to chat_messages (under the resolved interactive
  // session via parent_session_id, or the task session as fallback).
  let persisted = false
  try {
    persistTaskResultMessage(db, userId, task, durationMinutes, options.targetSessionId)
    persisted = true
  } catch (err) {
    console.error(`[task-notification] Failed to persist task result for task ${task.id}:`, err)
  }

  // 2. Broadcast via ChatEventBus
  let broadcastSent = false
  if (broadcastEvent) {
    const eventType = task.resultStatus === 'question'
      ? 'task_question'
      : task.resultStatus === 'failed' || task.status === 'failed'
        ? 'task_failed'
        : 'task_completed'

    try {
      const preview = previewOf(task)
      broadcastEvent({
        type: eventType,
        userId,
        taskId: task.id,
        taskName: task.name,
        taskSummary: preview.preview || 'No summary available.',
        taskSummaryTruncated: preview.truncated,
        taskSummaryFullLength: preview.fullLength,
        taskDurationMinutes: durationMinutes,
        taskTokensUsed: task.promptTokens + task.completionTokens,
        taskTriggerType: task.triggerType,
      })
      broadcastSent = true
    } catch (err) {
      console.error(`[task-notification] Failed to broadcast task event for task ${task.id}:`, err)
    }
  }

  // 3. Conditionally send Telegram
  let telegramSent = false
  if (sendTelegram) {
    const shouldSendTelegram =
      telegramDeliveryMode === 'always' ||
      (telegramDeliveryMode === 'auto' && !hasActiveWebSocket(userId))

    if (shouldSendTelegram) {
      try {
        const message = formatTaskTelegramMessage(task, durationMinutes)
        telegramSent = await sendTelegram(message)
      } catch (err) {
        console.error(`[task-notification] Failed to send Telegram notification for task ${task.id}:`, err)
      }
    }
  }

  return { persisted, telegramSent, broadcastSent }
}
