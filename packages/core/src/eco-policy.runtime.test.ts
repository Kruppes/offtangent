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
const { setStrandEcoEnabled, lastEcoViewForStrand } = await import('./eco-mode-store.js')
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
      contextWindow: 8000, maxTokens: 1024,
    },
    apiKey: 'none',
    db,
    tools: [],
    memoryDir: path.join(tmpDir, 'memory'),
  })
  db.prepare("INSERT INTO sessions (id, agent_id) VALUES ('s-eco', 'main')").run()
  ;(runtime as unknown as { currentSessionId: string }).currentSessionId = 's-eco'
  return { db }
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

  it('eco mode budgets every request of a tool loop and logs an estimate metric', async () => {
    const { db } = boot()
    setStrandEcoEnabled(db, 's-eco', true)
    for (const n of [2, 4, 6]) {
      const msgs = loop(n)
      const before = JSON.stringify(msgs)
      const out = await captured.transformContext!(msgs) as Array<{ role: string; content: Array<{ text?: string }> }>
      expect(JSON.stringify(msgs)).toBe(before) // transcript untouched: no tool re-runs
      const last = out[out.length - 1]
      expect(last.content[0].text).toContain(`RESULT-${n - 1} `) // current batch exact
      expect(JSON.stringify(out).length).toBeLessThan(before.length)
    }
    const metric = lastEcoViewForStrand(db, 's-eco')
    expect(metric).not.toBeNull()
    expect(metric!.inputBudgetTokens).toBe(resolveEcoBudget({ contextWindow: 8000, maxTokens: 1024 }).inputBudget)
    expect(metric!.estimatedTokensAfter!).toBeLessThan(metric!.estimatedTokensBefore!)
  })

  it('switching eco off restores the normal view on the next request (rollback)', async () => {
    const { db } = boot()
    setStrandEcoEnabled(db, 's-eco', true)
    const msgs = loop(4)
    expect(JSON.stringify(await captured.transformContext!(msgs))).not.toBe(JSON.stringify(msgs))
    setStrandEcoEnabled(db, 's-eco', false)
    expect(JSON.stringify(await captured.transformContext!(msgs))).toBe(JSON.stringify(msgs))
  })
})
