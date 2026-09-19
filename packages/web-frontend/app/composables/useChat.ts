import { useFeed } from './useFeed'
import { advanceTurn, isTurnActive, type TurnProgress } from '../features/threads/turnProgress'
import { resolveFrameSession } from '../features/threads/frameAssignment'
import type { ArtifactRef } from '~/api/artifacts'
import type { FeedItem } from '~/api/feed'
import { readInteractionAnswers, type InteractionAnswerState } from '@axiom/core/contracts'
import { ApiError } from './useApi'
import {
  applyTaskActivityFrame,
  isTaskActivityFrame,
  type StrandTaskStore,
} from '../features/threads/taskActivity'


export interface ToolCallData {
  toolName: string
  toolCallId: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  /** Client-observed completion; absent on historic rows without duration. */
  completedAt?: string
}

/**
 * One option in a slash-command-driven picker (e.g. /model). When the user
 * clicks the corresponding button the frontend re-sends `command` as a
 * verbatim slash-command, which the backend dispatches through the same
 * registry to produce the next picker (or final confirmation).
 */
export interface ChatPickerOption {
  command: string
  label: string
  description?: string
  badge?: string
}

export interface ChatPicker {
  pickerId: string
  title?: string
  description?: string
  options: ChatPickerOption[]
}

/**
 * A button attached to an interactive chat message (e.g. an email waiting for
 * approval). Clicking posts to `/api/chat/actions/:messageId`; the backend
 * answers with the resolution text that replaces the buttons.
 */
export interface ChatActionButton {
  actionId: string
  label: string
  style?: 'primary' | 'danger'
}

export interface ChatActionMessage {
  messageId: string
  kind: string
  refId: string
  text: string
  actions: ChatActionButton[]
  /** Set once decided (in any channel) — buttons are replaced by this text. */
  resolution?: string
}

export type ChatStallOutcome = 'recovered' | 'aborted'

/**
 * Provider-stall details attached to a stall notice. Mirrors the backend
 * `StallInfo`; `messageId` is the persisted `chat_messages` row id, which is
 * what lets a `stall_resolved` update the already-rendered bubble in place.
 */
export interface ChatStallInfo {
  messageId?: number
  startedAt: string
  resolvedAt?: string
  durationMs: number
  outcome?: ChatStallOutcome
}

/**
 * Auto-retry details attached to a `retry_scheduled` status. Mirrors the
 * backend `RetryInfo`. Live-only: the failed attempt is discarded server-side,
 * so nothing about it survives a reload.
 */
export interface ChatRetryInfo {
  attempt: number
  maxRetries: number
  delayMs: number
  error: string
}

export type ChatTurnErrorCause = 'non_retryable' | 'retry_exhausted' | 'agent_unavailable'

/**
 * Terminal-error details of a failed turn. Mirrors the backend `TurnErrorInfo`;
 * the error is a persisted chat row, so `messageId` matches the live bubble
 * with the one rebuilt from history after a reload.
 */
export interface ChatTurnErrorInfo {
  messageId?: number
  /**
   * Id of the Retry chat action hanging off this error. Sent live and stored
   * on the persisted row, so the button is rebuilt after a page reload.
   */
  retryActionId?: string
  cause: ChatTurnErrorCause
  error: string
  attempts: number
  retryable: boolean
  occurredAt: string
}

export interface ChatAttachment {
  kind: 'image' | 'file'
  originalName: string
  storedName: string
  relativePath: string
  urlPath: string
  mimeType: string
  size: number
  previewUrl?: string
  width?: number
  height?: number
}

export interface ChatMessage {
  artifacts?: ArtifactRef[]
  id?: number
  role: 'user' | 'assistant' | 'system' | 'tool' | 'divider'
  content: string
  timestamp?: string
  streaming?: boolean
  attachments?: ChatAttachment[]
  /** The source channel (for cross-channel messages) */
  source?: 'web' | 'telegram'
  /** Sender display name (for cross-channel messages) */
  senderName?: string
  /** Tool call details (for role=tool) */
  toolData?: ToolCallData
  /** Whether this message was also delivered to Telegram */
  telegramDelivered?: boolean
  /** Whether this is a task injection response */
  isTaskInjection?: boolean
  /** Whether this is a task result notification (system message) */
  isTaskResult?: boolean
  /** Task result display name */
  taskResultName?: string
  /** Task result status: completed, failed, question */
  taskResultStatus?: string
  /** Task duration in minutes */
  taskResultDuration?: number
  /** The id of the task, so the card can fetch the full report on demand */
  taskResultTaskId?: string
  /** True when the visible body is only the preview of a longer report */
  taskResultTruncated?: boolean
  /** Length of the full report in characters */
  taskResultFullLength?: number
  /**
   * Answers to interactive blocks (SPEC 7.4c) carried by THIS message,
   * restored from `chat_messages.metadata` so an answered card still shows
   * its chip after a reload.
   */
  interactionAnswers?: InteractionAnswerState
  /**
   * Whether this is a periodic task-status heartbeat (system message).
   * Rendered as a compact single-line progress row so it does not look
   * like a completed-task card.
   */
  isTaskStatusUpdate?: boolean
  /** Task name for the heartbeat */
  taskStatusUpdateName?: string
  /** How long the task has been running so far, in minutes */
  taskStatusRuntimeMinutes?: number
  /** Number of tool calls the task has made so far */
  taskStatusToolCallCount?: number
  /** Approximate total tokens the task has consumed so far */
  taskStatusTokensUsed?: number
  /**
   * Whether this assistant message is a thinking/reasoning block.
   * Rendered as a separate collapsible card (sparkles icon).
   */
  isThinking?: boolean
  /**
   * Provider-stall details for a `role: 'system'` stall notice. Present both
   * live (from `stall_warning`) and after a reload (from the persisted
   * `provider_stall` row), so the bubble survives a refresh.
   */
  stallInfo?: ChatStallInfo
  /**
   * Terminal provider error for a `role: 'system'` error notice. Present both
   * live (from the `error` chunk) and after a reload (from the persisted
   * `turn_error` row), so the failure never silently disappears.
   */
  errorInfo?: ChatTurnErrorInfo
  /**
   * Excerpt of the message the user replied to (e.g. Telegram reply-to), truncated to 500 chars.
   * When present, the UI renders a WhatsApp/Telegram-style quote bubble above the
   * message body with `[Replying to: "…"]`. Only set for `role: 'user'`.
   */
  replyContext?: string
  /**
   * Interactive picker (button group) attached to a system message.
   * Set on `role: 'system'`. Once the user picks an option we mark the
   * picker as resolved (see `pickerResolvedCommand`) so the buttons are
   * disabled and a single “selected” indicator is shown.
   */
  picker?: ChatPicker
  /** The picker option command the user picked (disables the buttons). */
  pickerResolvedCommand?: string
  /**
   * Interactive action buttons attached to a system message. Once
   * `chatAction.resolution` is set the buttons are replaced by the result,
   * which also happens when another channel decided.
   */
  chatAction?: ChatActionMessage
  /**
   * For `role: 'divider'` messages: the id of the session that ended at
   * this divider. Used to match late-arriving `session_summary` events
   * (from the non-blocking /new flow) to the right divider so its
   * `content` can be filled in in place.
   */
  endedSessionId?: string
}

