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
 * Tests for the per-provider task slots (`tasks.maxConcurrentPerProvider`,
 * `tasks.maxConcurrentByProvider`) together with the global safety cap.
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

function providerWithId(id: string): ProviderConfig {
  return { ...mockProvider, id, name: `name-${id}` }
}

const P1 = providerWithId('provider-one')
const P2 = providerWithId('provider-two')

describe('TaskRunner — per-provider concurrency', () => {
  let db: Database
  let store: TaskStore
  let runner: TaskRunner
  let sessionManager: SessionManager
  const tmpFiles: string[] = []
  let globalLimit: number
  let perProvider: number
  let byProvider: Record<string, number>

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-taskqueue-pp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

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
      getMaxConcurrentTasks: () => globalLimit,
      getProviderTaskLimits: () => ({ perProvider, byProvider }),
      ...overrides,
    })
  }

  function createTask(name: string, provider: ProviderConfig, triggerType: 'user' | 'agent' | 'cronjob' | 'heartbeat' = 'agent') {
    return store.create({ name, prompt: `Work on ${name}`, triggerType, provider: provider.name })
  }

  function agentFor(taskName: string): AgentHandle | undefined {
    return agents.find(a => a.systemPrompt.includes(`Work on ${taskName}`))
  }

  beforeEach(() => {
    agents.length = 0
    globalLimit = 12
    perProvider = 5
    byProvider = {}
    db = initDatabase(tmpDbPath())
    store = new TaskStore(db)
    sessionManager = new SessionManager({ db })
    runner = makeRunner()
  })

  afterEach(async () => {
    vi.useRealTimers()
    runner.dispose()
    await flush()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  it('runs 5 tasks per provider in parallel and lets another provider pass a waiting task', async () => {
    const one = Array.from({ length: 6 }, (_, i) => createTask(`One${i}`, P1))
    const two = Array.from({ length: 5 }, (_, i) => createTask(`Two${i}`, P2))
    for (const t of one) await runner.startTask(t, P1)
    for (const t of two) await runner.startTask(t, P2)
    await flush()

    expect(runner.getRunningTaskIds()).toHaveLength(10)
    expect(runner.getQueuedTaskIds()).toEqual([one[5]!.id])

    // The waiting task keeps the durable QUEUED marker.
    const waiting = store.getById(one[5]!.id)!
    expect(waiting.status).toBe('running')
    expect(waiting.startedAt).toBeNull()

    const info = runner.getQueueInfo(one[5]!.id)
    expect(info).toMatchObject({
      queued: true, position: 1, running: 10, queued_count: 1, limit: 12,
      reason: 'provider', provider: 'provider-one', provider_running: 5, provider_limit: 5,
    })

    // A slot of the other provider frees up: the waiting task does not move.
    agentFor('Two0')!.complete()
    await flush()
    expect(runner.getQueuedTaskIds()).toEqual([one[5]!.id])

    // A slot of its own provider frees up: now it starts.
    agentFor('One0')!.complete()
    await flush()
    expect(runner.isRunning(one[5]!.id)).toBe(true)
    expect(store.getById(one[5]!.id)!.startedAt).toBeTruthy()
  })

  it('reports the global cap as the wait reason when it is the binding limit', async () => {
    globalLimit = 2
    const a = createTask('Alpha', P1)
    const b = createTask('Bravo', P2)
    const c = createTask('Charlie', P2)
    for (const [t, p] of [[a, P1], [b, P2], [c, P2]] as const) await runner.startTask(t, p)
    await flush()

    expect(runner.getQueuedTaskIds()).toEqual([c.id])
    expect(runner.getQueueInfo(c.id)).toMatchObject({ reason: 'global', provider: 'provider-two', provider_running: 1 })

    agentFor('Alpha')!.complete()
    await flush()
    expect(runner.isRunning(c.id)).toBe(true)
  })

  it('aborting a waiting task removes it and never starts it', async () => {
    perProvider = 1
    const blocker = createTask('Alpha', P1)
    const queued = createTask('Bravo', P1)
    await runner.startTask(blocker, P1)
    await runner.startTask(queued, P1)
    await flush()
    expect(runner.getQueuedTaskIds()).toEqual([queued.id])

    runner.abortTask(queued.id, 'Aborted by user')
    await flush()
    expect(store.getById(queued.id)!.status).toBe('failed')
    expect(runner.isQueued(queued.id)).toBe(false)

    agentFor('Alpha')!.complete()
    await flush()
    expect(agentFor('Bravo')).toBeUndefined()
  })

  it('bypassing cronjobs take a slot of their own provider only', async () => {
    perProvider = 1
    const cron = createTask('Alpha', P1, 'cronjob')
    await runner.startTask(cron, P1)
    await flush()
    expect(runner.isRunning(cron.id)).toBe(true)

    const sameProvider = createTask('Bravo', P1)
    const otherProvider = createTask('Charlie', P2)
    await runner.startTask(sameProvider, P1)
    await runner.startTask(otherProvider, P2)
    await flush()
    expect(runner.getQueuedTaskIds()).toEqual([sameProvider.id])
    expect(runner.isRunning(otherProvider.id)).toBe(true)
  })

  it('a resumed task re-occupies a slot of the provider it was admitted with', async () => {
    perProvider = 1
    const asker = createTask('Alpha', P1)
    await runner.startTask(asker, P1)
    await flush()
    agentFor('Alpha')!.ask()
    await flush()
    expect(runner.isPaused(asker.id)).toBe(true)

    expect(await runner.resumeTask(asker.id, 'Use Postgres')).toBe(true)
    await flush()

    const follower = createTask('Bravo', P1)
    await runner.startTask(follower, P1)
    await flush()
    expect(runner.getQueueInfo(follower.id)).toMatchObject({ queued: true, reason: 'provider', provider_running: 1 })
  })

  it('applies the per-provider override and picks up live changes', async () => {
    byProvider = { 'provider-one': 1 }
    const a = createTask('Alpha', P1)
    const b = createTask('Bravo', P1)
    const c = createTask('Charlie', P1)
    for (const t of [a, b, c]) await runner.startTask(t, P1)
    await flush()
    expect(runner.getQueuedTaskIds()).toEqual([b.id, c.id])

    byProvider = { 'provider-one': 3 }
    agentFor('Alpha')!.complete()
    await flush()
    expect(runner.getQueuedTaskIds()).toEqual([])
    expect(runner.isRunning(b.id)).toBe(true)
    expect(runner.isRunning(c.id)).toBe(true)
  })

  it('recovers tasks of mixed providers through the per-provider queue', async () => {
    perProvider = 1
    for (const [name, p] of [['Alpha', P1], ['Bravo', P1], ['Charlie', P2], ['Delta', P2]] as const) {
      const t = createTask(name, p)
      store.update(t.id, { startedAt: '2026-01-01 00:00:00' })
    }

    const byName = (name: string) => (name === P1.name ? P1 : name === P2.name ? P2 : null)
    const result = await runner.recoverTasks(byName, P1)
    await flush()

    expect(result.resumed).toBe(4)
    // One per provider runs, one per provider waits.
    expect(agents).toHaveLength(2)
    expect(runner.getRunningTaskIds()).toHaveLength(2)
    const queued = runner.getQueuedTaskIds()
    expect(queued).toHaveLength(2)
    for (const id of queued) {
      const row = store.getById(id)!
      expect(row.status).toBe('running')
      expect(row.startedAt).toBeNull()
    }
    expect(queued.map(id => runner.getQueueInfo(id).provider).sort()).toEqual(['provider-one', 'provider-two'])

    // Finishing the provider-two run starts the provider-two waiter.
    const twoRunningName = ['Charlie', 'Delta'].find(name => agentFor(name))!
    agentFor(twoRunningName)!.complete()
    await flush()
    expect(agents).toHaveLength(3)
    expect(runner.getQueuedTaskIds()).toHaveLength(1)
    expect(runner.getQueueInfo(runner.getQueuedTaskIds()[0]!).provider).toBe('provider-one')
  })
})
