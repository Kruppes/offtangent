import type { Database } from './database.js'
import { ScheduledTaskStore } from './scheduled-task-store.js'
import type { ScheduledTask } from './scheduled-task-store.js'
import type { TaskStore } from './task-store.js'
import type { TaskRunner } from './task-runner.js'
import type { TaskOverrides } from './task-runner.js'
import type { ProviderConfig } from './provider-config.js'
import { parseProviderModelId, getProviderDefaultModel } from './provider-config.js'
import { parseCronExpression, getNextRunTime } from './cron-parser.js'

export interface TaskSchedulerOptions {
  db: Database
  taskStore: TaskStore
  taskRunner: TaskRunner
  /** Get the default provider for tasks; null when none is configured */
  getDefaultProvider: () => ProviderConfig | null
  /** Resolve a provider by name/id */
  resolveProvider: (nameOrId: string) => ProviderConfig | null
  /** Callback for injection-type cronjobs — delivers the reminder to the user */
  onInjection?: (scheduledTask: ScheduledTask) => void
}

interface ScheduleEntry {
  scheduledTaskId: string
  timer: ReturnType<typeof setTimeout>
  nextRunTime: Date
}

/**
 * Maximum safe timeout value for setTimeout (24 days).
 * Values above ~2^31-1 ms (~24.8 days) overflow in Node.js and fire immediately.
 * We use 24 hours as a safe maximum to periodically re-evaluate.
 */
const MAX_SAFE_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Threshold for auto-disabling "one-time" scheduled tasks.
 * If the next run is more than 364 days away, we consider it effectively one-time
 * and auto-disable after firing.
 */
const ONE_TIME_THRESHOLD_MS = 364 * 24 * 60 * 60 * 1000

/**
 * Task Scheduler — loads cron-based scheduled tasks and fires them via TaskRunner.
 *
 * Similar pattern to MemoryConsolidationScheduler but generalized for N schedules.
 */
export class TaskScheduler {
  private scheduledTaskStore: ScheduledTaskStore
  private taskStore: TaskStore
  private taskRunner: TaskRunner
  private options: TaskSchedulerOptions
  private schedules: Map<string, ScheduleEntry> = new Map()
  private running = false

  constructor(options: TaskSchedulerOptions) {
    this.options = options
    this.scheduledTaskStore = new ScheduledTaskStore(options.db)
    this.taskStore = options.taskStore
    this.taskRunner = options.taskRunner
  }

  /**
   * Get the underlying ScheduledTaskStore
   */
  getStore(): ScheduledTaskStore {
    return this.scheduledTaskStore
  }

  /**
   * Start the scheduler — loads all enabled schedules and sets timers
   */
  start(): void {
    if (this.running) return
    this.running = true
    this.loadAllSchedules()
  }

  /**
   * Stop the scheduler — clears all timers
   */
  stop(): void {
    this.running = false
    for (const [, entry] of this.schedules) {
      clearTimeout(entry.timer)
    }
    this.schedules.clear()
  }

  /**
   * Restart the scheduler
   */
  restart(): void {
    this.stop()
    this.start()
  }

  /**
   * Register or re-register a schedule (after create/update)
   */
  registerSchedule(scheduledTask: ScheduledTask): void {
    // Remove existing timer if any
    this.unregisterSchedule(scheduledTask.id)

    if (!scheduledTask.enabled || !this.running) return

    this.setNextTimer(scheduledTask)
  }

  /**
   * Unregister a schedule (after delete or disable)
   */
  unregisterSchedule(id: string): void {
    const entry = this.schedules.get(id)
    if (entry) {
      clearTimeout(entry.timer)
      this.schedules.delete(id)
    }
  }

  /**
   * Manually trigger a cronjob (run it immediately)
   */
  async triggerNow(scheduledTaskId: string): Promise<string | null> {
    const scheduledTask = this.scheduledTaskStore.getById(scheduledTaskId)
    if (!scheduledTask) return null

    if (scheduledTask.actionType === 'injection') {
      this.fireInjection(scheduledTask)
      return `injection-${scheduledTask.id}`
    }

    return this.fireTask(scheduledTask)
  }

