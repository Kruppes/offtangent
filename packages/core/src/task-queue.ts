import { loadConfig } from './config.js'

/**
 * Concurrency limits for background tasks: a budget of slots PER PROVIDER plus
 * a global safety cap for the host.
 *
 * History: the host froze on 2026-09-26 because seven coding tasks ran in
 * parallel, each with its own local build (RAM thrashing). The first fix was a
 * single global limit of 3 tasks. That was too coarse — tasks of different
 * providers do not compete for the same rate limits, so a busy provider made
 * every other provider wait. Since 2026-10-01:
 *
 *  - every provider (keyed by its provider id) may run
 *    `tasks.maxConcurrentPerProvider` tasks at the same time (default 5),
 *    optionally overridden per provider id in `tasks.maxConcurrentByProvider`,
 *  - `tasks.maxConcurrent` stays as a host-wide cap across all providers
 *    (default 12) because CPU/RAM are shared no matter which LLM drives a task,
 *  - a task starts only when BOTH its provider and the global count are below
 *    their limits; otherwise it waits,
 *  - dequeue is FIFO without head-of-line blocking: the oldest waiting task
 *    that can be admitted starts, so a waiting task of a saturated provider
 *    never blocks a task of another provider. Within one provider the order is
 *    strictly FIFO,
 *  - `0` (or a negative value) disables a limit,
 *  - the limits are re-read on every admission/dequeue decision, so editing
 *    `settings.json` takes effect without a server restart.
 *
 * Model/provider fallbacks inside a running task do not move its slot: the
 * slot stays with the provider key the task was admitted with until it is
 * released.
 *
 * This module is intentionally pure and side-effect free (apart from reading
 * settings.json in `readTaskConcurrencyLimitsFromConfig`): the durable marker
 * of a queued task is its DB row (`status='running'` with `startedAt IS
 * NULL`), written by the task runner, not here.
 */

/** Default host-wide cap of tasks running at the same time (all providers). */
export const DEFAULT_MAX_CONCURRENT_TASKS = 12

/** Default number of tasks one provider may run at the same time. */
export const DEFAULT_MAX_CONCURRENT_TASKS_PER_PROVIDER = 5

/** Slot key for a task whose provider could not be resolved. */
export const UNKNOWN_PROVIDER_KEY = 'unknown'

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
 * Coerce `tasks.maxConcurrentByProvider` into a clean `providerId → limit`
 * map. Entries whose value is not a finite number are dropped (they fall back
 * to the per-provider default); anything that is not a plain object yields an
 * empty map.
 */
export function normalizeProviderLimitOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const limit = normalizeMaxConcurrentTasks(raw)
    if (limit !== undefined) result[key] = limit
  }
  return result
}

/** The limits the queue works with. `0` = unlimited. */
export interface TaskConcurrencyLimits {
  /** Host-wide cap across all providers (`tasks.maxConcurrent`). */
  global: number
  /** Default slots per provider (`tasks.maxConcurrentPerProvider`). */
  perProvider: number
  /** Per-provider overrides keyed by provider id (`tasks.maxConcurrentByProvider`). */
  byProvider?: Record<string, number>
}

/**
 * Read the task concurrency limits from settings.json on every call, following
 * the same live-read pattern as `readBackgroundThinkingLevelFromConfig`.
 * Missing or unusable values fall back to the defaults; explicit values
 * (including `0`) are respected.
 */
export function readTaskConcurrencyLimitsFromConfig(): Required<TaskConcurrencyLimits> {
  try {
    const settings = loadConfig<{
      tasks?: { maxConcurrent?: unknown; maxConcurrentPerProvider?: unknown; maxConcurrentByProvider?: unknown }
    }>('settings.json')
    const tasks = settings.tasks ?? {}
    return {
      global: normalizeMaxConcurrentTasks(tasks.maxConcurrent) ?? DEFAULT_MAX_CONCURRENT_TASKS,
      perProvider: normalizeMaxConcurrentTasks(tasks.maxConcurrentPerProvider) ?? DEFAULT_MAX_CONCURRENT_TASKS_PER_PROVIDER,
      byProvider: normalizeProviderLimitOverrides(tasks.maxConcurrentByProvider),
    }
  } catch {
    return {
      global: DEFAULT_MAX_CONCURRENT_TASKS,
      perProvider: DEFAULT_MAX_CONCURRENT_TASKS_PER_PROVIDER,
      byProvider: {},
    }
  }
}

/**
 * Read only the global cap (`tasks.maxConcurrent`). Kept for callers that only
 * need the host-wide number.
 */
export function readMaxConcurrentTasksFromConfig(): number {
  return readTaskConcurrencyLimitsFromConfig().global
}

