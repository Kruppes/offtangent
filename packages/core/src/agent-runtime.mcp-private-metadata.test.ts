/**
 * Review 3 (REVIEW-5c5d90a7.md) / P1-2, over the wire: private (local_only)
 * MCP tool METADATA reaches the strictly local model WITHOUT any MCP tool
 * call. The strand must count as private for every side path from that
 * moment on: in memory for the running turn, persistently for a reload and
 * for helpers running in parallel. Real runtime, real loopback servers
 * (local model, MCP, TTS); the TTS server records what would be spoken.
 * Port of the earlier metadata and voice probe script.
 * {{secret:url-password-10}} data only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-meta-test-'))
process.env.DATA_DIR = root
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
fs.mkdirSync(path.join(root, 'config'), { recursive: true })

const META = 'Private fixture metadata number 927461'
const SID = 'voice-target'
const dbFile = path.join(root, 'state.db')

const wire: Array<{ path: string; body: unknown }> = []
const servers: http.Server[] = []
let step = 0
let mcpCalls = 0
/** Persisted privacy state at the instant the local model receives the metadata. */
let persistedAtFirstModelRequest: boolean | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let m: any
let db: import('better-sqlite3').Database

async function listen(s: http.Server): Promise<string> {
  servers.push(s)
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

async function readBody(q: http.IncomingMessage): Promise<string> {
  let b = ''
  for await (const x of q) b += x
  return b
}

let toolResults: unknown[] = []

beforeAll(async () => {
  const ttsUrl = await listen(http.createServer(async (q, r) => {
    wire.push({ path: q.url ?? '', body: JSON.parse(await readBody(q)) })
    r.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Synthetic refusal after recording request' } }))
  }))
  const llmUrl = await listen(http.createServer(async (q, r) => {
    wire.push({ path: q.url ?? '', body: JSON.parse(await readBody(q)) })
    step++
    // A helper running in parallel (outside the turn) asks while the local
    // model already holds the private metadata.
    if (step === 1) persistedAtFirstModelRequest = m.isPrivateMcpScope(db, SID)
    const delta = step === 1
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'voice-call', type: 'function', function: { name: 'send_voice_message', arguments: JSON.stringify({ text: META }) } }] }
      : { role: 'assistant', content: 'done' }
    r.writeHead(200, { 'content-type': 'text/event-stream' })
      .end(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: step === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  }))
  const mcpUrl = await listen(http.createServer(async (q, r) => {
    if (q.method !== 'POST') { r.writeHead(405).end(); return }
    const msg = JSON.parse(await readBody(q))
    if (msg.id === undefined) { r.writeHead(202).end(); return }
    let result: unknown
    if (msg.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    else if (msg.method === 'tools/list') result = { tools: [{ name: 'private_read', description: META, inputSchema: { type: 'object', properties: {} } }] }
    else if (msg.method === 'tools/call') { mcpCalls++; result = { content: [{ type: 'text', text: 'private body' }] } }
    r.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
  }))
  const base = (id: string, url: string, region: string) => ({
    id, name: id, type: 'openai-completions', providerType: 'openai-compatible', provider: 'openai', baseUrl: `${url}/v1`,
    apiKey: '{{secret:url-password-10}}-test-key', enabledModels: ['fixture-model'], models: [{ id: 'fixture-model', contextWindow: 32000, maxTokens: 1000 }],
    status: 'connected', authMethod: 'api-key', dataPolicy: { region, training: 'no' },
  })
  const local = base('fixture-local', llmUrl, 'local')
  const cloudTts = base('fixture-tts', ttsUrl, 'us')
  fs.writeFileSync(path.join(root, 'config', 'providers.json'), JSON.stringify({ providers: [local, cloudTts] }))
  fs.writeFileSync(path.join(root, 'config', 'settings.json'), JSON.stringify({
    mcp: { enabled: true, servers: { review: { transport: 'http', url: `${mcpUrl}/mcp`, personas: ['main'], users: ['1'], dataClass: 'local_only', connectTimeoutMs: 1000, callTimeoutMs: 1000 } } },
  }))
  m = {
    ...(await import('./agent-runtime.js')),
    ...(await import('./database.js')),
    ...(await import('./provider-config.js')),
    ...(await import('./mcp-client.js')),
    ...(await import('./mcp-egress.js')),
    ...(await import('./voice-note-tool.js')),
    ...(await import('./fact-extraction.js')),
    ...(await import('./delegation-context.js')),
    ...(await import('./task-tools.js')),
    ...(await import('./ask-agent-tool.js')),
  }
  db = m.initDatabase(dbFile)
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'fixture', 'none')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES (?, 1, 'main')").run(SID)
  // Production wiring of the voice tool (runtime-composition).
  const tool = m.createVoiceMessageTool({
    getCurrentToolUserId: () => 1,
    getCurrentInteractiveSessionId: () => SID,
    isCarriedByCurrentTurn: () => true,
    isPrivateStrand: (sid: string | null) => m.skipPrivateMcpSession(db, sid, 'send_voice_message'),
    loadConfig: () => ({ provider: 'openai', providerId: 'fixture-tts', model: 'tts-1', voice: 'alloy', style: '', maxChars: 1000, rewrite: false, format: 'wav', inherited: [] }),
  })
  const rt = m.createAgentRuntime({
    model: m.buildModel(local, 'fixture-model'), providerConfig: local, apiKey: '{{secret:url-password-10}}-test-key',
    db, tools: [tool], systemPrompt: 'Synthetic review', getCurrentToolUserId: () => 1, memoryDir: path.join(root, 'memory'),
  })
  const chunks: Array<{ type?: string; toolResult?: unknown }> = []
  for await (const c of rt.streamPrompt('Speak the {{secret:url-password-10}} tool description.', SID)) chunks.push(c)
  toolResults = chunks.filter(c => c.type === 'tool_call_end').map(c => c.toolResult)
})