interface WsMessage {
  feedItem?: FeedItem
  item?: FeedItem
  type: 'feed_item' | 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'system' | 'external_user_message' | 'session_end' | 'session_summary' | 'reminder' | 'task_completed' | 'task_failed' | 'task_question' | 'task_status_update' | 'task_started' | 'task_progress' | 'task_finished' | 'pong' | 'attachment' | 'chat_action' | 'chat_action_resolved' | 'turn_replay_start' | 'turn_replay_end' | 'stall_warning' | 'stall_resolved' | 'retry_scheduled' | 'queued'
  text?: string
  /** Machine-readable error code (for type='error'), e.g. `session_not_found`. */
  code?: string
  /** Position in the global message queue (for type='queued'), 1 = next. */
  position?: number
  /** Provider-stall details (for stall_warning / stall_resolved) */
  stall?: ChatStallInfo
  /** Auto-retry details (for retry_scheduled) */
  retry?: ChatRetryInfo
  /** Terminal-error details of a persisted error row (for type='error') */
  errorInfo?: ChatTurnErrorInfo
  /** Interactive message payload (for chat_action / chat_action_resolved) */
  chatAction?: ChatActionMessage
  /** Picker payload for interactive slash-command replies (e.g. /model). */
  picker?: ChatPicker
  /** Persisted chat row for an attachment frame. */
  messageId?: number
  /** Uploaded file the agent sent for the current turn (for type='attachment') */
  attachment?: ChatAttachment
  /** Thinking delta (for type='thinking') */
  thinking?: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  error?: string
  sessionId?: string
  /**
   * For `session_end`: the id of the session that just ended (sent explicitly
   * by the backend). Used to tag the divider so a late `session_summary` can
   * be matched to it, since the frontend's own `sessionId` is not reliably
   * up to date (not set by normal messages or history load).
   */
  endedSessionId?: string
  /** The source channel */
  source?: string
  /** Sender display name */
  senderName?: string
  /** Excerpt of the message the user replied to (for type='external_user_message') */
  replyContext?: string
  /** Reminder message */
  reminderMessage?: string
  /** Reminder name */
  reminderName?: string
  /** Cronjob ID */
  cronjobId?: string
  /** Whether this message was also delivered to Telegram */
  telegramDelivered?: boolean
  /** Whether this is a task injection response */
  isTaskInjection?: boolean
  /** Task name (for task_completed/task_failed/task_question) */
  taskName?: string
  /** Task summary — the capped preview, not the full report */
  taskSummary?: string
  /** True when `taskSummary` is only a preview */
  taskSummaryTruncated?: boolean
  /** Length of the full report in characters */
  taskSummaryFullLength?: number
  /** Task ID */
  taskId?: string
  /** Task duration in minutes */
  taskDurationMinutes?: number
  /** Human-readable content for task_status_update events */
  taskStatusContent?: string
  /** Task runtime in minutes (task_status_update) */
  taskStatusRuntimeMinutes?: number
  /** Task tool-call count so far (task_status_update) */
  taskStatusToolCallCount?: number
  /** Task tokens consumed so far (task_status_update) */
  taskStatusTokensUsed?: number
  /**
   * Strand activity frames (`task_started` / `task_progress` /
   * `task_finished`): one node of the strand's task tree. `sessionId` is the
   * resolved strand, `taskParentId` the delegating task (null for a task the
   * strand started itself).
   */
  taskParentId?: string | null
  taskStatus?: string
  taskResultStatus?: string | null
  taskTriggerType?: string
  taskError?: string | null
  taskCreatedAt?: string
  taskStartedAt?: string | null
  taskCompletedAt?: string | null
  taskToolCallCount?: number
  /** Persona the frame belongs to. */
  agentId?: string
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

function normalizeReminderText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^⏰\s*/u, '')
    .replace(/^(reminder|erinnerung)\s*:\s*/u, '')
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/g, ' ')
}

function formatReminderContent(name?: string, message?: string): string {
  const trimmedName = name?.trim() ?? ''
  const trimmedMessage = message?.trim() ?? ''

  if (!trimmedName) return trimmedMessage ? `⏰ ${trimmedMessage}` : '⏰'
  if (!trimmedMessage) return `⏰ ${trimmedName}`

  const normalizedName = normalizeReminderText(trimmedName)
  const normalizedMessage = normalizeReminderText(trimmedMessage)

  if (
    normalizedName === normalizedMessage
    || normalizedMessage.includes(normalizedName)
    || normalizedName.includes(normalizedMessage)
  ) {
    return `⏰ ${trimmedMessage}`
  }

  return `⏰ ${trimmedName}\n\n${trimmedMessage}`
}

/**
 * If the last message is a streaming thinking block, mark it as done.
 * Used when a non-thinking chunk (text / tool / done) arrives so the
 * thinking card stops showing the typing indicator.
 */
function closeStreamingThinking(list: ChatMessage[]): ChatMessage[] {
  if (list.length === 0) return list
  const last = list[list.length - 1]!
  if (last.role === 'assistant' && last.isThinking && last.streaming) {
    const updated = [...list]
    updated[updated.length - 1] = { ...last, streaming: false }
    return updated
  }
  return list
}

/**
 * Place the file of an `attachment` frame into the transcript.
 *
 * The live path has to end up with the same picture a reload produces, so the
 * rule follows the row the backend wrote:
 *
 *   - `messageId` set: a background task already persisted its own assistant
 *     row for this file. It gets its own finished bubble carrying that id —
 *     never appended to an older answer that has nothing to do with it.
 *   - no `messageId`: the file belongs to the turn that is streaming right
 *     now, whose row will carry text AND files. So it joins the streaming
 *     bubble, or opens one (still streaming) for the following text chunks.
 *
 * The upload id (`relativePath`) is checked against the whole transcript
 * first: a client that loaded the persisted row and then sees the frame (or
 * sees the frame twice) must render one card, not two.
 */
export function applyAttachmentFrame(
  list: ChatMessage[],
  attachment: ChatAttachment,
  options: { messageId?: number } = {},
): ChatMessage[] {
  const alreadyShown = list.some(m => m.attachments?.some(a => a.relativePath === attachment.relativePath))
  if (alreadyShown) return list

  if (options.messageId === undefined) {
    const lastIdx = list.length - 1
    const last = lastIdx >= 0 ? list[lastIdx]! : null
    if (last && last.role === 'assistant' && !last.isThinking && last.streaming) {
      const updated = [...list]
      updated[lastIdx] = { ...last, attachments: [...(last.attachments ?? []), attachment] }
      return updated
    }
    // Close any open thinking block before inserting the new bubble.
    return [...closeStreamingThinking(list), {
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      streaming: true,
      attachments: [attachment],
    }]
  }

  return [...closeStreamingThinking(list), {
    id: options.messageId,
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    attachments: [attachment],
  }]
}

/**
 * Drop the trailing assistant/tool run so a replayed turn can be rebuilt from
 * scratch. Everything the running turn produced sits after the last user (or
 * system) message, so this removes exactly the partial turn — whether it came
 * from a mid-stream reconnect or from history rows the backend already wrote.
 */
export function stripTrailingTurn(list: ChatMessage[]): ChatMessage[] {
  let end = list.length
  while (end > 0) {
    const message = list[end - 1]!
    // Stall and error notices are emitted as part of the turn, so they belong
    // to the turn being rebuilt — leaving them in place would strand them and
    // block stripping of the assistant/tool run that came before them. The
    // replay re-emits both, so nothing is lost.
    const belongsToTurn = message.role === 'assistant'
      || message.role === 'tool'
      || (message.role === 'system' && (!!message.stallInfo || !!message.errorInfo))
    if (!belongsToTurn) break
    end--
  }
  return end === list.length ? list : list.slice(0, end)
}

