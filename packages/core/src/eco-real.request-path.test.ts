/**
 * REAL Eco (plan 2026-10-05-real-eco) over the real request path: no module mocks. The real runtime, the real pi-agent loop, the
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
import { setStrandEcoEnabled, lastEcoViewForStrand } from './eco-mode-store.js'
import { frozenEcoRowId } from './eco-tool-freeze.js'
import { createRecallMessageTool } from './recall-message-tool.js'

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

function boot(opts: { reasoning?: boolean; maxTokens?: number; contextWindow?: number; tools?: AgentTool[]; db?: Database } = {}) {
  const db = opts.db ?? initDatabase(':memory:')
  if (!opts.db) {
    // Production strands always have an owner; Eco freezes only for a trusted owner (fail closed).
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u1', 'h', 'admin')").run()
    db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('s-eco', 1, 'main')").run()
  }
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
      // turn-runner dedupe: a result frozen at creation already owns its row.
      if (frozenEcoRowId(db, 's-eco', chunk.toolCallId, chunk.toolResult) !== undefined) continue
      db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)').run(
        's-eco', null, 'tool', `Tool: ${chunk.toolName}`,
        JSON.stringify({ toolName: chunk.toolName, toolCallId: chunk.toolCallId, toolArgs: null, toolResult: chunk.toolResult ?? null, toolIsError: chunk.toolIsError ?? false }),
        'main',
      )
    }
  }
  return out
}


const toolMsgs = (r: Received) => r.body.messages.filter(m => m.role === 'tool')
const contentText = (m: WireMessage) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
const fixedPart = (r: Received) => JSON.stringify({ ...r.body, messages: undefined, stream_options: r.body.stream_options })

async function scenario(eco: boolean[]) {
  const { db, runtime } = boot({ tools: [syntheticDumpTool()], contextWindow: 200000, maxTokens: 2048 })
  for (let turn = 0; turn < eco.length; turn++) {
    setStrandEcoEnabled(db, 's-eco', eco[turn])
    script.push(res => sseToolCalls(res, 'synthetic_dump', [`call-${turn}`]))
    script.push(res => sse(res, `done ${turn}`))
    await collect(runtime.streamPrompt(`synthetic turn ${turn}`, 's-eco'), db)
  }
  return { db, runtime }
}

describe('real Eco: freeze NEW tool results at creation (real request path)', () => {
  it('Eco on: the very FIRST request that carries the new result already carries the smaller frozen projection; recall returns the verbatim original incl. the middle fact', async () => {
    const { db } = await scenario([true])
    expect(received).toHaveLength(2)
    const sent = toolMsgs(received[1])
    expect(sent).toHaveLength(1)
    const text = contentText(sent[0])
    const rows = db.prepare("SELECT id, metadata, eco_original FROM chat_messages WHERE session_id = 's-eco' AND role = 'tool'").all() as Array<{ id: number; metadata: string; eco_original: string | null }>
    expect(rows).toHaveLength(1) // no duplicate row
    const row = rows[0]
    expect(row.eco_original).toContain(MIDDLE_MARK)
    expect(text).toContain(`message ${row.id}`)
    expect(text).toContain('HEAD-call-0')
    expect(text).toContain('TAIL-call-0')
    expect(text).not.toContain(MIDDLE_MARK) // genuinely partial ...
    const original = (JSON.parse(row.eco_original!) as { content: Array<{ text: string }> }).content[0].text
    expect(text.length).toBeLessThan(original.length * 0.6) // ... and genuinely smaller
    // persisted model-facing projection == what went on the wire
    const meta = JSON.parse(row.metadata) as { toolCallId: string; toolResult: { content: Array<{ text: string }>; details: { eco: { rowId: number } } } }
    expect(meta.toolCallId).toBe('call-0')
    expect(meta.toolResult.content[0].text).toBe(text)
    expect(meta.toolResult.details.eco.rowId).toBe(row.id)
    // recall: same persona scope returns the original, paged, middle fact retrievable
    const recall = createRecallMessageTool({ db, getCurrentAgentId: () => 'main', maxChars: 200000 })
    const out = await recall.execute('r1', { message_id: row.id })
    const recalled = (out.content[0] as { text: string }).text
    expect(recalled).toContain(MIDDLE_MARK)
    expect(recalled).toContain(original.slice(0, 2000))
    // other persona cannot read it
    const foreign = createRecallMessageTool({ db, getCurrentAgentId: () => 'other' })
    const denied = await foreign.execute('r2', { message_id: row.id })
    expect((denied.content[0] as { text: string }).text).toContain('not found')
  })

  it('Eco off (default): wire carries the full original, no eco column written — Normal unchanged', async () => {
    const { db } = await scenario([false])
    const text = contentText(toolMsgs(received[1])[0])
    expect(text).toContain(MIDDLE_MARK)
    expect(text).not.toContain('[eco:')
    const n = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE eco_original IS NOT NULL").get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('toggle on -> off -> on: every request is a strict prefix extension of the previous one (LCP), tools/max_tokens/params byte-identical; old projections stay pinned, only NEW results follow the switch', async () => {
    const { db } = await scenario([true, false, true])
    expect(received).toHaveLength(6)
    for (let i = 1; i < received.length; i++) {
      const prev = received[i - 1].body.messages
      const cur = received[i].body.messages
      expect(cur.length).toBeGreaterThan(prev.length)
      expect(JSON.stringify(cur.slice(0, prev.length))).toBe(JSON.stringify(prev))
      expect(fixedPart(received[i])).toBe(fixedPart(received[0]))
    }
    const last = toolMsgs(received[5]).map(contentText)
    expect(last).toHaveLength(3)
    expect(last[0]).toContain('[eco:') // frozen while on, stays frozen after off
    expect(last[1]).toContain(MIDDLE_MARK) // created while off: full
    expect(last[1]).not.toContain('[eco:')
    expect(last[2]).toContain('[eco:')
    const counts = db.prepare("SELECT json_extract(metadata,'$.toolCallId') AS c, COUNT(*) AS n FROM chat_messages WHERE role='tool' GROUP BY c").all() as Array<{ n: number }>
    expect(counts).toHaveLength(3)
    expect(counts.every(c => c.n === 1)).toBe(true)
  })

  it('total wire chars of the completed Eco workload (incl. one recall round-trip) stay below the Normal baseline', async () => {
    await scenario([false, false, false])
    const normal = received.reduce((s, r) => s + JSON.stringify(r.body.messages).length, 0)
    received = []
    const { db } = await scenario([true, true, true])
    // the model recalls one original in a 4th turn: counts the recall request + result
    const rowId = (db.prepare("SELECT id FROM chat_messages WHERE eco_original IS NOT NULL ORDER BY id LIMIT 1").get() as { id: number }).id
    const recall = createRecallMessageTool({ db, getCurrentAgentId: () => 'main', maxChars: 200000 })
    const recalledChars = ((await recall.execute('r', { message_id: rowId })).content[0] as { text: string }).text.length
    const lastLen = JSON.stringify(received[received.length - 1].body.messages).length
    const eco = received.reduce((s, r) => s + JSON.stringify(r.body.messages).length, 0) + lastLen + recalledChars
    expect(eco).toBeLessThan(normal)
  })
  it('restart: a fresh runtime over the same DB keeps the stored projection + raw original byte-stable, recall still works, Eco off keeps NEW results full', async () => {
    const { db } = await scenario([true])
    const before = db.prepare("SELECT id, metadata, eco_original FROM chat_messages WHERE role = 'tool'").get() as { id: number; metadata: string; eco_original: string }
    setStrandEcoEnabled(db, 's-eco', false)
    const { runtime: restarted } = boot({ tools: [syntheticDumpTool()], contextWindow: 200000, maxTokens: 2048, db })
    received = []
    script.push(res => sseToolCalls(res, 'synthetic_dump', ['call-after-restart']))
    script.push(res => sse(res, 'done'))
    await collect(restarted.streamPrompt('synthetic turn after restart', 's-eco'), db)
    const after = db.prepare('SELECT metadata, eco_original FROM chat_messages WHERE id = ?').get(before.id) as { metadata: string; eco_original: string }
    expect(after).toEqual({ metadata: before.metadata, eco_original: before.eco_original })
    expect(contentText(toolMsgs(received[1])[0])).toContain(MIDDLE_MARK)
    const recall = createRecallMessageTool({ db, getCurrentAgentId: () => 'main', maxChars: 200000 })
    expect(((await recall.execute('r', { message_id: before.id })).content[0] as { text: string }).text).toContain(MIDDLE_MARK)
    expect(lastEcoViewForStrand(db, 's-eco')).toMatchObject({ compactedResults: 1, refused: false, droppedMessages: 0 })
  })
})
