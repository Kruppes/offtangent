/**
 * Real Eco (plan 2026-10-05-real-eco), reviewer FINAL repros (zz-final4),
 * committed as deterministic regression tests:
 *  A. real pi-ai Anthropic Messages serializer over a fake HTTP server:
 *     the previous request's last cache_control marker prefix is byte-identical
 *     in the next request (Eco, Normal, mixed toggles); marker layout equals
 *     the Normal baseline; tools/system/max_tokens fixed;
 *  B. TaskRunner pause/resume (STATUS: question) with an already frozen Eco
 *     result in the SAME task session: projection byte-identical across resume
 *     after Eco was toggled OFF, raw original recallable only with the session
 *     owner (F3), the new result after resume honours the current toggle.
 * Synthetic data only, no cloud/live call.
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
import { setStrandEcoEnabled, readStrandEcoMode } from './eco-mode-store.js'
import { frozenEcoRowId } from './eco-tool-freeze.js'
import { createRecallMessageTool } from './recall-message-tool.js'
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
let defaultReply: (res: http.ServerResponse) => void

function anthropicSse(res: http.ServerResponse, blocks: Array<{ tool?: { id: string; name: string; input: unknown }; text?: string }>) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  blocks.forEach((b, index) => {
    if (b.tool) {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.tool.id, name: b.tool.name, input: {} } })
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.tool.input) } })
    } else {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text ?? '' } })
    }
    ev('content_block_stop', { index })
  })
  ev('message_delta', { delta: { stop_reason: blocks.some(b => b.tool) ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
  ev('message_stop', {})
  res.end()
}

function openaiSse(res: http.ServerResponse, opts: { tool?: { id: string; name: string; args?: string }; text?: string }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  if (opts.tool) {
    res.write(frame({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: opts.tool.id, type: 'function', function: { name: opts.tool.name, arguments: opts.tool.args ?? '{}' } }] }, null))
    res.write(frame({}, 'tool_calls'))
  } else {
    res.write(frame({ role: 'assistant', content: opts.text ?? 'ok' }, null))
    res.write(frame({}, 'stop'))
  }
  res.end('data: [DONE]\n\n')
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-anth-task-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
  process.env.DATA_DIR = tmpDir
  process.env.WORKSPACE_DIR = path.join(tmpDir, 'workspace')
  received = []
  script = []
  defaultReply = res => anthropicSse(res, [{ text: 'synthetic ok' }])
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      try { received.push(JSON.parse(raw) as Body) } catch { received.push({ messages: [] }) }
      const next = script.shift()
      if (next) next(res)
      else defaultReply(res)
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
})

const MIDDLE_MARK = 'SYNTHETIC-MIDDLE-ID-4711 /srv/synthetic/deep/path 98765'
function shellLikeTool(name = 'shell'): AgentTool {
  // A synthetic shell implementation returning a long synthetic test log with
  // (name `shell` in the TaskRunner case — no built-ins there — so the strict
  // F1 allowlist projects it; `synthetic_shell` next to the runtime's built-in
  // shell, where a duplicate name would replace the built-in schema mid-run)
  // one failure in the middle, so the shell profile (error + trace frames, long
  // tail) is exercised on the real request path.
  return {
    name,
    label: 'Synthetic shell',
    description: 'Synthetic shell (test only).',
    parameters: Type.Object({ command: Type.Optional(Type.String()) }),
    execute: async (toolCallId: string) => {
      const ok = Array.from({ length: 600 }, (_, i) => ` ✓ src/m${i}.test.ts (3 tests) ${i % 40}ms [${toolCallId}]`)
      ok.splice(300, 0, ' FAIL src/pay.test.ts > totals', `AssertionError: ${MIDDLE_MARK}`, '  at src/pay.ts:88:13')
      ok.push('      Tests  1 failed | 1800 passed', 'exit status 1')
      return { content: [{ type: 'text' as const, text: ok.join('\n') }], details: {} }
    },
  }
}

function stripMarkers(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripMarkers)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== 'cache_control') out[k] = stripMarkers(x)
    return out
  }
  return v
}
/** Serialized message items (marker-free) — the unit of prefix comparison. */