  /**
   * Get info about all active schedules
   */
  getActiveSchedules(): Array<{ id: string; nextRunTime: Date }> {
    return Array.from(this.schedules.entries()).map(([id, entry]) => ({
      id,
      nextRunTime: entry.nextRunTime,
    }))
  }

  /**
   * Load all enabled schedules from DB and set timers
   */
  private loadAllSchedules(): void {
    const enabledTasks = this.scheduledTaskStore.listEnabled()
    for (const task of enabledTasks) {
      this.setNextTimer(task)
    }
    console.log(`[axiom] Task scheduler loaded ${enabledTasks.length} enabled schedule(s)`)
  }

  /** Minimum cooldown between firings of the same cronjob (in ms) */
  private static readonly FIRE_COOLDOWN_MS = 55_000 // 55 seconds — prevents double-firing within the same cron minute

  /**
   * Check whether a cronjob was already fired recently (deduplication guard).
   * Protects against double-firing caused by server restarts, watch-mode reloads, etc.
   */
  private wasFiredRecently(scheduledTask: ScheduledTask): boolean {
    if (!scheduledTask.lastRunAt) return false
    try {
      const lastRun = new Date(scheduledTask.lastRunAt.replace(' ', 'T') + 'Z').getTime()
      return (Date.now() - lastRun) < TaskScheduler.FIRE_COOLDOWN_MS
    } catch {
      return false
    }
  }

