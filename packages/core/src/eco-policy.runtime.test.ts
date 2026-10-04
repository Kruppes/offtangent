/**
 * Eco mode over the REAL runtime wiring (plan 2026-10-04-eco-implementation):
 * pi-agent is replaced by a capture double so the test can call the one
 * pre-send hook (`transformContext`) exactly as every LLM request — including
 * every tool-loop iteration — does. Synthetic data only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EcoBudgetError } from './eco-policy.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'

const captured = vi.hoisted(() => ({ transformContext: null as null | ((messages: unknown[]) => Promise<unknown[]>) }))

vi.mock('@earendil-works/pi-agent-core', () => {
  class MockAgent {
    public state: { systemPrompt: string; model: unknown; tools: AgentTool[]; messages: unknown[] }
    constructor(options: { initialState: { systemPrompt: string; model: unknown; tools: AgentTool[] }; transformContext?: (messages: unknown[]) => Promise<unknown[]> }) {
      this.state = { ...options.initialState, messages: [] }
      captured.transformContext = options.transformContext ?? null
    }
    subscribe(): () => void { return () => {} }
    async prompt(): Promise<void> {}
    async continue(): Promise<void> {}
    abort(): void {}
  }
  return { Agent: MockAgent }
})

const { createAgentRuntime } = await import('./agent-runtime.js')
const { initDatabase } = await import('./database.js')
const { setStrandEcoEnabled, lastEcoViewForStrand, inheritEcoMode, isStrandEcoEnabled, resetObservedEcoLimits, observedEcoContextLimit } = await import('./eco-mode-store.js')
const { createRecallMessageTool } = await import('./recall-message-tool.js')
const { resolveEcoBudget } = await import('./eco-policy.js')

let tmpDir: string
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-runtime-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
  process.env.DATA_DIR = tmpDir
  process.env.WORKSPACE_DIR = path.join(tmpDir, 'workspace')
  captured.transformContext = null
  resetObservedEcoLimits()
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function boot() {
  const db = initDatabase(':memory:')
  const runtime = createAgentRuntime({
    model: {
      id: 'local-test', name: 'Local test', api: 'openai-completions' as const, provider: 'ollama',
      baseUrl: 'http://127.0.0.1:1/v1', reasoning: true,
      input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16000, maxTokens: 1024,
    },
    apiKey: 'none',
    db,
    tools: [],
    memoryDir: path.join(tmpDir, 'memory'),
  })
  db.prepare("INSERT INTO sessions (id, agent_id) VALUES ('s-eco', 'main')").run()
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'synthetic-a', 'x'), (8, 'synthetic-b', 'x')").run()
  ;(runtime as unknown as { currentSessionId: string }).currentSessionId = 's-eco'
  return { db, runtime }
}

function loop(n: number): unknown[] {
  const msgs: unknown[] = [{ role: 'user', content: [{ type: 'text', text: 'synthetic task' }], timestamp: 1 }]
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'shell', arguments: { command: `step ${i}` } }], stopReason: 'toolUse', timestamp: 1 })
    msgs.push({ role: 'toolResult', toolCallId: `c${i}`, toolName: 'shell', content: [{ type: 'text', text: `RESULT-${i} ` + 'z'.repeat(6000) + ` exit code 0 id=${i}` }], isError: false, timestamp: 1 })
  }
  return msgs
}

describe('eco runtime wiring', () => {
  it('normal mode (default) sends the context unchanged', async () => {
    const { db } = boot()
    const msgs = loop(6)
    const out = await captured.transformContext!(msgs)
    expect(JSON.stringify(out)).toBe(JSON.stringify(msgs))
    expect(lastEcoViewForStrand(db, 's-eco')).toBeNull()
  })

  it('eco mode budgets every request of a tool loop over PERSISTED results and logs a numeric metric', async () => {
    const { db } = boot()
    setStrandEcoEnabled(db, 's-eco', true)
    for (const n of [6, 8, 10]) {
      const msgs = loop(n) as Array<{ role: string; toolCallId?: string; content: Array<{ text?: string }> }>
      for (const m of msgs) if (m.role === 'toolResult') persistToolRow(db, 's-eco', m.toolCallId!, m.content[0].text!)
      const before = JSON.stringify(msgs)
      const out = await captured.transformContext!(msgs) as Array<{ role: string; content: Array<{ text?: string }> }>
      expect(JSON.stringify(msgs)).toBe(before) // transcript untouched: no tool re-runs
      expect(JSON.stringify(out).length).toBeLessThan(before.length)
    }
    const metric = lastEcoViewForStrand(db, 's-eco')
    expect(metric).not.toBeNull()
    expect(metric!.refused).toBe(false)
    expect(metric!.inputBudgetTokens).toBe(resolveEcoBudget({ contextWindow: 16000, maxTokens: 1024 }).inputBudget)
    expect(metric!.estimatedTokensAfter!).toBeLessThan(metric!.estimatedTokensBefore!)
    // Metrics live in their own table: tool stats are not polluted.
    expect((db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get() as { n: number }).n).toBe(0)
  })

  it('fails CLOSED when results are not persisted yet: typed refusal, nothing sent, refusal metric', async () => {
    const { db } = boot()
    setStrandEcoEnabled(db, 's-eco', true)
    const msgs = loop(6)
    await expect(captured.transformContext!(msgs)).rejects.toBeInstanceOf(EcoBudgetError)
    const metric = lastEcoViewForStrand(db, 's-eco')!
    expect(metric.refused).toBe(true)
    expect(metric.refusalReason).toBeTruthy()
  })

  it('switching eco off restores the normal view on the next request (rollback)', async () => {
    const { db } = boot()
    setStrandEcoEnabled(db, 's-eco', true)
    const msgs = loop(4) as Array<{ role: string; toolCallId?: string; content: Array<{ text?: string }> }>
    for (const m of msgs) if (m.role === 'toolResult') persistToolRow(db, 's-eco', m.toolCallId!, m.content[0].text!)
    expect(JSON.stringify(await captured.transformContext!(msgs))).not.toBe(JSON.stringify(msgs))
    setStrandEcoEnabled(db, 's-eco', false)
    expect(JSON.stringify(await captured.transformContext!(msgs))).toBe(JSON.stringify(msgs))
  })
})

/** Persist a tool row exactly like turn-runner/task-runner do (metadata.toolCallId). */
function persistToolRow(db: ReturnType<typeof initDatabase>, sessionId: string, callId: string, text: string, userId: number | null = 7): number {
  const res = db.prepare(
    "INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, 'tool', 'Tool: shell', ?, 'main')",
  ).run(sessionId, userId, JSON.stringify({ toolName: 'shell', toolCallId: callId, toolArgs: { command: 'synthetic' }, toolResult: text, toolIsError: false }))
  return Number(res.lastInsertRowid)
}

