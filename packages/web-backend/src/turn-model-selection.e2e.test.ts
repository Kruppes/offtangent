/** Local transport integration: real HTTP/WS, SQLite, AgentCore and TurnRunner.
 * Runtime/router completions use a loopback recorder, with test-supplied
 * resolver wiring and mocked config/memory helpers. No provider SDK,
 * credential, external network, production database or live write is used.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import express from 'express'
import { WebSocket } from 'ws'
import { AgentCore, initDatabase, resolveEffectiveModel, TurnRunner } from '@axiom/core'
import type { Database, EffectiveModel, ProviderConfig, ResolvedRouterModel, ResponseChunk } from '@axiom/core'
import type { AgentRuntimeBoundary } from '@axiom/core'
import { createCapturesRouters } from './api/modules/captures/route.js'
import { createStrandsRouters } from './api/modules/strands/route.js'
import { setupWebSocketChat } from './ws-chat.js'
import { generateAccessToken } from './auth.js'

vi.mock('../../core/src/memory.js', () => ({
  ensureMemoryStructure: vi.fn(), ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'local integration system'),
}))
vi.mock('../../core/src/config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(), loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => `${process.env.DATA_DIR}/config`),
}))

let db: Database
let core: AgentCore
let server: http.Server
let providerServer: http.Server
let wsSetup: ReturnType<typeof setupWebSocketChat>
let baseUrl: string
let providerUrl: string
let token: string
let tempDir: string
let previousDataDir: string | undefined
let nextRouterAnswer: Record<string, unknown>
const sockets: WebSocket[] = []
const requests: Array<{ lane: string; providerId: string; modelId: string; sessionId?: string }> = []
const resolved: Array<EffectiveModel & { sessionId: string }> = []
const ended: string[] = []
const payloads: EffectiveModel[] = []
const providers: Record<string, ProviderConfig> = {}

function model(id: string) {
  return { id, name: id, api: 'openai-completions' as const, provider: 'openai', baseUrl: providerUrl,
    reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10000, maxTokens: 100 }
}
async function listen(s: http.Server) {
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`
}
async function completion(input: (typeof requests)[number]) {
  const response = await fetch(`${providerUrl}/completion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(`local completion failed: ${response.status}`)
  return (await response.json() as { text: string }).text
}
function pin(id: string) {
  return db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get(id)
}
async function post(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/captures`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as {
    capture: { id: string; strandId: string }; decision: { action: string; model: string }; code?: string
  } }
}
async function waitForEnd(count: number) {
  await vi.waitFor(() => expect(ended).toHaveLength(count), { timeout: 5000, interval: 10 })
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDir = fs.mkdtempSync(`${process.cwd()}/.turn-model-e2e-`)
  process.env.DATA_DIR = tempDir
  fs.mkdirSync(`${tempDir}/config`, { recursive: true })
  const providerApp = express()
  providerApp.use(express.json())
  providerApp.post('/completion', (req, res) => {
    requests.push(req.body)
    res.json({ text: req.body.lane === 'router' ? JSON.stringify(nextRouterAnswer) : 'loopback completion' })
  })
  providerServer = http.createServer(providerApp)
  providerUrl = await listen(providerServer)
  for (const [id, models] of [['global', ['global-model']], ['chosen', ['chosen-model']], ['pinned', ['pinned-model']]] as const) {
    providers[id] = { id, name: id, type: 'openai-completions', providerType: 'openai', provider: 'openai',
      baseUrl: providerUrl, apiKey: 'local-fake-key', enabledModels: [...models] }
  }
  fs.writeFileSync(`${tempDir}/config/providers.json`, JSON.stringify({
    providers: Object.values(providers).map(provider => ({ ...provider, apiKey: '' })),
    activeProvider: 'global', activeModel: 'global-model',
  }))
  db = initDatabase(`${tempDir}/test.sqlite`)
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'local', 'x', 'admin')").run()
  let currentProvider = providers.global!
  let currentModel = model('global-model')
  let messages: unknown[] = []
  const runtime = {
    swapProvider(provider: ProviderConfig, _key: string, modelId?: string) {
      currentProvider = provider
      currentModel = model(modelId!)
    },
    getCurrentProvider: () => currentProvider, getCurrentModel: () => currentModel,
    getCurrentTimeContext: () => 'local time', refreshSystemPrompt: vi.fn(),
    getMessages: () => messages, setMessages: (next: unknown[]) => { messages = next },
    clearMessages: () => { messages = [] },
    getStateSnapshot: () => ({ modelId: currentModel.id, toolNames: [], messageCount: messages.length }),
    setProviderManager: vi.fn(), getProviderManager: () => undefined, setThinkingLevel: vi.fn(),
    async *streamPrompt(_text: string, sessionId: string): AsyncIterable<ResponseChunk> {
      const detail = await fetch(`${baseUrl}/api/strands/${sessionId}`, { headers: { Authorization: `Bearer ${token}` } })
      const body = await detail.json() as { strand: { effectiveModel: EffectiveModel } }
      payloads.push(body.strand.effectiveModel)
      const text = await completion({ lane: 'chat', providerId: currentProvider.id, modelId: currentModel.id, sessionId })
      yield { type: 'text', text }
      yield { type: 'done' }
    },
  } as unknown as AgentRuntimeBoundary
  core = new AgentCore({ db, tools: [], model: model('global-model'), apiKey: 'local-fake-key',
    memoryDir: `${tempDir}/memory`, providerConfig: providers.global, runtimeFactory: () => runtime,
    resolveTurnModel: async ({ sessionId, turnOverride }) => {
      const row = pin(sessionId) as { model_provider_id: string | null; model_id: string | null }
      const effective = resolveEffectiveModel({ turnOverride,
        strandPin: row.model_provider_id && row.model_id ? { providerId: row.model_provider_id, modelId: row.model_id } : null,
        globalActive: { providerId: 'global', modelId: 'global-model' }, providers: Object.values(providers) })!
      resolved.push({ ...effective, sessionId })
      return { provider: providers[effective.providerId]!, apiKey: 'local-fake-key', effective }
    },
  })
  // With zero candidates routing intentionally short-circuits to a synthetic
  // new_strand. Seed an unrelated candidate so the real router lane executes.
  core.getSessionManager().createThread('1', 'main', 'Unrelated seed')
  const runner = new TurnRunner({ db, getAgent: () => core })
  runner.subscribe(1, event => { if (event.type === 'turn_end') ended.push(event.sessionId) })
  const chain: ResolvedRouterModel[] = [{ spec: 'local-router:router-model', threshold: null,
    providerId: 'local-router', providerName: 'Local router', modelId: 'router-model', composite: 'local-router:router-model' }]
  const app = express()
  app.use(express.json())
  app.use('/api/captures', createCapturesRouters({ db, getAgentCore: () => core, getTurnRunner: () => runner,
    routerChain: () => chain,
    routerComplete: entry => completion({ lane: 'router', providerId: entry.providerId, modelId: entry.modelId }),
  }).captures)
  app.use('/api/strands', createStrandsRouters({ db, getAgentCore: () => core, getTurnRunner: () => runner }).strands)
  server = http.createServer(app)
  wsSetup = setupWebSocketChat(server, db, () => core, undefined, undefined, undefined, runner)
  baseUrl = await listen(server)
  token = generateAccessToken({ userId: 1, username: 'local', role: 'admin' })
})

afterAll(async () => {
  for (const ws of sockets) ws.terminate()
  if (wsSetup) await new Promise<void>(resolve => wsSetup.wss.close(() => resolve()))
  for (const s of [server, providerServer]) if (s) await new Promise<void>(resolve => s.close(() => resolve()))
  db?.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('turn model selection through local HTTP/WS and real core', () => {
  it('HTTP new_strand: selected chat model has source turn, router remains independent, new pin persists', async () => {
    const before = ended.length
    nextRouterAnswer = { action: 'new_strand', newStrand: { title: 'Local chosen strand', personaId: 'main', tags: [] },
      intent: 'ask', confidence: 0.95, tags: [], rationale: 'new topic' }
    const response = await post({ text: 'Explain this new topic?', intent: 'ask', modelProviderId: 'chosen', modelId: 'chosen-model' })
    expect(response.status).toBe(201)
    expect(response.body.decision).toMatchObject({ action: 'new_strand', model: 'local-router:router-model' })
    const id = response.body.capture.strandId
    await waitForEnd(before + 1)
    expect(resolved.at(-1)).toEqual({ sessionId: id, providerId: 'chosen', modelId: 'chosen-model', source: 'turn' })
    expect(payloads.at(-1)).toEqual({ providerId: 'chosen', modelId: 'chosen-model', source: 'turn' })
    expect(requests.slice(-2)).toEqual([
      { lane: 'router', providerId: 'local-router', modelId: 'router-model' },
      { lane: 'chat', sessionId: id, providerId: 'chosen', modelId: 'chosen-model' },
    ])
    expect(pin(id)).toEqual({ model_provider_id: 'chosen', model_id: 'chosen-model' })
    // An unselected follow-up proves the stored pin, not a leaked override, wins.
    expect((await post({ text: 'Follow up?', strandId: id, intent: 'ask' })).status).toBe(201)
    await waitForEnd(before + 2)
    expect(resolved.at(-1)).toEqual({ sessionId: id, providerId: 'chosen', modelId: 'chosen-model', source: 'strand' })
  })

  it('HTTP append: one-shot override does not mutate the existing pin; unselected turn returns to it', async () => {
    const before = ended.length
    const id = core.getSessionManager().createThread('1', 'main', 'Existing pin').id
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('pinned', 'pinned-model', id)
    nextRouterAnswer = { action: 'append', strandId: id, intent: 'ask', confidence: 0.95, tags: [], rationale: 'same topic' }
    const response = await post({ text: 'Continue this topic?', intent: 'ask', modelProviderId: 'chosen', modelId: 'chosen-model' })
    expect(response.status).toBe(201)
    expect(response.body.decision).toMatchObject({ action: 'append', model: 'local-router:router-model' })
    expect(response.body.capture.strandId).toBe(id)
    await waitForEnd(before + 1)
    expect(resolved.at(-1)).toEqual({ sessionId: id, providerId: 'chosen', modelId: 'chosen-model', source: 'turn' })
    expect(payloads.at(-1)).toEqual({ providerId: 'chosen', modelId: 'chosen-model', source: 'turn' })
    expect(requests.at(-1)).toEqual({ lane: 'chat', sessionId: id, providerId: 'chosen', modelId: 'chosen-model' })
    expect(pin(id)).toEqual({ model_provider_id: 'pinned', model_id: 'pinned-model' })
    expect((await post({ text: 'Back to pin?', strandId: id, intent: 'ask' })).status).toBe(201)
    await waitForEnd(before + 2)
    expect(resolved.at(-1)).toEqual({ sessionId: id, providerId: 'pinned', modelId: 'pinned-model', source: 'strand' })
    expect(payloads.at(-1)).toEqual({ providerId: 'pinned', modelId: 'pinned-model', source: 'strand' })
    expect(requests.at(-1)).toEqual({ lane: 'chat', sessionId: id, providerId: 'pinned', modelId: 'pinned-model' })
  })

  it('WebSocket: authenticated selected turn reaches chosen runtime; next turn restores unchanged strand pin', async () => {
    const before = ended.length
    const id = core.getSessionManager().createThread('1', 'main', 'WS existing pin').id
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('pinned', 'pinned-model', id)
    const frames: Array<{ type: string; text?: string; sessionId?: string }> = []
    const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws/chat?token=${token}`)
    sockets.push(ws)
    ws.on('message', data => frames.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'system', text: 'Authenticated' }))
    const routerCount = requests.filter(r => r.lane === 'router').length
    ws.send(JSON.stringify({ type: 'message', content: 'Use my selected model', sessionId: id,
      clientMessageId: 'ws-selected', modelProviderId: 'chosen', modelId: 'chosen-model' }))
    await waitForEnd(before + 1)
    expect(resolved.at(-1)).toEqual({ sessionId: id, providerId: 'chosen', modelId: 'chosen-model', source: 'turn' })
    expect(payloads.at(-1)).toEqual({ providerId: 'chosen', modelId: 'chosen-model', source: 'turn' })
    expect(requests.at(-1)).toEqual({ lane: 'chat', sessionId: id, providerId: 'chosen', modelId: 'chosen-model' })
    expect(pin(id)).toEqual({ model_provider_id: 'pinned', model_id: 'pinned-model' })
    ws.send(JSON.stringify({ type: 'message', content: 'Use pin again', sessionId: id, clientMessageId: 'ws-pinned' }))
    await waitForEnd(before + 2)
    expect(resolved.at(-1)).toEqual({ sessionId: id, providerId: 'pinned', modelId: 'pinned-model', source: 'strand' })
    expect(payloads.at(-1)).toEqual({ providerId: 'pinned', modelId: 'pinned-model', source: 'strand' })
    expect(requests.at(-1)).toEqual({ lane: 'chat', sessionId: id, providerId: 'pinned', modelId: 'pinned-model' })
    expect(requests.filter(r => r.lane === 'router')).toHaveLength(routerCount)
    await vi.waitFor(() => expect(frames.filter(f => f.type === 'done' && f.sessionId === id)).toHaveLength(2))
    expect(frames.filter(f => f.type === 'error')).toEqual([])
    expect(frames.filter(f => f.type === 'text' && f.sessionId === id).map(f => f.text)).toEqual(['loopback completion', 'loopback completion'])
  })
})