/** Normalize a provider key: empty / missing ids share the `unknown` bucket. */
export function normalizeProviderKey(providerKey: string | null | undefined): string {
  return typeof providerKey === 'string' && providerKey.trim() ? providerKey : UNKNOWN_PROVIDER_KEY
}

/** Which limit keeps a task waiting. */
export type QueueWaitReason = 'provider' | 'global'

/** One waiting task: its id plus whatever the caller needs to start it later. */
export interface QueuedTask<T> {
  taskId: string
  payload: T
  /** Provider the slot is counted against. */
  providerKey: string
  enqueuedAtMs: number
}

/** Result of asking the queue for a slot. */
export type Admission =
  | { admitted: true; running: number }
  | {
      admitted: false
      /** 1-based position in the overall waiting list. */
      position: number
      running: number
      /** The limit that keeps the task waiting right now. */
      reason: QueueWaitReason
      providerKey: string
      providerRunning: number
      providerLimit: number
    }

/** Resolved limits of one decision (read once, used for every check in it). */
interface ResolvedLimits {
  global: number
  perProvider: number
  byProvider: Record<string, number>
}

/**
 * In-memory slot accounting plus FIFO waiting list.
 *
 * `active` maps the ids of tasks that currently occupy a slot to the provider
 * key the slot is counted against — only tasks that really run. A paused task
 * (waiting for a user answer) has released its slot and re-acquires one via
 * {@link occupy} when it is resumed.
 */
export class TaskConcurrencyQueue<T> {
  private readonly active = new Map<string, string>()
  private waiting: QueuedTask<T>[] = []

  /**
   * @param getLimits called once per admission/dequeue decision; missing or
   *   unusable fields fall back to the defaults.
   */
  constructor(private readonly getLimits: () => Partial<TaskConcurrencyLimits>) {}

  private resolveLimits(): ResolvedLimits {
    let raw: Partial<TaskConcurrencyLimits> = {}
    try {
      raw = this.getLimits() ?? {}
    } catch {
      raw = {}
    }
    return {
      global: normalizeMaxConcurrentTasks(raw.global) ?? DEFAULT_MAX_CONCURRENT_TASKS,
      perProvider: normalizeMaxConcurrentTasks(raw.perProvider) ?? DEFAULT_MAX_CONCURRENT_TASKS_PER_PROVIDER,
      byProvider: normalizeProviderLimitOverrides(raw.byProvider),
    }
  }

  private static providerLimitOf(limits: ResolvedLimits, providerKey: string): number {
    const override = limits.byProvider[providerKey]
    return override !== undefined ? override : limits.perProvider
  }

  /** The configured global cap (re-read on every call). `0` = unlimited. */
  limit(): number {
    return this.resolveLimits().global
  }

  /** The configured limit of one provider (re-read on every call). `0` = unlimited. */
  providerLimit(providerKey: string): number {
    return TaskConcurrencyQueue.providerLimitOf(this.resolveLimits(), normalizeProviderKey(providerKey))
  }

  /** Number of tasks occupying a slot (all providers). */
  activeCount(): number {
    return this.active.size
  }