afterAll(async () => {
  await m?.closeSharedMcpManager?.()
  db?.close()
  for (const s of servers) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())) }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('private MCP metadata without any tool call (review 3 / P1-2)', () => {
  it('the local model really received the private metadata, and no MCP tool was called', () => {
    const chat = wire.filter(w => w.path.includes('chat/completions'))
    expect(chat.length).toBeGreaterThan(0)
    expect(JSON.stringify(chat[0].body)).toContain(META)
    expect(mcpCalls).toBe(0)
  })

  it('send_voice_message is refused and NO request reaches the TTS endpoint', () => {
    expect(JSON.stringify(toolResults)).toContain('MCP privacy gate')
    expect(wire.filter(w => w.path.includes('audio/speech')).length).toBe(0)
    expect(JSON.stringify(wire.filter(w => !w.path.includes('chat/completions')))).not.toContain(META)
  })

  it('the strand marker was persisted BEFORE the model got the metadata (parallel helper sees it)', () => {
    expect(persistedAtFirstModelRequest).toBe(true)
  })

  it('after a reload (new DB connection) every side path still treats the strand as private', async () => {
    const reopened = m.initDatabase(dbFile)
    try {
      expect(m.isPrivateMcpSession(reopened, SID)).toBe(true)
      const facts = await m.extractAndStoreFacts(reopened, 1, SID, `User: ${META}`, { id: 'cloud' }, 'k')
      expect(facts.skipped).toBe('mcp_private')
      const ctx = m.buildDelegationContext({ db: reopened, mode: 'fork', parentSessionId: SID })
      expect(ctx.block).toBeNull()
      const task = m.createTaskTool({ db: reopened, taskRuntime: {} as never, getParentSessionId: () => SID } as never)
      expect(JSON.stringify(await task.execute('t', { name: 'n', prompt: `${META} ${'self contained synthetic brief '.repeat(12)}` } as never))).toContain('MCP privacy gate')
      const ask = m.createAskAgentTool({ getCurrentAgentId: () => 'main', getModel: () => ({ id: 'x' }), getApiKey: () => 'k', db: reopened, getCurrentSessionId: () => SID })
      expect(JSON.stringify(await ask.execute('a', { agent_id: 'builder', question: META }))).toContain('MCP privacy gate')
    } finally {
      reopened.close()
    }
  })
})
