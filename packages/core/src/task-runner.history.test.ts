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
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { setHeuristicsOverrideForTests } from './heuristics.js'
import { createRecallMessageTool } from './recall-message-tool.js'
import { EARLIER_MESSAGES_OPEN } from './transcript-compaction.js'

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

type TransformContext = (messages: AgentMessage[]) => Promise<AgentMessage[]>

const captured: { transformContext: TransformContext | null } = { transformContext: null }

// Minimal PiAgent double: it records the transformContext the runner wires in
// and drives one tool round trip plus a final assistant message through the
// event stream, exactly like the real loop does.
vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation((options: { transformContext?: TransformContext }) => {
    captured.transformContext = options.transformContext ?? null
    let subscribeFn: ((event: unknown) => void) | null = null
    const messages: unknown[] = []
    return {
      subscribe: vi.fn((fn: (event: unknown) => void) => {
        subscribeFn = fn
        return () => { subscribeFn = null }
      }),
      prompt: vi.fn(async () => {
        subscribeFn?.({
          type: 'tool_execution_start',
          toolCallId: 'tc-1',
          toolName: 'shell',
          args: { command: 'ls' },
        })
        subscribeFn?.({
          type: 'tool_execution_end',
          toolCallId: 'tc-1',
          toolName: 'shell',
          result: { content: [{ type: 'text', text: 'FULL-TOOL-OUTPUT-42' }] },
          isError: false,
        })
        const assistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: done' }],
          provider: 'test-provider',
          model: 'test-model',
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
        }
        subscribeFn?.({ type: 'message_end', message: assistantMessage })
        subscribeFn?.({ type: 'agent_end', messages: [] })
        messages.push(assistantMessage)
      }),
      abort: vi.fn(),
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

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } as unknown as AgentMessage
}
function assistant(text: string, toolCallId: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }, { type: 'toolCall', id: toolCallId, name: 'shell', arguments: {} }],
    timestamp: 1,
    stopReason: 'toolUse',
  } as unknown as AgentMessage
}
function toolResult(toolCallId: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'shell',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1,
  } as unknown as AgentMessage
}
function textOf(msg: AgentMessage): string {
  const content = (msg as { content: unknown }).content
  if (typeof content === 'string') return content
  return (content as Array<{ text?: string }>).map(b => b.text ?? '').join('')
}

