import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase } from './database.js'
import { TaskStore } from './task-store.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import type { Database } from './database.js'
import type { ProviderConfig } from './provider-config.js'
import { SessionManager } from './session-manager.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Tests for the global task concurrency limit (`tasks.maxConcurrent`).
 *
 * The agent mock here is *controllable*: `prompt()` returns a promise that
 * only settles when the test says so. That is what makes it possible to have
 * several tasks "running" at the same time and to check which of them the
 * runner actually started.
 */

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

interface AgentHandle {
  /** Order in which the runner constructed this agent (0-based). */
  index: number
  /** System prompt of this agent — used to map agent → task. */
  systemPrompt: string
  complete: (summary?: string) => void
  ask: (question?: string) => void
  fail: (message?: string) => void
  aborted: boolean
}

const agents: AgentHandle[] = []

vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation((options: { initialState?: { systemPrompt?: string } }) => {
      const messages: unknown[] = []
      let subscribeFn: ((event: unknown) => void) | null = null
      let settle: ((outcome: { error?: Error }) => void) | null = null

      const handle: AgentHandle = {
        index: agents.length,
        systemPrompt: String(options?.initialState?.systemPrompt ?? ''),
        aborted: false,
        complete: (summary = 'All good') => {
          if (subscribeFn) {
            subscribeFn({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: `STATUS: completed\nSUMMARY: ${summary}` }],
                provider: 'test-provider',
                model: 'test-model',
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
              },
            })
          }
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: `STATUS: completed\nSUMMARY: ${summary}` }],
          })
          settle?.({})
        },
        ask: (question = 'Which database should I use, Postgres or MySQL?') => {
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: `STATUS: question\nSUMMARY: ${question}` }],
          })
          settle?.({})
        },
        fail: (message = 'LLM API error') => {
          settle?.({ error: new Error(message) })
        },
      }
      agents.push(handle)

      return {
        subscribe: vi.fn((fn: (event: unknown) => void) => {
          subscribeFn = fn
          return () => { subscribeFn = null }
        }),
        prompt: vi.fn(() => {
          return new Promise<void>((resolve, reject) => {
            settle = (outcome) => {
              settle = null
              if (outcome.error) reject(outcome.error)
              else resolve()
            }
          })
        }),
        abort: vi.fn(() => {
          handle.aborted = true
          settle?.({})
        }),
        state: { get messages() { return messages } },
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

describe('TaskRunner — global concurrency limit', () => {
  let db: Database
  let store: TaskStore
  let runner: TaskRunner
  let sessionManager: SessionManager
  const tmpFiles: string[] = []
  /** Mutable so a test can change `tasks.maxConcurrent` mid-flight. */
  let limit: number

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-taskqueue-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  /** Let pending promise chains settle (the runner starts tasks detached). */
  async function flush(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 5))
    for (let i = 0; i < times; i++) await Promise.resolve()
  }

  function makeRunner(overrides: Partial<TaskRunnerOptions> = {}): TaskRunner {
    return new TaskRunner({
      db,
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      onTaskComplete: () => { },
      sessionManager,
      getMaxConcurrentTasks: () => limit,
      ...overrides,
    })
  }

  function createTask(name: string, triggerType: 'user' | 'agent' | 'cronjob' | 'heartbeat' = 'agent', maxDurationMinutes?: number) {
    return store.create({ name, prompt: `Work on ${name}`, triggerType, maxDurationMinutes })
  }

  /** The handle of the agent that was started for this task, if any. */
  function agentFor(taskName: string): AgentHandle | undefined {
    return agents.find(a => a.systemPrompt.includes(`Work on ${taskName}`))
  }

  beforeEach(() => {
    agents.length = 0
    limit = 2
    db = initDatabase(tmpDbPath())
    store = new TaskStore(db)
    sessionManager = new SessionManager({ db })
    runner = makeRunner()
  })

  afterEach(async () => {
    // Real timers first, then let the aborted runs finish their last DB
    // writes: disposing aborts the mock agents, and their (detached) promise
    // chains still touch the database. Closing it underneath them would
    // surface as an unhandled rejection.
    vi.useRealTimers()
    runner.dispose()
    await flush()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  describe('limit and FIFO order', () => {
    it('starts only `maxConcurrent` tasks and queues the rest', async () => {
      limit = 2
      const a = createTask('Alpha')
      const b = createTask('Bravo')
      const c = createTask('Charlie')
      const d = createTask('Delta')

      for (const t of [a, b, c, d]) await runner.startTask(t, mockProvider)
      await flush()

      expect(runner.getRunningTaskIds().sort()).toEqual([a.id, b.id].sort())
      expect(runner.getQueuedTaskIds()).toEqual([c.id, d.id])
      expect(agents).toHaveLength(2)

      // Queued tasks keep status='running' with startedAt = NULL — the marker
      // clients use to show them as QUEUED.
      expect(store.getById(c.id)!.status).toBe('running')
      expect(store.getById(c.id)!.startedAt).toBeNull()
      expect(store.getById(a.id)!.startedAt).toBeTruthy()

      expect(runner.getQueueInfo(d.id)).toEqual({
        queued: true, position: 2, running: 2, queued_count: 2, limit: 2,
      })
    })

    it('dequeues in FIFO order when slots free up', async () => {
      limit = 1
      const first = createTask('Alpha')
      const second = createTask('Bravo')
      const third = createTask('Charlie')
      for (const t of [first, second, third]) await runner.startTask(t, mockProvider)
      await flush()

      expect(agents).toHaveLength(1)
      expect(runner.getQueuedTaskIds()).toEqual([second.id, third.id])

      agentFor('Alpha')!.complete()
      await flush()
      expect(runner.isRunning(second.id)).toBe(true)
      expect(runner.getQueuedTaskIds()).toEqual([third.id])
      expect(store.getById(second.id)!.startedAt).toBeTruthy()

      agentFor('Bravo')!.complete()
      await flush()
      expect(runner.isRunning(third.id)).toBe(true)
      expect(runner.getQueuedTaskIds()).toEqual([])

      agentFor('Charlie')!.complete()
      await flush()
      expect(store.getById(third.id)!.status).toBe('completed')
    })

    it('treats maxConcurrent 0 as unlimited', async () => {
      limit = 0
      const tasks = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map(n => createTask(n))
      for (const t of tasks) await runner.startTask(t, mockProvider)
      await flush()

      expect(runner.getQueuedTaskIds()).toEqual([])
      expect(runner.getRunningTaskIds()).toHaveLength(5)
      expect(agents).toHaveLength(5)
    })

    it('picks up a settings change on the next dequeue without a restart', async () => {
      limit = 1
      const a = createTask('Alpha')
      const b = createTask('Bravo')
      const c = createTask('Charlie')
      for (const t of [a, b, c]) await runner.startTask(t, mockProvider)
      await flush()
      expect(runner.getQueuedTaskIds()).toEqual([b.id, c.id])

      // Operator raises tasks.maxConcurrent while a task is queued.
      limit = 3
      agentFor('Alpha')!.complete()
      await flush()

      // Both queued tasks fit now, no restart involved.
      expect(runner.getQueuedTaskIds()).toEqual([])
      expect(runner.isRunning(b.id)).toBe(true)
      expect(runner.isRunning(c.id)).toBe(true)
    })

    it('stops draining the queue when the limit is lowered', async () => {
      limit = 2
      const a = createTask('Alpha')
      const b = createTask('Bravo')
      const c = createTask('Charlie')
      for (const t of [a, b, c]) await runner.startTask(t, mockProvider)
      await flush()
      expect(runner.getQueuedTaskIds()).toEqual([c.id])

      limit = 1
      agentFor('Alpha')!.complete()
      await flush()

      // One slot is still over-subscribed (Bravo runs), so Charlie waits.
      expect(runner.isRunning(b.id)).toBe(true)
      expect(runner.getQueuedTaskIds()).toEqual([c.id])
    })
  })

  describe('bypass', () => {
    it('starts cronjob and heartbeat tasks immediately but counts their slots', async () => {
      limit = 1
      const user = createTask('Alpha', 'user')
      await runner.startTask(user, mockProvider)
      await flush()

      const cron = createTask('Bravo', 'cronjob')
      const beat = createTask('Charlie', 'heartbeat')
      await runner.startTask(cron, mockProvider)
      await runner.startTask(beat, mockProvider)
      await flush()

      expect(runner.getQueuedTaskIds()).toEqual([])
      expect(runner.getRunningTaskIds().sort()).toEqual([user.id, cron.id, beat.id].sort())

      // They occupy slots: a queue-governed task now has to wait behind them.
      const queued = createTask('Delta', 'agent')
      await runner.startTask(queued, mockProvider)
      await flush()
      expect(runner.getQueuedTaskIds()).toEqual([queued.id])
      expect(runner.getQueueInfo(queued.id).running).toBe(3)
    })

    it('resumes a paused task immediately even when the limit is exhausted', async () => {
      limit = 1
      const asker = createTask('Alpha')
      await runner.startTask(asker, mockProvider)
      await flush()

      const other = createTask('Bravo')
      await runner.startTask(other, mockProvider)
      await flush()
      expect(runner.getQueuedTaskIds()).toEqual([other.id])

      // The question frees the slot (a paused task holds none), so Bravo starts.
      agentFor('Alpha')!.ask()
      await flush()
      expect(runner.isPaused(asker.id)).toBe(true)
      expect(runner.isRunning(other.id)).toBe(true)
      expect(runner.getQueuedTaskIds()).toEqual([])

      // Resuming bypasses the queue although the limit is already reached.
      const resumed = await runner.resumeTask(asker.id, 'Use Postgres')
      await flush()
      expect(resumed).toBe(true)
      expect(runner.isRunning(asker.id)).toBe(true)
      expect(runner.getQueueInfo(asker.id).running).toBe(2)
    })
  })

  describe('slot release on every terminal path', () => {
    async function queuedFollower(): Promise<{ blocker: ReturnType<typeof createTask>; follower: ReturnType<typeof createTask> }> {
      limit = 1
      const blocker = createTask('Alpha')
      const follower = createTask('Bravo')
      await runner.startTask(blocker, mockProvider)
      await runner.startTask(follower, mockProvider)
      await flush()
      expect(runner.getQueuedTaskIds()).toEqual([follower.id])
      return { blocker, follower }
    }

    it('releases the slot when a task completes', async () => {
      const { blocker, follower } = await queuedFollower()
      agentFor('Alpha')!.complete()
      await flush()
      expect(store.getById(blocker.id)!.status).toBe('completed')
      expect(runner.isRunning(follower.id)).toBe(true)
    })

    it('releases the slot when a task fails', async () => {
      const { blocker, follower } = await queuedFollower()
      agentFor('Alpha')!.fail('LLM API error')
      await flush()
      expect(store.getById(blocker.id)!.status).toBe('failed')
      expect(runner.isRunning(follower.id)).toBe(true)
    })

    it('releases the slot when a task is aborted', async () => {
      const { blocker, follower } = await queuedFollower()
      runner.abortTask(blocker.id, 'Aborted by user')
      await flush()
      expect(store.getById(blocker.id)!.status).toBe('failed')
      expect(runner.isRunning(follower.id)).toBe(true)
    })

    it('releases the slot when a task pauses with a question', async () => {
      const { blocker, follower } = await queuedFollower()
      agentFor('Alpha')!.ask()
      await flush()
      expect(store.getById(blocker.id)!.status).toBe('paused')
      expect(runner.isRunning(follower.id)).toBe(true)
      expect(runner.getQueueInfo(blocker.id).running).toBe(1)
    })

    it('releases the slot when a task hits its max duration', async () => {
      vi.useFakeTimers()
      limit = 1
      const blocker = createTask('Alpha', 'agent', 1)
      const follower = createTask('Bravo')
      await runner.startTask(blocker, mockProvider)
      await runner.startTask(follower, mockProvider)
      await vi.advanceTimersByTimeAsync(10)
      expect(runner.getQueuedTaskIds()).toEqual([follower.id])

      await vi.advanceTimersByTimeAsync(61_000)
      expect(store.getById(blocker.id)!.status).toBe('failed')
      expect(store.getById(blocker.id)!.errorMessage).toBe('Max duration exceeded')
      expect(runner.isRunning(follower.id)).toBe(true)
    })

    it('releases the slot when the task fails to start at all', async () => {
      limit = 1
      // Only the first start blows up, so the follower can prove the slot of
      // the failed start was returned.
      let apiKeyCalls = 0
      const brokenRunner = makeRunner({
        getApiKey: async () => {
          apiKeyCalls++
          if (apiKeyCalls === 1) throw new Error('no credentials')
          return 'test-key'
        },
      })
      const broken = createTask('Alpha')
      const follower = createTask('Bravo')

      await expect(brokenRunner.startTask(broken, mockProvider)).rejects.toThrow('no credentials')
      expect(store.getById(broken.id)!.status).toBe('failed')

      // The failed start must not leave a ghost slot behind.
      await brokenRunner.startTask(follower, mockProvider)
      await flush()
      expect(brokenRunner.getQueuedTaskIds()).toEqual([])
      expect(brokenRunner.getQueueInfo(follower.id).running).toBe(1)
      brokenRunner.dispose()
    })

    it('releases the slot when the status-update config is invalid at start', async () => {
      limit = 1
      // An invalid interval makes every start throw. Each rejected start must
      // still give its slot back, otherwise the queue stalls behind ghosts.
      const invalidRunner = makeRunner({
        statusUpdates: { enabled: true, intervalMinutes: 0 } as TaskRunnerOptions['statusUpdates'],
      })
      const first = createTask('Alpha')
      const second = createTask('Bravo')

      await expect(invalidRunner.startTask(first, mockProvider)).rejects.toThrow('intervalMinutes')
      await expect(invalidRunner.startTask(second, mockProvider)).rejects.toThrow('intervalMinutes')

      expect(invalidRunner.getQueuedTaskIds()).toEqual([])
      expect(invalidRunner.getQueueInfo(second.id).running).toBe(0)
      invalidRunner.dispose()
    })

    it('does not leak a slot when a resume cannot start', async () => {
      limit = 1
      const asker = createTask('Alpha')
      await runner.startTask(asker, mockProvider)
      await flush()
      agentFor('Alpha')!.ask()
      await flush()
      expect(runner.isPaused(asker.id)).toBe(true)

      // A task without a session cannot be resumed — the bypass slot taken for
      // the attempt has to be given back.
      db.prepare('UPDATE tasks SET session_id = NULL WHERE id = ?').run(asker.id)
      expect(await runner.resumeTask(asker.id, 'Use Postgres')).toBe(false)

      const follower = createTask('Bravo')
      await runner.startTask(follower, mockProvider)
      await flush()
      expect(runner.isRunning(follower.id)).toBe(true)
      expect(runner.getQueuedTaskIds()).toEqual([])
    })
  })

  describe('aborting a queued task', () => {
    it('finalises the row and never starts it later', async () => {
      limit = 1
      const blocker = createTask('Alpha')
      const queued = createTask('Bravo')
      await runner.startTask(blocker, mockProvider)
      await runner.startTask(queued, mockProvider)
      await flush()
      expect(runner.getQueuedTaskIds()).toEqual([queued.id])

      runner.abortTask(queued.id, 'Aborted by user')
      await flush()

      const row = store.getById(queued.id)!
      expect(row.status).toBe('failed')
      expect(row.completedAt).toBeTruthy()
      expect(runner.getQueuedTaskIds()).toEqual([])
      expect(runner.isQueued(queued.id)).toBe(false)

      // Freeing the slot must not revive the aborted task.
      agentFor('Alpha')!.complete()
      await flush()
      expect(agentFor('Bravo')).toBeUndefined()
      expect(runner.isRunning(queued.id)).toBe(false)
      expect(store.getById(queued.id)!.status).toBe('failed')
    })

    it('skips a queued task whose row was finalised behind the queue', async () => {
      limit = 1
      const blocker = createTask('Alpha')
      const queued = createTask('Bravo')
      const other = createTask('Charlie')
      await runner.startTask(blocker, mockProvider)
      await runner.startTask(queued, mockProvider)
      await runner.startTask(other, mockProvider)
      await flush()

      // Simulate an external finalisation (e.g. a kill via the API layer)
      // without going through abortTask.
      store.update(queued.id, { status: 'failed', resultStatus: 'failed', completedAt: '2026-01-01 00:00:00' })

      agentFor('Alpha')!.complete()
      await flush()

      expect(agentFor('Bravo')).toBeUndefined()
      // The slot is handed to the next runnable task instead of being lost.
      expect(runner.isRunning(other.id)).toBe(true)
    })
  })

  describe('time budget', () => {
    it('starts the max-duration budget at the real start, not at enqueue', async () => {
      vi.useFakeTimers()
      limit = 1
      const blocker = createTask('Alpha')
      const waiting = createTask('Bravo', 'agent', 10)
      await runner.startTask(blocker, mockProvider)
      await runner.startTask(waiting, mockProvider)
      await vi.advanceTimersByTimeAsync(10)
      expect(runner.getQueuedTaskIds()).toEqual([waiting.id])

      // Wait far longer than Bravo's 10 minute budget while it is queued.
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(store.getById(waiting.id)!.status).toBe('running')
      expect(store.getById(waiting.id)!.startedAt).toBeNull()

      agentFor('Alpha')!.complete()
      await vi.advanceTimersByTimeAsync(10)
      expect(runner.isRunning(waiting.id)).toBe(true)
      const startedAt = store.getById(waiting.id)!.startedAt
      expect(startedAt).toBeTruthy()

      // 9 minutes after the real start it must still be alive; queued time
      // must not count against the budget.
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      expect(store.getById(waiting.id)!.status).toBe('running')
      expect(runner.isRunning(waiting.id)).toBe(true)

      // And it dies at its own 10 minute mark.
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(store.getById(waiting.id)!.status).toBe('failed')
      expect(store.getById(waiting.id)!.errorMessage).toBe('Max duration exceeded')
    })
  })

  describe('recovery after a server restart', () => {
    it('routes recovered tasks through the queue instead of starting them all', async () => {
      limit = 2
      // Three tasks that were running when the server went down.
      const crashed = ['Alpha', 'Bravo', 'Charlie'].map((name) => {
        const t = createTask(name)
        store.update(t.id, { startedAt: '2026-01-01 00:00:00' })
        return t
      })

      const result = await runner.recoverTasks(() => mockProvider, mockProvider)
      await flush()

      expect(result.resumed).toBe(3)
      // Only `limit` recovered tasks actually run; the rest wait.
      expect(agents).toHaveLength(2)
      expect(runner.getRunningTaskIds()).toHaveLength(2)
      expect(runner.getQueuedTaskIds()).toHaveLength(1)

      // The original rows are failed with the server-restart marker (existing
      // recovery semantics are unchanged).
      for (const t of crashed) {
        expect(store.getById(t.id)!.status).toBe('failed')
        expect(store.getById(t.id)!.errorMessage).toBe('server restart')
      }

      // The queued replacement row is the durable marker: running + no start.
      const queuedId = runner.getQueuedTaskIds()[0]!
      const queuedRow = store.getById(queuedId)!
      expect(queuedRow.status).toBe('running')
      expect(queuedRow.startedAt).toBeNull()
      expect(queuedRow.name).toContain('(resumed)')

      // Draining works: finishing a recovered task starts the waiting one.
      agents[0]!.complete()
      await flush()
      expect(runner.getQueuedTaskIds()).toEqual([])
      expect(agents).toHaveLength(3)
    })

    it('queues recovered cronjob tasks too (no restart storm)', async () => {
      limit = 1
      for (const name of ['Alpha', 'Bravo']) {
        const t = createTask(name, 'cronjob')
        store.update(t.id, { startedAt: '2026-01-01 00:00:00' })
      }

      const result = await runner.recoverTasks(() => mockProvider, mockProvider)
      await flush()

      expect(result.resumed).toBe(2)
      expect(agents).toHaveLength(1)
      expect(runner.getQueuedTaskIds()).toHaveLength(1)
    })
  })
})
