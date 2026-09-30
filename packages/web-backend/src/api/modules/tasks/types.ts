export interface TaskToolCallTimelineEvent {
  type: 'tool_call'
  timestamp: string | undefined
  toolName: string
  input: string
  output: string
  durationMs: number
  status: 'success' | 'error'
}

export interface TaskMessageTimelineEvent {
  type: 'message'
  timestamp: string
  role: string
  content: string
  metadata: unknown
}

export type TaskTimelineEvent = TaskToolCallTimelineEvent | TaskMessageTimelineEvent

/**
 * Where a timeline reader stands.
 *
 * A task's timeline is merged from two append-only tables (`tool_calls` and
 * `chat_messages`), each with its own `INTEGER PRIMARY KEY AUTOINCREMENT`.
 * Those ids are the only stable, strictly monotone thing in this data:
 *
 *   - both tables are insert-only for a task run (a tool call is written
 *     once, *after* it returned, with its output and duration already in
 *     the INSERT — nothing is updated later);
 *   - `timestamp` has **second** resolution and ties across the two tables
 *     all the time. Live example (task session 5527bf30…): a message and a
 *     tool call both stamped `2026-09-15 14:50:20`. A timestamp cursor
 *     would either re-send that whole second or silently drop one of them.
 *
 * So the cursor is one id per source, not a time.
 */
export interface TaskEventsCursor {
  /** Last `tool_calls.id` the client has seen. 0 = nothing yet. */
  toolCallId: number
  /** Last `chat_messages.id` the client has seen. 0 = nothing yet. */
  messageId: number
}

export const EMPTY_TASK_EVENTS_CURSOR: TaskEventsCursor = { toolCallId: 0, messageId: 0 }