async function drain(stream: AsyncIterable<ResponseChunk>, db: Database, sessionId: string) {
  for await (const chunk of stream) {
    if (chunk.type === 'tool_call_end' && chunk.toolCallId) {
      if (frozenEcoRowId(db, sessionId, chunk.toolCallId, chunk.toolResult) !== undefined) continue
      db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)').run(
        sessionId, 1, 'tool', `Tool: ${chunk.toolName}`,
        JSON.stringify({ toolName: chunk.toolName, toolCallId: chunk.toolCallId, toolResult: chunk.toolResult ?? null }), 'main')
    }
  }
}

async function anthropicScenario(eco: boolean[], recallPages = 0) {
  const db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u1', 'h', 'admin')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('s-anth', 1, 'main')").run()
  const runtime = createAgentRuntime({
    model: {
      id: 'claude-fake', name: 'Claude fake', api: 'anthropic-messages' as const, provider: 'anthropic',
      baseUrl: origin, reasoning: true,
      input: ['text' as const], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000, maxTokens: 4096,
    },
    apiKey: 'sk-ant-api03-synthetic',
    db,
    tools: [shellLikeTool('synthetic_shell')],
    memoryDir: path.join(tmpDir, 'memory'),
  })
  for (let turn = 0; turn < eco.length; turn++) {
    setStrandEcoEnabled(db, 's-anth', eco[turn])
    script.push(res => anthropicSse(res, [{ tool: { id: `toolu_${turn}`, name: 'synthetic_shell', input: { command: 'npm test' } } }]))
    for (let page = 0; page < recallPages && eco[turn]; page++) {
      // worst case: the model pages through the WHOLE original via recall_message;
      // the id is read from the projection the model just received
      script.push(res => {
        const last = JSON.stringify(received[received.length - 1].messages)
        const ids = [...last.matchAll(/recall_message\(message_id=(\d+)\)/g)].map(m => Number(m[1]))
        anthropicSse(res, [{ tool: { id: `toolu_r${turn}_${page}`, name: 'recall_message', input: { message_id: ids[ids.length - 1], offset: page * 16000 } } }])
      })
    }
    script.push(res => anthropicSse(res, [{ text: `done ${turn}` }]))
    await drain(runtime.streamPrompt(`synthetic turn ${turn}`, 's-anth'), db, 's-anth')
  }
  return { db, requests: [...received] }
}

// ---- FINAL review additions (marker-aware cache check; pause/resume) ----
type Blk = { path: string; key: string; hasMarker: boolean }
/** Flatten system+tools+messages into ordered blocks with their cache_control flag; key is marker-free. */
function blocks(b: Body): Blk[] {
  const out: Blk[] = []
  const push = (path: string, v: unknown) => {
    const has = !!(v && typeof v === 'object' && 'cache_control' in (v as object))
    out.push({ path, key: JSON.stringify(stripMarkers(v)), hasMarker: has })
  }
  const bb = b as unknown as { system?: unknown[]; tools?: unknown[]; messages: Array<{ role: string; content: unknown }> }
  for (const [i, t] of (bb.tools ?? []).entries()) push(`tool${i}`, t)
  for (const [i, s] of (bb.system ?? []).entries()) push(`system${i}`, s)
  bb.messages.forEach((m, mi) => {
    if (Array.isArray(m.content)) m.content.forEach((c, ci) => push(`msg${mi}.${m.role}.${ci}`, c))
    else push(`msg${mi}.${m.role}`, { text: m.content })
  })
  return out
}
function markerReuse(requests: Body[]) {
  const issues: string[] = []
  let reusedBlocks = 0
  for (let n = 0; n + 1 < requests.length; n++) {
    const a = blocks(requests[n]); const b = blocks(requests[n + 1])
    const lastMarker = a.map(x => x.hasMarker).lastIndexOf(true)
    if (lastMarker < 0) { issues.push(`req ${n}: no cache marker at all`); continue }
    // The provider can only hit the cache if every block up to the LAST marker of n is byte-identical in n+1
    for (let i = 0; i <= lastMarker; i++) {
      if (!b[i] || b[i].key !== a[i].key) { issues.push(`req ${n}->${n + 1}: marker block ${lastMarker} (${a[lastMarker].path}) prefix broken at block ${i} (${a[i].path})`); break }
    }
    if (!issues.length) reusedBlocks += lastMarker + 1
  }
  return { issues, reusedBlocks }
}
const markerPaths = (b: Body) => blocks(b).filter(x => x.hasMarker).map(x => x.path.replace(/msg\d+/, 'msgN'))

