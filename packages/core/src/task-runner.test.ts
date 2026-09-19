import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase } from './database.js'
import { TaskStore } from './task-store.js'
import { TaskRunner, TASK_PROGRESS_FRAME_INTERVAL_MS, formatTaskInjection, parseTaskTimestampMs } from './task-runner.js'
import type { TaskRunnerOptions, TaskOverrides } from './task-runner.js'
import type { Database } from './database.js'
import type { ProviderConfig } from './provider-config.js'
import { SessionManager } from './session-manager.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Mock estimateCost to avoid needing a real model
vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    estimateCost: vi.fn(() => 0.001),
  }
})

interface CapturedAgentOptions {
  getApiKey?: () => unknown
}
interface AgentOptionsBox {
  value: CapturedAgentOptions | null
}
const lastAgentOptions: AgentOptionsBox = { value: null }
function recordAgentOptions(options: CapturedAgentOptions): void {
  lastAgentOptions.value = options
}
function resetAgentOptions(): void {
  lastAgentOptions.value = null
}
function getCapturedAgentOptions(): CapturedAgentOptions {
  const v = lastAgentOptions.value
  if (!v) throw new Error('Agent options not captured')
  return v
}

// Mock the PiAgent to avoid actual LLM calls
vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation((options: CapturedAgentOptions) => {
      recordAgentOptions(options)
      let subscribeFn: ((event: unknown) => void) | null = null
      const messages: unknown[] = []

      return {
        subscribe: vi.fn((fn: (event: unknown) => void) => {
          subscribeFn = fn
          return () => { subscribeFn = null }
        }),
        prompt: vi.fn(async () => {
          // Simulate a successful completion with assistant message
          if (subscribeFn) {
            subscribeFn({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Task done successfully' }],
                provider: 'test-provider',
                model: 'test-model',
                usage: {
                  input: 100,
                  output: 50,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0.001 },
                },
              },
            })
            subscribeFn({
              type: 'agent_end',
              messages: [],
            })
          }
          // Add message to state
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Task done successfully' }],
          })
        }),
        abort: vi.fn(),
        state: {
          get messages() { return messages },
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

describe('TaskRunner', () => {
  let db: Database
  let store: TaskStore
  let runner: TaskRunner
  let sessionManager: SessionManager
  const tmpFiles: string[] = []
  let onTaskCompleteCalls: { taskId: string; injection: string }[] = []
  let onTaskPausedCalls: { taskId: string; injection: string }[] = []

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-runner-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  beforeEach(() => {
    db = initDatabase(tmpDbPath())
    store = new TaskStore(db)
    sessionManager = new SessionManager({ db })
    onTaskCompleteCalls = []
    onTaskPausedCalls = []

    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      memoryDir: undefined,
      onTaskComplete: (taskId: string, injection: string) => {
        onTaskCompleteCalls.push({ taskId, injection })
      },
      onTaskPaused: (taskId: string, injection: string) => {
        onTaskPausedCalls.push({ taskId, injection })
      },
      sessionManager,
    }

    runner = new TaskRunner(options)
  })

  afterEach(() => {
    runner.dispose()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  describe('task lifecycle: create → run → complete', () => {
    it('starts a task and marks it as completed', async () => {
      const task = store.create({
        name: 'Test Task',
        prompt: 'Build something',
        triggerType: 'agent',
        sessionId: 'task-session-1',
      })

      await runner.startTask(task, mockProvider)

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('completed')
      expect(updated.resultStatus).toBe('completed')
      expect(updated.resultSummary).toBe('Task done successfully')
      expect(updated.startedAt).toBeTruthy()
      expect(updated.completedAt).toBeTruthy()
      expect(updated.provider).toBe('test-provider')
      expect(updated.model).toBe('test-model')
    })

    it('calls onTaskComplete with injection message', async () => {
      const task = store.create({
        name: 'Notify Task',
        prompt: 'Do work',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(onTaskCompleteCalls).toHaveLength(1)
      expect(onTaskCompleteCalls[0].taskId).toBe(task.id)
      expect(onTaskCompleteCalls[0].injection).toContain('<task_injection')
      expect(onTaskCompleteCalls[0].injection).toContain('task_name="Notify Task"')
      expect(onTaskCompleteCalls[0].injection).toContain('status="completed"')
    })

    it('fires onTaskLifecycle started before the run and finished after it', async () => {
      // The strand activity view lives off these two signals: without
      // `started`, a sub-task is invisible until it finishes.
      const lifecycle: { phase: string; id: string; status: string }[] = []
      const localRunner = new TaskRunner({
        db,
        buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
        getApiKey: async () => 'test-key',
        tools: [],
        onTaskComplete: () => { },
        onTaskLifecycle: (phase, t) => lifecycle.push({ phase, id: t.id, status: t.status }),
        sessionManager,
      })
      const task = store.create({ name: 'Lifecycle', prompt: 'Do work', triggerType: 'agent' })

      await localRunner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(lifecycle.map(l => l.phase)).toEqual(['started', 'finished'])
      expect(lifecycle.every(l => l.id === task.id)).toBe(true)
      expect(lifecycle[1].status).toBe('completed')
      localRunner.dispose()
    })

    it('tracks token usage', async () => {
      const task = store.create({
        name: 'Token Task',
        prompt: 'Count tokens',
        triggerType: 'agent',
        sessionId: 'task-token-session',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.promptTokens).toBe(100)
      expect(updated.completionTokens).toBe(50)
      expect(updated.estimatedCost).toBeGreaterThan(0)

      // Check that token usage was logged to the token_usage table
      const tokenRows = db.prepare('SELECT * FROM token_usage WHERE session_id = ?').all('task-token-session') as Array<Record<string, unknown>>
      expect(tokenRows.length).toBeGreaterThan(0)
      expect(tokenRows[0].prompt_tokens).toBe(100)
      expect(tokenRows[0].completion_tokens).toBe(50)
    })
  })

  describe('task lifecycle: create → run → fail', () => {
    it('marks task as failed when agent throws', async () => {
      // Override mock to throw
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            throw new Error('LLM API error')
          }),
          abort: vi.fn(),
          state: { messages: [] },
        }
      })

      const task = store.create({
        name: 'Fail Task',
        prompt: 'This will fail',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.resultStatus).toBe('failed')
      expect(updated.errorMessage).toBe('LLM API error')
      expect(updated.completedAt).toBeTruthy()

      // Should still call onTaskComplete
      expect(onTaskCompleteCalls).toHaveLength(1)
      expect(onTaskCompleteCalls[0].injection).toContain('status="failed"')
    })
  })

  describe('max duration timeout', () => {
    it('aborts task via abortTask method', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let resolvePrompt: (() => void) | null = null
      let abortCalled = false
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(() => new Promise<void>((resolve) => {
            resolvePrompt = resolve
          })),
          abort: vi.fn(() => {
            abortCalled = true
            // When abort is called, resolve the promise so runTaskAsync catches the error
            if (resolvePrompt) resolvePrompt()
          }),
          state: { messages: [] },
        }
      })

      const task = store.create({
        name: 'Timeout Task',
        prompt: 'Long running task',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)

      // Task should be running (prompt is blocked)
      expect(runner.isRunning(task.id)).toBe(true)

      // Abort it (simulates what timeout would do)
      runner.abortTask(task.id, 'Max duration exceeded')

      // abortTask updates the DB synchronously
      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.errorMessage).toBe('Max duration exceeded')
      expect(runner.isRunning(task.id)).toBe(false)
      expect(abortCalled).toBe(true)
    })
  })

  describe('formatTaskInjection', () => {
    it('formats a completed task injection correctly', () => {
      const task = store.create({
        name: 'Format Test',
        prompt: 'test',
        triggerType: 'agent',
      })
      store.update(task.id, {
        resultStatus: 'completed',
        resultSummary: 'Built the app successfully',
        promptTokens: 5000,
        completionTokens: 2000,
      })

      const updated = store.getById(task.id)!
      const injection = formatTaskInjection(updated, 5)

      expect(injection).toContain(`task_id="${task.id}"`)
      expect(injection).toContain('task_name="Format Test"')
      expect(injection).toContain('status="completed"')
      expect(injection).toContain('trigger="agent"')
      expect(injection).toContain('duration_minutes="5"')
      expect(injection).toContain('tokens_used="7000"')
      expect(injection).toContain('Built the app successfully')
    })

    it('formats a failed task injection correctly', () => {
      const task = store.create({
        name: 'Failed Task',
        prompt: 'test',
        triggerType: 'user',
      })
      store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        errorMessage: 'API rate limit hit',
      })

      const updated = store.getById(task.id)!
      const injection = formatTaskInjection(updated, 2)

      expect(injection).toContain('status="failed"')
      expect(injection).toContain('trigger="user"')
      expect(injection).toContain('API rate limit hit')
    })
  })

  describe('getRunningTaskIds', () => {
    it('tracks running tasks', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let resolvePrompt: (() => void) | null = null
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(() => new Promise<void>((resolve) => {
            resolvePrompt = resolve
          })),
          abort: vi.fn(() => { if (resolvePrompt) resolvePrompt() }),
          state: { messages: [] },
        }
      })

      const task = store.create({
        name: 'Running Task',
        prompt: 'work',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)

      expect(runner.getRunningTaskIds()).toContain(task.id)
      expect(runner.isRunning(task.id)).toBe(true)

      runner.abortTask(task.id)
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(runner.isRunning(task.id)).toBe(false)
    })
  })

  describe('zombie task handling', () => {
    it('abortTask finalizes a running DB row even when not in runningTasks map', () => {
      // Simulate a "zombie" task: status='running' in DB but never registered
      // with the runner (e.g. the process restarted, or startTask threw
      // before runTaskAsync took over). Kill button must still work.
      const task = store.create({
        name: 'Zombie Task',
        prompt: 'never actually ran',
        triggerType: 'cronjob',
      })

      expect(task.status).toBe('running')
      expect(runner.isRunning(task.id)).toBe(false)

      runner.abortTask(task.id, 'Killed by user from web UI')

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.resultStatus).toBe('failed')
      expect(updated.errorMessage).toBe('Killed by user from web UI')
      expect(updated.completedAt).toBeTruthy()
    })

    it('abortTask is a no-op on already-finalized tasks', () => {
      const task = store.create({
        name: 'Already Done',
        prompt: 'x',
        triggerType: 'agent',
      })
      const completedAt = '2025-01-01 00:00:00'
      store.update(task.id, {
        status: 'completed',
        resultStatus: 'completed',
        resultSummary: 'Done',
        completedAt,
      })

      runner.abortTask(task.id, 'late kill')

      const after = store.getById(task.id)!
      expect(after.status).toBe('completed')
      expect(after.resultSummary).toBe('Done')
      expect(after.completedAt).toBe(completedAt)
    })

    it('startTask marks task as failed when setup throws', async () => {
      const failingRunner = new TaskRunner({
        db,
        buildModel: () => {
          throw new Error('provider misconfigured')
        },
        getApiKey: async () => 'test-key',
        tools: [],
        memoryDir: undefined,
        sessionManager,
        onTaskComplete: () => {},
        onTaskPaused: () => {},
      })

      const task = store.create({
        name: 'Broken Provider Task',
        prompt: 'should fail at startup',
        triggerType: 'agent',
      })
      expect(task.status).toBe('running')

      await expect(failingRunner.startTask(task, mockProvider)).rejects.toThrow('provider misconfigured')

      const after = store.getById(task.id)!
      expect(after.status).toBe('failed')
      expect(after.resultStatus).toBe('failed')
      expect(after.errorMessage).toContain('provider misconfigured')
      expect(after.completedAt).toBeTruthy()
      expect(failingRunner.isRunning(task.id)).toBe(false)

      failingRunner.dispose()
    })
  })

  describe('pause/resume lifecycle', () => {
    it('pauses a task when agent outputs STATUS: question', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = []
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: What database should I use? PostgreSQL or MySQL?' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Question Task',
        prompt: 'Build a web app',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('paused')
      expect(updated.resultStatus).toBe('question')
      expect(updated.resultSummary).toContain('What database should I use?')
      expect(updated.completedAt).toBeNull()

      // Task should be in paused map, not running
      expect(runner.isRunning(task.id)).toBe(false)
      expect(runner.isPaused(task.id)).toBe(true)
      expect(runner.getPausedTaskIds()).toContain(task.id)

      // onTaskPaused should have been called
      expect(onTaskPausedCalls).toHaveLength(1)
      expect(onTaskPausedCalls[0].taskId).toBe(task.id)
      expect(onTaskPausedCalls[0].injection).toContain('status="question"')
      expect(onTaskPausedCalls[0].injection).toContain('What database should I use?')

      // onTaskComplete should NOT have been called
      expect(onTaskCompleteCalls).toHaveLength(0)
    })

    it('resumes a paused task and completes', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let promptCount = 0
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            promptCount++
            if (promptCount === 1) {
              // First prompt: ask a question
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: Which framework should I use?' }],
              })
            } else {
              // Second prompt (resume): complete the task
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Built the app using React as requested.' }],
              })
            }
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Resume Task',
        prompt: 'Build a web app',
        triggerType: 'agent',
      })

      // Start → pauses with question
      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(runner.isPaused(task.id)).toBe(true)
      expect(store.getById(task.id)!.status).toBe('paused')

      // Resume with answer
      const resumed = await runner.resumeTask(task.id, 'Use React please')
      expect(resumed).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 100))

      // Task should be completed
      const updated = store.getById(task.id)!
      expect(updated.status).toBe('completed')
      expect(updated.resultStatus).toBe('completed')
      expect(updated.resultSummary).toContain('Built the app using React')
      expect(updated.completedAt).toBeTruthy()

      // Should not be in paused or running maps
      expect(runner.isPaused(task.id)).toBe(false)
      expect(runner.isRunning(task.id)).toBe(false)

      // onTaskComplete should have been called
      expect(onTaskCompleteCalls).toHaveLength(1)
      expect(onTaskCompleteCalls[0].injection).toContain('status="completed"')
    })

    it('status transitions: running → paused → running → completed', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let promptCount = 0
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            promptCount++
            if (promptCount === 1) {
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: Need clarification' }],
              })
            } else {
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Done' }],
              })
            }
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Transition Task',
        prompt: 'Do work',
        triggerType: 'agent',
      })

      // running
      expect(store.getById(task.id)!.status).toBe('running')

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      // paused
      expect(store.getById(task.id)!.status).toBe('paused')

      await runner.resumeTask(task.id, 'Clarification provided')
      await new Promise(resolve => setTimeout(resolve, 100))

      // completed
      expect(store.getById(task.id)!.status).toBe('completed')
    })

    it('returns false when resuming a non-paused task', async () => {
      const result = await runner.resumeTask('non-existent-id', 'hello')
      expect(result).toBe(false)
    })
  })

  describe('24h cleanup of stale paused tasks', () => {
    it('cleans up tasks paused for >24h', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = []
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: What should I do?' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Stale Task',
        prompt: 'Do something',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(runner.isPaused(task.id)).toBe(true)

      // Manually set pausedAt to >24h ago by accessing private field
      const pausedTasks = (runner as unknown as { pausedTasks: Map<string, { pausedAt: number }> }).pausedTasks
      const pausedTask = pausedTasks.get(task.id)!
      pausedTask.pausedAt = Date.now() - (25 * 60 * 60 * 1000) // 25 hours ago

      // Run cleanup
      const cleaned = runner.cleanupStalePausedTasks()
      expect(cleaned).toBe(1)

      // Task should be removed from memory
      expect(runner.isPaused(task.id)).toBe(false)

      // Task should be marked as failed in DB
      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.resultStatus).toBe('failed')
      expect(updated.errorMessage).toBe('timeout — no response received')
      expect(updated.completedAt).toBeTruthy()

      // onTaskComplete should have been called for the timed-out task
      expect(onTaskCompleteCalls).toHaveLength(1)
    })

    it('does not clean up tasks paused for <24h', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = []
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: What should I do?' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Fresh Task',
        prompt: 'Do something',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(runner.isPaused(task.id)).toBe(true)

      // Run cleanup — task is freshly paused, should not be cleaned
      const cleaned = runner.cleanupStalePausedTasks()
      expect(cleaned).toBe(0)
      expect(runner.isPaused(task.id)).toBe(true)
      expect(store.getById(task.id)!.status).toBe('paused')
    })
  })

  describe('maxDurationMinutes enforcement across pause/resume', () => {
    // Mocks an agent that asks a question on first prompt() and completes on
    // the second (resume) prompt() — only after a configurable delay so the
    // resumed run is observably long.
    function mockPauseThenSlowComplete(resumeDelayMs: number) {
      return async () => {
        const { Agent } = await import('@earendil-works/pi-agent-core')
        const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
        let callCount = 0
        let resumeAbort: (() => void) | null = null
        MockAgent.mockImplementationOnce(() => {
          let subscribeFn: ((event: unknown) => void) | null = null
          const messages: unknown[] = []
          return {
            subscribe: vi.fn((fn: (event: unknown) => void) => {
              subscribeFn = fn
              return () => { subscribeFn = null }
            }),
            prompt: vi.fn(async () => {
              callCount++
              if (callCount === 1) {
                messages.push({
                  role: 'assistant',
                  content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: ?' }],
                })
                return
              }
              // Resume call: block until either the delay elapses or abort()
              // is invoked (which is what the max-duration timer triggers).
              await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, resumeDelayMs)
                resumeAbort = () => { clearTimeout(t); resolve() }
              })
              if (subscribeFn) {
                subscribeFn({
                  type: 'message_end',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: done' }],
                    provider: 'test-provider',
                    model: 'test-model',
                    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
                  },
                })
              }
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: done' }],
              })
            }),
            abort: vi.fn(() => { if (resumeAbort) resumeAbort() }),
            state: { get messages() { return messages } },
          }
        })
      }
    }

    it('aborts a resumed task whose original maxDuration deadline has already passed', async () => {
      await mockPauseThenSlowComplete(60_000)()

      const task = store.create({
        name: 'Long-paused Task',
        prompt: 'work',
        triggerType: 'agent',
        maxDurationMinutes: 1, // 1 minute budget
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(runner.isPaused(task.id)).toBe(true)

      // Pretend the original task started 2 minutes ago — the 1-minute
      // budget has already been blown while the task sat paused.
      const longAgo = new Date(Date.now() - 2 * 60 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19)
      store.update(task.id, { startedAt: longAgo })

      const ok = await runner.resumeTask(task.id, 'go')
      expect(ok).toBe(true)

      // Resume must NOT leave the task running indefinitely — it should
      // abort synchronously because the deadline already passed.
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(runner.isRunning(task.id)).toBe(false)
      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.errorMessage).toBe('Max duration exceeded')
    })

    it('aborts a hung task that has no maxDurationMinutes via the runner-wide watchdog default', async () => {
      // Build a runner whose default kicks in for tasks without their own
      // limit (mirrors heartbeat/consolidation/cronjob tasks in production).
      const watchdogRunner = new TaskRunner({
        db,
        buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
        getApiKey: async () => 'test-key',
        tools: [],
        memoryDir: undefined,
        onTaskComplete: () => { /* ignore */ },
        sessionManager,
        defaultMaxDurationMinutes: 1, // 1-minute fallback
      })

      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      let resolvePrompt: (() => void) | null = null
      MockAgent.mockImplementationOnce(() => ({
        subscribe: vi.fn(() => () => {}),
        // Hang forever — no error, no return — simulating a dead provider.
        prompt: vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve })),
        abort: vi.fn(() => { if (resolvePrompt) resolvePrompt() }),
        state: { messages: [] },
      }))

      const task = store.create({
        name: 'Heartbeat-like Task',
        prompt: 'work',
        triggerType: 'heartbeat',
        // Intentionally no maxDurationMinutes — mirrors heartbeat/cron paths.
      })

      await watchdogRunner.startTask(task, mockProvider)
      expect(watchdogRunner.isRunning(task.id)).toBe(true)

      // Backdate startedAt so the watchdog deadline is already past, then
      // re-arm by aborting via the same code path the timer would use.
      const longAgo = new Date(Date.now() - 5 * 60 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19)
      store.update(task.id, { startedAt: longAgo })

      // Sanity-check the helper directly: re-invoking scheduling with a
      // past-deadline task must abort synchronously.
      const internal = watchdogRunner as unknown as {
        scheduleMaxDurationTimeout: (rt: { taskId: string; timeoutTimer: unknown; startedAtMs: number }, t: { id: string; maxDurationMinutes: number | null; startedAt: string | null }) => void
        runningTasks: Map<string, { taskId: string; timeoutTimer: unknown; startedAtMs: number }>
      }
      const rt = internal.runningTasks.get(task.id)!
      const refreshed = store.getById(task.id)!
      internal.scheduleMaxDurationTimeout(rt, refreshed)

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.errorMessage).toBe('Max duration exceeded')
      expect(watchdogRunner.isRunning(task.id)).toBe(false)

      watchdogRunner.dispose()
    })

    it('cleanupStalePausedTasks aborts paused tasks that exceeded maxDurationMinutes', async () => {
      await mockPauseThenSlowComplete(60_000)()

      const task = store.create({
        name: 'Paused past deadline',
        prompt: 'work',
        triggerType: 'agent',
        maxDurationMinutes: 1,
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(runner.isPaused(task.id)).toBe(true)

      // Backdate startedAt past the 1-minute budget. pausedAt is fresh,
      // so the 24h pause cap does NOT apply — only the maxDuration check
      // should trigger cleanup.
      const longAgo = new Date(Date.now() - 5 * 60 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19)
      store.update(task.id, { startedAt: longAgo })

      const cleaned = runner.cleanupStalePausedTasks()
      expect(cleaned).toBe(1)
      expect(runner.isPaused(task.id)).toBe(false)

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.errorMessage).toBe('Max duration exceeded')
    })
  })

  describe('server restart recovery', () => {
    it('marks paused tasks as failed on recovery', async () => {
      // Manually insert a paused task in DB (simulating a task left from a previous server session)
      const task = store.create({
        name: 'Paused Before Restart',
        prompt: 'Build something',
        triggerType: 'agent',
      })
      store.update(task.id, { status: 'paused', resultStatus: 'question', resultSummary: 'Which DB?' })

      const result = await runner.recoverTasks(
        () => mockProvider,
        mockProvider,
      )

      expect(result.failed).toBe(1)
      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.errorMessage).toBe('server restart')
      expect(updated.resultSummary).toContain('server restart')
    })

    it('resumes running tasks on recovery', async () => {
      // Manually insert a running task in DB
      const task = store.create({
        name: 'Running Before Restart',
        prompt: 'Build an app',
        triggerType: 'agent',
        sessionId: 'session-restart-test',
      })
      store.update(task.id, { status: 'running', provider: 'test-provider', model: 'test-model' })

      // Add some tool calls for the session
      db.prepare(
        "INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status) VALUES (?, ?, ?, ?, ?, 'success')"
      ).run('session-restart-test', 'read_file', '{"path":"index.ts"}', '"file contents"', 100)

      const result = await runner.recoverTasks(
        (name) => name === 'test-provider' ? mockProvider : null,
        mockProvider,
      )

      expect(result.resumed).toBe(1)

      // Original task should be marked as failed
      const original = store.getById(task.id)!
      expect(original.status).toBe('failed')
      expect(original.errorMessage).toBe('server restart')

      // A new resumed task should have been created
      const allTasks = store.list()
      const resumedTask = allTasks.find(t => t.name === 'Running Before Restart (resumed)')
      expect(resumedTask).toBeDefined()
      expect(resumedTask!.prompt).toContain('Build an app')
      expect(resumedTask!.prompt).toContain('server restart')
    })

    it('handles recovery with no orphaned tasks', async () => {
      const result = await runner.recoverTasks(
        () => mockProvider,
        mockProvider,
      )

      expect(result.resumed).toBe(0)
      expect(result.failed).toBe(0)
    })

    it('marks running task as failed when provider is not found and resume fails', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            throw new Error('Cannot connect')
          }),
          abort: vi.fn(),
          state: { messages: [] },
        }
      })

      const task = store.create({
        name: 'Unreachable Task',
        prompt: 'Work',
        triggerType: 'agent',
      })
      store.update(task.id, { status: 'running', provider: 'unknown-provider', model: 'model' })

      await runner.recoverTasks(
        () => null,
        mockProvider,
      )

      // Should attempt to resume with default provider but the mock throws
      // Wait for async task to complete
      await new Promise(resolve => setTimeout(resolve, 200))

      // Original task should be marked as failed (server restart)
      const original = store.getById(task.id)!
      expect(original.status).toBe('failed')
    })

    it('carries agentId over to the resumed task (multi-persona attribution)', async () => {
      const task = store.create({
        name: 'Warren Task',
        prompt: 'Work',
        triggerType: 'agent',
        agentId: 'warren',
      })
      store.update(task.id, { status: 'running' })

      await runner.recoverTasks(() => null, mockProvider)

      const resumed = store.list({}).find(t => t.name === 'Warren Task (resumed)')
      expect(resumed).toBeDefined()
      // Must NOT fall back to 'main': a NULL agent_id would be re-attributed to
      // main downstream and leak the task into the wrong persona.
      expect(resumed!.agentId).toBe('warren')
    })

    it('leaves agentId unset when the original task had none', async () => {
      const task = store.create({
        name: 'Unowned Task',
        prompt: 'Work',
        triggerType: 'agent',
      })
      store.update(task.id, { status: 'running' })

      await runner.recoverTasks(() => null, mockProvider)

      const resumed = store.list({}).find(t => t.name === 'Unowned Task (resumed)')
      expect(resumed).toBeDefined()
      expect(resumed!.agentId).toBeNull()
    })
  })

  describe('task overrides', () => {
    it('excludes tools listed in toolsOverride', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let capturedOptions: { initialState: { tools: Array<{ name: string }>; systemPrompt: string } } | null = null
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce((options: unknown) => {
        capturedOptions = options as typeof capturedOptions
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Done' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      // Recreate runner with named tools
      const toolA = { name: 'shell', description: 'Shell', parameters: {}, execute: async () => '' }
      const toolB = { name: 'read_file', description: 'Read', parameters: {}, execute: async () => '' }
      const toolC = { name: 'write_file', description: 'Write', parameters: {}, execute: async () => '' }

      const runnerWithTools = new TaskRunner({
        db,
        buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
        getApiKey: async () => 'test-key',
        tools: [toolA, toolB, toolC] as unknown as TaskRunnerOptions['tools'],
        onTaskComplete: () => {},
        sessionManager,
      })

      const task = store.create({
        name: 'Tool Override Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })

      const overrides: TaskOverrides = {
        toolsOverride: JSON.stringify(['shell', 'write_file']),
      }

      await runnerWithTools.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      // The PiAgent should have been created with only read_file
      expect(capturedOptions).toBeTruthy()
      const passedTools = capturedOptions!.initialState.tools
      expect(passedTools).toHaveLength(1)
      expect(passedTools[0].name).toBe('read_file')

      runnerWithTools.dispose()
    })

    it('excludes skills listed in skillsOverride (passed through to runner)', async () => {
      // Skills override is stored and passed through — the runner stores the override
      // and it's available for the system prompt builder to use.
      // For now we verify the override is accepted without error.
      const task = store.create({
        name: 'Skill Override Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })

      const overrides: TaskOverrides = {
        skillsOverride: JSON.stringify(['brave-search', 'web-browser']),
      }

      await runner.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('completed')
    })

    it('uses system prompt override when set', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let capturedOptions: { initialState: { tools: Array<{ name: string }>; systemPrompt: string } } | null = null
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce((options: unknown) => {
        capturedOptions = options as typeof capturedOptions
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Done with custom prompt' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Custom Prompt Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })

      const customPrompt = 'You are a specialized news summarizer. Only summarize tech news.'
      const overrides: TaskOverrides = {
        systemPromptOverride: customPrompt,
      }

      await runner.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      // The PiAgent should have been created with the custom system prompt
      expect(capturedOptions).toBeTruthy()
      expect(capturedOptions!.initialState.systemPrompt).toBe(customPrompt)

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('completed')
      expect(updated.resultSummary).toBe('Done with custom prompt')
    })

    it('uses default system prompt when systemPromptOverride is null', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let capturedOptions: { initialState: { tools: Array<{ name: string }>; systemPrompt: string } } | null = null
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce((options: unknown) => {
        capturedOptions = options as typeof capturedOptions
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Done' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Default Prompt Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })

      const overrides: TaskOverrides = {
        systemPromptOverride: null,
      }

      await runner.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should use default prompt (contains "background task agent")
      expect(capturedOptions!.initialState.systemPrompt).toContain('background task agent')
      expect(capturedOptions!.initialState.systemPrompt).toContain('Do work')
    })

    it('handles invalid toolsOverride JSON gracefully', async () => {
      const task = store.create({
        name: 'Bad JSON Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })

      const overrides: TaskOverrides = {
        toolsOverride: 'invalid-json',
      }

      // Should not throw, should use all tools
      await runner.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('completed')
    })
  })

  describe('attached skills injection', () => {
    let skillsTmpDir: string
    let originalDataDir: string | undefined

    beforeEach(() => {
      originalDataDir = process.env.DATA_DIR
      skillsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-skills-'))
      process.env.DATA_DIR = skillsTmpDir
      // Create two skills
      const nitterDir = path.join(skillsTmpDir, 'skills_agent', 'nitter')
      fs.mkdirSync(nitterDir, { recursive: true })
      fs.writeFileSync(
        path.join(nitterDir, 'SKILL.md'),
        '---\nname: nitter\ndescription: Fetch tweets via Nitter.\n---\n\n# Nitter Skill\nAlways rotate Nitter mirrors.',
        'utf-8',
      )
      const redditDir = path.join(skillsTmpDir, 'skills_agent', 'reddit')
      fs.mkdirSync(redditDir, { recursive: true })
      fs.writeFileSync(
        path.join(redditDir, 'SKILL.md'),
        '---\nname: reddit\ndescription: Fetch Reddit threads.\n---\n\n# Reddit Skill\nUse .json endpoints.',
        'utf-8',
      )
    })

    afterEach(() => {
      if (originalDataDir === undefined) {
        delete process.env.DATA_DIR
      } else {
        process.env.DATA_DIR = originalDataDir
      }
      try { fs.rmSync(skillsTmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    async function captureSystemPrompt(overrides: TaskOverrides): Promise<string> {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      type Captured = { initialState: { systemPrompt: string } }
      const captured: { value: Captured | null } = { value: null }
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce((options: unknown) => {
        captured.value = options as Captured
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: ok' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Attached Skills Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })
      await runner.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      if (!captured.value) throw new Error('Agent was not instantiated')
      return captured.value.initialState.systemPrompt
    }

    it('injects <attached_skills> block with SKILL.md content before the base prompt', async () => {
      const systemPrompt = await captureSystemPrompt({ attachedSkills: ['nitter', 'reddit'] })

      expect(systemPrompt.startsWith('<attached_skills>')).toBe(true)
      expect(systemPrompt).toContain('<skill name="nitter">')
      expect(systemPrompt).toContain('Nitter Skill')
      expect(systemPrompt).toContain('Always rotate Nitter mirrors.')
      expect(systemPrompt).toContain('<skill name="reddit">')
      expect(systemPrompt).toContain('Use .json endpoints.')
      expect(systemPrompt).toContain('</attached_skills>')

      // Base task prompt must still follow the attached-skills block
      expect(systemPrompt).toContain('background task agent')
      expect(systemPrompt).toContain('Do work')
      const blockEnd = systemPrompt.indexOf('</attached_skills>')
      const baseStart = systemPrompt.indexOf('background task agent')
      expect(blockEnd).toBeGreaterThan(-1)
      expect(baseStart).toBeGreaterThan(blockEnd)
    })

    it('skips missing SKILL.md files with a warning and still runs the task', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const systemPrompt = await captureSystemPrompt({ attachedSkills: ['nitter', 'does-not-exist'] })

        expect(systemPrompt).toContain('<skill name="nitter">')
        expect(systemPrompt).not.toContain('<skill name="does-not-exist">')
        expect(warnSpy).toHaveBeenCalled()
        const warned = warnSpy.mock.calls.some(args => String(args[0] ?? '').includes('does-not-exist'))
        expect(warned).toBe(true)
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('does not add an attached-skills block when attachedSkills is empty/null', async () => {
      const systemPromptNull = await captureSystemPrompt({ attachedSkills: null })
      expect(systemPromptNull).not.toContain('<attached_skills>')

      const systemPromptEmpty = await captureSystemPrompt({ attachedSkills: [] })
      expect(systemPromptEmpty).not.toContain('<attached_skills>')
    })

    it('rejects unsafe skill names containing path separators', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const systemPrompt = await captureSystemPrompt({ attachedSkills: ['../etc/passwd', 'nitter'] })
        expect(systemPrompt).toContain('<skill name="nitter">')
        expect(systemPrompt).not.toContain('../etc/passwd')
        expect(warnSpy).toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  describe('periodic status updates', () => {
    /**
     * Build a fresh runner with an adjustable `statusUpdates` config and a
     * mocked `onStatusUpdate` callback. The outer `runner` in the suite's
     * `beforeEach` doesn't expose these options, so tests that need them
     * dispose the outer runner and construct their own.
     */
    function makeRunnerWithStatusUpdates(config: {
      statusUpdates?: { enabled: boolean; intervalMinutes: number }
      onStatusUpdate?: TaskRunnerOptions['onStatusUpdate']
    }): TaskRunner {
      runner.dispose()
      const options: TaskRunnerOptions = {
        db,
        buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
        getApiKey: async () => 'test-key',
        tools: [],
        memoryDir: undefined,
        onTaskComplete: (taskId: string, injection: string) => {
          onTaskCompleteCalls.push({ taskId, injection })
        },
        onTaskPaused: (taskId: string, injection: string) => {
          onTaskPausedCalls.push({ taskId, injection })
        },
        onStatusUpdate: config.onStatusUpdate,
        statusUpdates: config.statusUpdates,
        sessionManager,
      }
      return new TaskRunner(options)
    }

    /**
     * Stub the mocked `Agent.prompt` so the task stays in the "running"
     * state indefinitely — we need the running map populated while fake
     * timers advance.
     */
    async function stubLongRunningAgent(): Promise<void> {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(() => new Promise<void>(() => { /* never resolves */ })),
          abort: vi.fn(),
          state: { messages: [] },
        }
      })
    }

    it('fires onStatusUpdate at the configured interval with a <task_status> payload', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        const onStatusUpdate = vi.fn()
        runner = makeRunnerWithStatusUpdates({
          statusUpdates: { enabled: true, intervalMinutes: 1 },
          onStatusUpdate,
        })

        await stubLongRunningAgent()
        const task = store.create({
          name: 'Heartbeat Task',
          prompt: 'long-running work',
          triggerType: 'agent',
          sessionId: 'status-session-1',
        })
        await runner.startTask(task, mockProvider)

        // Advance past the first interval tick.
        await vi.advanceTimersByTimeAsync(60_000)
        expect(onStatusUpdate).toHaveBeenCalledTimes(1)
        const [firedTaskId, firedMessage, firedDetails] = onStatusUpdate.mock.calls[0]
        expect(firedTaskId).toBe(task.id)
        expect(firedMessage).toContain(`<task_status task_id="${task.id}"`)
        expect(firedMessage).toContain('type="periodic_update"')
        expect(firedMessage).toContain('Heartbeat Task')
        expect(firedDetails).toMatchObject({
          taskName: 'Heartbeat Task',
          runtimeMinutes: expect.any(Number),
          toolCallCount: expect.any(Number),
          totalTokens: expect.any(Number),
        })

        // Second interval — still firing.
        await vi.advanceTimersByTimeAsync(60_000)
        expect(onStatusUpdate).toHaveBeenCalledTimes(2)

        runner.abortTask(task.id, 'test cleanup')
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not fire when statusUpdates.enabled=false', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        const onStatusUpdate = vi.fn()
        runner = makeRunnerWithStatusUpdates({
          statusUpdates: { enabled: false, intervalMinutes: 1 },
          onStatusUpdate,
        })

        await stubLongRunningAgent()
        const task = store.create({
          name: 'Silent Task',
          prompt: 'should stay quiet',
          triggerType: 'agent',
        })
        await runner.startTask(task, mockProvider)

        await vi.advanceTimersByTimeAsync(5 * 60_000)
        expect(onStatusUpdate).not.toHaveBeenCalled()

        runner.abortTask(task.id, 'test cleanup')
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not crash when enabled but no onStatusUpdate callback is wired', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        runner = makeRunnerWithStatusUpdates({
          statusUpdates: { enabled: true, intervalMinutes: 1 },
          onStatusUpdate: undefined,
        })

        await stubLongRunningAgent()
        const task = store.create({
          name: 'No-Callback Task',
          prompt: 'runs silently',
          triggerType: 'agent',
        })
        await expect(runner.startTask(task, mockProvider)).resolves.toBeTypeOf('string')

        // Advance well past several intervals; no callback → no throw.
        await vi.advanceTimersByTimeAsync(3 * 60_000)

        runner.abortTask(task.id, 'test cleanup')
      } finally {
        vi.useRealTimers()
      }
    })

    it('rejects invalid status-update intervals before starting the task', async () => {
      const onStatusUpdate = vi.fn()
      runner = makeRunnerWithStatusUpdates({
        statusUpdates: { enabled: true, intervalMinutes: 121 },
        onStatusUpdate,
      })

      const task = store.create({
        name: 'Invalid Interval Task',
        prompt: 'should not start',
        triggerType: 'agent',
      })

      await expect(runner.startTask(task, mockProvider)).rejects.toThrow('tasks.statusUpdates.intervalMinutes must be an integer 1-120')
      expect(runner.isRunning(task.id)).toBe(false)
      expect(onStatusUpdate).not.toHaveBeenCalled()
    })

    it('keeps firing after a pause/resume cycle', async () => {
      const onStatusUpdate = vi.fn()
      runner = makeRunnerWithStatusUpdates({
        statusUpdates: { enabled: true, intervalMinutes: 1 },
        onStatusUpdate,
      })

      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      // First prompt pauses with a question; second (after resume) never
      // resolves so the runner stays in the running map for the second
      // interval tick.
      let promptCount = 0
      const messages: unknown[] = []
      MockAgent.mockImplementation(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(() => {
            promptCount++
            if (promptCount === 1) {
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: Need more detail' }],
              })
              return Promise.resolve()
            }
            return new Promise<void>(() => { /* never resolves */ })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Resume Heartbeat Task',
        prompt: 'work',
        triggerType: 'agent',
        sessionId: 'status-session-resume',
      })

      // Use fake timers from the start so `advanceTimersByTimeAsync` drains
      // both the short microtask sleeps AND the periodic interval tick.
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        await runner.startTask(task, mockProvider)
        // Let the mocked agent's `prompt` microtask chain settle so the task
        // transitions to the paused state.
        await vi.advanceTimersByTimeAsync(50)
        expect(runner.isPaused(task.id)).toBe(true)

        // Resume — the runner creates a fresh status-update timer.
        await runner.resumeTask(task.id, 'here is more detail')
        await vi.advanceTimersByTimeAsync(50)
        expect(runner.isRunning(task.id)).toBe(true)

        // Past the first interval tick after resume → callback fires.
        await vi.advanceTimersByTimeAsync(60_000)
        expect(onStatusUpdate).toHaveBeenCalledTimes(1)
        expect(onStatusUpdate.mock.calls[0][0]).toBe(task.id)
        expect(onStatusUpdate.mock.calls[0][1]).toContain('type="periodic_update"')

        runner.abortTask(task.id, 'test cleanup')
      } finally {
        vi.useRealTimers()
      }
    })
  })


  describe('parseTaskTimestampMs', () => {
    it('parses a task store timestamp as UTC, regardless of host TZ', () => {
      const ms = parseTaskTimestampMs('2024-01-15 12:00:00')
      expect(ms).toBe(Date.UTC(2024, 0, 15, 12, 0, 0))
    })

    it('returns null for empty / invalid input', () => {
      expect(parseTaskTimestampMs(null)).toBe(null)
      expect(parseTaskTimestampMs(undefined)).toBe(null)
      expect(parseTaskTimestampMs('')).toBe(null)
      expect(parseTaskTimestampMs('not a date')).toBe(null)
    })
  })

  describe('task injection duration uses real elapsed time', () => {
    it('reports duration based on actual elapsed time, not a TZ-offset artefact', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      MockAgent.mockImplementationOnce(() => {
        let subscribeFn: ((event: unknown) => void) | null = null
        const messages: unknown[] = []
        return {
          subscribe: vi.fn((fn: (event: unknown) => void) => {
            subscribeFn = fn
            return () => { subscribeFn = null }
          }),
          prompt: vi.fn(async () => {
            if (subscribeFn) {
              subscribeFn({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: ok' }],
                  provider: 'test-provider',
                  model: 'test-model',
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
                },
              })
            }
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: ok' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Smoke Test',
        prompt: 'quick',
        triggerType: 'agent',
        maxDurationMinutes: 5,
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(onTaskCompleteCalls).toHaveLength(1)
      const m = onTaskCompleteCalls[0].injection.match(/duration_minutes="(\d+)"/)
      expect(m).not.toBeNull()
      const reported = parseInt(m![1], 10)
      expect(reported).toBeLessThan(2)
    })
  })

  describe('live metric persistence during execution', () => {
    it('persists token / cost counters to the task row on message_end', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let subscribeFn: ((event: unknown) => void) | null = null
      let resumePromptResolve: (() => void) | null = null
      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = []
        return {
          subscribe: vi.fn((fn: (event: unknown) => void) => {
            subscribeFn = fn
            return () => { subscribeFn = null }
          }),
          prompt: vi.fn(() => new Promise<void>((resolve) => {
            resumePromptResolve = () => {
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: ok' }],
              })
              resolve()
            }
          })),
          abort: vi.fn(() => { resumePromptResolve?.() }),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Live Metrics Task',
        prompt: 'work',
        triggerType: 'agent',
        sessionId: 'live-metrics-session',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 20))

      const beforeEvent = store.getById(task.id)!
      expect(beforeEvent.status).toBe('running')
      expect(beforeEvent.promptTokens).toBe(0)
      expect(beforeEvent.completionTokens).toBe(0)
      expect(beforeEvent.toolCallCount).toBe(0)

      expect(subscribeFn).not.toBeNull()
      subscribeFn!({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'thinking out loud' }],
          provider: 'test-provider',
          model: 'test-model',
          usage: {
            input: 250,
            output: 90,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.0042 },
          },
        },
      })

      const afterMsg = store.getById(task.id)!
      expect(afterMsg.status).toBe('running')
      expect(afterMsg.promptTokens).toBe(250)
      expect(afterMsg.completionTokens).toBe(90)
      expect(afterMsg.estimatedCost).toBeCloseTo(0.0042, 6)

      subscribeFn!({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'shell',
        args: { command: 'ls' },
      })
      subscribeFn!({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'shell',
        result: 'ok',
        isError: false,
      })

      const afterTool = store.getById(task.id)!
      expect(afterTool.status).toBe('running')
      expect(afterTool.toolCallCount).toBe(1)
      expect(afterTool.promptTokens).toBe(250)

      resumePromptResolve!()
      await new Promise(resolve => setTimeout(resolve, 50))

      const finalRow = store.getById(task.id)!
      expect(finalRow.status).toBe('completed')
      expect(finalRow.promptTokens).toBe(250)
      expect(finalRow.completionTokens).toBe(90)
      expect(finalRow.toolCallCount).toBe(1)
    })
  })

  describe('TASKS.md background task guidelines injection', () => {
    let configTmpDir: string
    let originalDataDir: string | undefined

    beforeEach(() => {
      originalDataDir = process.env.DATA_DIR
      configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tasks-md-'))
      process.env.DATA_DIR = configTmpDir
    })

    afterEach(() => {
      if (originalDataDir === undefined) {
        delete process.env.DATA_DIR
      } else {
        process.env.DATA_DIR = originalDataDir
      }
      try { fs.rmSync(configTmpDir, { recursive: true, force: true }) } catch {
        // Cleanup failures should not mask the test result.
      }
    })

    async function captureSystemPromptForTask(): Promise<string> {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      type Captured = { initialState: { systemPrompt: string } }
      const captured: { value: Captured | null } = { value: null }
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce((options: unknown) => {
        captured.value = options as Captured
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: ok' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Guidelines Task',
        prompt: 'concrete task body',
        triggerType: 'cronjob',
      })
      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      if (!captured.value) throw new Error('Agent was not instantiated')
      return captured.value.initialState.systemPrompt
    }

    it('injects the default TASKS.md content into the task system prompt under <task_guidelines>', async () => {
      const systemPrompt = await captureSystemPromptForTask()

      expect(systemPrompt).toContain('<task_guidelines>')
      expect(systemPrompt).toContain('</task_guidelines>')

      expect(systemPrompt).toContain('Work independently for as long as possible')
      expect(systemPrompt).toContain('Do NOT just describe what you did')

      expect(systemPrompt).toContain('background task agent')
      expect(systemPrompt).toContain('concrete task body')
      expect(systemPrompt).toContain('STATUS: completed | failed | question | silent')

      const tasksPath = path.join(configTmpDir, 'config', 'TASKS.md')
      expect(fs.existsSync(tasksPath)).toBe(true)
    })

    it('injects user-edited TASKS.md content verbatim', async () => {
      const cfgDir = path.join(configTmpDir, 'config')
      fs.mkdirSync(cfgDir, { recursive: true })
      fs.writeFileSync(path.join(cfgDir, 'TASKS.md'), '# Custom\n\n- Always speak in haiku.\n- Never panic.\n', 'utf-8')

      const systemPrompt = await captureSystemPromptForTask()

      expect(systemPrompt).toContain('<task_guidelines>')
      expect(systemPrompt).toContain('Always speak in haiku.')
      expect(systemPrompt).toContain('Never panic.')
      expect(systemPrompt).not.toContain('Work independently for as long as possible')
    })

    it('moved guideline lines are no longer hardcoded outside TASKS.md', async () => {
      const cfgDir = path.join(configTmpDir, 'config')
      fs.mkdirSync(cfgDir, { recursive: true })
      fs.writeFileSync(path.join(cfgDir, 'TASKS.md'), '', 'utf-8')

      const systemPrompt = await captureSystemPromptForTask()

      expect(systemPrompt).not.toContain('<task_guidelines>')
      expect(systemPrompt).not.toContain('Work independently for as long as possible')
      expect(systemPrompt).not.toContain('Prefer acting over asking')
      expect(systemPrompt).not.toContain('Do NOT just describe what you did')

      expect(systemPrompt).toContain('background task agent')
      expect(systemPrompt).toContain('<workspace>')
      expect(systemPrompt).toContain('STATUS: completed | failed | question | silent')
    })
  })

  describe('OAuth token refresh during long-running tasks', () => {
    async function restoreCapturingAgentMock(): Promise<void> {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      MockAgent.mockReset()
      MockAgent.mockImplementation((options: CapturedAgentOptions) => {
        recordAgentOptions(options)
        let subscribeFn: ((event: unknown) => void) | null = null
        const messages: unknown[] = []
        return {
          subscribe: vi.fn((fn: (event: unknown) => void) => {
            subscribeFn = fn
            return () => { subscribeFn = null }
          }),
          prompt: vi.fn(async () => {
            const msg = {
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: ok' }],
              provider: 'test-provider',
              model: 'test-model',
              usage: {
                input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
                cost: { total: 0 },
              },
            }
            subscribeFn?.({ type: 'message_end', message: msg })
            subscribeFn?.({ type: 'agent_end', messages: [] })
            messages.push(msg)
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })
    }

    it('PiAgent.getApiKey re-resolves on every call instead of capturing once', async () => {
      await restoreCapturingAgentMock()
      resetAgentOptions()
      let getApiKeyCallCount = 0
      const apiKeys = ['key-fresh-1', 'key-fresh-2', 'key-fresh-3']
      const getApiKey = vi.fn(async () => apiKeys[getApiKeyCallCount++] ?? 'key-fallback')

      const customRunner = new TaskRunner({
        db,
        buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
        getApiKey,
        tools: [],
        memoryDir: undefined,
        onTaskComplete: () => {},
        sessionManager,
      })

      const task = store.create({
        name: 'OAuth task',
        prompt: 'Do work',
        triggerType: 'agent',
      })
      await customRunner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(getApiKey).toHaveBeenCalledTimes(1)
      const captured = getCapturedAgentOptions()
      const capturedGetApiKey = captured.getApiKey
      if (!capturedGetApiKey) throw new Error('getApiKey missing on captured options')

      const k1 = await capturedGetApiKey()
      const k2 = await capturedGetApiKey()
      expect(k1).toBe('key-fresh-2')
      expect(k2).toBe('key-fresh-3')
      expect(getApiKey).toHaveBeenCalledTimes(3)

      customRunner.dispose()
    })

    it('PiAgent.getApiKey routes through getProviderById when available so refreshed OAuth credentials on disk are picked up', async () => {
      await restoreCapturingAgentMock()
      resetAgentOptions()
      const providerSnapshots: ProviderConfig[] = [
        { ...mockProvider, apiKey: 'snapshot-1' },
        { ...mockProvider, apiKey: 'snapshot-2' },
      ]
      let snapshotIdx = 0
      const getProviderById = vi.fn((id: string) => {
        if (id !== mockProvider.id) return null
        return providerSnapshots[Math.min(snapshotIdx++, providerSnapshots.length - 1)]
      })
      const getApiKey = vi.fn(async (p: ProviderConfig) => p.apiKey)

      const customRunner = new TaskRunner({
        db,
        buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
        getApiKey,
        getProviderById,
        tools: [],
        memoryDir: undefined,
        onTaskComplete: () => {},
        sessionManager,
      })

      const task = store.create({
        name: 'OAuth task with refresh',
        prompt: 'Do work',
        triggerType: 'agent',
      })
      await customRunner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 50))

      const captured = getCapturedAgentOptions()
      const capturedGetApiKey = captured.getApiKey
      if (!capturedGetApiKey) throw new Error('getApiKey missing on captured options')
      const k1 = await capturedGetApiKey()
      const k2 = await capturedGetApiKey()
      expect(k1).toBe('snapshot-1')
      expect(k2).toBe('snapshot-2')
      expect(getProviderById).toHaveBeenCalledWith(mockProvider.id)
      expect(getProviderById).toHaveBeenCalledTimes(2)

      customRunner.dispose()
    })

    it('PiAgent.getApiKey falls back to the last known good key when refresh throws', async () => {
      await restoreCapturingAgentMock()
      resetAgentOptions()
      let calls = 0
      const getApiKey = vi.fn(async () => {
        calls++
        if (calls === 1) return 'initial-good-key'
        throw new Error('OAuth refresh exploded')
      })

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const customRunner = new TaskRunner({
        db,
        buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
        getApiKey,
        tools: [],
        memoryDir: undefined,
        onTaskComplete: () => {},
        sessionManager,
      })

      const task = store.create({
        name: 'OAuth task with broken refresh',
        prompt: 'Do work',
        triggerType: 'agent',
      })
      await customRunner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 50))

      const captured = getCapturedAgentOptions()
      const capturedGetApiKey = captured.getApiKey
      if (!capturedGetApiKey) throw new Error('getApiKey missing on captured options')
      const k = await capturedGetApiKey()
      expect(k).toBe('initial-good-key')
      expect(errSpy).toHaveBeenCalled()

      errSpy.mockRestore()
      customRunner.dispose()
    })
  })

  // Bug B: task runner must surface provider errors instead of recording an
  // empty "completed" (task aed6184a: 400 claude_code_version_too_old died on
  // the first model call, 0 tokens, empty body, yet status was "completed").
  describe('provider error surfacing (no silent empty completion)', () => {
    it('marks task failed when the agent produced no output and 0 completion tokens', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      // Simulate a run that died immediately: no message_end event fires (so
      // completionTokens stays 0) and state.messages holds only the empty,
      // errored assistant message pi-agent recorded instead of throwing.
      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = [{
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '400 claude_code_version_too_old: version 2.1.251 or newer is required',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        }]
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => { /* dies without emitting output */ }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Provider Error Task',
        prompt: 'Do work',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.resultStatus).toBe('failed')
      expect(updated.completionTokens).toBe(0)
      // The real provider cause is surfaced, not an empty summary.
      expect(updated.errorMessage).toContain('claude_code_version_too_old')

      // Injection reflects the failure and carries the real error.
      expect(onTaskCompleteCalls).toHaveLength(1)
      expect(onTaskCompleteCalls[0].injection).toContain('status="failed"')
      expect(onTaskCompleteCalls[0].injection).toContain('claude_code_version_too_old')
    })

    it('marks task failed with a fallback message when output is empty, 0 tokens, and no errorMessage', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = [{
          role: 'assistant',
          content: [],
          stopReason: 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        }]
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => { /* no output, no tokens */ }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Empty Output Task',
        prompt: 'Do work',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.resultStatus).toBe('failed')
      expect(updated.errorMessage).toContain('0 tokens')
    })

    it('passes through the real provider errorMessage when stopReason is error', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      // Even with some completion tokens recorded, a stopReason 'error' must
      // fail the task and forward the exact provider message.
      MockAgent.mockImplementationOnce(() => {
        let subscribeFn: ((event: unknown) => void) | null = null
        const messages: unknown[] = []
        return {
          subscribe: vi.fn((fn: (event: unknown) => void) => {
            subscribeFn = fn
            return () => { subscribeFn = null }
          }),
          prompt: vi.fn(async () => {
            const errored = {
              role: 'assistant',
              content: [],
              stopReason: 'error',
              errorMessage: 'The model refused to complete the request',
              provider: 'test-provider',
              model: 'test-model',
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
            }
            if (subscribeFn) subscribeFn({ type: 'message_end', message: errored })
            messages.push(errored)
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Refusal Task',
        prompt: 'Do work',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.resultStatus).toBe('failed')
      expect(updated.errorMessage).toBe('The model refused to complete the request')
    })

    it('does NOT run the verifier on an empty result (no pointless revision round)', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = [{
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'boom',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        }]
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => { /* dies */ }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      // buildModel is invoked by maybeVerifyAndRevise; assert it is never
      // reached for the reviewer pass on an empty/errored result.
      const buildModel = vi.fn(() => ({} as ReturnType<TaskRunnerOptions['buildModel']>))
      const verifyRunner = new TaskRunner({
        db,
        buildModel,
        getApiKey: async () => 'test-key',
        tools: [],
        memoryDir: undefined,
        onTaskComplete: () => {},
        sessionManager,
        // Explicitly enable verification so the guard — not the VITEST default —
        // is what prevents the reviewer pass.
        verification: { enabled: true },
        getProviderById: () => mockProvider,
      })

      const task = store.create({
        name: 'No Verify On Empty Task',
        prompt: 'Do work',
        triggerType: 'agent',
      })

      await verifyRunner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      // buildModel is called exactly once at startup (pre-resolve). The
      // reviewer pass would call it a SECOND time — it must not, because the
      // failed/empty result short-circuits before maybeVerifyAndRevise.
      expect(buildModel).toHaveBeenCalledTimes(1)

      verifyRunner.dispose()
    })
  })

  describe('output_schema enforcement (SPEC 11.6)', () => {
    const schema = '{"type":"object","required":["findings"],"properties":{"findings":{"type":"array","items":{"type":"string"}}},"additionalProperties":false}'

    async function mockAgentWithReplies(replies: string[]): Promise<{ prompts: string[] }> {
      const prompts: string[] = []
      const messages: unknown[] = []
      let i = 0
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      MockAgent.mockImplementationOnce(() => ({
        subscribe: vi.fn(() => () => {}),
        prompt: vi.fn(async (text: string) => {
          prompts.push(text)
          const reply = replies[Math.min(i, replies.length - 1)]
          i++
          messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] })
        }),
        abort: vi.fn(),
        state: { get messages() { return messages } },
      }))
      return { prompts }
    }

    it('accepts a SUMMARY that satisfies the schema without a correction turn', async () => {
      const { prompts } = await mockAgentWithReplies(['STATUS: completed\nSUMMARY: ```json\n{"findings":["a","b"]}\n```'])
      const task = store.create({ name: 'S', prompt: 'p', triggerType: 'agent', outputSchema: schema })
      await runner.startTask(task, mockProvider)
      await new Promise(r => setTimeout(r, 100))
      const done = store.getById(task.id)!
      expect(done.status).toBe('completed')
      expect(done.resultSummary).toContain('"findings"')
      expect(prompts).toHaveLength(1)
    })

    it('runs exactly one correction turn with the errors verbatim and accepts the corrected result', async () => {
      const { prompts } = await mockAgentWithReplies([
        'STATUS: completed\nSUMMARY: {"findings":"not an array","extra":1}',
        'STATUS: completed\nSUMMARY: {"findings":["fixed"]}',
      ])
      const task = store.create({ name: 'S', prompt: 'p', triggerType: 'agent', outputSchema: schema })
      await runner.startTask(task, mockProvider)
      await new Promise(r => setTimeout(r, 100))
      const done = store.getById(task.id)!
      expect(done.status).toBe('completed')
      expect(done.resultSummary).toContain('"fixed"')
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('only correction round')
      expect(prompts[1]).toContain('/findings: ')
      expect(prompts[1]).toContain('additional properties')
    })

    it('fails the task when the corrected result still violates the schema', async () => {
      const { prompts } = await mockAgentWithReplies([
        'STATUS: completed\nSUMMARY: no json here',
        'STATUS: completed\nSUMMARY: {"nope": true}',
        'STATUS: completed\nSUMMARY: {"findings": []}',
      ])
      const task = store.create({ name: 'S', prompt: 'p', triggerType: 'agent', outputSchema: schema })
      await runner.startTask(task, mockProvider)
      await new Promise(r => setTimeout(r, 100))
      const done = store.getById(task.id)!
      expect(done.status).toBe('failed')
      expect(done.resultSummary).toContain('output_schema not satisfied after the correction turn')
      expect(done.resultSummary).toContain('/: must have required properties findings')
      expect(prompts).toHaveLength(2)
      expect(onTaskCompleteCalls[0].injection).toContain('status="failed"')
    })

    it('puts the schema instruction into the task system prompt', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      let captured = ''
      MockAgent.mockImplementationOnce((options: { initialState?: { systemPrompt?: string } }) => {
        captured = options.initialState?.systemPrompt ?? ''
        const messages: unknown[] = [{ role: 'assistant', content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: {"findings":[]}' }] }]
        return { subscribe: vi.fn(() => () => {}), prompt: vi.fn(async () => {}), abort: vi.fn(), state: { get messages() { return messages } } }
      })
      const task = store.create({ name: 'S', prompt: 'p', triggerType: 'agent', outputSchema: schema })
      await runner.startTask(task, mockProvider)
      await new Promise(r => setTimeout(r, 50))
      expect(captured).toContain('<output_schema>')
      expect(captured).toContain('"required":["findings"]')
    })
  })
  describe('task execution context origin', () => {
    it('binds the resolved user and strand of the task to its execution context', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const { getCurrentTaskExecutionContext } = await import('./task-execution-context.js')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      let seen: { userId?: number | null; sessionId?: string | null; taskId?: string } | null = null
      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = [{ role: 'assistant', content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: done' }] }]
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            const ctx = getCurrentTaskExecutionContext()
            seen = { userId: ctx?.userId, sessionId: ctx?.sessionId, taskId: ctx?.taskId }
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const originRunner = new TaskRunner({
        db,
        buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
        getApiKey: async () => 'test-key',
        tools: [],
        onTaskComplete: () => {},
        onTaskPaused: () => {},
        sessionManager,
        resolveTaskOrigin: (task) => ({ userId: 42, sessionId: `strand-of-${task.name}` }),
      })

      try {
        const task = store.create({ name: 'Origin', prompt: 'p', triggerType: 'agent', sessionId: 'task-own-session' })
        await originRunner.startTask(task, mockProvider)
        await new Promise(r => setTimeout(r, 80))

        expect(seen).not.toBeNull()
        expect(seen!.userId).toBe(42)
        expect(seen!.sessionId).toBe('strand-of-Origin')
        expect(seen!.taskId).toBe(task.id)
      } finally {
        originRunner.dispose()
      }
    })

    it('leaves user and strand null when no origin resolver is configured', async () => {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const { getCurrentTaskExecutionContext } = await import('./task-execution-context.js')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      let seen: { userId?: number | null; sessionId?: string | null } | null = null
      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = [{ role: 'assistant', content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: done' }] }]
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            const ctx = getCurrentTaskExecutionContext()
            seen = { userId: ctx?.userId, sessionId: ctx?.sessionId }
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({ name: 'NoOrigin', prompt: 'p', triggerType: 'agent' })
      await runner.startTask(task, mockProvider)
      await new Promise(r => setTimeout(r, 80))

      expect(seen).not.toBeNull()
      expect(seen!.userId ?? null).toBeNull()
      expect(seen!.sessionId ?? null).toBeNull()
    })
  })
  /**
   * Live token counter (SPEC 10.x): the App shows a running (sub-)task but
   * could not show what it burns. Before this, the ONLY producer of a
   * `task_progress` frame was `onStatusUpdate`, which is off by default
   * (`tasks.statusUpdates.enabled=false`, and the production settings.json
   * carries only the legacy `statusUpdateIntervalMinutes`) — so a task that
   * ran for an hour emitted `started` and `finished` and nothing in between.
   */
  describe('periodic progress frames', () => {
    function makeRunnerWithLifecycle(
      onTaskLifecycle: TaskRunnerOptions['onTaskLifecycle'],
      statusUpdates?: { enabled: boolean; intervalMinutes: number },
    ): TaskRunner {
      runner.dispose()
      return new TaskRunner({
        db,
        buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
        getApiKey: async () => 'test-key',
        tools: [],
        onTaskComplete: (taskId: string, injection: string) => {
          onTaskCompleteCalls.push({ taskId, injection })
        },
        onTaskPaused: (taskId: string, injection: string) => {
          onTaskPausedCalls.push({ taskId, injection })
        },
        onTaskLifecycle,
        statusUpdates,
        sessionManager,
      })
    }

    /** Keep the task in the running map so fake timers have something to tick. */
    async function stubNeverEndingAgent(onSubscribe?: (fn: (event: unknown) => void) => void): Promise<void> {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      MockAgent.mockImplementationOnce(() => ({
        subscribe: vi.fn((fn: (event: unknown) => void) => {
          onSubscribe?.(fn)
          return () => {}
        }),
        prompt: vi.fn(() => new Promise<void>(() => { /* never resolves */ })),
        abort: vi.fn(),
        state: { messages: [] },
      }))
    }

    it('emits a progress frame every 30s while the task runs, without statusUpdates enabled', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        const phases: string[] = []
        runner = makeRunnerWithLifecycle((phase) => { phases.push(phase) })
        await stubNeverEndingAgent()

        const task = store.create({ name: 'Ticking', prompt: 'p', triggerType: 'agent', sessionId: 'progress-session-1' })
        await runner.startTask(task, mockProvider)
        expect(phases).toEqual(['started'])

        await vi.advanceTimersByTimeAsync(TASK_PROGRESS_FRAME_INTERVAL_MS)
        expect(phases).toEqual(['started', 'progress'])

        await vi.advanceTimersByTimeAsync(TASK_PROGRESS_FRAME_INTERVAL_MS)
        expect(phases).toEqual(['started', 'progress', 'progress'])

        runner.abortTask(task.id, 'test cleanup')
      } finally {
        vi.useRealTimers()
      }
    })

    it('carries the live token stand, so the numbers climb between two frames', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        const seen: { phase: string; prompt: number; completion: number }[] = []
        runner = makeRunnerWithLifecycle((phase, t) => {
          seen.push({ phase, prompt: t.promptTokens, completion: t.completionTokens })
        })
        let emit: ((event: unknown) => void) | null = null
        await stubNeverEndingAgent((fn) => { emit = fn })

        const task = store.create({ name: 'Billing', prompt: 'p', triggerType: 'agent', sessionId: 'progress-session-2' })
        await runner.startTask(task, mockProvider)

        const usage = (input: number, output: number) => ({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'working' }],
            provider: 'test-provider',
            model: 'test-model',
            usage: { input, output, cacheRead: 7, cacheWrite: 3, cost: { total: 0.002 } },
          },
        })

        emit!(usage(100, 50))
        await vi.advanceTimersByTimeAsync(TASK_PROGRESS_FRAME_INTERVAL_MS)
        emit!(usage(10, 5))
        await vi.advanceTimersByTimeAsync(TASK_PROGRESS_FRAME_INTERVAL_MS)

        const progress = seen.filter(s => s.phase === 'progress')
        expect(progress).toHaveLength(2)
        expect(progress[0]).toMatchObject({ prompt: 100, completion: 50 })
        expect(progress[1]).toMatchObject({ prompt: 110, completion: 55 })

        runner.abortTask(task.id, 'test cleanup')
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops ticking once the task finished (no timer outliving the task)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        const phases: string[] = []
        runner = makeRunnerWithLifecycle((phase) => { phases.push(phase) })

        // Default mock agent: completes immediately.
        // The runner always keeps ONE timer of its own (the hourly cleanup
        // of stale paused tasks), so compare against that idle baseline.
        const idleTimers = vi.getTimerCount()
        const task = store.create({ name: 'Short', prompt: 'p', triggerType: 'agent', sessionId: 'progress-session-3' })
        await runner.startTask(task, mockProvider)
        await vi.advanceTimersByTimeAsync(100)
        expect(store.getById(task.id)!.status).toBe('completed')
        expect(phases).toEqual(['started', 'finished'])

        // Ten intervals later: still nothing. A leaked interval would show up
        // here as a stream of progress frames for a completed task.
        await vi.advanceTimersByTimeAsync(TASK_PROGRESS_FRAME_INTERVAL_MS * 10)
        expect(phases).toEqual(['started', 'finished'])
        expect(vi.getTimerCount()).toBe(idleTimers)
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops ticking when the task is killed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        const phases: string[] = []
        runner = makeRunnerWithLifecycle((phase) => { phases.push(phase) })
        await stubNeverEndingAgent()

        const idleTimers = vi.getTimerCount()
        const task = store.create({ name: 'Killed', prompt: 'p', triggerType: 'agent', sessionId: 'progress-session-4' })
        await runner.startTask(task, mockProvider)
        await vi.advanceTimersByTimeAsync(TASK_PROGRESS_FRAME_INTERVAL_MS)
        expect(phases.filter(p => p === 'progress')).toHaveLength(1)

        runner.abortTask(task.id, 'killed by test')
        await vi.advanceTimersByTimeAsync(TASK_PROGRESS_FRAME_INTERVAL_MS * 5)
        expect(phases.filter(p => p === 'progress')).toHaveLength(1)
        expect(vi.getTimerCount()).toBe(idleTimers)
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops ticking while the task is paused waiting for an answer', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        const phases: string[] = []
        runner = makeRunnerWithLifecycle((phase) => { phases.push(phase) })

        const { Agent } = await import('@earendil-works/pi-agent-core')
        const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
        const messages: unknown[] = []
        MockAgent.mockImplementationOnce(() => ({
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({ role: 'assistant', content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: Need more detail' }] })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }))

        const idleTimers = vi.getTimerCount()
        const task = store.create({ name: 'Asking', prompt: 'p', triggerType: 'agent', sessionId: 'progress-session-5' })
        await runner.startTask(task, mockProvider)
        await vi.advanceTimersByTimeAsync(100)
        expect(store.getById(task.id)!.status).toBe('paused')

        await vi.advanceTimersByTimeAsync(TASK_PROGRESS_FRAME_INTERVAL_MS * 4)
        expect(phases.filter(p => p === 'progress')).toHaveLength(0)
        // The pause path used to drop the map entry by hand and leak both
        // intervals; now every timer is released.
        expect(vi.getTimerCount()).toBe(idleTimers)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not arm a timer when nobody listens for lifecycle frames', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        runner = makeRunnerWithLifecycle(undefined)
        await stubNeverEndingAgent()
        const idleTimers = vi.getTimerCount()
        const task = store.create({ name: 'NoConsumer', prompt: 'p', triggerType: 'agent', sessionId: 'progress-session-6' })
        await runner.startTask(task, mockProvider)
        expect(vi.getTimerCount()).toBe(idleTimers)
        runner.abortTask(task.id, 'test cleanup')
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