/**
 * Drop the assistant/tool output of an attempt the backend discarded before
 * restarting the turn. Unlike {@link stripTrailingTurn} this keeps stall
 * notices: those are persisted rows and remain part of the history.
 */
export function stripFailedAttempt(list: ChatMessage[]): ChatMessage[] {
  const result = [...list]
  for (let i = result.length - 1; i >= 0; i--) {
    const message = result[i]!
    if (message.role === 'assistant' || message.role === 'tool') {
      result.splice(i, 1)
      continue
    }
    if (message.role === 'system' && message.stallInfo) continue
    break
  }
  return result
}

/**
 * Insert or update the stall notice for `stall`. Matching on the persisted row
 * id keeps a single bubble across live warn → resolve, mid-turn replay and a
 * history reload that already rendered the row.
 */
export function upsertStallMessage(list: ChatMessage[], stall: ChatStallInfo, content: string): ChatMessage[] {
  const index = stall.messageId === undefined
    ? -1
    : list.findIndex(m => m.stallInfo?.messageId === stall.messageId)

  if (index >= 0) {
    const updated = [...list]
    updated[index] = { ...updated[index]!, content, stallInfo: stall }
    return updated
  }

  return insertBeforeTrailingStreams(list, {
    id: stall.messageId,
    role: 'system',
    content,
    timestamp: new Date().toISOString(),
    stallInfo: stall,
  })
}

/**
 * Insert or update the terminal-error notice for `info`. Matching on the
 * persisted row id keeps a single bubble when a turn that already failed is
 * replayed on top of a history load.
 */
export function upsertErrorMessage(
  list: ChatMessage[],
  info: ChatTurnErrorInfo,
  content: string,
): ChatMessage[] {
  const index = info.messageId === undefined
    ? -1
    : list.findIndex(m => m.errorInfo?.messageId === info.messageId)

  if (index >= 0) {
    const updated = [...list]
    const existing = updated[index]!
    updated[index] = {
      ...existing,
      content,
      errorInfo: info,
      // Keep an already-resolved retry resolved: a replay must not hand the
      // user a second Retry button for a click the server already answered.
      chatAction: existing.chatAction ?? buildTurnRetryAction(info, content),
    }
    return updated
  }

  return [...list, {
    id: info.messageId,
    role: 'system',
    content,
    timestamp: new Date().toISOString(),
    errorInfo: info,
    chatAction: buildTurnRetryAction(info, content),
  }]
}

/**
 * The Retry button of a terminal error. Resolved server-side against the
 * persisted error row, which is what makes it work after a reload; the label
 * is localized where the bubble is rendered.
 */
export function buildTurnRetryAction(
  info: ChatTurnErrorInfo,
  content: string,
): ChatActionMessage | undefined {
  if (!info.retryActionId || info.messageId === undefined) return undefined
  return {
    messageId: info.retryActionId,
    kind: 'turn_retry',
    refId: String(info.messageId),
    text: content,
    actions: [{ actionId: 'retry', label: 'Retry', style: 'primary' }],
  }
}

/**
 * Rebuild the terminal-error details of a persisted `turn_error` row on a
 * history load, so the error bubble looks exactly like it did live.
 */
export function turnErrorFromHistoryMetadata(metadata: unknown, messageId: number): ChatTurnErrorInfo | null {
  if (!metadata || typeof metadata !== 'object') return null
  const meta = metadata as Record<string, unknown>
  if (meta.kind !== 'turn_error' || typeof meta.error !== 'string') return null

  const cause = meta.cause === 'retry_exhausted' || meta.cause === 'agent_unavailable'
    ? meta.cause
    : 'non_retryable'

  return {
    messageId,
    retryActionId: typeof meta.retryActionId === 'string' ? meta.retryActionId : undefined,
    cause,
    error: meta.error,
    attempts: typeof meta.attempts === 'number' ? meta.attempts : 0,
    retryable: meta.retryable === true,
    occurredAt: typeof meta.occurredAt === 'string' ? meta.occurredAt : '',
  }
}

function insertBeforeTrailingStreams(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  let insertAt = list.length
  while (insertAt > 0 && list[insertAt - 1]?.streaming) {
    insertAt--
  }
  return [...list.slice(0, insertAt), message, ...list.slice(insertAt)]
}

function parseAttachments(metadata?: string): ChatAttachment[] {
  if (!metadata) return []
  try {
    const parsed = JSON.parse(metadata) as { files?: ChatAttachment[] }
    return Array.isArray(parsed.files) ? parsed.files : []
  } catch {
    return []
  }
}

/**
 * Turn state of a single thread (session). Fed by the WebSocket frames of ALL
 * threads, not just the open one, so the inbox can show which thread is
 * currently streaming and which one waits behind it in the global queue.
 */
export type SessionTurnState = 'running' | 'queued'

export interface SessionActivity {
  state: SessionTurnState
  /** Only for `queued`: position in the global message queue. */
  position?: number
}

/** Session-binding failures the backend reports on the `message` frame. */
export const SESSION_ERROR_CODES = ['session_not_found', 'session_agent_mismatch', 'session_forbidden'] as const
export type SessionErrorCode = typeof SESSION_ERROR_CODES[number]

/**
 * The session error code of an `error` frame, or `null` for every other
 * failure (provider errors, connection errors) which stay inline bubbles.
 */
export function sessionErrorCodeOf(frame: { type?: string; code?: string }): SessionErrorCode | null {
  if (frame.type !== 'error') return null
  const code = frame.code
  return (SESSION_ERROR_CODES as readonly string[]).includes(code ?? '')
    ? code as SessionErrorCode
    : null
}

/**
 * True when a frame belongs to a thread other than the one currently open.
 * Such frames must never be appended to the open thread's message list — they
 * only feed the inbox activity signals. Frames without a `sessionId` (and the
 * legacy mode, where no thread is bound) are always treated as ours.
 */
export function isForeignFrame(boundSessionId: string | null, frameSessionId?: string): boolean {
  if (!boundSessionId || !frameSessionId) return false
  return frameSessionId !== boundSessionId
}

/**
 * Fold one WebSocket frame into the per-session turn state map. Returns the
 * same object when nothing changed so watchers don't fire needlessly.
 */
export function applySessionActivity(
  activity: Record<string, SessionActivity>,
  frame: { type?: string; sessionId?: string; position?: number },
): Record<string, SessionActivity> {
  const sid = frame.sessionId
  if (!sid) return activity

  switch (frame.type) {
    case 'queued':
      return { ...activity, [sid]: { state: 'queued', position: frame.position } }
    case 'text':
    case 'thinking':
    case 'tool_call_start':
    case 'turn_replay_start':
      if (activity[sid]?.state === 'running') return activity
      return { ...activity, [sid]: { state: 'running' } }
    case 'done':
    case 'error':
    case 'session_end': {
      if (!activity[sid]) return activity
      const next = { ...activity }
      delete next[sid]
      return next
    }
    default:
      return activity
  }
}

