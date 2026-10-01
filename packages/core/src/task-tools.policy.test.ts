/**
 * Integration tests for the task policy at the `create_task` boundary and in
 * the runner: strand pins bound to the CALLING turn (two strands in
 * parallel), parent inheritance, explicit overrides, persisted thinking and
 * its use at start, recovery and verification. Synthetic fixtures only.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import { createTaskTool } from './task-tools.js'
import type { TaskToolsOptions } from './task-tools.js'
import type { ProviderConfig } from './provider-config.js'
import type { CreateTaskInput, Task, TaskListFilters, UpdateTaskInput } from './task-store.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'
import { runWithTaskExecutionContext } from './task-execution-context.js'

const ANTH: ProviderConfig = {
  id: 'anth-id',
  name: 'anth',
  type: 'anthropic-messages',
  providerType: 'anthropic-oauth',
  provider: 'anthropic',
  baseUrl: 'http://localhost:1',
  apiKey: 'k',
  enabledModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  models: [],
  status: 'connected',
  authMethod: 'oauth',
} as unknown as ProviderConfig

const OAI: ProviderConfig = {
  ...ANTH,
  id: 'oai-id',
  name: 'oai',
  type: 'openai-codex-responses',
  providerType: 'openai-codex',
  provider: 'openai-codex',
  enabledModels: ['gpt-6-sol', 'gpt-6-luna'],
} as unknown as ProviderConfig

const PROVIDERS = [ANTH, OAI]
const byIdOrName = (v: string) => PROVIDERS.find((p) => p.id === v || p.name === v) ?? null

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    estimateCost: vi.fn(() => 0),
    resolveProviderModelInput: vi.fn((input: { provider?: string; model?: string }) => {
      const list = [
        { id: 'anth-id', name: 'anth', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
        { id: 'oai-id', name: 'oai', models: ['gpt-6-sol', 'gpt-6-luna'] },
      ]
      const hit = input.provider
        ? list.find((p) => p.id === input.provider || p.name === input.provider)
        : list.find((p) => p.models.includes(input.model ?? ''))
      if (!hit) return { ok: false, error: `Unknown provider/model "${input.provider ?? ''}${input.model ?? ''}".` }
      const modelId = input.model ?? hit.models[0]
      if (!hit.models.includes(modelId)) return { ok: false, error: `Model "${modelId}" is not enabled on "${hit.name}".` }
      return { ok: true, providerId: hit.id, providerName: hit.name, modelId, composite: `${hit.id}:${modelId}` }
    }),
  }
})

const agentInits: Array<{ thinkingLevel?: string; prompt?: string }> = []
let agentPrompt: () => Promise<void> = () => new Promise<void>(() => {})
const agentMessages: unknown[] = []

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation((options: { initialState?: { thinkingLevel?: string; systemPrompt?: string } }) => {
    agentInits.push({ thinkingLevel: options.initialState?.thinkingLevel, prompt: options.initialState?.systemPrompt })
    return {
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(() => agentPrompt()),
      abort: vi.fn(),
      state: { get messages() { return agentMessages } },
    }
  }),
}))

const completeSimpleMock = vi.fn()
vi.mock('./pi-models.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, completeSimple: (...args: unknown[]) => completeSimpleMock(...args) }
})

describe('task policy at create_task', () => {
  const tmpFiles: string[] = []
  let db: Database
  let runner: TaskRunner
  // Simulates AgentCore's per-turn ALS: each turn sees ITS session id.
  const turn = new AsyncLocalStorage<{ sessionId: string }>()

  function boundary(): TaskRuntimeTaskBoundary {
    const store = runner.getStore()
    return {
      create: (input: CreateTaskInput) => store.create(input),
      getById: (id: string) => store.getById(id),
      list: (filters?: TaskListFilters) => store.list(filters),
      update: (id: string, updates: UpdateTaskInput) => store.update(id, updates),
      start: (task: Task, provider, overrides, parentSessionId) => runner.startTask(task, provider, overrides, parentSessionId),
      resume: (taskId: string, message: string) => runner.resumeTask(taskId, message),
      abort: (taskId: string, reason?: string) => runner.abortTask(taskId, reason),
      isRunning: (taskId: string) => runner.isRunning(taskId),
      getRunningIds: () => runner.getRunningTaskIds(),
      isPaused: (taskId: string) => runner.isPaused(taskId),
      getPausedIds: () => runner.getPausedTaskIds(),
      cleanupStalePaused: () => runner.cleanupStalePausedTasks(),
      recover: (getProvider, defaultProvider) => runner.recoverTasks(getProvider, defaultProvider),
    }
  }

  function tool(overrides: Partial<TaskToolsOptions> = {}) {
    return createTaskTool({
      taskRuntime: boundary(),
      // Default chain: parent task (ALS) first, else a system default on Opus.
      getDefaultProvider: () => {
        return { ...ANTH, enabledModels: ['claude-opus-5-5'] }
      },
      resolveProvider: byIdOrName,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 120,
      getParentSessionId: () => turn.getStore()?.sessionId ?? null,
      db,
      checkAutomaticModel: () => ({ allowed: true, reason: 'allowed' }),
      ...overrides,
    })
  }

  function seedStrand(id: string, pin: { providerId: string; modelId: string } | null): void {
    db.prepare("INSERT INTO sessions (id, type, model_provider_id, model_id) VALUES (?, 'interactive', ?, ?)")
      .run(id, pin?.providerId ?? null, pin?.modelId ?? null)
  }

  const text = (r: { content: Array<{ type: string; text?: string }> }) => (r.content[0] as { text: string }).text
  const taskByName = (name: string) => runner.getStore().list().find((t) => t.name === name)

  beforeEach(() => {
    setHeuristicsOverrideForTests({ delegation: { minBriefChars: 0 } })
    const p = path.join(os.tmpdir(), `task-policy-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
    agentInits.length = 0
    agentMessages.length = 0
    agentPrompt = () => new Promise<void>(() => {})
    completeSimpleMock.mockReset()
    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'k',
      tools: [],
      memoryDir: undefined,
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
      backgroundThinkingLevel: 'off',
      getProviderById: byIdOrName,
    }
    runner = new TaskRunner(options)
  })

  afterEach(() => {
    setHeuristicsOverrideForTests(null)
    runner.dispose()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  it('two strands delegating in parallel each get their OWN strand provider (no cross-talk)', async () => {
    seedStrand('strand-a', { providerId: 'anth-id', modelId: 'claude-opus-5-5' })
    seedStrand('strand-b', { providerId: 'oai-id', modelId: 'gpt-6-sol' })
    const t = tool()
    // Interleave: both turns are in flight at the same time.
    const [ra, rb] = await Promise.all([
      turn.run({ sessionId: 'strand-a' }, async () => {
        await new Promise((r) => setTimeout(r, 5))
        return t.execute('a', { prompt: 'p', name: 'A', task_kind: 'research', difficulty: 'high' })
      }),
      turn.run({ sessionId: 'strand-b' }, async () => {
        return t.execute('b', { prompt: 'p', name: 'B', task_kind: 'research', difficulty: 'high' })
      }),
    ])
    expect((ra.details as { error?: boolean }).error).toBeUndefined()
    expect((rb.details as { error?: boolean }).error).toBeUndefined()
    const a = taskByName('A')!
    const b = taskByName('B')!
    expect([a.provider, a.model, a.thinkingLevel]).toEqual(['anth', 'claude-opus-5-5', 'medium'])
    expect([b.provider, b.model, b.thinkingLevel]).toEqual(['oai', 'gpt-6-sol', 'medium'])
    expect(a.routing?.source).toBe('strand')
    expect(b.routing?.source).toBe('strand')
    // Each task session hangs below ITS strand.
    const parentOf = (sid: string | null) => (db.prepare('SELECT parent_session_id FROM sessions WHERE id = ?').get(sid) as { parent_session_id: string }).parent_session_id
    expect(parentOf(a.sessionId)).toBe('strand-a')
    expect(parentOf(b.sessionId)).toBe('strand-b')
  })

  it('an explicit model pin wins over the strand pin; visible in the tool result', async () => {
    seedStrand('strand-a', { providerId: 'anth-id', modelId: 'claude-opus-5-5' })
    const r = await turn.run({ sessionId: 'strand-a' }, () =>
      tool().execute('x', { prompt: 'p', name: 'Pinned', model: 'gpt-6-luna', task_kind: 'extraction', difficulty: 'low' }))
    const task = taskByName('Pinned')!
    expect([task.provider, task.model, task.thinkingLevel, task.isDefaultModel]).toEqual(['oai', 'gpt-6-luna', 'off', false])
    expect(text(r)).toContain('Model: gpt-6-luna · thinking off')
    expect(r.details).toMatchObject({ model: 'gpt-6-luna', thinkingLevel: 'off', routing: { source: 'explicit' } })
  })

  it('a sub-task inside a parent task inherits the parent provider and ignores any strand', async () => {
    seedStrand('strand-a', { providerId: 'anth-id', modelId: 'claude-opus-5-5' })
    const parentProvider = { ...OAI, enabledModels: ['gpt-6-luna'] }
    const t = tool({
      // Production chain: parent first.
      getDefaultProvider: () => parentProvider,
    })
    await turn.run({ sessionId: 'strand-a' }, () =>
      runWithTaskExecutionContext({ provider: parentProvider, taskId: 'parent-task' }, () =>
        t.execute('c', { prompt: 'p', name: 'Child', task_kind: 'coding', difficulty: 'medium' })))
    const child = taskByName('Child')!
    expect([child.provider, child.model, child.thinkingLevel]).toEqual(['oai', 'gpt-6-sol', 'medium'])
    expect(child.routing?.source).toBe('parent')
  })

  it('a strand without pin and a call without profile keep the legacy default (thinking NULL)', async () => {
    seedStrand('strand-free', null)
    await turn.run({ sessionId: 'strand-free' }, () => tool().execute('d', { prompt: 'p', name: 'Legacy' }))
    const task = taskByName('Legacy')!
    expect([task.provider, task.model, task.thinkingLevel, task.isDefaultModel]).toEqual(['anth', 'claude-opus-5-5', null, true])
    // The runner falls back to the background setting ('off' here).
    expect(agentInits.at(-1)?.thinkingLevel).toBe('off')
  })

  it('a pinned strand without profile gets the thrifty fallback', async () => {
    seedStrand('strand-b', { providerId: 'oai-id', modelId: 'gpt-6-sol' })
    await turn.run({ sessionId: 'strand-b' }, () => tool().execute('e', { prompt: 'p', name: 'Fallback' }))
    const task = taskByName('Fallback')!
    expect([task.model, task.thinkingLevel]).toEqual(['gpt-6-sol', 'low'])
    expect(task.routing?.thinkingSource).toBe('fallback')
    // Chosen by the strand tie-breaker, not by the default chain.
    expect(task.isDefaultModel).toBe(false)
  })

  it('rejects unknown classes, unknown thinking, xhigh without reason and disabled models — no task row', async () => {
    seedStrand('strand-a', { providerId: 'anth-id', modelId: 'claude-opus-5-5' })
    const t = tool()
    const run = (params: Record<string, unknown>) => turn.run({ sessionId: 'strand-a' }, () => t.execute('f', { prompt: 'p', name: 'Bad', ...params }))
    for (const params of [
      { task_kind: 'poetry' },
      { difficulty: 'insane' },
      { thinking: 'ultra' },
      { thinking: 'xhigh' },
      { model: 'gpt-7-unknown' },
    ]) {
      const r = await run(params)
      expect(r.details, JSON.stringify(params)).toMatchObject({ error: true })
    }
    expect(taskByName('Bad')).toBeUndefined()
  })

  it('a data-policy block fails the call instead of switching provider', async () => {
    seedStrand('strand-b', { providerId: 'oai-id', modelId: 'gpt-6-sol' })
    const r = await turn.run({ sessionId: 'strand-b' }, () => tool({
      checkAutomaticModel: () => ({ allowed: false, reason: 'blocked:test' }),
    }).execute('g', { prompt: 'p', name: 'Gated', task_kind: 'review', difficulty: 'low' }))
    expect(r.details).toMatchObject({ error: true })
    expect(text(r)).toContain('blocked:test')
    expect(taskByName('Gated')).toBeUndefined()
  })

  it('applies the persisted thinking level when the runner starts the agent', async () => {
    seedStrand('strand-a', { providerId: 'anth-id', modelId: 'claude-opus-5-5' })
    await turn.run({ sessionId: 'strand-a' }, () =>
      tool().execute('h', { prompt: 'p', name: 'Think', task_kind: 'review', difficulty: 'high' }))
    const task = taskByName('Think')!
    expect(task.thinkingLevel).toBe('high')
    expect(agentInits.at(-1)?.thinkingLevel).toBe('high')
    // Persisted in the row itself.
    const row = db.prepare('SELECT thinking_level, routing FROM tasks WHERE id = ?').get(task.id) as { thinking_level: string; routing: string }
    expect(row.thinking_level).toBe('high')
    expect(JSON.parse(row.routing)).toMatchObject({ kind: 'review', difficulty: 'high', tier: 'strong' })
  })

  it('recovery keeps model pin and thinking level of the interrupted task', async () => {
    seedStrand('strand-a', { providerId: 'anth-id', modelId: 'claude-opus-5-5' })
    await turn.run({ sessionId: 'strand-a' }, () =>
      tool().execute('i', { prompt: 'p', name: 'Recover', task_kind: 'extraction', difficulty: 'medium' }))
    const original = taskByName('Recover')!
    expect([original.model, original.thinkingLevel]).toEqual(['claude-sonnet-5-5', 'minimal'])

    // Simulate a restart: a fresh runner on the same DB.
    runner.dispose()
    agentInits.length = 0
    const builtFor: string[] = []
    runner = new TaskRunner({
      db,
      buildModel: (p: ProviderConfig) => {
        builtFor.push(p.enabledModels?.[0] ?? '')
        return { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as ReturnType<TaskRunnerOptions['buildModel']>
      },
      getApiKey: async () => 'k',
      tools: [],
      memoryDir: undefined,
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
      backgroundThinkingLevel: 'off',
    })
    // getProvider returns the FULL provider (Opus first) — the pin must be re-applied.
    const recovered = await runner.recoverTasks(byIdOrName, ANTH)
    expect(recovered.resumed).toBe(1)
    const resumed = runner.getStore().list().find((t) => t.name === 'Recover (resumed)')!
    expect([resumed.model, resumed.thinkingLevel]).toEqual(['claude-sonnet-5-5', 'minimal'])
    expect(resumed.routing?.kind).toBe('extraction')
    expect(agentInits.at(-1)?.thinkingLevel).toBe('minimal')
    expect(builtFor.at(-1)).toBe('claude-sonnet-5-5')
  })

  it('recovery with a meanwhile disabled pin records the model that actually runs', async () => {
    seedStrand('strand-a', { providerId: 'anth-id', modelId: 'claude-opus-5-5' })
    await turn.run({ sessionId: 'strand-a' }, () =>
      tool().execute('k', { prompt: 'p', name: 'Gone', task_kind: 'extraction', difficulty: 'medium' }))
    expect(taskByName('Gone')!.model).toBe('claude-sonnet-5-5')

    runner.dispose()
    const builtFor: string[] = []
    runner = new TaskRunner({
      db,
      buildModel: (p: ProviderConfig) => {
        builtFor.push(p.enabledModels?.[0] ?? '')
        return { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as ReturnType<TaskRunnerOptions['buildModel']>
      },
      getApiKey: async () => 'k',
      tools: [],
      memoryDir: undefined,
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
      backgroundThinkingLevel: 'off',
    })
    const opusOnly = { ...ANTH, enabledModels: ['claude-opus-5-5'] } as ProviderConfig
    await runner.recoverTasks((id) => (id === 'anth' || id === 'anth-id' ? opusOnly : null), ANTH)
    const resumed = runner.getStore().list().find((t) => t.name === 'Gone (resumed)')!
    expect(builtFor.at(-1)).toBe('claude-opus-5-5')
    expect(resumed.model).toBe('claude-opus-5-5')
    expect(resumed.routing?.modelId).toBe('claude-opus-5-5')
    expect(resumed.routing?.reason).toContain('"claude-sonnet-5-5" no longer enabled')
  })

  it('a dedicated reviewer provider keeps the background level, not the task level', async () => {
    runner.dispose()
    runner = new TaskRunner({
      db,
      buildModel: () => ({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'k',
      tools: [],
      memoryDir: undefined,
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
      backgroundThinkingLevel: 'off',
      verification: { enabled: true, providerId: 'oai-id' },
      getProviderById: (id: string) => byIdOrName(id),
    })
    completeSimpleMock.mockResolvedValue({ content: [{ type: 'text', text: 'VERDICT: pass\nCRITIQUE: -' }] })
    agentMessages.push({ role: 'assistant', content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: done' }] })
    agentPrompt = async () => {}
    seedStrand('strand-a', { providerId: 'anth-id', modelId: 'claude-opus-5-5' })
    await turn.run({ sessionId: 'strand-a' }, () =>
      tool().execute('l', { prompt: 'p', name: 'Reviewed', task_kind: 'coding', difficulty: 'high' }))
    await vi.waitFor(() => expect(completeSimpleMock).toHaveBeenCalled())
    const opts = completeSimpleMock.mock.calls[0][2] as { reasoning?: string }
    expect(opts.reasoning).not.toBe('high')
  })

  it('the verifier reviews with the task thinking level', async () => {
    runner.dispose()
    runner = new TaskRunner({
      db,
      buildModel: () => ({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'k',
      tools: [],
      memoryDir: undefined,
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
      backgroundThinkingLevel: 'off',
      verification: { enabled: true },
    })
    completeSimpleMock.mockResolvedValue({ content: [{ type: 'text', text: 'VERDICT: pass\nCRITIQUE: -' }] })
    agentMessages.push({ role: 'assistant', content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: done' }] })
    agentPrompt = async () => {}
    seedStrand('strand-a', { providerId: 'anth-id', modelId: 'claude-opus-5-5' })
    await turn.run({ sessionId: 'strand-a' }, () =>
      tool().execute('j', { prompt: 'p', name: 'Verified', task_kind: 'coding', difficulty: 'high' }))
    await vi.waitFor(() => expect(completeSimpleMock).toHaveBeenCalled())
    const opts = completeSimpleMock.mock.calls[0][2] as { reasoning?: string }
    expect(opts.reasoning).toBe('high')
  })
})
