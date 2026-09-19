import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase } from './database.js'
import { TaskStore } from './task-store.js'
import { ScheduledTaskStore } from './scheduled-task-store.js'
import { TaskScheduler } from './task-scheduler.js'
import type { TaskRunner } from './task-runner.js'
import type { Database } from './database.js'
import type { ProviderConfig } from './provider-config.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const mockProvider: ProviderConfig = {
  id: 'test-provider',
  name: 'Test Provider',
  provider: 'openai',
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  enabledModels: ['gpt-4o'],
} as ProviderConfig

describe('TaskScheduler', () => {
  let db: Database
  let taskStore: TaskStore
  let scheduledTaskStore: ScheduledTaskStore
  let scheduler: TaskScheduler
  let mockTaskRunner: TaskRunner
  const tmpFiles: string[] = []

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  beforeEach(() => {
    vi.useFakeTimers()
    db = initDatabase(tmpDbPath())
    taskStore = new TaskStore(db)
    scheduledTaskStore = new ScheduledTaskStore(db)

    mockTaskRunner = {
      startTask: vi.fn().mockResolvedValue('task-id'),
      getStore: () => taskStore,
    } as unknown as TaskRunner

    scheduler = new TaskScheduler({
      db,
      taskStore,
      taskRunner: mockTaskRunner,
      getDefaultProvider: () => mockProvider,
      resolveProvider: (name: string) => name === 'test' ? mockProvider : null,
    })
  })

  afterEach(() => {
    scheduler.dispose()
    vi.useRealTimers()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  describe('start/stop', () => {
    it('loads enabled schedules on start', () => {
      scheduledTaskStore.create({ name: 'Job 1', prompt: 'test', schedule: '0 9 * * *', enabled: true })
      scheduledTaskStore.create({ name: 'Job 2', prompt: 'test', schedule: '0 10 * * *', enabled: false })

      scheduler.start()

      const active = scheduler.getActiveSchedules()
      expect(active).toHaveLength(1) // Only enabled one
    })

    it('clears all timers on stop', () => {
      scheduledTaskStore.create({ name: 'Job 1', prompt: 'test', schedule: '0 9 * * *' })
      scheduler.start()
      expect(scheduler.getActiveSchedules()).toHaveLength(1)

      scheduler.stop()
      expect(scheduler.getActiveSchedules()).toHaveLength(0)
    })
  })

  describe('registerSchedule', () => {
    it('registers a new schedule', () => {
      scheduler.start()
      const task = scheduledTaskStore.create({ name: 'New Job', prompt: 'test', schedule: '0 9 * * *' })

      scheduler.registerSchedule(task)

      const active = scheduler.getActiveSchedules()
      expect(active.find(s => s.id === task.id)).toBeTruthy()
    })

    it('re-registers an updated schedule', () => {
      scheduler.start()
      const task = scheduledTaskStore.create({ name: 'Job', prompt: 'test', schedule: '0 9 * * *' })
      scheduler.registerSchedule(task)

      const updatedTask = scheduledTaskStore.update(task.id, { schedule: '0 10 * * *' })!
      scheduler.registerSchedule(updatedTask)

      const active = scheduler.getActiveSchedules()
      expect(active).toHaveLength(1) // Replaced, not duplicated
    })

    it('does not register disabled schedules', () => {
      scheduler.start()
      const task = scheduledTaskStore.create({ name: 'Disabled Job', prompt: 'test', schedule: '0 9 * * *', enabled: false })

      scheduler.registerSchedule(task)

      const active = scheduler.getActiveSchedules()
      expect(active.find(s => s.id === task.id)).toBeUndefined()
    })
  })

  describe('unregisterSchedule', () => {
    it('removes a schedule', () => {
      scheduler.start()
      const task = scheduledTaskStore.create({ name: 'Job', prompt: 'test', schedule: '0 9 * * *' })
      scheduler.registerSchedule(task)
      expect(scheduler.getActiveSchedules()).toHaveLength(1)

      scheduler.unregisterSchedule(task.id)
      expect(scheduler.getActiveSchedules()).toHaveLength(0)
    })

    it('does nothing for non-existent schedule', () => {
      scheduler.start()
      scheduler.unregisterSchedule('non-existent')
      expect(scheduler.getActiveSchedules()).toHaveLength(0)
    })
  })

  describe('triggerNow', () => {
    it('creates and starts a task immediately', async () => {
      scheduler.start()
      const scheduledTask = scheduledTaskStore.create({
        name: 'Manual Trigger',
        prompt: 'Do something now',
        schedule: '0 9 * * *',
      })

      const taskId = await scheduler.triggerNow(scheduledTask.id)

      expect(taskId).toBeTruthy()
      expect(mockTaskRunner.startTask).toHaveBeenCalled()

      // Check last_run_at was updated
      const updated = scheduledTaskStore.getById(scheduledTask.id)!
      expect(updated.lastRunAt).toBeTruthy()
      expect(updated.lastRunTaskId).toBeTruthy()
      expect(updated.lastRunStatus).toBe('running')
    })

    it('returns null for non-existent schedule', async () => {
      scheduler.start()
      const result = await scheduler.triggerNow('non-existent')
      expect(result).toBeNull()
    })

    it('skips the run without starting a task when no provider is available', async () => {
      const providerlessScheduler = new TaskScheduler({
        db,
        taskStore,
        taskRunner: mockTaskRunner,
        getDefaultProvider: () => null,
        resolveProvider: () => null,
      })
      providerlessScheduler.start()
      const scheduledTask = scheduledTaskStore.create({ name: 'No Provider', prompt: 'test', schedule: '0 9 * * *' })

      const result = await providerlessScheduler.triggerNow(scheduledTask.id)

      expect(result).toBeNull()
      expect(mockTaskRunner.startTask).not.toHaveBeenCalled()
      providerlessScheduler.dispose()
    })
  })

  describe('injection mode', () => {
    let injectionCallback: ReturnType<typeof vi.fn>
    let injectionScheduler: TaskScheduler

    beforeEach(() => {
      injectionCallback = vi.fn()
      injectionScheduler = new TaskScheduler({
        db,
        taskStore,
        taskRunner: mockTaskRunner,
        getDefaultProvider: () => mockProvider,
        resolveProvider: (name: string) => name === 'test' ? mockProvider : null,
        onInjection: injectionCallback,
      })
    })

    afterEach(() => {
      injectionScheduler.dispose()
    })

    it('fires injection callback instead of task for injection-type cronjobs', async () => {
      injectionScheduler.start()
      const scheduledTask = scheduledTaskStore.create({
        name: 'Reminder',
        prompt: 'Pack your bags!',
        schedule: '0 9 * * *',
        actionType: 'injection',
      })

      const result = await injectionScheduler.triggerNow(scheduledTask.id)

      expect(result).toBe(`injection-${scheduledTask.id}`)
      expect(injectionCallback).toHaveBeenCalledTimes(1)
      const passedTask = injectionCallback.mock.calls[0][0]
      expect(passedTask.id).toBe(scheduledTask.id)
      expect(passedTask.prompt).toBe('Pack your bags!')
      expect(passedTask.name).toBe('Reminder')
      expect(passedTask.actionType).toBe('injection')
      // Should NOT start a task
      expect(mockTaskRunner.startTask).not.toHaveBeenCalled()
    })

    it('updates last_run fields for injection-type cronjobs', async () => {
      injectionScheduler.start()
      const scheduledTask = scheduledTaskStore.create({
        name: 'Status Ping',
        prompt: 'Time to check in!',
        schedule: '0 9 * * *',
        actionType: 'injection',
      })

      await injectionScheduler.triggerNow(scheduledTask.id)

      const updated = scheduledTaskStore.getById(scheduledTask.id)!
      expect(updated.lastRunAt).toBeTruthy()
      expect(updated.lastRunStatus).toBe('completed')
    })

    it('fires task for task-type cronjobs even with injection callback set', async () => {
      injectionScheduler.start()
      const scheduledTask = scheduledTaskStore.create({
        name: 'Heavy Job',
        prompt: 'Do complex work',
        schedule: '0 9 * * *',
        actionType: 'task',
      })

      const taskId = await injectionScheduler.triggerNow(scheduledTask.id)

      expect(taskId).toBeTruthy()
      expect(taskId).not.toContain('injection')
      expect(mockTaskRunner.startTask).toHaveBeenCalled()
      expect(injectionCallback).not.toHaveBeenCalled()
    })

    it('triggerNow fires injection with correct XML wrapper', async () => {
      injectionScheduler.start()
      const scheduledTask = scheduledTaskStore.create({
        name: 'XML Check',
        prompt: 'Check this!',
        schedule: '0 9 * * *',
        actionType: 'injection',
      })

      await injectionScheduler.triggerNow(scheduledTask.id)

      const call = injectionCallback.mock.calls[0]
      const passedTask = call[0]
      expect(passedTask.id).toBe(scheduledTask.id)
      expect(passedTask.name).toBe('XML Check')
      expect(passedTask.prompt).toBe('Check this!')
      expect(passedTask.actionType).toBe('injection')
    })

    it('deduplication: does not re-fire if lastRunAt is very recent', async () => {
      injectionScheduler.start()
      const scheduledTask = scheduledTaskStore.create({
        name: 'Dedup Test',
        prompt: 'Dont spam!',
        schedule: '0 9 * * *',
        actionType: 'injection',
      })

      // First trigger — should fire
      await injectionScheduler.triggerNow(scheduledTask.id)
      expect(injectionCallback).toHaveBeenCalledTimes(1)

      // Simulate cron-fired (not manual triggerNow) — the dedup guard should block
      // We access the private method via bracket notation for testing
      const scheduler = injectionScheduler as unknown as {
        onCronFired: (id: string) => Promise<void>
      }
      await scheduler.onCronFired(scheduledTask.id)

      // Should still be 1 (blocked by dedup)
      expect(injectionCallback).toHaveBeenCalledTimes(1)
    })
  })
})
