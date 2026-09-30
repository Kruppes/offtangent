/**
 * The fallback half of W4: a small interval that re-delivers task injections
 * nobody acknowledged.
 *
 * The boot hook covers the restart case. This covers the quieter one: the
 * session died mid-run (runtime swap, provider abort, an exception between
 * enqueue and the `done` chunk) while the process kept going. Without a
 * sweep, such a row would sit `pending` until the next restart.
 *
 * Deliberately dumb: no exponential backoff, no priority, no parallelism
 * control beyond a batch limit. `retryAfterMs` doubles as the in-flight
 * guard — a row whose attempt is younger than that is assumed to be running
 * right now, because `markTaskInjectionAttempt` is called at dispatch time.
 */

import type { Database } from './database.js'
import {
  abandonTaskInjection,
  listPendingTaskInjections,
  markTaskInjectionAttempt,
  markTaskInjectionFailed,
  selectInjectionsForRedelivery,
  type TaskInjectionRow,
} from './task-injection-queue.js'

export interface TaskInjectionSweeperLogger {
  log?: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
}

export interface TaskInjectionSweeperOptions {
  db: Database
  /** Hand the row to the agent. Must not throw for delivery failures. */
  deliver: (row: TaskInjectionRow) => void | Promise<void>
  /** False when there is no agent core to inject into — skip the sweep. */
  isDeliverable?: () => boolean
  /** Sweep period in ms; 0 disables the timer (manual `sweepOnce` still works). */
  intervalMs?: number
  retryAfterMs?: number
  maxAttempts?: number
  maxAgeMs?: number
  batchLimit?: number
  logger?: TaskInjectionSweeperLogger
  now?: () => number
}

export interface SweepResult {
  redelivered: number
  expired: number
  skipped: boolean
}

export const DEFAULT_SWEEP_INTERVAL_MS = 90_000
export const DEFAULT_RETRY_AFTER_MS = 300_000
export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const DEFAULT_BATCH_LIMIT = 5

export class TaskInjectionSweeper {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly options: TaskInjectionSweeperOptions
  private readonly logger: TaskInjectionSweeperLogger
  private running = false

  constructor(options: TaskInjectionSweeperOptions) {
    this.options = options
    this.logger = options.logger ?? console
  }

  start(): void {
    const intervalMs = this.options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    if (intervalMs <= 0 || this.timer) return
    this.timer = setInterval(() => {
      this.sweepOnce().catch(err => this.logger.error('[task-injection-sweeper] Sweep failed:', err))
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * One pass. Re-entrancy guarded: a slow sweep must not stack up with the
   * next tick and dispatch the same row twice.
   */
  async sweepOnce(): Promise<SweepResult> {
    if (this.running) return { redelivered: 0, expired: 0, skipped: true }
    if (this.options.isDeliverable && !this.options.isDeliverable()) {
      return { redelivered: 0, expired: 0, skipped: true }
    }
    this.running = true
    try {
      const now = (this.options.now ?? Date.now)()
      const pending = listPendingTaskInjections(this.options.db)
      if (pending.length === 0) return { redelivered: 0, expired: 0, skipped: false }

      const { redeliver, expire } = selectInjectionsForRedelivery(pending, {
        now,
        retryAfterMs: this.options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
        maxAttempts: this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        maxAgeMs: this.options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
        limit: this.options.batchLimit ?? DEFAULT_BATCH_LIMIT,
      })

      for (const { row, reason } of expire) {
        abandonTaskInjection(this.options.db, row.id, reason)
        this.logger.warn(
          `[task-injection-sweeper] Abandoned injection ${row.id} for task ${row.taskId}: ${reason}`,
        )
      }

      let redelivered = 0
      for (const row of redeliver) {
        markTaskInjectionAttempt(this.options.db, row.id)
        try {
          await this.options.deliver(row)
          redelivered++
        } catch (err) {
          markTaskInjectionFailed(this.options.db, row.id, String(err))
          this.logger.error(`[task-injection-sweeper] Re-delivery of ${row.id} failed:`, err)
        }
      }

      if (redelivered > 0 || expire.length > 0) {
        this.logger.log?.(
          `[task-injection-sweeper] Re-delivered ${redelivered} injection(s), abandoned ${expire.length}`,
        )
      }
      return { redelivered, expired: expire.length, skipped: false }
    } finally {
      this.running = false
    }
  }
}
