import { loadConfig } from './config.js'

/**
 * Global concurrency limit for background tasks.
 *
 * Why this exists: the host froze on 2026-09-26 because seven coding tasks
 * ran in parallel, each with its own local build. Nothing capped the number
 * of *tasks* — `provider-concurrency.ts` only caps LLM calls per provider —
 * and after the restart `recoverTasks` started all seven again at once.
 *
 * The rules implemented here (see the plan of 2026-09-26):
 *  - at most `tasks.maxConcurrent` tasks occupy a slot at any time,
 *  - further tasks wait in a FIFO queue and start when a slot frees up,
 *  - `0` (or a negative value) disables the limit,
 *  - the limit is re-read on every admission/dequeue decision, so editing
 *    `settings.json` takes effect without a server restart.
 *
 * This module is intentionally pure and side-effect free (apart from reading
 * settings.json in `readMaxConcurrentTasksFromConfig`): the durable marker of
 * a queued task is its DB row (`status='running'` with `startedAt IS NULL`),
 * written by the task runner, not here.
 */

/** Default number of tasks allowed to run at the same time. */
export const DEFAULT_MAX_CONCURRENT_TASKS = 3

/**
 * Trigger types the queue applies to. Everything else bypasses the wait
 * (but still occupies a slot): cronjob/heartbeat runs are short and
 * time-critical, and a resumed task is a user waiting for an answer.
 */
const QUEUED_TRIGGER_TYPES: ReadonlySet<string> = new Set(['user', 'agent'])

/**
 * Does the FIFO queue apply to this trigger type?
 * `user` / `agent` → yes. `cronjob`, `heartbeat`, `consolidation` → no.
 */
export function queueAppliesToTrigger(triggerType: string): boolean {
  return QUEUED_TRIGGER_TYPES.has(triggerType)
}

/**
 * Coerce a settings value into a usable limit: a non-negative integer, or
 * `undefined` when the value is not a finite number. `0` is meaningful
 * (= unlimited) and therefore preserved.
 */
export function normalizeMaxConcurrentTasks(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const floored = Math.floor(value)
  return floored < 0 ? 0 : floored
}

/**
 * Read `tasks.maxConcurrent` from settings.json on every call, following the
 * same live-read pattern as `readBackgroundThinkingLevelFromConfig`. Falls
 * back to {@link DEFAULT_MAX_CONCURRENT_TASKS} when the file or the key is
 * missing or unusable.
 */
export function readMaxConcurrentTasksFromConfig(): number {
  try {
    const settings = loadConfig<{ tasks?: { maxConcurrent?: unknown } }>('settings.json')
    return normalizeMaxConcurrentTasks(settings.tasks?.maxConcurrent) ?? DEFAULT_MAX_CONCURRENT_TASKS
  } catch {
    return DEFAULT_MAX_CONCURRENT_TASKS
  }
}

/** One waiting task: its id plus whatever the caller needs to start it later. */
export interface QueuedTask<T> {
  taskId: string
  payload: T
  enqueuedAtMs: number
}

/** Result of asking the queue for a slot. */
export type Admission =
  | { admitted: true; running: number }
  | { admitted: false; position: number; running: number }

/**
 * In-memory slot accounting plus FIFO waiting list.
 *
 * `active` holds the ids of tasks that currently occupy a slot — only tasks
 * that really run. A paused task (waiting for a user answer) has released its
 * slot and re-acquires one via {@link occupy} when it is resumed.
 */
export class TaskConcurrencyQueue<T> {
  private readonly active = new Set<string>()
  private waiting: QueuedTask<T>[] = []

  constructor(private readonly getLimit: () => number) {}

  /** The currently configured limit (re-read on every call). `0` = unlimited. */
  limit(): number {
    const limit = normalizeMaxConcurrentTasks(this.getLimit())
    return limit ?? DEFAULT_MAX_CONCURRENT_TASKS
  }

  /** Number of tasks occupying a slot. */
  activeCount(): number {
    return this.active.size
  }

  /** Number of tasks waiting for a slot. */
  queuedCount(): number {
    return this.waiting.length
  }

  /** Ids of the waiting tasks, in FIFO order. */
  queuedIds(): string[] {
    return this.waiting.map(entry => entry.taskId)
  }

  /** Ids of the tasks occupying a slot. */
  activeIds(): string[] {
    return [...this.active]
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId)
  }

  isQueued(taskId: string): boolean {
    return this.waiting.some(entry => entry.taskId === taskId)
  }

  /** 1-based queue position, or `0` when the task is not waiting. */
  position(taskId: string): number {
    const index = this.waiting.findIndex(entry => entry.taskId === taskId)
    return index < 0 ? 0 : index + 1
  }

  /** Is there room for one more task right now? */
  hasFreeSlot(): boolean {
    const limit = this.limit()
    if (limit <= 0) return true
    return this.active.size < limit
  }

  /**
   * Take a slot without waiting (bypass paths: resume, cronjob, heartbeat,
   * consolidation). Idempotent, and it may push the active count above the
   * limit by design — bypassing tasks count, they just do not wait.
   */
  occupy(taskId: string): void {
    this.active.add(taskId)
  }

  /**
   * Ask for a slot for a queue-governed task. Either the task is admitted
   * (slot taken) or it is appended to the FIFO queue and gets its position.
   * Calling it again for a task that is already active/queued does not
   * duplicate the entry.
   */
  admit(taskId: string, payload: T, nowMs: number = Date.now()): Admission {
    if (this.active.has(taskId)) return { admitted: true, running: this.active.size }
    const queuedPosition = this.position(taskId)
    if (queuedPosition > 0) {
      return { admitted: false, position: queuedPosition, running: this.active.size }
    }
    if (this.hasFreeSlot()) {
      this.active.add(taskId)
      return { admitted: true, running: this.active.size }
    }
    this.waiting.push({ taskId, payload, enqueuedAtMs: nowMs })
    return { admitted: false, position: this.waiting.length, running: this.active.size }
  }

  /**
   * Release the slot of a task that stopped running (completed, failed,
   * aborted, timed out, paused, or failed to start). Returns true when a
   * slot was actually held — callers use that to decide whether to log.
   */
  release(taskId: string): boolean {
    return this.active.delete(taskId)
  }

  /**
   * Pop the next waiting task if a slot is free, marking it active. Returns
   * null when the queue is empty or the limit is currently reached. The limit
   * is re-read here, so lowering it in settings.json stops the queue from
   * draining further without a restart.
   */
  takeNext(): QueuedTask<T> | null {
    if (this.waiting.length === 0) return null
    if (!this.hasFreeSlot()) return null
    const next = this.waiting.shift()!
    this.active.add(next.taskId)
    return next
  }

  /**
   * Remove a waiting task from the queue (abort of a queued task). Returns
   * the removed entry, or null when the task was not waiting.
   */
  cancel(taskId: string): QueuedTask<T> | null {
    const index = this.waiting.findIndex(entry => entry.taskId === taskId)
    if (index < 0) return null
    const [removed] = this.waiting.splice(index, 1)
    return removed ?? null
  }

  /** Drop all state (shutdown). */
  clear(): void {
    this.active.clear()
    this.waiting = []
  }

  /** Snapshot for logging / diagnostics. */
  snapshot(): { limit: number; running: number; queued: number; queuedIds: string[] } {
    return {
      limit: this.limit(),
      running: this.active.size,
      queued: this.waiting.length,
      queuedIds: this.queuedIds(),
    }
  }
}