  /**
   * Calculate next run time and set a timer for a scheduled task.
   *
   * For delays > MAX_SAFE_TIMEOUT_MS (24h), sets an intermediate wake-up timer
   * that re-evaluates when to fire, avoiding Node.js setTimeout overflow
   * (values > ~2^31 ms fire immediately).
   */
  private setNextTimer(scheduledTask: ScheduledTask): void {
    try {
      const fields = parseCronExpression(scheduledTask.schedule)
      const nextRun = getNextRunTime(fields)

      if (!nextRun) {
        console.warn(`[axiom] Could not calculate next run time for schedule "${scheduledTask.name}" (${scheduledTask.schedule})`)
        return
      }

      const delayMs = nextRun.getTime() - Date.now()

      // Guard: if the next run is in the past (e.g. server restart after the
      // scheduled time), skip it rather than firing immediately.
      if (delayMs < -5_000) {
        console.log(`[axiom] Skipping past-due schedule "${scheduledTask.name}" (was due ${Math.round(-delayMs / 60000)} min ago)`)
        return
      }

      // Guard: if the delay exceeds the safe setTimeout limit, set an
      // intermediate wake-up timer that re-evaluates when closer to the target.
      // This prevents the Node.js 32-bit integer overflow that causes
      // setTimeout to fire immediately for very large values.
      const effectiveDelay = Math.max(0, delayMs)
      const timerDelay = effectiveDelay > MAX_SAFE_TIMEOUT_MS
        ? MAX_SAFE_TIMEOUT_MS
        : effectiveDelay

      const timer = setTimeout(() => {
        if (effectiveDelay > MAX_SAFE_TIMEOUT_MS) {
          // Intermediate wake-up: re-read from DB and re-schedule
          this.schedules.delete(scheduledTask.id)
          const refreshed = this.scheduledTaskStore.getById(scheduledTask.id)
          if (refreshed && refreshed.enabled && this.running) {
            this.setNextTimer(refreshed)
          }
        } else {
          this.onCronFired(scheduledTask.id)
        }
      }, timerDelay)

      // Don't keep the process alive for timers
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref()
      }

      this.schedules.set(scheduledTask.id, {
        scheduledTaskId: scheduledTask.id,
        timer,
        nextRunTime: nextRun,
      })

      if (effectiveDelay > MAX_SAFE_TIMEOUT_MS) {
        console.log(`[axiom] Scheduled "${scheduledTask.name}" next run at ${nextRun.toISOString()} (in ${Math.round(delayMs / 86400000)} days, wake-up in 24h)`)
      } else {
        console.log(`[axiom] Scheduled "${scheduledTask.name}" next run at ${nextRun.toISOString()} (in ${Math.round(delayMs / 60000)} min)`)
      }
    } catch (err) {
      console.error(`[axiom] Failed to schedule "${scheduledTask.name}":`, (err as Error).message)
    }
  }

  /**
   * Called when a cron timer fires
   */
  private async onCronFired(scheduledTaskId: string): Promise<void> {
    // Remove the old timer entry
    this.schedules.delete(scheduledTaskId)

    // Re-read from DB (may have been updated/disabled)
    const scheduledTask = this.scheduledTaskStore.getById(scheduledTaskId)
    if (!scheduledTask || !scheduledTask.enabled) return

    // Deduplication guard: skip if this cronjob already fired very recently
    // (protects against double-fire from server restarts / watch-mode reloads)
    if (this.wasFiredRecently(scheduledTask)) {
      console.log(`[axiom] Skipping cronjob "${scheduledTask.name}" — already fired recently (lastRunAt: ${scheduledTask.lastRunAt})`)
      // Still schedule the next run
      if (this.running) {
        this.setNextTimer(scheduledTask)
      }
      return
    }

    try {
      if (scheduledTask.actionType === 'injection') {
        this.fireInjection(scheduledTask)
        console.log(`[axiom] Cronjob "${scheduledTask.name}" fired → injection`)
      } else {
        const taskId = await this.fireTask(scheduledTask)
        if (taskId) {
          console.log(`[axiom] Cronjob "${scheduledTask.name}" fired → task ${taskId}`)
        }
      }
    } catch (err) {
      console.error(`[axiom] Cronjob "${scheduledTask.name}" failed to fire:`, (err as Error).message)
    }

    // Schedule the next run (if still enabled and running)
    if (this.running) {
      const refreshed = this.scheduledTaskStore.getById(scheduledTaskId)
      if (refreshed && refreshed.enabled) {
        this.setNextTimer(refreshed)
      }
    }
  }

  /**
   * Fire an injection — deliver the reminder/injection message.
   */
  private fireInjection(scheduledTask: ScheduledTask): void {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

    // Update last_run fields
    this.scheduledTaskStore.update(scheduledTask.id, {
      lastRunAt: now,
      lastRunStatus: 'completed',
    })

    // Deliver via callback
    if (this.options.onInjection) {
      this.options.onInjection(scheduledTask)
    } else {
      console.warn(`[axiom] Injection cronjob "${scheduledTask.name}" fired but no onInjection handler is set`)
    }

    // Auto-disable if this is effectively a one-time schedule
    // (next run > 364 days away — e.g. a specific date/time cron)
    this.autoDisableIfOneTime(scheduledTask)
  }

  /**
   * Check if a scheduled task's next run is far in the future (> 364 days)
   * and auto-disable it if so. This handles "one-time" reminders that use
   * specific date/time cron expressions like "35 13 30 3 *".
   */
  private autoDisableIfOneTime(scheduledTask: ScheduledTask): void {
    try {
      const fields = parseCronExpression(scheduledTask.schedule)
      const nextRun = getNextRunTime(fields)
      if (!nextRun) {
        // No next run at all — disable
        this.scheduledTaskStore.update(scheduledTask.id, { enabled: false })
        this.unregisterSchedule(scheduledTask.id)
        console.log(`[axiom] Auto-disabled one-time schedule "${scheduledTask.name}" (no future run found)`)
        return
      }

      const delayMs = nextRun.getTime() - Date.now()
      if (delayMs > ONE_TIME_THRESHOLD_MS) {
        this.scheduledTaskStore.update(scheduledTask.id, { enabled: false })
        this.unregisterSchedule(scheduledTask.id)
        console.log(`[axiom] Auto-disabled one-time schedule "${scheduledTask.name}" (next run ${Math.round(delayMs / 86400000)} days away)`)
      }
    } catch {
      // ignore parse errors
    }
  }

  /**
   * Fire a scheduled task — create a task via TaskRunner
   */
  private async fireTask(scheduledTask: ScheduledTask): Promise<string | null> {
    // Resolve provider — the stored value is either a `providerId:modelId`
    // composite (same format used everywhere else in settings) or, for legacy
    // rows, a plain provider name/id. `parseProviderModelId` handles both:
    // without a colon it returns `{ providerId: <raw> }` and modelId stays undefined.
    let provider: ProviderConfig | null
    let modelOverride: string | undefined
    if (scheduledTask.provider) {
      const { providerId, modelId } = parseProviderModelId(scheduledTask.provider)
      const resolved = providerId ? this.options.resolveProvider(providerId) : null
      provider = resolved ?? this.options.getDefaultProvider()
      modelOverride = modelId
    } else {
      provider = this.options.getDefaultProvider()
    }

    if (!provider) {
      console.warn(`[axiom] Cronjob "${scheduledTask.name}" skipped: no provider available (configure a task default or an active provider)`)
      return null
    }

    // When the cronjob pins a specific model, pass that model through to the
    // task runner via a cloned provider config (matches the pattern used by
    // `getTaskDefaultProvider` in runtime-composition).
    if (modelOverride) {
      provider = { ...provider, enabledModels: [modelOverride] }
    }

    // Create task in the task store — sessionId is created by the
    // TaskRunner via SessionManager when the task starts.
    // A cronjob is considered to run on the "default" provider/model when its
    // stored `provider` is null — in that case `getDefaultProvider()` above
    // decided the (provider, model) pair, which matches what the Settings
    // UI exposes as the Task Default.
    const task = this.taskStore.create({
      name: scheduledTask.name,
      prompt: scheduledTask.prompt,
      triggerType: 'cronjob',
      triggerSourceId: scheduledTask.id,
      provider: provider.name,
      model: getProviderDefaultModel(provider),
      isDefaultModel: !scheduledTask.provider,
      // Route the task result back to the cronjob's persona (runtime +
      // Telegram bot). Deterministic from the DB row, never LLM-inferred.
      agentId: scheduledTask.agentId,
    })

    // Update last_run_at on the scheduled task
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    this.scheduledTaskStore.update(scheduledTask.id, {
      lastRunAt: now,
      lastRunTaskId: task.id,
      lastRunStatus: 'running',
    })

    // Build overrides from scheduled task
    const overrides: TaskOverrides = {
      toolsOverride: scheduledTask.toolsOverride,
      skillsOverride: scheduledTask.skillsOverride,
      systemPromptOverride: scheduledTask.systemPromptOverride,
      attachedSkills: scheduledTask.attachedSkills,
    }

    // Start the task
    try {
      await this.taskRunner.startTask(task, provider, overrides)

      // Subscribe to task completion to update last_run_status
      this.watchTaskCompletion(scheduledTask.id, task.id)

      return task.id
    } catch (err) {
      // Update status to failed
      this.scheduledTaskStore.update(scheduledTask.id, {
        lastRunStatus: 'failed',
      })
      throw err
    }
  }

  /**
   * Poll for task completion to update the scheduled task's last_run_status
   */
  private watchTaskCompletion(scheduledTaskId: string, taskId: string): void {
    const checkInterval = setInterval(() => {
      const task = this.taskStore.getById(taskId)
      if (!task) {
        clearInterval(checkInterval)
        return
      }

      if (task.status === 'completed' || task.status === 'failed') {
        this.scheduledTaskStore.update(scheduledTaskId, {
          lastRunStatus: task.status,
        })
        clearInterval(checkInterval)
      }
    }, 5000) // Check every 5 seconds

    // Don't keep the process alive
    if (typeof checkInterval === 'object' && 'unref' in checkInterval) {
      checkInterval.unref()
    }
  }

  /**
   * Dispose the scheduler
   */
  dispose(): void {
    this.stop()
  }
}
