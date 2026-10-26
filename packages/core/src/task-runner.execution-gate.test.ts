import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase } from './database.js'
import { TaskStore } from './task-store.js'
import { TaskRunner, TaskExecutionRefusedError, TASK_EXECUTION_REFUSED_PREFIX } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import type { Database } from './database.js'
import type { ProviderConfig } from './provider-config.js'
import { SessionManager } from './session-manager.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * B-01-R execution/admission gate (`refuseTaskExecution`) on every TaskRunner
 * lifecycle path: admission, queue pump, resume, restart recovery, credential
 * refresh, per-call tool gate, verifier/schema rounds. The agent mock below is
 * the one of the concurrency suite (controllable prompt), extended to keep the
 * constructor options so the test can reach the tools and the credential hook
 * the runner handed to the agent.
 *
 * Original header of the borrowed mock: tests for the global task concurrency limit (`tasks.maxConcurrent`). The
 * per-provider limit is switched off here (perProvider 0) so these tests pin
 * the host-wide cap on its own; see task-runner.concurrency-per-provider.test.ts
 * for the per-provider slots.
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
  options: any
}

const agents: AgentHandle[] = []

vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation((options: any) => {
      const messages: unknown[] = []
      let subscribeFn: ((event: unknown) => void) | null = null
      let settle: ((outcome: { error?: Error }) => void) | null = null

      const handle: AgentHandle = {
        index: agents.length,
        systemPrompt: String(options?.initialState?.systemPrompt ?? ''),
        aborted: false,
        options,
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


describe('TaskRunner — B-01-R execution gate', () => {
  let db: Database
  let store: TaskStore
  let runner: TaskRunner
  let sessionManager: SessionManager
  const tmpFiles: string[] = []
  let limit: number
  const invalid = new Set<string>()
  let gateThrows = false
  const buildModel = vi.fn(() => ({} as ReturnType<TaskRunnerOptions['buildModel']>))
  const getApiKey = vi.fn(async () => 'test-key')
  const toolExecute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'REAL_TOOL_RAN' }], details: {} }))
  const onTaskComplete = vi.fn()
  const gate = vi.fn((task: { id: string }) => {
    if (gateThrows) throw new Error('lineage walk failed')
    return invalid.has(task.id) ? 'invalid ownership lineage' : null
  })

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-b01r-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
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
      buildModel,
      getApiKey,
      tools: [{ name: 'probe_tool', label: 'probe', description: 'probe', parameters: {} as never, execute: toolExecute } as never],
      onTaskComplete,
      sessionManager,
      getMaxConcurrentTasks: () => limit,
      getProviderTaskLimits: () => ({ perProvider: 0 }),
      refuseTaskExecution: gate,
      ...overrides,
    })
  }

  function createTask(name: string, triggerType: 'user' | 'agent' | 'cronjob' | 'heartbeat' = 'agent') {
    return store.create({ name, prompt: `Work on ${name}`, triggerType })
  }

  function agentFor(taskName: string): AgentHandle | undefined {
    return agents.find(a => a.systemPrompt.includes(`Work on ${taskName}`))
  }

  function expectQuarantined(taskId: string): void {
    const row = store.getById(taskId)!
    expect(row.status).toBe('failed')
    expect(row.resultSummary).toContain(TASK_EXECUTION_REFUSED_PREFIX)
    expect(row.errorMessage).toContain(TASK_EXECUTION_REFUSED_PREFIX)
  }

  beforeEach(() => {
    agents.length = 0
    invalid.clear()
    gateThrows = false
    limit = 2
    buildModel.mockClear()
    getApiKey.mockClear()
    toolExecute.mockClear()
    onTaskComplete.mockClear()
    gate.mockClear()
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

  it('admission: an invalid task is rejected before model, credential, agent or tool', async () => {
    const t = createTask('Invalid')
    invalid.add(t.id)
    await expect(runner.startTask(t, mockProvider)).rejects.toBeInstanceOf(TaskExecutionRefusedError)
    await flush()
    expect(agents).toHaveLength(0)
    expect(buildModel).not.toHaveBeenCalled()
    expect(getApiKey).not.toHaveBeenCalled()
    expect(toolExecute).not.toHaveBeenCalled()
    expect(onTaskComplete).not.toHaveBeenCalled()
    expect(runner.getRunningTaskIds()).toEqual([])
    expect(runner.getQueuedTaskIds()).toEqual([])
    expectQuarantined(t.id)
  })

  it('admission: bypassing trigger types (cronjob, heartbeat) are gated too', async () => {
    for (const trigger of ['cronjob', 'heartbeat'] as const) {
      const t = createTask(`Invalid ${trigger}`, trigger)
      invalid.add(t.id)
      await expect(runner.startTask(t, mockProvider)).rejects.toBeInstanceOf(TaskExecutionRefusedError)
      expectQuarantined(t.id)
    }
    expect(agents).toHaveLength(0)
    expect(buildModel).not.toHaveBeenCalled()
    expect(getApiKey).not.toHaveBeenCalled()
  })

  it('admission: a throwing gate refuses (fail closed)', async () => {
    const t = createTask('Gate error')
    gateThrows = true
    await expect(runner.startTask(t, mockProvider)).rejects.toBeInstanceOf(TaskExecutionRefusedError)
    expect(agents).toHaveLength(0)
    expect(buildModel).not.toHaveBeenCalled()
    expect(getApiKey).not.toHaveBeenCalled()
    expectQuarantined(t.id)
  })

  it('counter-check: admitted tasks (owner/none) still build the model, get a credential and reach their tools', async () => {
    for (const trigger of ['agent', 'user', 'cronjob', 'heartbeat'] as const) {
      const t = createTask(`Valid ${trigger}`, trigger)
      await runner.startTask(t, mockProvider)
      await flush()
      const agent = agentFor(`Valid ${trigger}`)!
      expect(agent).toBeTruthy()
      const tool = agent.options.initialState.tools.find((x: { name: string }) => x.name === 'probe_tool')
      const result = await tool.execute('call', {})
      expect(result.content[0].text).toBe('REAL_TOOL_RAN')
      expect(await agent.options.getApiKey('openai')).toBe('test-key')
      agent.complete()
      await flush()
      expect(store.getById(t.id)!.status).toBe('completed')
    }
    expect(buildModel).toHaveBeenCalled()
    expect(toolExecute).toHaveBeenCalledTimes(4)
  })

  it('queue pump: a task that turned invalid while queued is quarantined when dequeued', async () => {
    limit = 1
    const a = createTask('Alpha')
    const b = createTask('Bravo')
    await runner.startTask(a, mockProvider)
    await runner.startTask(b, mockProvider)
    await flush()
    expect(runner.getQueuedTaskIds()).toEqual([b.id])
    const modelCalls = buildModel.mock.calls.length
    const keyCalls = getApiKey.mock.calls.length
    invalid.add(b.id)
    agentFor('Alpha')!.complete()
    await flush()
    expect(agents).toHaveLength(1)
    expect(agentFor('Bravo')).toBeUndefined()
    expect(buildModel.mock.calls.length).toBe(modelCalls)
    expect(getApiKey.mock.calls.length).toBe(keyCalls)
    expect(runner.isRunning(b.id)).toBe(false)
    expect(runner.getQueuedTaskIds()).toEqual([])
    expectQuarantined(b.id)
    // The slot was released: a valid task starts right away.
    const c = createTask('Charlie')
    await runner.startTask(c, mockProvider)
    await flush()
    expect(runner.isRunning(c.id)).toBe(true)
  })

  it('resume: a paused task that turned invalid is not resumed and is quarantined', async () => {
    const asker = createTask('Asker')
    await runner.startTask(asker, mockProvider)
    await flush()
    agentFor('Asker')!.ask()
    await flush()
    expect(runner.isPaused(asker.id)).toBe(true)
    const modelCalls = buildModel.mock.calls.length
    invalid.add(asker.id)
    expect(await runner.resumeTask(asker.id, 'go on')).toBe(false)
    await flush()
    expect(runner.isPaused(asker.id)).toBe(false)
    expect(runner.isRunning(asker.id)).toBe(false)
    expect(agentFor('Asker')!.aborted).toBe(true)
    expect(buildModel.mock.calls.length).toBe(modelCalls)
    expectQuarantined(asker.id)
  })

  it('resume counter-check: a valid paused task still resumes', async () => {
    const asker = createTask('Asker2')
    await runner.startTask(asker, mockProvider)
    await flush()
    agentFor('Asker2')!.ask()
    await flush()
    expect(await runner.resumeTask(asker.id, 'go on')).toBe(true)
    await flush()
    expect(runner.isRunning(asker.id)).toBe(true)
  })

  it('restart recovery: an invalid interrupted task is not copied into a resumed run', async () => {
    const bad = createTask('CrashedInvalid')
    const good = createTask('CrashedValid')
    for (const t of [bad, good]) store.update(t.id, { startedAt: '2026-01-01 00:00:00' })
    invalid.add(bad.id)
    const result = await runner.recoverTasks(() => mockProvider, mockProvider)
    await flush()
    expect(result.resumed).toBe(1)
    expect(result.failed).toBe(1)
    expectQuarantined(bad.id)
    expect(store.getById(bad.id)!.errorMessage).toContain('server restart; not resumed')
    const names = (db.prepare('SELECT name FROM tasks').all() as { name: string }[]).map(r => r.name)
    expect(names).not.toContain('CrashedInvalid (resumed)')
    expect(names).toContain('CrashedValid (resumed)')
    expect(agents.some(a => a.systemPrompt.includes('Work on CrashedInvalid'))).toBe(false)
  })

  it('mid-run: lineage turning invalid revokes every further tool call and credential refresh', async () => {
    const t = createTask('Midrun')
    await runner.startTask(t, mockProvider)
    await flush()
    const agent = agentFor('Midrun')!
    const tool = agent.options.initialState.tools.find((x: { name: string }) => x.name === 'probe_tool')
    invalid.add(t.id)
    const refused = await tool.execute('call', {})
    expect(refused.details).toMatchObject({ error: true, refused: true })
    expect(refused.content[0].text).toContain(TASK_EXECUTION_REFUSED_PREFIX)
    expect(toolExecute).not.toHaveBeenCalled()
    const keyCalls = getApiKey.mock.calls.length
    await expect(agent.options.getApiKey('openai')).rejects.toBeInstanceOf(TaskExecutionRefusedError)
    expect(getApiKey.mock.calls.length).toBe(keyCalls)
  })

  it('verifier round: no reviewer model for a task that turned invalid', async () => {
    runner.dispose()
    runner = makeRunner({ verification: { enabled: true } as never })
    const t = createTask('Verify')
    await runner.startTask(t, mockProvider)
    await flush()
    const modelCalls = buildModel.mock.calls.length
    invalid.add(t.id)
    agentFor('Verify')!.complete('done')
    await flush()
    expect(buildModel.mock.calls.length).toBe(modelCalls)
    expect(agents).toHaveLength(1)
    expect(store.getById(t.id)!.resultSummary).toContain(TASK_EXECUTION_REFUSED_PREFIX)
    expect(store.getById(t.id)!.status).toBe('failed')
  })
})
