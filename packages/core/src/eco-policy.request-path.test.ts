/**
 * Eco mode over the REAL request path (plan 2026-10-04-eco-implementation,
 * Pflicht 8): no module mocks. The real runtime, the real pi-agent loop, the
 * real pi-ai openai-completions client and a real HTTP socket — only the
 * model server is a local fake that records what actually arrives on the wire.
 * Synthetic data only. Proves wiring, not tokenizer accuracy or native speed.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createAgentRuntime } from './agent-runtime.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createRecallMessageTool } from './recall-message-tool.js'
import { setStrandEcoEnabled, lastEcoViewForStrand, resetObservedEcoLimits } from './eco-mode-store.js'

interface WireMessage { role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string } }> }
interface Received { url: string; body: { max_tokens?: number; max_completion_tokens?: number; messages: WireMessage[]; [key: string]: unknown } }

let tmpDir: string
let previous: Record<string, string | undefined> = {}
let server: http.Server
let baseUrl: string
let received: Received[] = []
/** Scripted responses, one per request; an empty queue answers with plain text. */
let script: Array<(res: http.ServerResponse) => void> = []

/** One streamed assistant turn that calls `name` once per id (parallel tool calls). */
function sseToolCalls(res: http.ServerResponse, name: string, ids: string[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'fake-tc', object: 'chat.completion.chunk', created: 1, model: 'local-test',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  res.write(frame({ role: 'assistant', content: null, tool_calls: ids.map((id, index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify({ part: index }) } })) }, null))
  res.write(frame({}, 'tool_calls'))
  res.end('data: [DONE]\n\n')
}

function sse(res: http.ServerResponse, text: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'fake-1', object: 'chat.completion.chunk', created: 1, model: 'local-test',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  res.write(chunk({ role: 'assistant', content: text }, null))
  res.write(chunk({}, 'stop'))
  res.write(`data: ${JSON.stringify({ id: 'fake-1', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [], usage: { prompt_tokens: 50, completion_tokens: 2, total_tokens: 52 } })}\n\n`)
  res.end('data: [DONE]\n\n')
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-request-path-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
  process.env.DATA_DIR = tmpDir
  process.env.WORKSPACE_DIR = path.join(tmpDir, 'workspace')
  resetObservedEcoLimits()
  received = []
  script = []
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      try { received.push({ url: req.url ?? '', body: JSON.parse(raw) as Received['body'] }) } catch { received.push({ url: req.url ?? '', body: { messages: [] } }) }
      const scripted = script.shift()
      if (scripted) scripted(res)
      else sse(res, 'synthetic ok')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Synthetic tool: 25k chars with ids/numbers/paths in the middle. */
const MIDDLE_MARK = 'SYNTHETIC-MIDDLE-ID-4711 /srv/synthetic/deep/path 98765'
function syntheticDumpTool(): AgentTool {
  return {
    name: 'synthetic_dump',
    label: 'Synthetic dump',
    description: 'Returns a large synthetic text block (test only).',
    parameters: Type.Object({ part: Type.Optional(Type.Number()) }),
    execute: async (toolCallId: string) => {
      const filler = `row ${toolCallId} 0123456789 abcdefghij\n`.repeat(300)
      return { content: [{ type: 'text' as const, text: `HEAD-${toolCallId}\n${filler}${MIDDLE_MARK}\n${filler}TAIL-${toolCallId}` }], details: {} }
    },
  }
}

function boot(opts: { reasoning?: boolean; maxTokens?: number; contextWindow?: number; tools?: AgentTool[] } = {}) {
  const db = initDatabase(':memory:')
  db.prepare("INSERT INTO sessions (id, agent_id) VALUES ('s-eco', 'main')").run()
  const runtime = createAgentRuntime({
    model: {
      id: 'local-test', name: 'Local test', api: 'openai-completions' as const, provider: 'ollama',
      baseUrl, reasoning: opts.reasoning ?? false,
      input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: opts.contextWindow ?? 16000, maxTokens: opts.maxTokens ?? 1024,
    },
    apiKey: 'none',
    db,
    tools: opts.tools ?? [],
    memoryDir: path.join(tmpDir, 'memory'),
  })
  return { db, runtime }
}

async function collect(stream: AsyncIterable<ResponseChunk>, db?: Database): Promise<ResponseChunk[]> {
  const out: ResponseChunk[] = []
  for await (const chunk of stream) {
    out.push(chunk)
    // Persist tool rows exactly like turn-runner's saveChatMessage does, so
    // Eco finds a stored original (the recall reference) for each call.
    if (db && chunk.type === 'tool_call_end' && chunk.toolCallId) {
      db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)').run(
        's-eco', null, 'tool', `Tool: ${chunk.toolName}`,
        JSON.stringify({ toolName: chunk.toolName, toolCallId: chunk.toolCallId, toolArgs: null, toolResult: chunk.toolResult ?? null, toolIsError: chunk.toolIsError ?? false }),
        'main',
      )
    }
  }
  return out
}