/** One row of `GET /api/chat/history`. */
export interface ChatHistoryRow {
  artifacts?: ArtifactRef[]
  id: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  metadata?: string
  /** ISO-8601 UTC (`2026-09-15T06:15:53.000Z`) since the chronology fix. */
  timestamp: string
  /**
   * Same value as {@link ChatHistoryRow.timestamp}, under the name that states
   * the contract. Absent when talking to a backend from before the fix.
   */
  timestampUtc?: string
  session_id: string
  source?: string | null
  session_type?: string | null
}

/**
 * Rebuild the rendered message list from history rows (oldest first). Lives
 * here rather than in the page so the legacy chat view and a thread view
 * rehydrate identically.
 *
 * Rows are sorted by `id` first. `id` is the insertion order, and it is the
 * only exact one: `timestamp` has second resolution, so several messages per
 * second are normal and any timestamp-based order would be a coin flip between
 * them. This also keeps the transcript stable if a page is ever assembled from
 * two responses.
 */
export function mapHistoryRows(rows: ChatHistoryRow[]): ChatMessage[] {
  return [...rows].sort((a, b) => a.id - b.id).map((m) => {
    // `JSON.parse` yields `any` on purpose here: metadata is a loose grab bag
    // whose shape depends on the row kind, narrowed by the checks below.
    const meta = (() => {
      try { return JSON.parse(m.metadata || '{}') } catch { return {} }
    })()
    const attachments = (Array.isArray(meta.files) ? meta.files : []) as ChatMessage['attachments']
    // Source comes from the joined `sessions.source` column (web/telegram/telegram-group/rest/...).
    // Telegram messages render with a Telegram badge; everything else has no badge.
    const source = (m.source === 'telegram' || m.source === 'telegram-group') ? 'telegram' as const : undefined

    // Reconstruct tool messages with toolData from metadata
    if (m.role === 'tool' && meta.toolName) {
      return {
        id: m.id, role: 'tool' as const, content: m.content, timestamp: m.timestamp, source,
        toolData: { toolName: meta.toolName, toolCallId: meta.toolCallId ?? '', toolArgs: meta.toolArgs, toolResult: meta.toolResult, toolIsError: meta.toolIsError },
      } as ChatMessage
    }

    // Parse system messages with session_divider metadata as dividers.
    // The chat_messages row is inserted with the ended session as
    // `session_id`; tag the divider with `endedSessionId` so a
    // late-arriving `session_summary` event can locate and update
    // it in place after a reload.
    if (m.role === 'system' && meta.type === 'session_divider') {
      return {
        id: m.id, role: 'divider' as const, content: meta.summary ?? '', timestamp: m.timestamp, source,
        endedSessionId: m.session_id,
      } as ChatMessage
    }

    // Parse task result notifications from metadata
    if (m.role === 'system' && meta.type === 'task_result') {
      return {
        id: m.id, role: 'system' as const, content: m.content, timestamp: m.timestamp, source,
        isTaskResult: true,
        taskResultName: meta.taskName ?? 'Background Task',
        taskResultStatus: meta.taskResultStatus ?? meta.taskStatus ?? 'completed',
        taskResultDuration: meta.durationMinutes,
        taskResultTaskId: typeof meta.taskId === 'string' ? meta.taskId : undefined,
        taskResultTruncated: meta.resultTruncated === true,
        taskResultFullLength: typeof meta.resultFullLength === 'number' ? meta.resultFullLength : undefined,
      } as ChatMessage
    }

    // Parse periodic task heartbeat rows — the backend stores a
    // human-readable single-line content plus structured metrics in
    // metadata so we can rehydrate the dedicated progress card on
    // reload instead of falling through to a raw system bubble.
    if (m.role === 'system' && meta.type === 'task_status_update') {
      return {
        id: m.id, role: 'system' as const, content: m.content, timestamp: m.timestamp, source,
        isTaskStatusUpdate: true,
        taskStatusUpdateName: meta.taskName ?? 'Background Task',
        taskStatusRuntimeMinutes: typeof meta.runtimeMinutes === 'number' ? meta.runtimeMinutes : undefined,
        taskStatusToolCallCount: typeof meta.toolCallCount === 'number' ? meta.toolCallCount : undefined,
        taskStatusTokensUsed: typeof meta.totalTokens === 'number' ? meta.totalTokens : undefined,
      } as ChatMessage
    }

    // Provider-stall notices (system rows with metadata.kind ===
    // 'provider_stall'). The row is written when the watchdog warns and
    // updated in place on recovery/abort, so history always reflects the
    // final state — that's what makes the warning survive a refresh.
    if (m.role === 'system' && meta.kind === 'provider_stall') {
      return {
        id: m.id, role: 'system' as const, content: m.content, timestamp: m.timestamp, source,
        stallInfo: {
          messageId: m.id,
          startedAt: meta.startedAt,
          resolvedAt: meta.resolvedAt ?? undefined,
          durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : 0,
          outcome: meta.outcome ?? undefined,
        },
      } as ChatMessage
    }

    // Terminal turn errors (system rows with metadata.kind ===
    // 'turn_error'). Persisted with the full provider error text so the
    // failure — and, later, its retry button — survives a page reload.
    const turnError = m.role === 'system' ? turnErrorFromHistoryMetadata(meta, m.id) : null
    if (turnError) {
      return {
        id: m.id, role: 'system' as const, content: m.content, timestamp: m.timestamp, source,
        errorInfo: turnError,
        // The Retry button is resolved server-side against the persisted
        // row, so it keeps working after this reload.
        chatAction: buildTurnRetryAction(turnError, m.content),
      } as ChatMessage
    }

    // Parse thinking blocks (assistant messages with metadata.kind === 'thinking').
    // Persisted live by ws-chat so they survive a page reload.
    if (m.role === 'assistant' && meta.kind === 'thinking') {
      return {
        id: m.id, role: 'assistant' as const, content: m.content, timestamp: m.timestamp, source,
        isThinking: true,
      } as ChatMessage
    }

    // Parse telegramDelivered and isTaskInjection from metadata
    const base: ChatMessage = { id: m.id, role: m.role, content: m.content, timestamp: m.timestamp, source, attachments, artifacts: m.artifacts }
    if (m.role === 'assistant' && meta.telegramDelivered) {
      base.telegramDelivered = true
    }
    if (meta.type === 'task_injection_response') {
      base.isTaskInjection = true
    }
    // Reply-to context (Telegram reply-to-message) lives in metadata.replyContext
    // so the quote bubble survives a page reload.
    if (m.role === 'user' && typeof meta.replyContext === 'string' && meta.replyContext) {
      base.replyContext = meta.replyContext
    }
    // Answers to interactive blocks (SPEC 7.4c) live in the metadata of the
    // message that carries the block, so an answered card comes back as its
    // chip after a reload instead of offering the buttons again.
    if (m.role === 'assistant') {
      const answers = readInteractionAnswers(meta)
      if (Object.keys(answers).length > 0) base.interactionAnswers = answers
    }
    return base
  })
}

/** Rows per history page when loading a thread (backend caps `limit` at 100). */
const HISTORY_PAGE_LIMIT = 100
/** Safety stop so a huge thread cannot spin the loader forever. */
const HISTORY_MAX_PAGES = 10

// Module-level singletons so multiple useChat() calls share the same WebSocket
let ws: WebSocket | null = null
let connectionOwners = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatInterval: ReturnType<typeof setInterval> | null = null
let pongTimeout: ReturnType<typeof setTimeout> | null = null
/** Current reconnect delay in ms — doubles on each failed attempt (max 30 s) */
let reconnectDelay = 2000
/** Set to true during intentional disconnect (navigation away) to suppress auto-reconnect */
let intentionalDisconnect = false
/** Ensure the global online/visibilitychange listeners are registered only once */
let globalListenersRegistered = false

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
  if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null }
}

