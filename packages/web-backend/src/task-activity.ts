/**
 * Live visibility of what works for a strand (SPEC 10.x).
 *
 * The strand used to look dead during a whole wave of background work:
 * `create_task` emitted a `tool_call_start` / `tool_call_end` pair inside one
 * frame batch (so the delegation flashed by), and nothing announced the birth
 * of a sub-task at all. `task_completed` did arrive, but without `sessionId`
 * or `agentId`, so no client could attribute it to a strand.
 *
 * This module turns a task lifecycle signal from the task runner into a
 * `task_started` / `task_progress` / `task_finished` chat event that carries
 * the resolved strand, the task id AND the parent task id.
 *
 * Attribution rule (hard): strand via `sessionId`, else via the lineage /
 * task-parent chain, else DROP the frame. The "only strand currently running"
 * fallback is forbidden — it has ended foreign turns before.
 */
import { buildTaskActivityFrame, type Database, type Task, type TaskActivityPhase } from '@axiom/core'
import type { ChatEventBus } from './chat-event-bus.js'

export interface TaskActivityDeps {
  db: Database
  chatEventBus?: ChatEventBus | null
  /** The user a task belongs to. Resolved by the composition layer. */
  resolveUserId: (task: Task) => number | null
  logger?: { warn: (msg: string, ...args: unknown[]) => void }
}

/**
 * Broadcast one strand-activity frame. Returns true when a frame went out,
 * false when it was dropped (no strand, no user, no bus) — the caller does
 * not retry, this is a live signal and the REST catch-up
 * (`GET /api/strands/:id/tasks`) is the safety net.
 */
export function broadcastTaskActivity(
  deps: TaskActivityDeps,
  phase: TaskActivityPhase,
  task: Task,
): boolean {
  if (!deps.chatEventBus) return false

  const frame = buildTaskActivityFrame(deps.db, task, phase)
  if (!frame) return false

  const userId = deps.resolveUserId(task)
  if (userId == null) {
    deps.logger?.warn(`[task-activity] Dropping ${phase} frame for task ${task.id}: no user resolved`)
    return false
  }

  deps.chatEventBus.broadcast({
    type: phase === 'started' ? 'task_started' : phase === 'progress' ? 'task_progress' : 'task_finished',
    userId,
    source: 'task',
    sessionId: frame.strandId,
    agentId: frame.agentId ?? 'main',
    taskId: frame.taskId,
    taskParentId: frame.parentTaskId,
    taskName: frame.name,
    taskStatus: frame.status,
    taskResultStatus: frame.resultStatus,
    taskTriggerType: frame.triggerType,
    taskError: frame.errorMessage,
    taskCreatedAt: frame.createdAt,
    taskStartedAt: frame.startedAt,
    taskCompletedAt: frame.completedAt,
    taskToolCallCount: frame.toolCallCount,
    // Live usage. Same names on every phase (`task_started` carries zeros,
    // `task_progress` the current stand, `task_finished` the total), so a
    // client can apply one frame handler instead of three.
    taskPromptTokens: frame.promptTokens,
    taskCompletionTokens: frame.completionTokens,
    taskCacheRead: frame.cacheRead,
    taskCacheWrite: frame.cacheWrite,
    taskEstimatedCost: frame.estimatedCost,
  })
  return true
}