const textOf = (chunks: ResponseChunk[]) => chunks.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
const errorsOf = (chunks: ResponseChunk[]) => chunks.filter(c => c.type === 'error').map(c => c.error ?? '').join('\n')

describe('eco mode over the real HTTP request path', () => {
  it('eco on, small prompt: exactly one request reaches the server with the real max_tokens, answer streams back', async () => {
    const { db, runtime } = boot()
    setStrandEcoEnabled(db, 's-eco', true)
    const chunks = await collect(runtime.streamPrompt('synthetic short question', 's-eco'))
    expect(errorsOf(chunks)).toBe('')
    expect(textOf(chunks)).toContain('synthetic ok')
    expect(received).toHaveLength(1)
    expect(received[0]!.url).toContain('/chat/completions')
    const maxOut = received[0]!.body.max_tokens ?? received[0]!.body.max_completion_tokens
    expect(maxOut).toBe(1024)
    expect(JSON.stringify(received[0]!.body.messages)).toContain('synthetic short question')
    // Within budget nothing was compacted or refused, so no metric row is
    // written (rows exist only for changed or refused views).
    expect(lastEcoViewForStrand(db, 's-eco')).toBeNull()
  }, 30_000)

  it('eco on, 150k-char paste: fails CLOSED — nothing reaches the server, the chat gets an actionable refusal', async () => {
    const { db, runtime } = boot()
    setStrandEcoEnabled(db, 's-eco', true)
    const paste = 'synthetic-line 0123456789 /tmp/synthetic/path\n'.repeat(Math.ceil(150_000 / 46))
    const chunks = await collect(runtime.streamPrompt(paste, 's-eco'))
    expect(received).toHaveLength(0)
    const visible = `${errorsOf(chunks)}\n${textOf(chunks)}`
    expect(visible).toMatch(/eco/i)
    expect(visible.length).toBeGreaterThan(20)
    expect(visible).not.toContain('synthetic-line 0123456789')
    const view = lastEcoViewForStrand(db, 's-eco')
    expect(view?.refused).toBe(true)
    expect(view?.refusalReason).toBe('current_user_message_too_large')
  }, 30_000)

  it('normal mode (eco off) is unchanged: the same paste is sent as-is', async () => {
    const { runtime } = boot()
    const paste = 'synthetic-line 0123456789 /tmp/synthetic/path\n'.repeat(Math.ceil(150_000 / 46))
    const chunks = await collect(runtime.streamPrompt(paste, 's-eco'))
    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(received[0]!.body.messages)).toContain('synthetic-line 0123456789')
    expect(textOf(chunks)).toContain('synthetic ok')
  }, 30_000)
  it('tool loop: eco OFF sends raw results; eco ON compacts the older persisted results on the wire with intact call/result mapping and a working recall reference', async () => {
    const { db, runtime } = boot({ tools: [syntheticDumpTool()] })
    // Turn 1 in normal mode: two parallel 25k-char results go out raw.
    script = [res => sseToolCalls(res, 'synthetic_dump', ['call_a', 'call_b'])]
    const turn1 = await collect(runtime.streamPrompt('synthetic: dump twice', 's-eco'), db)
    expect(errorsOf(turn1)).toBe('')
    expect(received).toHaveLength(2)
    const raw = received[1]!.body.messages
    expect(raw.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(['call_a', 'call_b'])
    expect(JSON.stringify(raw)).toContain(MIDDLE_MARK)

    // Turn 2 with eco ON: the same transcript no longer fits the budget.
    setStrandEcoEnabled(db, 's-eco', true)
    const turn2 = await collect(runtime.streamPrompt('synthetic: summarize', 's-eco'), db)
    expect(errorsOf(turn2)).toBe('')
    expect(textOf(turn2)).toContain('synthetic ok')
    expect(received).toHaveLength(3)
    const sent = received[2]!.body
    expect(sent.max_tokens ?? sent.max_completion_tokens).toBe(1024)
    const wire = JSON.stringify(sent.messages)
    expect(wire).toContain('synthetic: summarize')
    // Every tool_call id still has its tool result (or the whole pair was
    // dropped into the ledger): never an orphan in either direction.
    const callIds = sent.messages.flatMap(m => (m.tool_calls ?? []).map(c => c.id))
    const resultIds = sent.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)
    expect(resultIds.sort()).toEqual(callIds.sort())
    // The raw middle is gone from the wire, a recall reference is present.
    expect(wire).not.toContain(MIDDLE_MARK)
    const ref = /message_id=(\d+)/.exec(wire)
    expect(ref).not.toBeNull()
    expect(wire).not.toMatch(/transcript (is )?kept|full result kept/i)
    const view = lastEcoViewForStrand(db, 's-eco')
    expect(view?.refused).toBe(false)

    // The reference resolves to the stored original — the exact text the tool
    // returned (no tool cap applied here, so it contains the middle).
    const recall = createRecallMessageTool({ db, getCurrentAgentId: () => 'main' })
    const out = await recall.execute('r1', { message_id: Number(ref![1]), part: 'result', max_chars: 16000 }) as { content: Array<{ text: string }> }
    expect(out.content[0]!.text).toContain(MIDDLE_MARK)
  }, 30_000)

  it('tool loop without a stored original: eco refuses instead of cutting, and the refused request is NOT sent', async () => {
    const { db, runtime } = boot({ tools: [syntheticDumpTool()] })
    script = [res => sseToolCalls(res, 'synthetic_dump', ['call_a', 'call_b'])]
    await collect(runtime.streamPrompt('synthetic: dump twice', 's-eco')) // no persistence
    expect(received).toHaveLength(2)
    setStrandEcoEnabled(db, 's-eco', true)
    const turn2 = await collect(runtime.streamPrompt('synthetic: summarize', 's-eco'))
    expect(received).toHaveLength(2)
    expect(errorsOf(turn2) + textOf(turn2)).toMatch(/eco/i)
    expect(lastEcoViewForStrand(db, 's-eco')?.refused).toBe(true)
  }, 30_000)

  it('fixed context too large: a system prompt sent as a system message counts as fixed context, the refusal names it (not the history), nothing is sent', async () => {
    // Real base tool set + system prompt, 16k window, maxTokens = window:
    // the reserve min(maxTokens, window/2) leaves no room for the fixed part.
    const { db, runtime } = boot({ reasoning: true, maxTokens: 16000 })
    setStrandEcoEnabled(db, 's-eco', true)
    const chunks = await collect(runtime.streamPrompt('synthetic short question', 's-eco'))
    expect(received).toHaveLength(0)
    expect(lastEcoViewForStrand(db, 's-eco')?.refusalReason).toBe('fixed_context_too_large')
    expect(errorsOf(chunks) + textOf(chunks)).toMatch(/Systemprompt/)
  }, 30_000)

  it('reasoning model with maxTokens = window: the wire limit is pi-ai\'s context clamp (never above model.maxTokens), no separate reasoning budget on top', async () => {
    const { db, runtime } = boot({ reasoning: true, contextWindow: 40960, maxTokens: 40960 })
    setStrandEcoEnabled(db, 's-eco', true)
    const chunks = await collect(runtime.streamPrompt('synthetic short question', 's-eco'))
    expect(errorsOf(chunks)).toBe('')
    expect(received).toHaveLength(1)
    const body = received[0]!.body
    const sentMax = body.max_tokens ?? body.max_completion_tokens
    expect(typeof sentMax).toBe('number')
    // clampMaxTokensToContext: min(model.maxTokens, window - estimate(chars/4) - 4096).
    expect(sentMax!).toBeLessThan(40960 - 4096)
    expect(sentMax!).toBeGreaterThan(0)
    // Reasoning shares that one completion limit: no extra budget field.
    expect(body).not.toHaveProperty('thinking_token_budget')
    expect(body).not.toHaveProperty('max_thinking_tokens')
  }, 30_000)
})
