import { EventEmitter } from 'node:events'

/**
 * Event types emitted during task execution
 */
export type TaskEventType =
  | 'tool_call_start'
  | 'tool_call_end'
  | 'text_delta'
  | 'status_change'

export interface TaskEvent {
  /** The type of event */
  type: TaskEventType
  /** Task ID this event belongs to */
  taskId: string
  /** ISO timestamp */
  timestamp: string
  /** Tool name (for tool_call_start, tool_call_end) */
  toolName?: string
  /** Tool call ID */
  toolCallId?: string
  /** Tool arguments (for tool_call_start) */
  toolArgs?: unknown
  /** Tool result (for tool_call_end) */
  toolResult?: unknown
  /** Whether the tool call errored (for tool_call_end) */
  toolIsError?: boolean
  /** Duration in ms (for tool_call_end) */
  durationMs?: number
  /** Text content (for text_delta) */
  text?: string
  /** New task status (for status_change) */
  status?: string
  /** Additional info for status changes (e.g. error message, summary) */
  statusMessage?: string
}

/**
 * Event bus for streaming task execution events.
 * The TaskRunner emits events here; WebSocket endpoints subscribe per task ID.
 */
export class TaskEventBus extends EventEmitter {
  /** Recent events per task (backlog for late joiners) */
  private taskBacklogs: Map<string, TaskEvent[]> = new Map()
  /** Max events to keep in backlog per task */
  private maxBacklogSize = 1000

  /**
   * Emit a task event
   */
  emitTaskEvent(event: TaskEvent): void {
    // Store in backlog
    let backlog = this.taskBacklogs.get(event.taskId)
    if (!backlog) {
      backlog = []
      this.taskBacklogs.set(event.taskId, backlog)
    }
    backlog.push(event)

    // Trim backlog if too large
    if (backlog.length > this.maxBacklogSize) {
      backlog.splice(0, backlog.length - this.maxBacklogSize)
    }

    // Emit on task-specific channel
    super.emit(`task:${event.taskId}`, event)
  }

  /**
   * Subscribe to events for a specific task.
   * Returns an unsubscribe function.
   */
  subscribeToTask(taskId: string, handler: (event: TaskEvent) => void): () => void {
    const channel = `task:${taskId}`
    super.on(channel, handler)
    return () => { super.off(channel, handler) }
  }

  /**
   * Get the backlog of events for a task (for late joiners).
   */
  getBacklog(taskId: string): TaskEvent[] {
    return this.taskBacklogs.get(taskId) ?? []
  }

  /**
   * Clear the backlog for a task (e.g. when it completes and no more subscribers).
   */
  clearBacklog(taskId: string): void {
    this.taskBacklogs.delete(taskId)
  }

  /**
   * Check if a task has any listeners
   */
  hasSubscribers(taskId: string): boolean {
    return this.listenerCount(`task:${taskId}`) > 0
  }
}
