/**
 * Real Eco (plan 2026-10-05-real-eco), verification part 2:
 *  A. real pi-ai Anthropic Messages serializer over a fake HTTP server:
 *     prefix invariant (LCP) on the wire, fixed tools/system/max_tokens/thinking,
 *     <= 4 cache_control markers, toggle both ways;
 *  B. offline cache accounting of the SAME completed scenario, Normal vs Eco
 *     (theoretical prefix reuse, NOT a provider cache hit);
 *  C. TaskRunner end-to-end with the real pi-agent loop + openai-completions
 *     fake HTTP: the task's FIRST request carrying the result is already the
 *     frozen projection; the task session stores the raw original for recall.
 * Synthetic data only, no cloud/live call.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createAgentRuntime, createYoloTools } from './agent-runtime.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { setStrandEcoEnabled } from './eco-mode-store.js'
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

const REAL_SHELL = (({ name, label, description, parameters }) => ({ name, label, description, parameters }))(createYoloTools().find(t => t.name === 'shell')!)

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

function openaiSse(res: http.ServerResponse, opts: { tool?: { id: string; name: string }; text?: string }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  if (opts.tool) {
    res.write(frame({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: opts.tool.id, type: 'function', function: { name: opts.tool.name, arguments: JSON.stringify(opts.tool.name === 'shell' ? { command: 'npm test' } : {}) } }] }, null))
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
function shellLikeTool(): AgentTool {
  // The `shell` tool (F1 allowlist: only recognised build/test runs are projected) returning a long synthetic test log with
  // one failure in the middle, so the shell profile (error + trace frames, long
  // tail) is exercised on the real request path.
  return {
    // Same definition as the built-in shell (name/description/schema), only
    // execute is a double: the request's tool list stays byte-identical.
    ...REAL_SHELL,
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
const countMarkers = (v: unknown): number => JSON.stringify(v).split('"cache_control"').length - 1
/** Serialized message items (marker-free) — the unit of prefix comparison. */
const items = (b: Body): string[] => (stripMarkers(b.messages) as unknown[]).flatMap(m => {
  const mm = m as { role: string; content: unknown }
  return Array.isArray(mm.content) ? mm.content.map(c => `${mm.role}:${JSON.stringify(c)}`) : [`${mm.role}:${JSON.stringify(mm.content)}`]
})
const fixed = (b: Body) => JSON.stringify(stripMarkers({ ...b, messages: undefined }))

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
    tools: [shellLikeTool()],
    memoryDir: path.join(tmpDir, 'memory'),
  })
  for (let turn = 0; turn < eco.length; turn++) {
    setStrandEcoEnabled(db, 's-anth', eco[turn])
    script.push(res => anthropicSse(res, [{ tool: { id: `toolu_${turn}`, name: 'shell', input: { command: 'npm test' } } }]))
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

/**
 * Offline cache model of one completed scenario: request n can reuse the
 * longest common item prefix with request n-1 (cacheRead), the rest is
 * written/recomputed (cacheWrite). Characters, not provider tokens.
 */
function cacheAccount(requests: Body[]) {
  let read = 0; let write = 0; let total = 0; let brokenPrefixes = 0
  let prev: string[] = []
  for (const r of requests) {
    const cur = items(r)
    let lcp = 0
    while (lcp < prev.length && lcp < cur.length && prev[lcp] === cur[lcp]) lcp++
    if (lcp < prev.length) brokenPrefixes++
    const reused = cur.slice(0, lcp).join('').length
    const all = cur.join('').length
    read += reused; write += all - reused; total += all
    prev = cur
  }
  // weighted with the Anthropic list price ratios (read 0.1x, write 1.25x)
  return { requests: requests.length, read, write, total, brokenPrefixes, weighted: Math.round(read * 0.1 + write * 1.25) }
}

describe('real Eco on the Anthropic Messages serializer (fake HTTP)', () => {
  it('first request with the new result is already compact; prefix invariant + fixed tools/system/max_tokens/thinking + <= 4 cache markers across on/off toggles', async () => {
    const { db, requests } = await anthropicScenario([false, true, false, true])
    expect(requests).toHaveLength(8)
    for (const r of requests) expect(countMarkers(r)).toBeLessThanOrEqual(4)
    for (let i = 1; i < requests.length; i++) {
      expect(fixed(requests[i])).toBe(fixed(requests[0]))
      const prev = items(requests[i - 1]); const cur = items(requests[i])
      expect(cur.slice(0, prev.length)).toEqual(prev)
    }
    expect(requests[0].max_tokens).toBe(requests[7].max_tokens)
    expect(JSON.stringify(requests[0].thinking)).toBe(JSON.stringify(requests[7].thinking))
    const toolResults = (b: Body) => items(b).filter(s => s.includes('"tool_result"'))
    // turn 0 (off): full; turn 1 (on): first request that carries it is compact
    expect(toolResults(requests[1])[0]).toContain('src/m599.test.ts')
    expect(toolResults(requests[1])[0]).not.toContain('[eco:')
    const ecoFirst = toolResults(requests[3])[1]
    expect(ecoFirst).toContain('[eco: shell result compacted once')
    expect(ecoFirst).toContain(MIDDLE_MARK) // error line kept by the shell profile
    expect(ecoFirst.length).toBeLessThan(toolResults(requests[1])[0].length * 0.5)
    // off again: the NEW result is full, the earlier projection stays pinned
    expect(toolResults(requests[5])[2]).not.toContain('[eco:')
    expect(toolResults(requests[5])[1]).toBe(ecoFirst)
    // owner recall of the projected row returns the verbatim original
    const rowId = Number(/recall_message\(message_id=(\d+)\)/.exec(ecoFirst)![1])
    const owner = await createRecallMessageTool({ db, getCurrentUserId: () => 1, getCurrentAgentId: () => 'main', getCurrentSessionId: () => 's-anth', maxChars: 200000 }).execute('r', { message_id: rowId })
    const ownerText = (owner.content as Array<{ text: string }>).map(c => c.text).join('')
    expect(ownerText).toContain('src/m450.test.ts')
  })

  it('offline cache accounting of the same completed scenario: Eco never breaks a cached prefix and writes/reads fewer chars than Normal', async () => {
    const normal = cacheAccount((await anthropicScenario([true, true, true].map(() => false))).requests)
    received = []
    const eco = cacheAccount((await anthropicScenario([true, true, true])).requests)
    console.log(`[eco-cache-offline] normal=${JSON.stringify(normal)} eco=${JSON.stringify(eco)}`)
    expect(normal.brokenPrefixes).toBe(0)
    expect(eco.brokenPrefixes).toBe(0)
    expect(eco.requests).toBe(normal.requests)
    expect(eco.write).toBeLessThan(normal.write)
    expect(eco.read).toBeLessThan(normal.read)
    expect(eco.weighted).toBeLessThan(normal.weighted)
  })

  it('worst case (documented, not hidden): the model recalls the WHOLE original of every projected result (2 pages each)', async () => {
    const normalReqs = (await anthropicScenario([false, false, false])).requests
    const normal = cacheAccount(normalReqs)
    received = []
    const worstRun = await anthropicScenario([true, true, true], 2)
    const worst = cacheAccount(worstRun.requests)
    const recalled = worstRun.requests.at(-1)!.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
      .filter(c => JSON.stringify(c).includes('[recalled] message')).length
    // the recall results reach the model verbatim (never re-projected) and
    // together contain the whole original incl. the middle failure fact
    const recallTexts = items(worstRun.requests.at(-1)!).filter(x => x.includes('[recalled] message'))
    expect(recallTexts.every(x => !x.includes('[eco:'))).toBe(true)
    expect(recallTexts.join('')).toContain('src/m599.test.ts')
    expect(recallTexts.join('')).toContain(MIDDLE_MARK)
    console.log(`[eco-cache-worst] normal=${JSON.stringify(normal)} eco_full_recall=${JSON.stringify(worst)} recall_results=${recalled}`)
    expect(recalled).toBe(6)
    expect(worst.brokenPrefixes).toBe(0)
    // Honest: full recall of everything costs MORE than Normal (extra round
    // trips re-read the prefix). Eco only pays off when most omitted lines are
    // not needed. Asserted so a regression in either direction is visible.
    expect(worst.requests).toBe(normal.requests + 6)
    expect(worst.total).toBeGreaterThan(normal.total)
  })
})

describe('real Eco in the TaskRunner (real pi-agent loop, fake HTTP)', () => {
  it('a task in an Eco strand sends the frozen projection on its first request after the tool call; Normal strand sends the full original', async () => {
    defaultReply = res => openaiSse(res, { text: 'STATUS: completed\nSUMMARY: synthetic done' })
    const run = async (eco: boolean) => {
      received = []
      const db = initDatabase(path.join(tmpDir, `task-${eco}.db`))
      const store = new TaskStore(db)
      const STRAND = `strand-${eco}`
      db.prepare("INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES (?, 'system', 'interactive', NULL, '1')").run(STRAND)
      setStrandEcoEnabled(db, STRAND, eco)
      let done: () => void = () => {}
      const finished = new Promise<void>(r => { done = r })
      const provider: ProviderConfig = {
        id: 'p-local', name: 'p-local', type: 'openai', providerType: 'openai', provider: 'openai', baseUrl: `${origin}/v1`,
        apiKey: 'none', enabledModels: ['local-test'], models: [], status: 'connected', authMethod: 'api-key',
      } as ProviderConfig
      const runner = new TaskRunner({
        db,
        buildModel: () => ({
          id: 'local-test', name: 'Local test', api: 'openai-completions', provider: 'openai', baseUrl: `${origin}/v1`, reasoning: false,
          input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 2048,
        }) as unknown as ReturnType<TaskRunnerOptions['buildModel']>,
        getApiKey: async () => 'none',
        tools: [shellLikeTool()],
        onTaskComplete: () => { done() },
        sessionManager: new SessionManager({ db }),
      })
      script.push(res => openaiSse(res, { tool: { id: 'tc-task-1', name: 'shell' } }))
      const task = store.create({ name: 'eco synthetic', prompt: 'run the synthetic tests', triggerType: 'user', agentId: 'main' })
      await runner.startTask(task, provider, undefined, STRAND)
      await Promise.race([finished, new Promise((_, rej) => setTimeout(() => rej(new Error('task timeout')), 15000))])
      const final = store.getById(task.id)!
      runner.dispose()
      const second = received[1]
      const tool = (second.messages as Array<{ role: string; content: unknown }>).find(m => m.role === 'tool')!
      const sessionId = final.sessionId!
      const row = db.prepare("SELECT id, eco_original FROM chat_messages WHERE session_id = ? AND role = 'tool'").get(sessionId) as { id: number; eco_original: string | null } | undefined
      db.close()
      return { status: final.status, toolText: typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content), row, requests: received.length }
    }
    const normal = await run(false)
    const eco = await run(true)
    expect(normal.status).toBe('completed')
    expect(eco.status).toBe('completed')
    expect(normal.toolText).not.toContain('[eco:')
    expect(normal.toolText).toContain('src/m599.test.ts')
    expect(eco.toolText).toContain('[eco: shell result compacted once')
    expect(eco.toolText).toContain(MIDDLE_MARK)
    expect(eco.toolText.length).toBeLessThan(normal.toolText.length * 0.5)
    expect(eco.row?.eco_original).toContain('src/m450.test.ts')
    expect(eco.toolText).toContain(`message_id=${eco.row!.id}`)
  })
})
