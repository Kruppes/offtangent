/**
 * Review 3 (REVIEW-5c5d90a7.md) / P1-1, over the wire: the privacy gate must
 * judge the model the SDK loop ACTUALLY sends a request to. The pi-agent loop
 * keeps the model snapshot of its start, so a swapProvider in the middle of a
 * turn does not move the running loop. Two real loopback "model servers"
 * (one classified cloud, one strictly local) record every request body.
 * Port of the earlier request target probe script, both directions.
 * {{secret:url-password-10}} data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-target-test-'))
process.env.DATA_DIR = root
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
fs.mkdirSync(path.join(root, 'config'), { recursive: true })

const MARKER = 'SYNTH_PRIVATE_RECALLED_839171'

type Region = 'cloud' | 'local'
const reqs: Array<{ region: Region; body: unknown }> = []
const steps: Record<Region, number> = { cloud: 0, local: 0 }
const servers: Partial<Record<Region, { s: http.Server; url: string }>> = {}
const providers: Partial<Record<Region, Record<string, unknown>>> = {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any
let db: import('better-sqlite3').Database

function sse(res: http.ServerResponse, delta: unknown, finish: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
}

function provider(region: Region) {
  return {
    id: `fixture-${region}`, name: `Fixture ${region}`, type: 'openai-completions', providerType: 'openai-compatible', provider: 'openai',
    baseUrl: `${servers[region]!.url}/v1`, apiKey: '{{secret:url-password-10}}-test-key', enabledModels: ['fixture-model'],
    models: [{ id: 'fixture-model', contextWindow: 32000, maxTokens: 1000 }], status: 'connected', authMethod: 'api-key',
    dataPolicy: { region: region === 'local' ? 'local' : 'us', training: 'no' },
  }
}

beforeAll(async () => {
  for (const region of ['cloud', 'local'] as const) {
    const s = http.createServer(async (q, r) => {
      let b = ''
      for await (const x of q) b += x
      reqs.push({ region, body: JSON.parse(b) })
      steps[region]++
      // The first request a server sees asks for the switch tool; later ones answer.
      if (steps[region] === 1) sse(r, { role: 'assistant', tool_calls: [{ index: 0, id: 'switch-call', type: 'function', function: { name: 'switch_then_recall', arguments: '{}' } }] }, 'tool_calls')
      else sse(r, { role: 'assistant', content: 'done' }, 'stop')
    })
    await new Promise<void>(res => s.listen(0, '127.0.0.1', res))
    servers[region] = { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }
  }
  providers.cloud = provider('cloud')
  providers.local = provider('local')
  fs.writeFileSync(path.join(root, 'config', 'providers.json'), JSON.stringify({ providers: [providers.cloud, providers.local] }))
  fs.writeFileSync(path.join(root, 'config', 'settings.json'), JSON.stringify({ mcp: { enabled: false } }))
  mod = {
    ...(await import('./agent-runtime.js')),
    ...(await import('./database.js')),
    ...(await import('./provider-config.js')),
    ...(await import('./recall-message-tool.js')),
    ...(await import('./mcp-client.js')),
  }
  db = mod.initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'fixture', 'none')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('private-source', 1, 'main'), ('clean-target', 1, 'main')").run()
})

afterAll(async () => {
  await mod?.closeSharedMcpManager?.()
  db?.close()
  for (const v of Object.values(servers)) { v!.s.closeAllConnections(); await new Promise<void>(r => v!.s.close(() => r())) }
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => { reqs.length = 0; steps.cloud = 0; steps.local = 0 })

async function runSwitch(from: Region, to: Region) {
  const row = db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES ('private-source', 1, 'tool', 'Tool: mcp_fixture_read', ?, 'main')")
    .run(JSON.stringify({ toolName: 'mcp_fixture_read', toolCallId: 'source-call', toolArgs: {}, toolResult: { content: [{ type: 'text', text: MARKER }], details: { mcpDataClass: 'local_only' } } }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const holder: { rt?: any } = {}
  const recall = mod.createRecallMessageTool({
    db, getCurrentUserId: () => 1, getCurrentAgentId: () => 'main', getCurrentSessionId: () => 'clean-target',
    allowPrivateMcp: () => holder.rt.getCurrentProvider().id === providers.local!.id,
  })
  const tools = [{
    name: 'switch_then_recall', label: 'switch', description: 'Synthetic timing seam.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      holder.rt.swapProvider(providers[to], '{{secret:url-password-10}}-test-key', 'fixture-model')
      return recall.execute('recall', { message_id: Number(row.lastInsertRowid) })
    },
  }]
  const rt = holder.rt = mod.createAgentRuntime({
    model: mod.buildModel(providers[from], 'fixture-model'), providerConfig: providers[from], apiKey: '{{secret:url-password-10}}-test-key',
    db, tools, systemPrompt: 'Synthetic', getCurrentToolUserId: () => 1, memoryDir: path.join(root, 'memory'),
  })
  const chunks: Array<{ type?: string }> = []
  for await (const c of rt.streamPrompt('Run switch_then_recall.', 'clean-target')) chunks.push(c as { type?: string })
  return { chunks, current: rt.getCurrentProvider().id as string }
}

const withMarker = (region: Region) => reqs.filter(r => r.region === region && JSON.stringify(r.body).includes(MARKER)).length

describe('MCP privacy gate on the actual request target (review 3 / P1-1)', () => {
  it('cloud -> local swap mid-turn: the running loop never sends the recalled private data to the old cloud endpoint', async () => {
    const { chunks, current } = await runSwitch('cloud', 'local')
    expect(current).toBe('fixture-local')
    // The first request went to cloud (clean). The follow-up request of the
    // running loop still targets the cloud snapshot and must be refused.
    expect(reqs[0]?.region).toBe('cloud')
    expect(withMarker('cloud')).toBe(0)
    expect(reqs.filter(r => r.region === 'cloud').length).toBe(1)
    expect(chunks.some(c => c.type === 'error')).toBe(true)
  })

  it('local -> cloud swap mid-turn: nothing private reaches the cloud endpoint either', async () => {
    const { current } = await runSwitch('local', 'cloud')
    expect(current).toBe('fixture-cloud')
    expect(reqs[0]?.region).toBe('local')
    expect(withMarker('cloud')).toBe(0)
    expect(reqs.filter(r => r.region === 'cloud').length).toBe(0)
  })

  it('no swap, strictly local target: the recalled private data still reaches the local model', async () => {
    const { chunks } = await runSwitch('local', 'local')
    expect(reqs.every(r => r.region === 'local')).toBe(true)
    expect(withMarker('local')).toBe(1)
    expect(chunks.some(c => c.type === 'error')).toBe(false)
  })
})
