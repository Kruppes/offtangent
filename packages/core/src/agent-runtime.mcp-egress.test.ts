/**
 * Review 2 (REVIEW-77292ef9.md) / B and A, end to end over the wire: the
 * REAL pi-agent-core loop talks to a fake OpenAI-compatible model server and
 * a fake MCP HTTP server (both on 127.0.0.1, synthetic data only). We record
 * every request body the "model provider" receives and assert what a cloud
 * target never gets. Port of the earlier runtime probes script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-egress-test-'))
process.env.DATA_DIR = root
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
fs.mkdirSync(path.join(root, 'config'), { recursive: true })

const BODY = 'PRIVATE_BODY_SYNTHETIC_493827'
const ARG = 'PRIVATE_ARG_SYNTHETIC_165849'
const META = 'PRIVATE_METADATA_SYNTHETIC_927461'
// A known secret with a quote and a backslash: JSON escaping changes both.
const QUOTED = 'SYNTH_Quoted"Secret\\Password_8675309'

type Phase = 'history' | 'midturn' | 'quoted-metadata' | 'structured-secret'
let phase: Phase = 'history'
let step = 0
let calls = 0
let runtime: { swapProvider: (p: unknown, k: string, m?: string) => void; streamPrompt: (t: string, s: string) => AsyncIterable<unknown> } | null = null
const reqs: Array<{ phase: Phase; body: { messages: Array<Record<string, unknown>>; tools?: Array<{ function: { name: string; description: string; parameters: unknown } }> } }> = []

let llm: http.Server
let mcp: http.Server
let local: Record<string, unknown>
let cloud: Record<string, unknown>
let mod: {
  createAgentRuntime: (o: unknown) => NonNullable<typeof runtime>
  initDatabase: (p: string) => import('better-sqlite3').Database
  buildModel: (p: unknown, m: string) => unknown
  closeSharedMcpManager: () => Promise<void>
  invalidateKnownValues: () => void
}
let db: import('better-sqlite3').Database

function sse(res: http.ServerResponse, delta: unknown, finish = 'stop') {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
}

async function listen(s: http.Server): Promise<string> {
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

function writeSettings(url: string, dataClass: 'local_only' | 'cloud_ok') {
  fs.writeFileSync(path.join(root, 'config', 'settings.json'), JSON.stringify({
    mcp: { enabled: true, servers: { review: { transport: 'http', url, personas: ['main'], users: ['1'], dataClass, connectTimeoutMs: 2000, callTimeoutMs: 2000 } } },
  }))
}

let mcpUrl = ''

beforeAll(async () => {
  llm = http.createServer(async (q, r) => {
    let b = ''
    for await (const x of q) b += x
    reqs.push({ phase, body: JSON.parse(b) })
    step++
    if (step === 1) {
      sse(r, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${phase}`, type: 'function', function: { name: 'mcp_review_private_read', arguments: JSON.stringify({ query: ARG }) } }] }, 'tool_calls')
    } else {
      sse(r, { role: 'assistant', content: phase === 'history' && step === 2 ? `Exact quote: ${BODY}` : 'done' })
    }
  })
  const llmUrl = await listen(llm)
  const base = (id: string, region: string) => ({
    id, name: id, type: 'openai-completions', providerType: 'openai-compatible', provider: 'openai', baseUrl: `${llmUrl}/v1`,
    apiKey: 'not-a-secret', enabledModels: ['fixture-model'], models: [{ id: 'fixture-model', contextWindow: 32000, maxTokens: 1000 }],
    status: 'connected', authMethod: 'api-key', dataPolicy: { region, training: 'no' },
  })
  local = base('fixture-local', 'local')
  cloud = base('fixture-cloud', 'us')
  fs.writeFileSync(path.join(root, 'config', 'providers.json'), JSON.stringify({ providers: [local, cloud] }))

  mcp = http.createServer(async (q, r) => {
    if (q.method !== 'POST') { r.writeHead(405).end(); return }
    let b = ''
    for await (const x of q) b += x
    const msg = JSON.parse(b)
    if (msg.id === undefined) { r.writeHead(202).end(); return }
    let result: unknown
    const meta = phase === 'quoted-metadata' ? QUOTED : META
    if (msg.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    else if (msg.method === 'tools/list') {
      result = { tools: [{ name: 'private_read', title: phase === 'structured-secret' ? 'read' : meta, description: phase === 'structured-secret' ? 'read' : meta,
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: phase === 'quoted-metadata' ? QUOTED : 'query' } } } }] }
    } else if (msg.method === 'tools/call') {
      calls++
      if (phase === 'midturn') runtime!.swapProvider(cloud, 'not-a-secret', 'fixture-model')
      result = phase === 'structured-secret' ? { structuredContent: { value: QUOTED, [QUOTED]: 'key' }, content: [] } : { content: [{ type: 'text', text: BODY }] }
    } else { r.writeHead(405).end(); return }
    r.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
  })
  mcpUrl = `${await listen(mcp)}/mcp`

  const [rt, database, providers, client, boundary] = await Promise.all([
    import('./agent-runtime.js'), import('./database.js'), import('./provider-config.js'), import('./mcp-client.js'), import('./secret-boundary.js'),
  ])
  mod = {
    createAgentRuntime: rt.createAgentRuntime as never,
    initDatabase: database.initDatabase as never,
    buildModel: providers.buildModel as never,
    closeSharedMcpManager: client.closeSharedMcpManager,
    invalidateKnownValues: boundary.invalidateKnownValues,
  }
  db = mod.initDatabase(':memory:')
}, 30_000)

afterAll(async () => {
  await mod?.closeSharedMcpManager()
  db?.close()
  delete process.env.MCP_REVIEW_API_KEY
  mod?.invalidateKnownValues()
  for (const s of [mcp, llm]) {
    s?.closeAllConnections()
    await new Promise<void>(r => (s ? s.close(() => r()) : r()))
  }
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await mod.closeSharedMcpManager()
  step = 0
  calls = 0
})

function make(provider: Record<string, unknown>) {
  return mod.createAgentRuntime({
    model: mod.buildModel(provider, 'fixture-model'), providerConfig: provider, apiKey: 'not-a-secret', db, tools: [],
    systemPrompt: 'Synthetic test. No real data.', getCurrentToolUserId: () => 1, memoryDir: path.join(root, 'memory'),
  })
}

async function drain(rt: NonNullable<typeof runtime>, text: string, session: string) {
  const chunks: Array<{ type?: string; error?: string }> = []
  for await (const c of rt.streamPrompt(text, session)) chunks.push(c as { type?: string; error?: string })
  return chunks
}

const of = (p: Phase) => reqs.filter(r => r.phase === p)

describe('review 2 / B: no private MCP context to a non-local model (runtime-probes.mts)', () => {
  it('history: after a switch to a cloud model the strand sends NOTHING (no tool body, no assistant quote, no args, no MCP tools)', async () => {
    phase = 'history'
    writeSettings(mcpUrl, 'local_only')
    runtime = make(local)
    await drain(runtime, 'Read the fixture', '11fc5858-0771-446d-924a-a929acecbb82')
    // The local model did get the private body (and quoted it).
    expect(of('history')).toHaveLength(2)
    expect(JSON.stringify(of('history')[1].body.messages)).toContain(BODY)
    expect(calls).toBe(1)

    runtime.swapProvider(cloud, 'not-a-secret', 'fixture-model')
    const chunks = await drain(runtime, 'Continue', '11fc5858-0771-446d-924a-a929acecbb82')
    // No request at all reached the cloud provider.
    expect(of('history')).toHaveLength(2)
    const errors = chunks.filter(c => c.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].error).toMatch(/MCP privacy gate/)
    expect(JSON.stringify(chunks)).not.toContain(BODY)
  }, 30_000)

  it('history reload: a fresh runtime on a cloud model for a strand with persisted private MCP rows sends nothing', async () => {
    phase = 'history'
    const session = '61fc5858-0771-446d-924a-a929acecbb82'
    // The chat layer (web-backend) persists tool rows; the runtime alone does
    // not. Insert the row exactly as it is stored (format of recall-probes.mts).
    db.prepare("INSERT INTO chat_messages (session_id, role, content, metadata, agent_id) VALUES (?, 'tool', 'Tool: mcp_review_private_read', ?, 'main')")
      .run(session, JSON.stringify({ toolName: 'mcp_review_private_read', toolCallId: 'c1', toolArgs: { query: ARG }, toolResult: { content: [{ type: 'text', text: BODY }], details: { mcpDataClass: 'local_only' } } }))
    const before = of('history').length
    const fresh = make(cloud)
    const chunks = await drain(fresh, 'Continue after reload', session)
    expect(of('history')).toHaveLength(before)
    expect(chunks.some(c => c.type === 'error' && /MCP privacy gate/.test(c.error ?? ''))).toBe(true)
  }, 30_000)

  it('midturn: a provider swap DURING the MCP call stops the next request (the target model is checked per request)', async () => {
    phase = 'midturn'
    writeSettings(mcpUrl, 'local_only')
    runtime = make(local)
    await drain(runtime, 'Read the fixture', '21fc5858-0771-446d-924a-a929acecbb82')
    expect(calls).toBe(1)
    // Only the first (local) request went out; the follow-up to the cloud model was refused.
    expect(of('midturn')).toHaveLength(1)
    const sent = JSON.stringify(of('midturn').slice(1))
    for (const marker of [BODY, ARG, META]) expect(sent).not.toContain(marker)
  }, 30_000)

  it('a new strand on a cloud model is not affected (no private material, local_only tools not offered)', async () => {
    phase = 'midturn'
    writeSettings(mcpUrl, 'local_only')
    const before = of('midturn').length
    step = 1 // the fake model answers with plain text
    const rt = make(cloud)
    const chunks = await drain(rt, 'Hello', '51fc5858-0771-446d-924a-a929acecbb82')
    expect(of('midturn')).toHaveLength(before + 1)
    expect(chunks.some(c => c.type === 'error')).toBe(false)
    expect((of('midturn').at(-1)!.body.tools ?? []).some(t => t.function.name.startsWith('mcp_'))).toBe(false)
  }, 30_000)
})

describe('review 2 / A: escaped known secrets never reach the model (runtime-probes.mts)', () => {
  it('a tool whose title/description/schema contain a quoted/backslashed secret is dropped', async () => {
    phase = 'quoted-metadata'
    process.env.MCP_REVIEW_API_KEY = QUOTED
    mod.invalidateKnownValues()
    writeSettings(mcpUrl, 'cloud_ok')
    step = 1 // plain answer: we only inspect the declared tools
    runtime = make(cloud)
    await drain(runtime, 'Read the fixture', '31fc5858-0771-446d-924a-a929acecbb82')
    const first = of('quoted-metadata')[0].body
    expect((first.tools ?? []).some(t => t.function.name === 'mcp_review_private_read')).toBe(false)
    const wire = JSON.stringify(of('quoted-metadata'))
    expect(wire).not.toContain(JSON.stringify(QUOTED).slice(1, -1))
    expect(wire).not.toContain('SYNTH_Quoted')
  }, 30_000)

  it('structuredContent with a quoted/backslashed secret in a value and a key is sealed before serialisation', async () => {
    phase = 'structured-secret'
    process.env.MCP_REVIEW_API_KEY = QUOTED
    mod.invalidateKnownValues()
    writeSettings(mcpUrl, 'cloud_ok')
    runtime = make(cloud)
    await drain(runtime, 'Read the fixture', '41fc5858-0771-446d-924a-a929acecbb82')
    expect(calls).toBe(1)
    const reqsHere = of('structured-secret')
    expect(reqsHere).toHaveLength(2)
    const toolMsg = reqsHere[1].body.messages.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    const wire = JSON.stringify(reqsHere)
    expect(wire).not.toContain(JSON.stringify(QUOTED).slice(1, -1))
    expect(wire).not.toContain('SYNTH_Quoted')
    expect(String(toolMsg!.content)).toContain('MCP server "review"')
  }, 30_000)
})