describe('FINAL: Anthropic marker-aware cache reuse', () => {
  it('actual cache_control breakpoints: previous request\'s last marker prefix is byte-identical in the next one; marker layout equals Normal baseline', async () => {
    const eco = await anthropicScenario([true, true, true])
    received = []; script = []
    const normal = await anthropicScenario([false, false, false])
    const mixed = await (async () => { received = []; script = []; return anthropicScenario([false, true, false, true]) })()
    for (const [label, sc] of [['eco', eco], ['normal', normal], ['mixed', mixed]] as const) {
      const r = markerReuse(sc.requests)
      console.log(`[F-CACHE] ${label}: requests=${sc.requests.length} issues=${JSON.stringify(r.issues)} reusedBlocks=${r.reusedBlocks} markers/req=${sc.requests.map(q => markerPaths(q).join('+')).join(' | ')}`)
      expect(r.issues, label).toEqual([])
    }
    // same marker layout (in terms of role/slot, not index) as Normal
    const layout = (sc: { requests: Body[] }) => sc.requests.map(markerPaths)
    expect(layout(eco)).toEqual(layout(normal))
    // fixed parts byte-identical incl. markers (tools/system/max_tokens)
    const fx = (b: Body) => JSON.stringify({ ...b, messages: undefined })
    for (const sc of [eco, normal, mixed]) for (const r of sc.requests) expect(fx(r)).toBe(fx(sc.requests[0]))
  })
})

