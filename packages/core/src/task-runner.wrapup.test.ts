/**
 * W5/P0 + W5/P2: the wrap-up signal at ~80 % of the time budget, the hard
 * deadline that still fires behind it, and the handoff a dying run leaves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskStore } from './task-store.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import type { ProviderConfig } from './provider-config.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'

const hoisted = vi.hoisted(() => ({
  agents: [] as Array<{
    steerCalls: unknown[]
    abortCalls: number
    finish: (text: string) => void
  }>,
}))

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

// A task agent that runs until something finishes it — the realistic shape
// for a deadline test (the real one is mid-tool-loop when the timer fires).
vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation(() => {
      const messages: unknown[] = []
      let resolveRun: (() => void) | null = null
      const handle = {
        steerCalls: [] as unknown[],
        abortCalls: 0,
        finish: (text: string) => {
          messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
          resolveRun?.()
        },
        subscribe: vi.fn(() => () => {}),
        prompt: vi.fn(() => new Promise<void>((resolve) => { resolveRun = resolve })),
        steer: vi.fn((msg: unknown) => { handle.steerCalls.push(msg) }),
        abort: vi.fn(() => { handle.abortCalls++; resolveRun?.() }),
        state: { get messages() { return messages } },
      }
      hoisted.agents.push(handle)
      return handle
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

describe('TaskRunner wrap-up + handoff (W5)', () => {
  const tmpFiles: string[] = []
  let db: Database
  let store: TaskStore
  let runner: TaskRunner
  let sessionManager: SessionManager

  beforeEach(() => {
    hoisted.agents.length = 0
    vi.useFakeTimers()
    const p = path.join(os.tmpdir(), `axiom-wrapup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
    store = new TaskStore(db)
    sessionManager = new SessionManager({ db })
    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      onTaskComplete: () => {},
      sessionManager,
    }
    runner = new TaskRunner(options)
  })

  afterEach(() => {
    setHeuristicsOverrideForTests(null)
    runner.dispose()
    db.close()
    vi.useRealTimers()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  async function startTask(maxDurationMinutes: number | undefined, name = 'Long task') {
    const task = store.create({
      name,
      prompt: 'Do a long piece of work',
      triggerType: 'agent',
      maxDurationMinutes,
    })
    await runner.startTask(task, mockProvider)
    return task
  }

  it('injects exactly one wrap-up message at 80% of the budget instead of only killing at 100%', async () => {
    const task = await startTask(10)
    const agent = hoisted.agents[0]

    // 7 minutes in: nothing yet.
    await vi.advanceTimersByTimeAsync(7 * 60_000)
    expect(agent.steerCalls).toHaveLength(0)
    expect(store.getById(task.id)!.status).toBe('running')

    // 8 minutes = 80 % of 10 min.
    await vi.advanceTimersByTimeAsync(60_000 + 500)
    expect(agent.steerCalls).toHaveLength(1)
    const steered = agent.steerCalls[0] as { role: string; content: Array<{ text: string }> }
    expect(steered.role).toBe('user')
    expect(steered.content[0].text).toContain('<time_budget_warning>')
    expect(steered.content[0].text).toContain('10 min')
    expect(steered.content[0].text).toContain('HANDOFF')
    // Still running — the wrap-up is a signal, not a kill.
    expect(store.getById(task.id)!.status).toBe('running')
    expect(agent.abortCalls).toBe(0)

    // The task lands the plane before the hard deadline.
    agent.finish('STATUS: completed\nSUMMARY: Wrapped up in time.\n\nHANDOFF: docs page still open')
    await vi.advanceTimersByTimeAsync(10)

    const done = store.getById(task.id)!
    expect(done.status).toBe('completed')
    expect(done.resultSummary).toContain('Wrapped up in time')
    // Completed under the wrap-up signal WITH open work -> handoff persisted.
    expect(done.handoff).toContain('HANDOFF: docs page still open')
    expect(done.handoff).toContain('time budget nearly exhausted')

    // No second signal after the run ended.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(agent.steerCalls).toHaveLength(1)
  })

  it('still hard-aborts at 100% and persists a timeout handoff', async () => {
    const task = await startTask(10)
    const agent = hoisted.agents[0]

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000)

    expect(agent.steerCalls).toHaveLength(1)
    expect(agent.abortCalls).toBeGreaterThanOrEqual(1)
    const failed = store.getById(task.id)!
    expect(failed.status).toBe('failed')
    expect(failed.errorMessage).toBe('Max duration exceeded')
    expect(failed.handoff).toContain('hard max-duration abort')
    expect(failed.handoff).toContain(task.id)
  })

  it('skips the signal when the remaining lead time is too short to act on', async () => {
    // 2 min budget -> wrap-up would leave 24 s, below the 60 s floor.
    const task = await startTask(2)
    const agent = hoisted.agents[0]
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1000)
    expect(agent.steerCalls).toHaveLength(0)
    expect(store.getById(task.id)!.status).toBe('failed')
  })

  it('can be disabled through the heuristics', async () => {
    setHeuristicsOverrideForTests({ taskWrapUp: { budgetFraction: 0 } })
    const task = await startTask(10)
    const agent = hoisted.agents[0]
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(agent.steerCalls).toHaveLength(0)
    expect(store.getById(task.id)!.status).toBe('running')
  })

  it('does not persist a handoff for a clean completion', async () => {
    const task = await startTask(10)
    const agent = hoisted.agents[0]
    agent.finish('STATUS: completed\nSUMMARY: All done, nothing open.')
    await vi.advanceTimersByTimeAsync(10)
    const done = store.getById(task.id)!
    expect(done.status).toBe('completed')
    expect(done.handoff).toBeNull()
  })

  it('persists a handoff when the task honestly reports failure', async () => {
    const task = await startTask(10)
    const agent = hoisted.agents[0]
    agent.finish('STATUS: failed\nSUMMARY: Build is red.\n\nHANDOFF: fix tsc error in task-store.ts, then rerun vitest')
    await vi.advanceTimersByTimeAsync(10)
    const done = store.getById(task.id)!
    expect(done.status).toBe('failed')
    expect(done.handoff).toContain('task reported STATUS: failed')
    expect(done.handoff).toContain('fix tsc error in task-store.ts')
  })

  it('states the time budget and the honesty rules in the task system prompt', async () => {
    const { Agent } = await import('@earendil-works/pi-agent-core')
    await startTask(45)
    const calls = (Agent as unknown as { mock: { calls: Array<[{ initialState: { systemPrompt: string } }]> } }).mock.calls
    const systemPrompt = calls[calls.length - 1][0].initialState.systemPrompt
    expect(systemPrompt).toContain('Time budget: 45 minutes')
    expect(systemPrompt).toContain('<time_budget_warning>')
    expect(systemPrompt).toMatch(/Never report a test, build, lint or check as green/)
    expect(systemPrompt).toMatch(/Never weaken, skip, delete or narrow tests/)
    expect(systemPrompt).toContain('HANDOFF')
    // Compact by design — the block must not crowd out the brief.
    const block = systemPrompt.slice(
      systemPrompt.indexOf('<budget_and_honesty>'),
      systemPrompt.indexOf('</budget_and_honesty>'),
    )
    expect(block.split('\n').length).toBeLessThanOrEqual(10)
  })
})