  /** Number of tasks of one provider occupying a slot. */
  activeCountFor(providerKey: string): number {
    const key = normalizeProviderKey(providerKey)
    let count = 0
    for (const value of this.active.values()) if (value === key) count++
    return count
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
    return [...this.active.keys()]
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId)
  }

  isQueued(taskId: string): boolean {
    return this.waiting.some(entry => entry.taskId === taskId)
  }

  /** Provider key of an active or waiting task, or null when unknown here. */
  providerOf(taskId: string): string | null {
    const active = this.active.get(taskId)
    if (active !== undefined) return active
    return this.waiting.find(entry => entry.taskId === taskId)?.providerKey ?? null
  }

  /** 1-based queue position (overall waiting list), or `0` when not waiting. */
  position(taskId: string): number {
    const index = this.waiting.findIndex(entry => entry.taskId === taskId)
    return index < 0 ? 0 : index + 1
  }

  /**
   * Which limit would keep a task of this provider out right now, or null
   * when it could start. The provider limit is reported first: it is the more
   * specific reason, and freeing global capacity alone would not help.
   */
  private blockedBy(limits: ResolvedLimits, providerKey: string): QueueWaitReason | null {
    const providerLimit = TaskConcurrencyQueue.providerLimitOf(limits, providerKey)
    if (providerLimit > 0 && this.activeCountFor(providerKey) >= providerLimit) return 'provider'
    if (limits.global > 0 && this.active.size >= limits.global) return 'global'
    return null
  }

  /**
   * Is there room for one more task right now? Without a provider key only
   * the global cap is checked.
   */
  hasFreeSlot(providerKey?: string): boolean {
    const limits = this.resolveLimits()
    if (providerKey === undefined) return limits.global <= 0 || this.active.size < limits.global
    return this.blockedBy(limits, normalizeProviderKey(providerKey)) === null
  }

  /**
   * Why a waiting task is still waiting (`null` when it is not waiting). A
   * task that waits only behind an older task of its own provider reports
   * `provider`.
   */
  waitReason(taskId: string): QueueWaitReason | null {
    const entry = this.waiting.find(e => e.taskId === taskId)
    if (!entry) return null
    return this.blockedBy(this.resolveLimits(), entry.providerKey) ?? 'provider'
  }

  /**
   * Take a slot without waiting (bypass paths: resume, cronjob, heartbeat,
   * consolidation). Idempotent, and it may push the counts above the limits
   * by design — bypassing tasks count, they just do not wait.
   */
  occupy(taskId: string, providerKey?: string | null): void {
    if (this.active.has(taskId)) return
    this.active.set(taskId, normalizeProviderKey(providerKey))
  }

  /**
   * Ask for a slot for a queue-governed task. Either the task is admitted
   * (slot taken) or it is appended to the FIFO queue and gets its position.
   * Calling it again for a task that is already active/queued does not
   * duplicate the entry. A newcomer never overtakes an older waiting task of
   * the same provider.
   */
  admit(taskId: string, payload: T, providerKey?: string | null, nowMs: number = Date.now()): Admission {
    if (this.active.has(taskId)) return { admitted: true, running: this.active.size }
    const limits = this.resolveLimits()
    const queued = this.waiting.find(entry => entry.taskId === taskId)
    if (queued) return this.waitingAdmission(limits, queued)

    const key = normalizeProviderKey(providerKey)
    const olderOfSameProvider = this.waiting.some(entry => entry.providerKey === key)
    if (!olderOfSameProvider && this.blockedBy(limits, key) === null) {
      this.active.set(taskId, key)
      return { admitted: true, running: this.active.size }
    }
    const entry: QueuedTask<T> = { taskId, payload, providerKey: key, enqueuedAtMs: nowMs }
    this.waiting.push(entry)
    return this.waitingAdmission(limits, entry)
  }

  private waitingAdmission(limits: ResolvedLimits, entry: QueuedTask<T>): Admission {
    return {
      admitted: false,
      position: this.position(entry.taskId),
      running: this.active.size,
      reason: this.blockedBy(limits, entry.providerKey) ?? 'provider',
      providerKey: entry.providerKey,
      providerRunning: this.activeCountFor(entry.providerKey),
      providerLimit: TaskConcurrencyQueue.providerLimitOf(limits, entry.providerKey),
    }
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
   * Start the oldest waiting task that can be admitted right now, marking it
   * active. Waiting tasks of a saturated provider are skipped (no
   * head-of-line blocking across providers); within one provider the oldest
   * entry is always the first candidate, so the order there stays FIFO.
   * Returns null when nothing can start. The limits are re-read here, so
   * changing them in settings.json applies from the next dequeue on.
   */
  takeNext(): QueuedTask<T> | null {
    if (this.waiting.length === 0) return null
    const limits = this.resolveLimits()
    if (limits.global > 0 && this.active.size >= limits.global) return null
    const blockedProviders = new Set<string>()
    for (let index = 0; index < this.waiting.length; index++) {
      const entry = this.waiting[index]!
      if (blockedProviders.has(entry.providerKey)) continue
      if (this.blockedBy(limits, entry.providerKey) !== null) {
        blockedProviders.add(entry.providerKey)
        continue
      }
      this.waiting.splice(index, 1)
      this.active.set(entry.taskId, entry.providerKey)
      return entry
    }
    return null
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

  /** Snapshot for logging / diagnostics, including the occupancy per provider. */
  snapshot(): {
    limit: number
    perProviderLimit: number
    running: number
    queued: number
    queuedIds: string[]
    providers: Record<string, { running: number; queued: number; limit: number }>
  } {
    const limits = this.resolveLimits()
    const providers: Record<string, { running: number; queued: number; limit: number }> = {}
    const bucket = (key: string) => {
      providers[key] ??= { running: 0, queued: 0, limit: TaskConcurrencyQueue.providerLimitOf(limits, key) }
      return providers[key]!
    }
    for (const key of this.active.values()) bucket(key).running++
    for (const entry of this.waiting) bucket(entry.providerKey).queued++
    return {
      limit: limits.global,
      perProviderLimit: limits.perProvider,
      running: this.active.size,
      queued: this.waiting.length,
      queuedIds: this.queuedIds(),
      providers,
    }
  }
}