describe('FINAL: TaskRunner pause/resume with an already frozen result', () => {
  it('question pause keeps the projection byte-identical across resume (Eco on, then toggled OFF before resume); original still recallable; resumed new result honours the CURRENT toggle', async () => {
    const db = initDatabase(path.join(tmpDir, 'pr.db'))
    const store = new TaskStore(db)
    const STRAND = 'strand-pr'
    db.prepare("INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES (?, 'system', 'interactive', NULL, '1')").run(STRAND)
    setStrandEcoEnabled(db, STRAND, true)
    let paused: () => void = () => {}
    const pausedP = new Promise<void>(r => { paused = r })
    let completed: () => void = () => {}
    const completedP = new Promise<void>(r => { completed = r })
    const provider = { id: 'p-local', name: 'p-local', type: 'openai', providerType: 'openai', provider: 'openai', baseUrl: `${origin}/v1`, apiKey: 'none', enabledModels: ['local-test'], models: [], status: 'connected', authMethod: 'api-key' } as ProviderConfig
    // F3: raw originals are owner-checked against the caller's session owner
    const recallCaller: { sessionId?: string } = {}
    const recall = createRecallMessageTool({ db, getCurrentAgentId: () => 'main', getCurrentSessionId: () => recallCaller.sessionId })
    const runner = new TaskRunner({
      db,
      buildModel: () => ({ id: 'local-test', name: 'Local test', api: 'openai-completions', provider: 'openai', baseUrl: `${origin}/v1`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 2048 }) as unknown as ReturnType<TaskRunnerOptions['buildModel']>,
      getApiKey: async () => 'none',
      tools: [shellLikeTool(), recall],
      onTaskComplete: () => { completed() },
      onTaskPaused: () => { paused() },
      sessionManager: new SessionManager({ db }),
    } as unknown as TaskRunnerOptions)
    script.push(res => openaiSse(res, { tool: { id: 'tc-1', name: 'shell', args: '{"command":"npm test"}' } }))
    script.push(res => openaiSse(res, { text: 'STATUS: question\nSUMMARY: which one?' }))
    const task = store.create({ name: 'pause', prompt: 'run synthetic tests then ask', triggerType: 'user', agentId: 'main' })
    await runner.startTask(task, provider, undefined, STRAND)
    await Promise.race([pausedP, new Promise((_, rej) => setTimeout(() => rej(new Error('pause timeout')), 15000))])
    expect(runner.isPaused(task.id)).toBe(true)
    const sessionId = store.getById(task.id)!.sessionId!
    const rowsBefore = db.prepare("SELECT id, eco_original IS NOT NULL f FROM chat_messages WHERE session_id=? AND role='tool'").all(sessionId) as Array<{ id: number; f: number }>
    const beforeReq = received.length
    // toggle Eco OFF while paused, then resume: a call to the recall tool + a second big result
    setStrandEcoEnabled(db, STRAND, false)
    console.log('[F-PR] task session eco mode after parent strand toggled OFF:', JSON.stringify(db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId)).slice(0, 300), readStrandEcoMode(db, sessionId))
    setStrandEcoEnabled(db, sessionId, false)
    const rid = rowsBefore[0]!.id
    // fail closed without a caller session owner (F3)
    const denied = await (recall as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('x', { message_id: rid })
    expect(denied.content[0]!.text).toContain('not found')
    recallCaller.sessionId = sessionId
    script.push(res => openaiSse(res, { tool: { id: 'tc-2', name: 'shell', args: '{"command":"npm test"}' } }))
    script.push(res => openaiSse(res, { text: 'STATUS: completed\nSUMMARY: done' }))
    expect(await runner.resumeTask(task.id, 'take the first one')).toBe(true)
    await Promise.race([completedP, new Promise((_, rej) => setTimeout(() => rej(new Error('complete timeout')), 15000))])
    runner.dispose()
    const toolText = (b: Body) => (b.messages as Array<{ role: string; content: unknown }>).filter(m => m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    const beforeLast = toolText(received[beforeReq - 1])
    const afterFirst = toolText(received[beforeReq])   // first request after resume
    const afterLast = toolText(received[received.length - 1])
    console.log('[F-PR] rowsBefore', JSON.stringify(rowsBefore), 'req before/after pause', beforeReq, received.length, 'tool msgs pre-pause', beforeLast.length, 'after resume 1st', afterFirst.length, 'last', afterLast.length)
    console.log('[F-PR] first tool msg prefix identical across resume?', beforeLast[0] === afterFirst[0], 'is projection?', afterFirst[0]?.includes('[eco:'))
    expect(beforeLast[0]).toContain('[eco: shell result compacted once')
    expect(afterFirst[0]).toBe(beforeLast[0])
    expect(afterLast[0]).toBe(beforeLast[0])
    // second result produced after the toggle OFF stays full
    expect(afterLast[1]).not.toContain('[eco:')
    expect(afterLast[1]!.length).toBeGreaterThan(20000)
    const r = await (recall as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('x', { message_id: rid })
    expect(r.content[0]!.text).toContain(MIDDLE_MARK)
    // exactly one raw-original row, one normal row for the second result, no duplicates
    const rowsAfter = db.prepare("SELECT id, eco_original IS NOT NULL f, json_extract(metadata,'$.toolCallId') cid FROM chat_messages WHERE session_id=? AND role='tool'").all(sessionId)
    console.log('[F-PR] rowsAfter', JSON.stringify(rowsAfter))
    expect(rowsAfter).toHaveLength(2)
    db.close()
  })
})