function startHeartbeat(wsRef: () => WebSocket | null) {
  stopHeartbeat()
  heartbeatInterval = setInterval(() => {
    const socket = wsRef()
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'ping' }))
    // If no pong arrives within 10 s the connection is silently dead — force close
    pongTimeout = setTimeout(() => { wsRef()?.close() }, 10_000)
  }, 10_000)
}

export function useChat() {
  const feed = useFeed()
  const transcriptRevision = useState<number>('chat_transcript_revision', () => 0)
  const turnProgress = useState<Record<string, TurnProgress>>('chat_turn_progress', () => ({}))
  function updateProgress(sid: string | null, type: string) {
    if (!sid) return
    const next = advanceTurn(turnProgress.value[sid], type, Date.now())
    if (next) turnProgress.value = { ...turnProgress.value, [sid]: next }
  }
  const lastActiveByPersona = useState<Record<string, string>>('chat_last_active_persona', () => ({}))
  const messages = useState<ChatMessage[]>('chat_messages', () => [])
  const connectionStatus = useState<ConnectionStatus>('chat_status', () => 'disconnected')
  const sessionId = useState<string | null>('chat_session_id', () => null)
  const isStreaming = useState<boolean>('chat_streaming', () => false)
  const loadingHistory = useState<boolean>('chat_loading_history', () => false)
  /**
   * The thread this chat view is bound to. `null` = legacy mode: the backend
   * picks the session and we just follow whatever it sends, exactly as before
   * threads existed (Telegram, companion app and the plain /chat page).
   */
  const boundSessionId = useState<string | null>('chat_bound_session_id', () => null)
  const boundAgentId = useState<string | null>('chat_bound_agent_id', () => null)
  /** Queue position of the bound thread while its turn waits, else `null`. */
  const queuePosition = useState<number | null>('chat_queue_position', () => null)
  /** Session-binding failure of the bound thread (user-readable in the view). */
  const sessionError = useState<SessionErrorCode | null>('chat_session_error', () => null)
  /** Turn state per session id, fed by the frames of every thread. */
  const sessionActivity = useState<Record<string, SessionActivity>>('chat_session_activity', () => ({}))
  /**
   * Bumped whenever a frame for another thread arrives. The inbox watches this
   * to refresh itself instead of polling.
   */
  const threadActivity = useState<number>('chat_thread_activity', () => 0)
  /**
   * What works for each strand right now: delegated tasks and their
   * sub-tasks, keyed by strand id. Fed by `task_started` / `task_progress` /
   * `task_finished` frames here and by the REST catch-up in
   * `useStrandTasks`. Kept OUTSIDE the message list on purpose: a task tree
   * is state, not a chat turn.
   */
  const strandTasks = useState<StrandTaskStore>('chat_strand_tasks', () => ({}))

  function connect() {
    const { getAccessToken } = useAuth()
    const config = useRuntimeConfig()
    const token = getAccessToken()

    if (!token) return

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    connectionStatus.value = 'connecting'

    // Register global event listeners once so we reconnect on network recovery
    // or when the browser tab becomes visible again after a long sleep.
    if (!globalListenersRegistered && typeof window !== 'undefined') {
      globalListenersRegistered = true

      window.addEventListener('online', () => {
        if (intentionalDisconnect) return
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          reconnectDelay = 2000 // reset backoff on explicit network recovery
          connect()
        }
      })

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || intentionalDisconnect) return
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          connect()
        }
      })
    }

    // Determine WebSocket URL from API base
    const apiBase = config.public.apiBase as string
    const wsBase = apiBase.replace(/^http/, 'ws')
    ws = new WebSocket(`${wsBase}/ws/chat?token=${encodeURIComponent(token)}`)

    ws.onopen = () => {
      reconnectDelay = 2000 // reset exponential backoff after successful connect
      connectionStatus.value = 'connected'
      startHeartbeat(() => ws)
      void feed.load()

      // Clean up stale streaming messages from before the reconnect.
      // If we lost the connection mid-stream, those messages will never
      // receive a 'done' event, so force them to non-streaming.
      const staleFixed = messages.value.map(m =>
        m.streaming ? { ...m, streaming: false } : m
      )
      if (staleFixed.some((m, i) => m !== messages.value[i])) {
        messages.value = staleFixed
      }
      isStreaming.value = false
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage
        handleWsMessage(msg)
      } catch {
        // ignore parse errors
      }
    }

    ws.onclose = () => {
      stopHeartbeat()
      connectionStatus.value = 'disconnected'
      for (const sid of Object.keys(turnProgress.value)) {
        if (turnProgress.value[sid]?.endedAt === undefined) updateProgress(sid, 'disconnect')
      }
      isStreaming.value = false
      ws = null
      // Only auto-reconnect if this was NOT an intentional disconnect
      // (e.g. navigating away from the chat page)
      if (!intentionalDisconnect) {
        reconnectTimer = setTimeout(() => connect(), reconnectDelay)
        // Exponential backoff: 2 s → 4 s → 8 s → … capped at 30 s
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
      }
      intentionalDisconnect = false
    }

    ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  function handleWsMessage(msg: WsMessage) {
    if (msg.type === 'feed_item') {
      const item = msg.item ?? msg.feedItem
      if (item) feed.receive(item)
      return
    }

    // Connection controls have no strand ownership and never enter history.
    if (msg.type === 'pong') {
      if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null }
      return
    }
    const assignedSession = resolveFrameSession(msg, lastActiveByPersona.value)
    if (!assignedSession) return
    if (msg.sessionId && msg.agentId) {
      lastActiveByPersona.value = { ...lastActiveByPersona.value, [msg.agentId]: msg.sessionId }
    }
    msg = { ...msg, sessionId: assignedSession }
    sessionActivity.value = applySessionActivity(sessionActivity.value, msg)

    // Strand activity frames are state for the activity panel, never chat
    // rows — and they are folded in BEFORE the foreign-frame guard, because a
    // frame for another strand still belongs in that strand's tree (the panel
    // reads its own strand's slice). A frame without sessionId/taskId is
    // dropped inside the reducer instead of being attributed to the open
    // strand.
    if (isTaskActivityFrame(msg)) {
      strandTasks.value = applyTaskActivityFrame(strandTasks.value, msg)
      if (msg.sessionId && msg.sessionId !== boundSessionId.value) threadActivity.value++
      return
    }

    updateProgress(assignedSession, msg.type)

    // A frame of another thread must not land in the open thread's message
    // list. It only bumps the activity signal so the inbox can refresh.
    if (isForeignFrame(boundSessionId.value, msg.sessionId)) {
      threadActivity.value++
      return
    }

    transcriptRevision.value++
    if (isTurnActive(turnProgress.value[assignedSession])) isStreaming.value = true

    // Binding failures are not chat content: the thread cannot be opened at
    // all, so the view shows a dedicated error state with a way back.
    const sessionErr = sessionErrorCodeOf(msg)
    if (sessionErr) {
      sessionError.value = sessionErr
      queuePosition.value = null
      isStreaming.value = false
      messages.value = messages.value.map(m => (m.streaming ? { ...m, streaming: false } : m))
      return
    }

    // Any turn output clears a pending queue notice.
    if (msg.type === 'text' || msg.type === 'thinking' || msg.type === 'tool_call_start' || msg.type === 'done' || msg.type === 'error') {
      queuePosition.value = null
    }

    switch (msg.type) {
      case 'queued':
        // The global message queue is busy; the turn of this thread starts
        // once the ones before it finished.
        queuePosition.value = typeof msg.position === 'number' ? msg.position : null
        break

      case 'system':
        if (msg.sessionId) {
          sessionId.value = msg.sessionId
        }
        if (msg.picker) {
          // Interactive slash-command reply. Always rendered — the frontend
          // shows title + description (msg.text fallback) above the buttons.
          messages.value = [...messages.value, {
            role: 'system',
            content: msg.text ?? '',
            timestamp: new Date().toISOString(),
            picker: msg.picker,
          }]
        } else if (msg.text && msg.text !== 'Authenticated') {
          // Show system messages (like session reset)
          messages.value = [...messages.value, {
            role: 'system',
            content: msg.text,
            timestamp: new Date().toISOString(),
          }]
        }
        isStreaming.value = false
        break

      case 'session_end': {
        // Prefer the ended session id the backend sent explicitly
        // (`clientSessions`-backed, reliable across reloads). Fall back to
        // our own tracked sessionId only if absent, then mutate
        // sessionId.value. The divider is tagged with this so a later
        // `session_summary` event can be matched against it.
        const endedSessionId = msg.endedSessionId ?? sessionId.value ?? undefined
        if (msg.sessionId) {
          sessionId.value = msg.sessionId
        }
        // Add a divider with optional summary to the chat
        messages.value = [...messages.value, {
          role: 'divider',
          content: msg.text ?? '',
          timestamp: new Date().toISOString(),
          endedSessionId,
        }]
        isStreaming.value = false
        break
      }

      case 'session_summary': {
        // Late-arriving summary for a session that was ended
        // non-blockingly via /new. Find the matching divider (by
        // endedSessionId) and fill in its content in place, so the
        // user sees the same divider expand from "— New Session —" to
        // include the collapsible summary card without spawning a new
        // divider. Falls back to appending a divider if no match exists
        // (e.g. another browser tab that never received the immediate
        // session_end).
        if (!msg.text) break
        const list = messages.value
        let realIdx = -1
        if (msg.sessionId) {
          for (let k = list.length - 1; k >= 0; k--) {
            const m = list[k]
            if (m && m.role === 'divider' && m.endedSessionId === msg.sessionId) {
              realIdx = k
              break
            }
          }
        }
        if (realIdx >= 0) {
          const updated = [...list]
          const target = updated[realIdx]
          if (target) {
            updated[realIdx] = { ...target, content: msg.text }
            messages.value = updated
          }
        } else {
          messages.value = [...list, {
            role: 'divider',
            content: msg.text,
            timestamp: new Date().toISOString(),
            endedSessionId: msg.sessionId,
          }]
        }
        break
      }

      case 'external_user_message':
        // A message from another channel (e.g. Telegram) for the same user
        if (msg.text) {
          messages.value = [...messages.value, {
            role: 'user',
            content: msg.text,
            timestamp: new Date().toISOString(),
            source: (msg.source as 'web' | 'telegram') ?? undefined,
            senderName: msg.senderName,
            replyContext: msg.replyContext,
          }]
        }
        break

      case 'reminder': {
        const reminderContent = formatReminderContent(msg.reminderName, msg.reminderMessage)

        if (reminderContent) {
          messages.value = [...messages.value, {
            role: 'system',
            content: reminderContent,
            timestamp: new Date().toISOString(),
          }]

          if (
            typeof window !== 'undefined'
            && typeof Notification !== 'undefined'
            && document.visibilityState !== 'visible'
            && Notification.permission === 'granted'
          ) {
            new Notification(msg.reminderName || 'Reminder', {
              body: msg.reminderMessage,
            })
          }
        }
        break
      }

      case 'task_completed':
      case 'task_failed':
      case 'task_question': {
        const emoji = msg.type === 'task_completed' ? '✅' : msg.type === 'task_failed' ? '❌' : '❓'
        const statusLabel = msg.type.replace('task_', '')
        // `taskSummary` is the capped preview the backend persisted, not the
        // full report: the live card and the reloaded card show the same
        // three lines, and the rest is fetched from /api/tasks/:id on demand.
        const content = `${emoji} Task ${statusLabel}: ${msg.taskName ?? 'Unknown'}\n\n${msg.taskSummary ?? msg.text ?? 'No summary available.'}`
        messages.value = [...messages.value, {
          role: 'system',
          content,
          timestamp: new Date().toISOString(),
          isTaskResult: true,
          taskResultName: msg.taskName ?? 'Background Task',
          taskResultStatus: statusLabel,
          taskResultDuration: msg.taskDurationMinutes,
          taskResultTaskId: msg.taskId,
          taskResultTruncated: msg.taskSummaryTruncated === true,
          taskResultFullLength: msg.taskSummaryFullLength,
        }]
        break
      }

      case 'task_status_update': {
        // Ephemeral heartbeat from a running background task. Rendered as a
        // compact single-line progress row; distinct from task_result cards
        // because the task is still in progress.
        const taskName = msg.taskName ?? 'Background Task'
        const content = msg.taskStatusContent ?? `⏱ Task running: ${taskName}`
        messages.value = insertBeforeTrailingStreams(messages.value, {
          role: 'system',
          content,
          timestamp: new Date().toISOString(),
          isTaskStatusUpdate: true,
          taskStatusUpdateName: taskName,
          taskStatusRuntimeMinutes: msg.taskStatusRuntimeMinutes,
          taskStatusToolCallCount: msg.taskStatusToolCallCount,
          taskStatusTokensUsed: msg.taskStatusTokensUsed,
        })
        break
      }

      case 'text':
        if (msg.text) {
          const lastMsg = messages.value[messages.value.length - 1]
          if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isThinking && lastMsg.streaming) {
            // Append to existing streaming message (but not to a thinking block)
            const updated = [...messages.value]
            updated[updated.length - 1] = {
              ...lastMsg,
              content: lastMsg.content + msg.text,
              isTaskInjection: lastMsg.isTaskInjection || msg.isTaskInjection,
            }
            messages.value = updated
          } else {
            // Close any streaming thinking block and start new assistant message
            const closed = closeStreamingThinking(messages.value)
            messages.value = [...closed, {
              role: 'assistant',
              content: msg.text,
              timestamp: new Date().toISOString(),
              streaming: true,
              isTaskInjection: msg.isTaskInjection,
            }]
          }
          isStreaming.value = true
        }
        break

      case 'thinking':
        if (msg.thinking) {
          const lastMsg = messages.value[messages.value.length - 1]
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isThinking && lastMsg.streaming) {
            // Append to existing streaming thinking block
            const updated = [...messages.value]
            updated[updated.length - 1] = {
              ...lastMsg,
              content: lastMsg.content + msg.thinking,
            }
            messages.value = updated
          } else {
            // Start a new streaming thinking block (close any open non-thinking stream)
            messages.value = [...messages.value, {
              role: 'assistant',
              content: msg.thinking,
              timestamp: new Date().toISOString(),
              streaming: true,
              isThinking: true,
            }]
          }
          isStreaming.value = true
        }
        break

      case 'done':
        // Mark all trailing streaming messages (text + thinking) as done.
        // A turn can end with a thinking block still streaming if the model
        // emitted thinking without follow-up text (rare but possible).
        if (messages.value.length > 0) {
          const updated = [...messages.value]
          for (let i = updated.length - 1; i >= 0; i--) {
            const m = updated[i]!
            if (!m.streaming) break
            updated[i] = {
              ...m,
              streaming: false,
              telegramDelivered: m.isThinking ? m.telegramDelivered : (msg.telegramDelivered || m.telegramDelivered),
              isTaskInjection: m.isThinking ? m.isTaskInjection : (msg.isTaskInjection || m.isTaskInjection),
            }
          }
          messages.value = updated
        }
        isStreaming.value = false
        // Persisted rows carry artifact refs and interaction message ids. Do
        // not replace a newer turn/navigation with a late catch-up response.
        if (boundSessionId.value) void loadThreadHistory(boundSessionId.value).catch(() => {})
        break

      case 'error': {
        // Clear streaming flag on the last message so it doesn't stay
        // stuck with a loading indicator forever
        const updatedOnError = [...messages.value]
        const lastOnError = updatedOnError[updatedOnError.length - 1]
        if (lastOnError && lastOnError.streaming) {
          updatedOnError[updatedOnError.length - 1] = { ...lastOnError, streaming: false }
        }
        if (msg.errorInfo) {
          // A terminal turn failure: the backend persisted it as a chat row and
          // sent the very text it stored, so the bubble is identical after a
          // reload. Connection-level errors (no `errorInfo`) stay ephemeral.
          messages.value = upsertErrorMessage(
            updatedOnError,
            msg.errorInfo,
            msg.text ?? `Error: ${msg.error}`,
          )
        } else {
          updatedOnError.push({
            role: 'system',
            content: `Error: ${msg.error}`,
            timestamp: new Date().toISOString(),
          })
          messages.value = updatedOnError
        }
        isStreaming.value = false
        break
      }

      case 'tool_call_start':
        if (msg.toolName) {
          // A tool call also ends any in-flight thinking block.
          const closed = closeStreamingThinking(messages.value)
          messages.value = [...closed, {
            role: 'tool',
            content: `Tool: ${msg.toolName}`,
            timestamp: new Date().toISOString(),
            toolData: {
              toolName: msg.toolName,
              toolCallId: msg.toolCallId ?? '',
              toolArgs: msg.toolArgs,
            },
          }]
        }
        break

      case 'chat_action':
        if (msg.chatAction) {
          messages.value = [...messages.value, {
            role: 'system',
            content: msg.chatAction.text,
            timestamp: new Date().toISOString(),
            chatAction: msg.chatAction,
          }]
        }
        break

      case 'chat_action_resolved':
        // A decision arrived (this tab, another tab, the web UI or Telegram) —
        // swap the buttons for the result.
        if (msg.chatAction) applyChatActionResolution(msg.chatAction.messageId, msg.chatAction.resolution)
        break

      case 'stall_warning':
      case 'stall_resolved':
        // The provider went silent (or came back). The notice is a persisted
        // chat row, so this only mirrors it into the live view; the same row
        // is rebuilt from history after a reload.
        // The backend sends the same text it persisted on the row, so live
        // rendering and a history reload never disagree.
        if (msg.stall) messages.value = upsertStallMessage(messages.value, msg.stall, msg.text ?? '')
        break

      case 'retry_scheduled':
        // The provider failed with a transient error; the backend discarded the
        // failed attempt and restarts the turn after a backoff. Drop the partial
        // answer here too so the retried turn does not stack on top of garbage.
        if (msg.retry) {
          const retry = msg.retry
          messages.value = [...stripFailedAttempt(messages.value), {
            role: 'system',
            content: msg.text ?? `Retrying (${retry.attempt}/${retry.maxRetries})…`,
            timestamp: new Date().toISOString(),
          }]
          isStreaming.value = true
        }
        break

      case 'turn_replay_start':
        // The backend is about to replay a turn that is still running (or just
        // finished) server-side. Discard whatever partial turn we currently
        // show — from a mid-stream reconnect or from history — so the replayed
        // chunks rebuild it exactly once.
        if (msg.sessionId) sessionId.value = msg.sessionId
        messages.value = stripTrailingTurn(messages.value)
        isStreaming.value = true
        break

      case 'turn_replay_end':
        // Buffer drained; live chunks follow (or the turn already ended, in
        // which case the replayed `done` already cleared the indicator).
        break

      case 'attachment':
        // A file the agent sent (via the `send_file_to_user` tool), either
        // from the running turn or from a background task that already
        // persisted its own row. `applyAttachmentFrame` owns the placement.
        if (msg.attachment) {
          messages.value = applyAttachmentFrame(messages.value, msg.attachment, { messageId: msg.messageId })
        }
        break

      case 'tool_call_end':
        if (msg.toolCallId) {
          const updated = [...messages.value]
          const toolMsgIdx = updated.findLastIndex(
            m => m.role === 'tool' && m.toolData?.toolCallId === msg.toolCallId
          )
          const existingMsg = toolMsgIdx !== -1 ? updated[toolMsgIdx] : undefined
          if (existingMsg) {
            updated[toolMsgIdx] = {
              ...existingMsg,
              toolData: {
                ...existingMsg.toolData!,
                toolResult: msg.toolResult,
                toolIsError: msg.toolIsError,
                completedAt: new Date().toISOString(),
              },
            }
            messages.value = updated
          }
        }
        break
    }
    if (turnProgress.value[assignedSession]?.phase === 'aborted') {
      isStreaming.value = false
      messages.value = messages.value.map(m => m.streaming ? { ...m, streaming: false } : m)
    }
  }

  /**
   * Load the transcript of one thread, oldest first. Uses the cursor mode of
   * `GET /api/chat/history` (`since_id`), which returns ascending pages, so a
   * long thread is fetched page by page instead of truncated to the newest 50.
   */
  async function loadThreadHistory(threadSessionId: string) {
    const { apiFetch } = useApi()
    const revision = transcriptRevision.value
    const rows: ChatHistoryRow[] = []
    let sinceId = 0

    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const query = new URLSearchParams({
        session_id: threadSessionId,
        since_id: String(sinceId),
        limit: String(HISTORY_PAGE_LIMIT),
      })
      const data = await apiFetch<{ messages?: ChatHistoryRow[] }>(`/api/chat/history?${query.toString()}`)
      const batch = data.messages ?? []
      rows.push(...batch)
      if (batch.length < HISTORY_PAGE_LIMIT) break
      sinceId = batch[batch.length - 1]!.id
    }

    if (boundSessionId.value === threadSessionId && transcriptRevision.value === revision) {
      const observed = new Map(messages.value.filter(m => m.toolData?.completedAt).map(m => [m.toolData!.toolCallId, m]))
      messages.value = mapHistoryRows(rows).map(message => {
        const live = message.toolData ? observed.get(message.toolData.toolCallId) : undefined
        return live ? { ...message, timestamp: live.timestamp, toolData: { ...message.toolData!, completedAt: live.toolData!.completedAt } } : message
      })
    }
  }

  /**
   * Legacy history load: the newest page across all sessions of this user,
   * exactly what the chat page did before threads existed.
   */
  async function loadRecentHistory(limit = 50) {
    const { apiFetch } = useApi()
    loadingHistory.value = true
    try {
      const data = await apiFetch<{ messages?: ChatHistoryRow[] }>(`/api/chat/history?limit=${limit}`)
      const rows = data.messages ?? []
      if (rows.length) messages.value = mapHistoryRows([...rows].reverse())
    } finally {
      loadingHistory.value = false
    }
  }

  /**
   * Bind the chat to one thread: every send carries its `sessionId`, frames of
   * other threads are ignored, and the transcript is (re)loaded from history.
   */
  async function openThread(threadSessionId: string, agentId?: string | null) {
    transcriptRevision.value++
    boundSessionId.value = threadSessionId
    boundAgentId.value = agentId ?? null
    if (agentId) lastActiveByPersona.value = { ...lastActiveByPersona.value, [agentId]: threadSessionId }
    sessionId.value = threadSessionId
    sessionError.value = null
    queuePosition.value = sessionActivity.value[threadSessionId]?.position ?? null
    isStreaming.value = isTurnActive(turnProgress.value[threadSessionId])
    messages.value = []
    loadingHistory.value = true
    try {
      await loadThreadHistory(threadSessionId)
    } finally {
      if (boundSessionId.value === threadSessionId) loadingHistory.value = false
    }
  }

  /** Drop the thread binding (back to the inbox) and clear its transcript. */
  function leaveThread() {
    boundSessionId.value = null
    boundAgentId.value = null
    queuePosition.value = null
    sessionError.value = null
    messages.value = []
  }

  async function sendMessage(content: string, files: File[] = []) {
    const trimmed = content.trim()
    if (!trimmed && files.length === 0) return
    transcriptRevision.value++

    if (files.length > 0) {
      const { apiFetch } = useApi()
      const formData = new FormData()
      formData.append('content', trimmed)
      // Explicit thread binding: the backend activates exactly this session
      // instead of resolving one heuristically.
      if (boundSessionId.value) formData.append('sessionId', boundSessionId.value)
      if (boundAgentId.value) formData.append('agentId', boundAgentId.value)
      for (const file of files) formData.append('files', file)

      const response = await apiFetch<{ message: { session_id: string; role: 'user'; content: string; metadata?: string; timestamp: string } }>('/api/chat/message', {
        method: 'POST',
        body: formData as unknown as BodyInit,
      })

      const attachments = parseAttachments(response.message.metadata)
      messages.value = [...messages.value, {
        role: 'user',
        content: response.message.content,
        timestamp: response.message.timestamp,
        attachments,
      }]

      // Trigger the agent via WebSocket (message already saved by HTTP route)
      if (ws && ws.readyState === WebSocket.OPEN) {
        updateProgress(boundSessionId.value, 'send')
        isStreaming.value = true
        ws.send(JSON.stringify({ type: 'message', content: response.message.content, skipSave: true, attachments, ...threadFields() }))
      }
      return
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!trimmed) return

    messages.value = [...messages.value, {
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    }]

    updateProgress(boundSessionId.value, 'send')
    isStreaming.value = true
    ws.send(JSON.stringify({ type: 'message', content: trimmed, ...threadFields() }))
  }

  /**
   * The thread-binding fields added to outgoing frames. Empty in legacy mode,
   * which keeps the old server-side session resolution untouched.
   */
  function threadFields(): { sessionId?: string; agentId?: string } {
    const fields: { sessionId?: string; agentId?: string } = {}
    if (boundSessionId.value) fields.sessionId = boundSessionId.value
    if (boundAgentId.value) fields.agentId = boundAgentId.value
    if (fields.agentId && fields.sessionId) lastActiveByPersona.value = { ...lastActiveByPersona.value, [fields.agentId]: fields.sessionId }
    return fields
  }

  function sendCommand(command: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'command', content: `/${command}`, ...threadFields() }))
  }

  /**
   * Send a verbatim slash command (must include the leading `/`). Used by
   * picker buttons that already carry a fully-formed command from the
   * backend, e.g. `/model <providerId> <modelId>`.
   */
  function sendRawCommand(command: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!command.startsWith('/')) return
    ws.send(JSON.stringify({ type: 'command', content: command, ...threadFields() }))
  }

  /**
   * Mark a picker message as resolved (button clicked). Disables the buttons
   * and records which option fired so the UI can highlight it.
   */
  function resolvePicker(messageIndex: number, command: string) {
    const list = messages.value
    const target = list[messageIndex]
    if (!target || !target.picker || target.pickerResolvedCommand) return
    const updated = [...list]
    updated[messageIndex] = { ...target, pickerResolvedCommand: command }
    messages.value = updated
    sendRawCommand(command)
  }

  function applyChatActionResolution(messageId: string, resolution?: string) {
    const list = messages.value
    const index = list.findIndex(m => m.chatAction?.messageId === messageId)
    if (index < 0) return
    const target = list[index]!
    const updated = [...list]
    updated[index] = { ...target, chatAction: { ...target.chatAction!, resolution } }
    messages.value = updated
  }

  /**
   * Answer an interactive chat message button. The backend owns the decision
   * (including first-action-wins), so a losing click still gets a resolution
   * text back and the buttons disappear.
   */
  async function submitChatAction(messageId: string, actionId: string) {
    const { apiFetch } = useApi()
    try {
      const response = await apiFetch<{ status: string; resolution: string }>(
        `/api/chat/actions/${encodeURIComponent(messageId)}`,
        { method: 'POST', body: JSON.stringify({ actionId }) },
      )
      applyChatActionResolution(messageId, response.resolution)
    } catch (err) {
      // Only a client-side rejection is final (stale button, lost race, a button
      // minted before a restart): the server answered and its text replaces the
      // buttons — for a lost race the broadcast carries the same text.
      // Everything else (offline, expired session, 5xx) left the decision
      // unmade, so the buttons stay clickable for another attempt.
      const status = err instanceof ApiError ? err.status : null
      if (status === null || status === 401 || status >= 500) {
        console.error('[chat] action failed:', err)
        return
      }
      applyChatActionResolution(messageId, (err as Error).message)
    }
  }

  function newSession() {
    sendCommand('new')
  }

  function stopTask() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    sendCommand('stop')
    // Existing backend /stop aborts this user's turns, not just the open
    // strand. The UI labels this scope explicitly. No done frame is required.
    for (const sid of Object.keys(turnProgress.value)) {
      if (turnProgress.value[sid]?.endedAt === undefined) updateProgress(sid, 'stop')
    }
    sessionActivity.value = {}
    queuePosition.value = null
    isStreaming.value = false
    messages.value = messages.value.map(m => m.streaming ? { ...m, streaming: false } : m)
  }

  function retainConnection() {
    connectionOwners++
    connect()
    let released = false
    return () => {
      if (released) return
      released = true
      connectionOwners--
      if (connectionOwners === 0) {
        disconnect()
        feed.reset()
      }
    }
  }

  function disconnect() {
    if (connectionOwners > 0) return
    intentionalDisconnect = true
    stopHeartbeat()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.close()
      ws = null
    }
    connectionStatus.value = 'disconnected'
  }

  function clearMessages() {
    messages.value = []
  }

  return {
    messages,
    connectionStatus,
    sessionId,
    isStreaming,
    loadingHistory,
    boundSessionId,
    boundAgentId,
    queuePosition,
    sessionError,
    sessionActivity,
    threadActivity,
    strandTasks,
    turnProgress,
    connect,
    disconnect,
    retainConnection,
    sendMessage,
    sendRawCommand,
    resolvePicker,
    submitChatAction,
    newSession,
    stopTask,
    clearMessages,
    openThread,
    leaveThread,
    loadRecentHistory,
  }
}
