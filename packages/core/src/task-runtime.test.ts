import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDatabase } from './database.js'
import { createTaskRuntime } from './task-runtime.js'
import type { Database } from './database.js'
import type { ProviderConfig } from './provider-config.js'
import { SessionManager } from './session-manager.js'

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    estimateCost: vi.fn(() => 0.001),
  }
})

vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation(() => {
      let listener: ((event: unknown) => void) | null = null
      const messages: unknown[] = []

      return {
        subscribe: vi.fn((fn: (event: unknown) => void) => {
          listener = fn
          return () => { listener = null }
        }),
        prompt: vi.fn(async () => {
          listener?.({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Task done successfully' }],
              provider: 'test-provider',
              model: 'test-model',
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0.001 },
              },
            },
          })
          listener?.({ type: 'agent_end', messages: [] })

          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Task done successfully' }],
          })
        }),
        abort: vi.fn(),
        state: {
          get messages() {
            return messages
          },
        },
      }
    }),
  }
})

const mockProvider: ProviderConfig = {
  id: 'test-provider-id',
  name: 'test-provider',
  type: 'openai',
  providerType: 'openai',
  provider: 'openai',
  baseUrl: 'http://localhost:1234',
  apiKey: 'test-key',
  enabledModels: ['test-model'],
  models: [],
  status: 'connected',
  authMethod: 'api-key',
}

describe('TaskRuntime boundary', () => {
  const resources: Array<{ db: Database; dispose: () => void }> = []

  afterEach(() => {
    for (const { db, dispose } of resources.splice(0)) {
      dispose()
      db.close()
    }
  })

  function createRuntimeHarness() {
    const db = initDatabase(':memory:')
    const onTaskComplete = vi.fn()
    const onInjection = vi.fn()
    const sessionManager = new SessionManager({ db })

    const runtime = createTaskRuntime({
      db,
      runner: {
        buildModel: () => ({ id: 'test-model' } as never),
        getApiKey: async () => 'test-key',
        tools: [],
        onTaskComplete,
        sessionManager,
      },
      scheduler: {
        getDefaultProvider: () => mockProvider,
        resolveProvider: () => mockProvider,
        onInjection,
      },
    })

    resources.push({ db, dispose: () => runtime.dispose() })
    return { runtime, onTaskComplete, onInjection }
  }

  it('runs task lifecycle behind the tasks boundary', async () => {
    const { runtime, onTaskComplete } = createRuntimeHarness()

    const task = runtime.tasks.create({
      name: 'Boundary task',
      prompt: 'Do something',
      triggerType: 'agent',
      sessionId: 'task-runtime-boundary-1',
    })

    await runtime.tasks.start(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 50))

    const updated = runtime.tasks.getById(task.id)
    expect(updated?.status).toBe('completed')
    expect(updated?.resultStatus).toBe('completed')
    expect(onTaskComplete).toHaveBeenCalledOnce()
  })

  it('manages schedule registration lifecycle behind the schedules boundary', () => {
    const { runtime } = createRuntimeHarness()

    runtime.schedules.create({
      name: 'Daily task',
      prompt: 'Run check',
      schedule: '0 9 * * *',
      enabled: true,
    })

    runtime.schedules.start()
    expect(runtime.schedules.getActiveSchedules()).toHaveLength(1)

    runtime.schedules.stop()
    expect(runtime.schedules.getActiveSchedules()).toHaveLength(0)
  })

  it('triggers cronjob execution via schedule boundary contracts', async () => {
    const { runtime } = createRuntimeHarness()

    const cronjob = runtime.schedules.create({
      name: 'Manual trigger task',
      prompt: 'Run now',
      schedule: '0 9 * * *',
      actionType: 'task',
      enabled: true,
    })

    const taskId = await runtime.schedules.triggerNow(cronjob.id)
    expect(taskId).toBeTruthy()

    const createdTask = taskId ? runtime.tasks.getById(taskId) : null
    expect(createdTask?.triggerType).toBe('cronjob')

    const updatedCronjob = runtime.schedules.getById(cronjob.id)
    expect(updatedCronjob?.lastRunTaskId).toBe(taskId)
  })
})
