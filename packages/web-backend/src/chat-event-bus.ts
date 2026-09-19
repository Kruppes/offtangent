import { EventEmitter } from 'node:events'
import type { Capture, Decision, FeedItem, RetryInfo, StallInfo, StrandProjectSuggestion, TurnErrorInfo, UploadDescriptor } from '@axiom/core'
import type { ChatActionMessage } from './chat-actions.js'

/**
 * A chat event emitted when messages flow through any channel (web, telegram).
 * Used to synchronize chat state across connected clients.
 */
export interface ChatEvent {
  /** The kind of event being broadcast */
  type: 'turn_queued' | 'user_message' | 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'done' | 'error' | 'system' | 'session_end' | 'session_summary' | 'task_completed' | 'task_failed' | 'task_question' | 'task_status_update' | 'task_started' | 'task_progress' | 'task_finished' | 'reminder' | 'attachment' | 'chat_action' | 'chat_action_resolved' | 'stall_warning' | 'stall_resolved' | 'retry_scheduled' | 'capture_routed' | 'capture_needs_review' | 'now_set_changed' | 'feed_item' | 'strand_project_changed'
  /** The Axiom user ID (integer) this event belongs to */
  userId: number
  /** Where the event originated */
  source: 'web' | 'telegram' | 'task'
  /** Opaque ID of the originating connection (to avoid echo) */
  sourceConnectionId?: string
  /** Chat session ID */
  sessionId?: string
  /**
   * Fork multi-persona: persona the event belongs to (`user_message`,
   * `session_end`, `session_summary`). Optional; absent means 'main' or
   * "not persona-scoped" (task/reminder events carry their own ids).
   */
  agentId?: string
  /** Text content (for user_message, text, system, error) */
  text?: string
  /** Thinking delta (for type='thinking') */
  thinking?: string
  /** Tool name (for tool_call_start, tool_call_end) */
  toolName?: string
  /** Tool call ID */
  toolCallId?: string
  /** Tool arguments */
  toolArgs?: unknown
  /** Tool result */
  toolResult?: unknown
  /** Whether the tool call errored */
  toolIsError?: boolean
  /** Error description */
  error?: string
  /** Terminal-error details of a persisted error row (for `error`) */
  errorInfo?: TurnErrorInfo
  /** Provider-stall details (for `stall_warning` / `stall_resolved`) */
  stall?: StallInfo
  /** Auto-retry details (for `retry_scheduled`) */
  retry?: RetryInfo
  /** Display name of the sender (e.g. Telegram username) */
  senderName?: string
  /** Task ID (for task_completed, task_failed, task_question events) */
  taskId?: string
  /** Task name (for task events) */
  taskName?: string
  /** Task result summary (for task events) — the capped preview, not the full report */
  taskSummary?: string
  /** True when `taskSummary` is only the preview of a longer report */
  taskSummaryTruncated?: boolean
  /** Length of the full report in characters */
  taskSummaryFullLength?: number
  /** Task duration in minutes (for task events) */
  taskDurationMinutes?: number
  /** Total tokens used by the task (for task events) */
  taskTokensUsed?: number
  /** Task trigger type (user, agent, cronjob) */
  taskTriggerType?: string
  /**
   * Strand activity frames (`task_started` / `task_progress` /
   * `task_finished`). `sessionId` carries the resolved strand — a frame
   * without one is never broadcast (see `buildTaskActivityFrame`).
   */
  taskParentId?: string | null
  /** Task lifecycle status: running | paused | completed | failed. */
  taskStatus?: string
  /** Result status of a finished task: completed | failed | question | silent. */
  taskResultStatus?: string | null
  /** Failure reason, kept visible so a failed task does not vanish silently. */
  taskError?: string | null
  /** `tasks.created_at` (UTC, "YYYY-MM-DD HH:MM:SS"). */
  taskCreatedAt?: string
  /** `tasks.started_at`, null while queued. */
  taskStartedAt?: string | null
  /** `tasks.completed_at`, null while it runs. */
  taskCompletedAt?: string | null
  /** Tool calls the task has made so far. */
  taskToolCallCount?: number
  /**
   * Live usage of the task at the moment the frame was built, mirrored from
   * the `tasks` row (`prompt_tokens`, `completion_tokens`, `cache_read`,
   * `cache_write`, `estimated_cost`). Present on `task_started` /
   * `task_progress` / `task_finished`.
   */
  taskPromptTokens?: number
  taskCompletionTokens?: number
  taskCacheRead?: number
  taskCacheWrite?: number
  /** Accumulated cost in USD. */
  taskEstimatedCost?: number
  /**
   * Human-readable single-line summary for `task_status_update` events
   * (also the value persisted in `chat_messages.content`). Live clients
   * render this verbatim so a page reload + live rendering match.
   */
  taskStatusContent?: string
  /** How long the task has been running, in minutes. */
  taskStatusRuntimeMinutes?: number
  /** Number of tool calls the task has made so far. */
  taskStatusToolCallCount?: number
  /** Approximate total tokens consumed by the task so far. */
  taskStatusTokensUsed?: number
  /** Reminder message (for reminder events) */
  reminderMessage?: string
  /** Reminder/cronjob name (for reminder events) */
  reminderName?: string
  /** Cronjob ID (for reminder events) */
  cronjobId?: string
  /** Whether this message was also delivered to Telegram */
  telegramDelivered?: boolean
  /** Whether this event is part of a task injection response */
  isTaskInjection?: boolean
  /** Uploaded file attached to the current assistant turn (for type='attachment') */
  attachment?: UploadDescriptor
  /**
   * `chat_messages` row this event's file already lives on (for
   * `type: 'attachment'`). Set when the file was persisted BEFORE the frame
   * went out — a background task writes its own assistant row — so a client
   * renders it as that row instead of appending the card to the last answer.
   * Absent for a file of the running turn, whose row is written when the turn
   * ends.
   */
  messageId?: number
  /**
   * Excerpt of the message the user replied to (e.g. in Telegram), truncated to 500 chars.
   * Forwarded to web clients so they can render a quote bubble above the user message.
   * Only set for `type: 'user_message'`.
   */
  replyContext?: string
  /** Interactive message with action buttons (for chat_action* events) */
  chatAction?: ChatActionMessage
  /**
   * Plan 2026-09-19 (D4), `turn_queued`: 1-based place of a turn that has to
   * wait, and the turn of the same persona that blocks it. Only broadcast for
   * `position >= 2`; `blockedBy.title` is null when the strand has no title
   * (or is not the user's). Clients clear the notice on the first turn frame
   * of the strand, or on `done`/`error`.
   */
  position?: number
  blockedBy?: { agentId: string; sessionId: string | null; title: string | null } | null
  /** Offtangent (SPEC 6.6): the capture and its decision for `capture_routed` / `capture_needs_review`. */
  capture?: Capture
  decision?: Decision
  /** Offtangent: the now set after a change, ordered by rank (for `now_set_changed`). */
  strandIds?: string[]
  /** Offtangent (SPEC 2.9, 6.6): the feed item that was just appended (for `feed_item`). */
  feedItem?: FeedItem
  /**
   * Offtangent Stufe 2 (`strand_project_changed`): the running assignment
   * either filed the strand (`projectId` set, suggestion null) or produced a
   * proposal (`projectId` null, `projectSuggestion` set). `sessionId` names
   * the strand. Additive frame: a client that does not know it ignores it.
   */
  projectId?: string | null
  projectSuggestion?: StrandProjectSuggestion | null
}

/**
 * Simple event bus for broadcasting chat events across channels.
 * Both ws-chat and telegram emit into this bus; ws-chat subscribes
 * to forward events to the appropriate WebSocket clients.
 */
export class ChatEventBus extends EventEmitter {
  /**
   * Broadcast a chat event to all subscribers.
   */
  broadcast(msg: ChatEvent): void {
    super.emit('chat', msg)
  }

  /**
   * Subscribe to chat events. Returns an unsubscribe function.
   */
  subscribe(handler: (msg: ChatEvent) => void): () => void {
    super.on('chat', handler)
    return () => { super.off('chat', handler) }
  }
}
