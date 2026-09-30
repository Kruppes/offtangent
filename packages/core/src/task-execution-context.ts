import { AsyncLocalStorage } from 'node:async_hooks'
import type { ProviderConfig } from './provider-config.js'

/**
 * Per-task execution context, carried through the async call tree of a running
 * background task via AsyncLocalStorage.
 *
 * Why AsyncLocalStorage and not an instance field: multiple background tasks
 * (and their sub-tasks / sub-sub-tasks) run concurrently in one process. A tool
 * invoked from inside task A must see task A's context even while task B is mid
 * LLM call. A shared mutable field would leak B's provider into A. ALS gives
 * each async task tree its own isolated view.
 *
 * The context enables the per-task/subtask model inheritance chain:
 *   explicit provider/model on create_task  >  parent task's model (this ctx)
 *   >  agent/persona default  >  system default
 *
 * When a running task calls `create_task` WITHOUT an explicit provider/model,
 * the tool resolves its default via `getTaskDefaultProvider`, which reads
 * `getCurrentTaskProvider()` here first — so a Kimi-pinned parent spawns a
 * Kimi-pinned child instead of silently falling back to the global default.
 */
/**
 * Who a task belongs to and where its output goes: the user that owns the
 * task and the strand (session) that triggered it. Resolved once per run by
 * the composition layer (which knows the session lineage) and carried in the
 * execution context, so a tool cannot end up guessing a "current" user that
 * only exists during an interactive turn.
 */
export interface TaskOrigin {
  /** Numeric user id (matches `users.id`), or null when unresolvable. */
  userId: number | null
  /** The strand that triggered the task, or null when it has none. */
  sessionId: string | null
}

export interface TaskExecutionContext {
  /** The provider config (already model-pinned) the current task runs on. */
  provider: ProviderConfig | null
  /** The persona/agent id the current task is attributed to, if any. */
  agentId?: string | null
  /** The current task's id (for debugging / future depth limits). */
  taskId?: string
  /** The user the current task belongs to (see {@link TaskOrigin}). */
  userId?: number | null
  /** The strand that triggered the current task (see {@link TaskOrigin}). */
  sessionId?: string | null
}

const storage = new AsyncLocalStorage<TaskExecutionContext>()

/**
 * Run `fn` with the given task execution context bound to the async call tree.
 * Every `create_task` / provider resolution that happens inside `fn` (including
 * nested tool calls and their own child tasks) sees this context.
 */
export function runWithTaskExecutionContext<T>(
  ctx: TaskExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn)
}

/** The full context of the task currently executing, or undefined at top level. */
export function getCurrentTaskExecutionContext(): TaskExecutionContext | undefined {
  return storage.getStore()
}

/**
 * The provider (model-pinned) of the task currently executing, or null when
 * not inside a task (interactive chat, top-level scheduler, etc.). Used by the
 * task-default-provider resolver to implement parent-task model inheritance.
 */
export function getCurrentTaskProvider(): ProviderConfig | null {
  return storage.getStore()?.provider ?? null
}

/** The persona/agent id of the task currently executing, if any. */
export function getCurrentTaskAgentId(): string | null | undefined {
  return storage.getStore()?.agentId
}

/**
 * User + strand of the task currently executing, or null outside a task.
 * Tools that deliver something to the user (files, notifications) use this
 * instead of the interactive-turn getters, which are unset in background
 * contexts.
 */
export function getCurrentTaskOrigin(): TaskOrigin | null {
  const store = storage.getStore()
  if (!store) return null
  return { userId: store.userId ?? null, sessionId: store.sessionId ?? null }
}
