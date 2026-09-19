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

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

/**
 * Script the fake agent runs through. Each entry is one tool round trip; the
 * agent finally reports "completed" — which is exactly the dangerous case:
 * a guarded task must NOT end up completed just because the model said so
 * after the abort.
 */
const script: { calls: Array<{ toolName: string; args: unknown }>; aborted: boolean } = {
  calls: [],
  aborted: false,
}

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation(() => {
    let subscribeFn: ((event: unknown) => void) | null = null
    const messages: unknown[] = []
    return {
      subscribe: vi.fn((fn: (event: unknown) => void) => {
        subscribeFn = fn
        return () => { subscribeFn = null }
      }),
      prompt: vi.fn(async () => {
        let i = 0
        for (const call of script.calls) {
          i++
          subscribeFn?.({ type: 'tool_execution_start', toolCallId: `tc-${i}`, toolName: call.toolName, args: call.args })
          subscribeFn?.({
            type: 'tool_execution_end',
            toolCallId: `tc-${i}`,
            toolName: call.toolName,
            result: { content: [{ type: 'text', text: 'ok' }] },
            isError: false,
          })
          const assistantMessage = {
            role: 'assistant',
            content: [{ type: 'text', text: `step ${i}` }],
            provider: 'test-provider',
            model: 'test-model',
            usage: { input: 1000, output: 10, cacheRead: 500, cacheWrite: 0, cost: { total: 0.001 } },
          }
          subscribeFn?.({ type: 'message_end', message: assistantMessage })
          messages.push(assistantMessage)
        }
        const final = {
          role: 'assistant',
          content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: all good' }],
          provider: 'test-provider',
          model: 'test-model',
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
        }
        subscribeFn?.({ type: 'message_end', message: final })
        subscribeFn?.({ type: 'agent_end', messages: [] })
        messages.push(final)
      }),
      abort: vi.fn(() => { script.aborted = true }),
      state: { get messages() { return messages } },
    }
  }),
}))

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

function repeat(n: number, toolName: string, args: unknown) {
  return Array.from({ length: n }, () => ({ toolName, args }))
}

describe('TaskRunner progress guard', () => {
  let db: Database
  let store: TaskStore
  let runner: TaskRunner
  let dbPath: string
  let completions: Array<{ taskId: string; status: string }>

  function makeRunner(): TaskRunner {
    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      onTaskComplete: (taskId) => {
        completions.push({ taskId, status: store.getById(taskId)?.status ?? 'unknown' })
      },
      sessionManager: new SessionManager({ db }),
    }
    return new TaskRunner(options)
  }

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `ot-task-guard-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    store = new TaskStore(db)
    completions = []
    script.calls = []
    script.aborted = false
    runner = makeRunner()
  })

  afterEach(() => {
    setHeuristicsOverrideForTests(null)
    runner.dispose()
    db.close()
    try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
  })

  it('fails a task that repeats one identical tool call', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 0, repeatedToolCalls: 3, maxInputTokens: 0 } })
    script.calls = repeat(6, 'read_file', { path: '/same' })

    const task = store.create({ name: 'Zombie', prompt: 'work', triggerType: 'agent', sessionId: 'guard-1' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))

    const row = store.getById(task.id)!
    expect(row.status).toBe('failed')
    expect(row.resultStatus).toBe('failed')
    expect(row.errorMessage).toContain('read_file')
    expect(row.resultSummary).toContain('Progress guard')
    expect(script.aborted).toBe(true)

    // The "completed" the model produced after the abort must not win.
    expect(completions).toHaveLength(1)
    expect(completions[0].status).toBe('failed')

    const guardRows = db.prepare(
      "SELECT input, output FROM tool_calls WHERE session_id = ? AND tool_name = 'task_guard'"
    ).all('guard-1') as Array<{ input: string; output: string }>
    expect(guardRows).toHaveLength(1)
    expect(JSON.parse(guardRows[0].input).guard).toBe('repeated_tool_calls')
    expect(JSON.parse(guardRows[0].output).repeats).toBe(3)
  })

  it('fails a task that exceeds the tool call cap', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 4, repeatedToolCalls: 0, maxInputTokens: 0 } })
    script.calls = Array.from({ length: 10 }, (_, i) => ({ toolName: 'shell', args: { command: `echo ${i}` } }))

    const task = store.create({ name: 'Grinder', prompt: 'work', triggerType: 'agent', sessionId: 'guard-2' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))

    const row = store.getById(task.id)!
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toContain('tool call cap of 4')
    expect(row.toolCallCount).toBe(4)
  })

  it('fails a task that blows the input token budget', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 0, repeatedToolCalls: 0, maxInputTokens: 3000 } })
    script.calls = Array.from({ length: 10 }, (_, i) => ({ toolName: 'shell', args: { command: `echo ${i}` } }))

    const task = store.create({ name: 'Burner', prompt: 'work', triggerType: 'agent', sessionId: 'guard-3' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))

    const row = store.getById(task.id)!
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toContain('input tokens')
    // Two responses at 1500 input each cross the 3000 budget.
    expect(row.promptTokens).toBe(2000)
  })

  it('lets a normal task finish and records a task_usage metric row', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 300, repeatedToolCalls: 5, maxInputTokens: 30_000_000 } })
    script.calls = [
      { toolName: 'shell', args: { command: 'ls' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]

    const task = store.create({ name: 'Healthy', prompt: 'work', triggerType: 'agent', sessionId: 'guard-4' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))

    const row = store.getById(task.id)!
    expect(row.status).toBe('completed')
    expect(row.resultSummary).toBe('all good')

    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ? AND tool_name = 'task_guard'")
      .get('guard-4')).toEqual({ n: 0 })

    const usage = db.prepare(
      "SELECT output FROM tool_calls WHERE session_id = ? AND tool_name = 'task_usage'"
    ).all('guard-4') as Array<{ output: string }>
    expect(usage).toHaveLength(1)
    const payload = JSON.parse(usage[0].output)
    expect(payload.taskId).toBe(task.id)
    expect(payload.toolCalls).toBe(2)
    expect(payload.promptTokens).toBe(2010)
    expect(payload.cacheRead).toBe(1000)
    // 1000 / (2010 + 1000)
    expect(payload.cacheReadRatio).toBeCloseTo(0.3322, 3)
  })
})