describe('eco end-to-end through the runtime: DB switch -> request view -> recall tool -> metric', () => {
  it('older results become exact views that reference their stored row; recall_message pages the raw result back', async () => {
    const { db, runtime } = boot()
    setStrandEcoEnabled(db, 's-eco', true)
    const msgs = loop(4) as Array<{ role: string; toolCallId?: string; content: Array<{ text?: string }> }>
    const rowIds = new Map<string, number>()
    for (const m of msgs) if (m.role === 'toolResult') rowIds.set(m.toolCallId!, persistToolRow(db, 's-eco', m.toolCallId!, m.content[0].text!))
    const out = await captured.transformContext!(msgs) as typeof msgs
    // Older results are lossy views (or ledger entries) that point at their
    // stored row; the current batch stays exact.
    const all = JSON.stringify(out)
    expect(all.includes(`message_id=${rowIds.get('c0')}`) || all.includes(`recall=${rowIds.get('c0')}`)).toBe(true)
    expect(all).toContain('LOSSY')
    const c3 = out.find(m => m.role === 'toolResult' && m.toolCallId === 'c3')!
    expect(c3.content[0].text).toBe(msgs.find(m => m.toolCallId === 'c3')!.content[0].text)

    // The model follows the reference with the REAL tool registered on the runtime.
    const tools = (runtime as unknown as { agent: { state: { tools: AgentTool[] } } }).agent.state.tools
    const recall = tools.find(t => t.name === 'recall_message')!
    expect(recall).toBeDefined()
    const page1 = await recall.execute('r1', { message_id: rowIds.get('c0')!, part: 'result' }) as { content: Array<{ text: string }>; details: { remaining: number } }
    // part="result" returns the stored result text verbatim (after the header line).
    expect(page1.content[0].text.split('\n').slice(1).join('\n')).toBe(msgs.find(m => m.toolCallId === 'c0')!.content[0].text)
    const metric = lastEcoViewForStrand(db, 's-eco')
    expect(metric!.compactedResults).toBeGreaterThan(0)
  })

  it('recall is scoped: another user cannot read the referenced row, invalid ids are rejected', async () => {
    const { db } = boot()
    const id = persistToolRow(db, 's-eco', 'c9', 'SECRET-SYNTHETIC ' + 'k'.repeat(40000), 7)
    const other = createRecallMessageTool({ db, getCurrentUserId: () => 8, getCurrentAgentId: () => 'main' })
    const denied = await other.execute('r', { message_id: id }) as { content: Array<{ text: string }> }
    expect(denied.content[0].text).toBe(`Error: message ${id} not found.`)
    const owner = createRecallMessageTool({ db, getCurrentUserId: () => 7, getCurrentAgentId: () => 'main' })
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const r = await owner.execute('r', { message_id: bad }) as { content: Array<{ text: string }> }
      expect(r.content[0].text).toMatch(/^Error/)
    }
    // Paged and size-capped: never more than the cap per call, offset continues.
    const p1 = await owner.execute('r', { message_id: id }) as { details: { returned: number; remaining: number } }
    expect(p1.details.returned).toBeLessThanOrEqual(16000)
    expect(p1.details.remaining).toBeGreaterThan(0)
    const p2 = await owner.execute('r', { message_id: id, offset: p1.details.returned }) as { details: { offset: number } }
    expect(p2.details.offset).toBe(p1.details.returned)
  })

  it('overflow recovery: the runner-reported limit sizes the next request; transcript and tools untouched', async () => {
    const { db } = boot()
    setStrandEcoEnabled(db, 's-eco', true)
    const base = loop(3) as Array<{ role: string; toolCallId?: string; content: Array<{ text?: string }> }>
    for (const m of base) if (m.role === 'toolResult') persistToolRow(db, 's-eco', m.toolCallId!, m.content[0].text!)
    const msgs = [
      ...base,
      { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'request (13100 tokens) exceeds the available context size (12000 tokens)', timestamp: 1 },
    ]
    const before = JSON.stringify(msgs)
    const out = await captured.transformContext!(msgs)
    expect(JSON.stringify(msgs)).toBe(before)
    expect(observedEcoContextLimit('s-eco')).toBe(12000)
    const metric = lastEcoViewForStrand(db, 's-eco')!
    expect(metric.inputBudgetTokens).toBe(resolveEcoBudget({ contextWindow: 12000, maxTokens: 1024 }).inputBudget)
    expect(JSON.stringify(out).length).toBeLessThan(before.length)
    // Off again: normal path, byte-identical, the evidence does not leak into normal mode.
    setStrandEcoEnabled(db, 's-eco', false)
    expect(JSON.stringify(await captured.transformContext!(msgs))).toBe(JSON.stringify(msgs))
  })

  it('tasks inherit Eco from the spawning strand as an explicit persisted copy', () => {
    const { db } = boot()
    db.prepare("INSERT INTO sessions (id, agent_id, type) VALUES ('task-a', 'main', 'task'), ('task-b', 'main', 'task')").run()
    expect(inheritEcoMode(db, 's-eco', 'task-a')).toBe(false)
    expect(isStrandEcoEnabled(db, 'task-a')).toBe(false)
    setStrandEcoEnabled(db, 's-eco', true)
    expect(inheritEcoMode(db, 's-eco', 'task-b')).toBe(true)
    expect(isStrandEcoEnabled(db, 'task-b')).toBe(true)
    // Later parent changes do not leak into the running task.
    setStrandEcoEnabled(db, 's-eco', false)
    expect(isStrandEcoEnabled(db, 'task-b')).toBe(true)
    expect(inheritEcoMode(db, null, 'task-a')).toBe(false)
  })
})