describe('TaskRunner history compaction', () => {
  let db: Database
  let store: TaskStore
  let runner: TaskRunner
  let dbPath: string

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `ot-task-history-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    store = new TaskStore(db)
    captured.transformContext = null
    setHeuristicsOverrideForTests({ taskHistory: { windowTokens: 6000, targetTokens: 3000, indexLines: 60 } })

    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
    }
    runner = new TaskRunner(options)
  })

  afterEach(() => {
    setHeuristicsOverrideForTests(null)
    runner.dispose()
    db.close()
    try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
  })

  it('wires a transform that trims a long task transcript and keeps the tail raw', async () => {
    const task = store.create({ name: 'Long Task', prompt: 'Do work', triggerType: 'agent', sessionId: 'task-hist-1' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(captured.transformContext).toBeTypeOf('function')

    const transcript: AgentMessage[] = [user('Begin working on the task described in your system prompt.')]
    for (let i = 0; i < 40; i++) {
      transcript.push(assistant(`step ${i}`, `tc${i}`), toolResult(`tc${i}`, `out ${i} ${'x'.repeat(4000)}`))
    }

    const view = await captured.transformContext!(transcript)

    expect(view.length).toBeLessThan(transcript.length)
    expect(textOf(view[0])).toContain(EARLIER_MESSAGES_OPEN)
    expect(view[view.length - 1]).toBe(transcript[transcript.length - 1])
    const viewChars = view.reduce((n, m) => n + textOf(m).length, 0)
    const fullChars = transcript.reduce((n, m) => n + textOf(m).length, 0)
    expect(viewChars).toBeLessThan(fullChars / 2)

    // Every trim leaves a metric row, like `strand_context` does interactively.
    const rows = db.prepare("SELECT output FROM tool_calls WHERE session_id = ? AND tool_name = 'task_history'").all('task-hist-1') as Array<{ output: string }>
    expect(rows.length).toBe(1)
    expect(JSON.parse(rows[0].output).droppedNow).toBeGreaterThan(0)
  })

  it('leaves a short transcript untouched', async () => {
    const task = store.create({ name: 'Short Task', prompt: 'Do work', triggerType: 'agent', sessionId: 'task-hist-2' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 100))

    const transcript: AgentMessage[] = [user('hi'), assistant('step', 'tc1'), toolResult('tc1', 'small')]
    const view = await captured.transformContext!(transcript)
    expect(view).toHaveLength(3)
    expect(view[0]).toBe(transcript[0])
  })

  it('persists task tool results so recall_message can reload a trimmed one', async () => {
    const task = store.create({ name: 'Recall Task', prompt: 'Do work', triggerType: 'agent', sessionId: 'task-hist-3' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 100))

    const row = db.prepare(
      "SELECT id, content, metadata FROM chat_messages WHERE session_id = ? AND role = 'tool'"
    ).get('task-hist-3') as { id: number; content: string; metadata: string } | undefined
    expect(row).toBeDefined()
    expect(row!.content).toBe('Tool: shell')
    expect(JSON.parse(row!.metadata).toolCallId).toBe('tc-1')

    const recall = createRecallMessageTool({ db })
    const result = await recall.execute('c1', { message_id: row!.id }, undefined as never) as {
      content: Array<{ type: string; text?: string }>
    }
    const text = result.content.map(c => c.text ?? '').join('')
    expect(text).toContain('FULL-TOOL-OUTPUT-42')
    expect(text).toContain('Tool: shell')
  })

  it('eco: a task session with Eco on gets the shared Eco admission on every request: a fitting request passes byte-identical, a non-fitting PERSISTED one is refused, never compacted', async () => {
    db.prepare("INSERT INTO sessions (id, agent_id, type, eco_mode) VALUES ('task-eco-1', 'main', 'task', 1)").run()
    const task = store.create({ name: 'Eco Task', prompt: 'Do work', triggerType: 'agent', sessionId: 'task-eco-1' })
    // Tiny declared window so the Eco budget (not the chars/4 compactor) is the binding limit.
    runner.dispose()
    runner = new TaskRunner({
      db,
      buildModel: () => ({ contextWindow: 4096, maxTokens: 512 } as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
    })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 100))

    const transcript: AgentMessage[] = [user('Begin.')]
    for (let i = 0; i < 3; i++) transcript.push(assistant(`step ${i}`, `e${i}`), toolResult(`e${i}`, `OUT-${i} ${'y'.repeat(3000)} exit code ${i}`))
    // Same row shape the runner writes on tool_execution_end. Persistence no
    // longer unlocks any shortening: Eco never rewrites sent history (cache gate).
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES ('task-eco-1', NULL, 'tool', 'Tool: shell', ?, 'main')")
        .run(JSON.stringify({ toolName: 'shell', toolCallId: `e${i}`, toolArgs: {}, toolResult: `OUT-${i} ${'y'.repeat(3000)} exit code ${i}`, toolIsError: false }))
    }
    const before = JSON.stringify(transcript)
    await expect(captured.transformContext!(transcript)).rejects.toMatchObject({ code: 'ECO_BUDGET_REFUSED' })
    expect(JSON.stringify(transcript)).toBe(before)
    const metric = db.prepare('SELECT input_budget AS b, refusal_reason AS r, compacted AS c FROM eco_metrics WHERE session_id = ?').get('task-eco-1') as { b: number; r: string | null; c: number } | undefined
    expect(metric).toBeDefined()
    expect(metric!.b).toBeGreaterThan(0)
    expect(metric!.r).toBeTruthy()
    expect(metric!.c).toBe(0)
    // A request that fits is handed through as the very same array (same serialized prefix as normal mode).
    const small: AgentMessage[] = [user('Begin.'), assistant('step 0', 'f0'), toolResult('f0', 'OUT small exit code 0')]
    expect(JSON.stringify(await captured.transformContext!(small))).toBe(JSON.stringify(small))
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool_name = 'eco_context'").get()).toEqual({ n: 0 })
  })

  it('eco: a task session refuses (typed EcoBudgetError) instead of cutting UNpersisted results', async () => {
    db.prepare("INSERT INTO sessions (id, agent_id, type, eco_mode) VALUES ('task-eco-2', 'main', 'task', 1)").run()
    const task = store.create({ name: 'Eco Task 2', prompt: 'Do work', triggerType: 'agent', sessionId: 'task-eco-2' })
    runner.dispose()
    runner = new TaskRunner({
      db,
      buildModel: () => ({ contextWindow: 4096, maxTokens: 512 } as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
    })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 100))
    const transcript: AgentMessage[] = [user('Begin.')]
    for (let i = 0; i < 3; i++) transcript.push(assistant(`step ${i}`, `n${i}`), toolResult(`n${i}`, `OUT-${i} ${'y'.repeat(3000)} exit code ${i}`))
    await expect(captured.transformContext!(transcript)).rejects.toMatchObject({ code: 'ECO_BUDGET_REFUSED' })
  })

  it('eco: normal task sessions (default) never get the Eco stage', async () => {
    const task = store.create({ name: 'Plain Task', prompt: 'Do work', triggerType: 'agent', sessionId: 'task-plain-1' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 100))
    const transcript: AgentMessage[] = [user('hi'), assistant('step', 'p1'), toolResult('p1', 'z'.repeat(9000))]
    const view = await captured.transformContext!(transcript)
    expect(view.map(textOf).join('')).not.toContain('[eco view')
    expect(db.prepare('SELECT COUNT(*) AS n FROM eco_metrics').get()).toEqual({ n: 0 })
  })

  it('eco: a task spawned from an Eco strand persists an inherited Eco switch on its own session', async () => {
    db.prepare("INSERT INTO sessions (id, agent_id, eco_mode) VALUES ('strand-eco', 'main', 1)").run()
    const task = store.create({ name: 'Child Task', prompt: 'Do work', triggerType: 'agent' })
    await runner.startTask(task, mockProvider, undefined, 'strand-eco')
    await new Promise(resolve => setTimeout(resolve, 100))
    const sessionId = store.getById(task.id)!.sessionId!
    expect(sessionId).toBeTruthy()
    const row = db.prepare('SELECT eco_mode, parent_session_id FROM sessions WHERE id = ?').get(sessionId) as { eco_mode: number; parent_session_id: string }
    expect(row).toEqual({ eco_mode: 1, parent_session_id: 'strand-eco' })
  })
})
