/**
 * M4 universal overflow guard, end to end (plan 2026-10-05-real-eco):
 * the real interactive AgentRuntime (TurnRunner + pi-agent loop) and the real
 * TaskRunner, both over the one shared buildStreamFn path, against a fake
 * openai-completions HTTP server. Synthetic data only, no cloud call.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createAgentRuntime } from './agent-runtime.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { initDatabase } from './database.js'
import { setStrandEcoEnabled } from './eco-mode-store.js'
import { CONTEXT_GUARD_MARKER, getObservedContextLimit, resetObservedContextLimits } from './request-overflow-guard.js'
import { TaskStore } from './task-store.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import type { ProviderConfig } from './provider-config.js'

type Body = Record<string, unknown> & { messages: Array<{ role: string; content: unknown }> }
let tmpDir: string
let previous: Record<string, string | undefined> = {}
let server: http.Server
let origin: string
let received: Body[] = []
let script: Array<(res: http.ServerResponse) => void> = []

function openaiSse(res: http.ServerResponse, opts: { tool?: { id: string; name: string }; text?: string }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  if (opts.tool) {
    res.write(frame({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: opts.tool.id, type: 'function', function: { name: opts.tool.name, arguments: '{"command":"npm test"}' } }] }, null))
    res.write(frame({}, 'tool_calls'))
  } else {
    res.write(frame({ role: 'assistant', content: opts.text ?? 'ok' }, null))
    res.write(frame({}, 'stop'))
  }
  res.end('data: [DONE]\n\n')
}
function overflow400(res: http.ServerResponse) {
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: "This model's maximum context length is 40960 tokens. However, you requested 70000 tokens (9000 in the messages, 61000 in the completion).", type: 'invalid_request_error', code: null } }))
}
const maxTok = (b: Body) => Number(b.max_completion_tokens ?? b.max_tokens)

let toolRuns = 0
function irreversibleShell(): AgentTool {
  // Synthetic "irreversible" tool with a big output: counts executions.
  return {
    name: 'shell', label: 'Synthetic shell', description: 'Synthetic shell (test only).',
    parameters: Type.Object({ command: Type.Optional(Type.String()) }),
    execute: async () => {
      toolRuns++
      const lines = Array.from({ length: 900 }, (_, i) => ` ✓ src/m${i}.test.ts (3 tests) ${i % 40}ms`)
      lines.push('      Tests  2700 passed', 'exit status 0')
      return { content: [{ type: 'text' as const, text: lines.join('\n') }], details: {} }
    },
  }
}

beforeEach(async () => {
  resetObservedContextLimits()
  toolRuns = 0
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-guard-e2e-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
  process.env.DATA_DIR = tmpDir
  process.env.WORKSPACE_DIR = path.join(tmpDir, 'workspace')
  received = []
  script = []
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      try { received.push(JSON.parse(raw) as Body) } catch { received.push({ messages: [] }) }
      const next = script.shift()
      if (next) next(res)
      else openaiSse(res, { text: 'synthetic ok' })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  resetObservedContextLimits()
})

const model = () => ({
  id: 'local-test', name: 'Local test', api: 'openai-completions' as const, provider: 'openai',
  baseUrl: `${origin}/v1`, reasoning: false, input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 65536,
})

async function collect(stream: AsyncIterable<ResponseChunk>): Promise<ResponseChunk[]> {
  const out: ResponseChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

describe('M4 e2e: interactive runtime tool loop, Normal and Eco', () => {
  for (const eco of [false, true]) {
    it(`${eco ? 'Eco' : 'Normal'}: overflow after a big irreversible tool result -> one transparent retry, tool ran ONCE, history not rewritten; next turn uses the learned window`, async () => {
      const db = initDatabase(':memory:')
      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u1', 'h', 'admin')").run()
      db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('s-m4', 1, 'main')").run()
      setStrandEcoEnabled(db, 's-m4', eco)
      const runtime = createAgentRuntime({ model: model(), apiKey: 'synthetic', db, tools: [irreversibleShell()], memoryDir: path.join(tmpDir, 'memory') })
      script.push(res => openaiSse(res, { tool: { id: 'tc-1', name: 'shell' } }))
      script.push(overflow400)
      script.push(res => openaiSse(res, { text: 'done 1' }))
      await collect(runtime.streamPrompt('synthetic turn 1', 's-m4'))
      expect(toolRuns).toBe(1)
      expect(received).toHaveLength(3)
      // first request: Normal wire, the SDK's own clamp on the declared window
      expect(maxTok(received[0]!)).toBeGreaterThan(40960)
      // the retry re-sends the IDENTICAL messages (no cut, no rewrite), only max tokens changed
      expect(JSON.stringify(received[2]!.messages)).toBe(JSON.stringify(received[1]!.messages))
      expect(JSON.stringify({ ...received[2], max_tokens: 0, max_completion_tokens: 0 })).toBe(JSON.stringify({ ...received[1], max_tokens: 0, max_completion_tokens: 0 }))
      expect(maxTok(received[2]!)).toBeLessThan(maxTok(received[1]!))
      expect(maxTok(received[2]!) + 9000).toBeLessThanOrEqual(40960)
      expect(getObservedContextLimit(model())?.tokens).toBe(40960)
      const toolMsg = JSON.stringify(received[2]!.messages.filter(m => m.role === 'tool'))
      if (eco) expect(toolMsg).toContain('[eco:')
      else expect(toolMsg).not.toContain('[eco:')
      // next turn: no 400 needed, learned window applied by the SDK clamp
      script.push(res => openaiSse(res, { text: 'done 2' }))
      await collect(runtime.streamPrompt('synthetic turn 2', 's-m4'))
      expect(received).toHaveLength(4)
      expect(maxTok(received[3]!)).toBeLessThanOrEqual(40960)
      // earlier history prefix byte-identical (cache-safe)
      const prev = JSON.stringify(received[2]!.messages)
      expect(JSON.stringify(received[3]!.messages).startsWith(prev.slice(0, -1))).toBe(true)
      expect(toolRuns).toBe(1)
      db.close()
    })
  }

  it('repeated provider overflow -> typed fail-fast, at most 2 HTTP calls per turn (no TurnRunner retry storm), tool ran once', async () => {
    const db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u1', 'h', 'admin')").run()
    db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('s-ff', 1, 'main')").run()
    const runtime = createAgentRuntime({ model: model(), apiKey: 'synthetic', db, tools: [irreversibleShell()], memoryDir: path.join(tmpDir, 'memory') })
    script.push(res => openaiSse(res, { tool: { id: 'tc-1', name: 'shell' } }))
    for (let i = 0; i < 6; i++) script.push(overflow400)
    const chunks = await collect(runtime.streamPrompt('synthetic turn', 's-ff'))
    const errText = JSON.stringify(chunks.filter(c => c.type === 'error'))
    expect(errText).toContain(CONTEXT_GUARD_MARKER)
    expect(errText).toContain('new strand')
    expect(received).toHaveLength(3)
    expect(toolRuns).toBe(1)
    db.close()
  })
})

describe('M4 e2e: TaskRunner shares the same guard path', () => {
  it('task (forced provider) learns the window from the provider error, retries once, completes; tool ran once', async () => {
    const db = initDatabase(path.join(tmpDir, 'task.db'))
    const store = new TaskStore(db)
    let completed: () => void = () => {}
    const completedP = new Promise<void>(r => { completed = r })
    const provider = { id: 'p-local', name: 'p-local', type: 'openai', providerType: 'openai', provider: 'openai', baseUrl: `${origin}/v1`, apiKey: 'none', enabledModels: ['local-test'], models: [], status: 'connected', authMethod: 'api-key' } as ProviderConfig
    const runner = new TaskRunner({
      db,
      buildModel: () => model() as unknown as ReturnType<TaskRunnerOptions['buildModel']>,
      getApiKey: async () => 'none',
      tools: [irreversibleShell()],
      onTaskComplete: () => { completed() },
      sessionManager: new SessionManager({ db }),
    } as unknown as TaskRunnerOptions)
    script.push(res => openaiSse(res, { tool: { id: 'tc-1', name: 'shell' } }))
    script.push(overflow400)
    script.push(res => openaiSse(res, { text: 'STATUS: completed\nSUMMARY: done' }))
    const task = store.create({ name: 'm4', prompt: 'run synthetic tests', triggerType: 'user', agentId: 'main' })
    await runner.startTask(task, provider)
    await Promise.race([completedP, new Promise((_, rej) => setTimeout(() => rej(new Error('complete timeout')), 15000))])
    runner.dispose()
    expect(toolRuns).toBe(1)
    expect(received).toHaveLength(3)
    expect(JSON.stringify(received[2]!.messages)).toBe(JSON.stringify(received[1]!.messages))
    expect(maxTok(received[2]!) + 9000).toBeLessThanOrEqual(40960)
    expect(store.getById(task.id)!.status).toBe('completed')
    db.close()
  })
})
