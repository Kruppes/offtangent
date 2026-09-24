/**
 * Filing a capture with `offtangent.nowSetMode = 'auto'`: the `now_set` table
 * stays empty (the set is computed), and `now_set_changed` is only broadcast
 * when the computed id list actually changed.
 *
 * Fails against the pre-auto service, which called `addToNowSetIfRoom` on
 * every filing and broadcast whatever the table then held.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, saveProviders, SessionManager } from '@axiom/core'
import type { AgentCore, Database, NowSetMode, ResolvedRouterModel } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import { generateAccessToken } from '../../../auth.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import type { ChatEvent } from '../../../chat-event-bus.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let mode: NowSetMode = 'auto'
let events: ChatEvent[] = []
let nextAnswers: string[] = []

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-now-auto-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  const bus = new ChatEventBus()
  bus.subscribe(e => events.push(e))

  const app = express()
  app.use(express.json())
  const captures = createCapturesRouters({
    db,
    getAgentCore: () => agentCore,
    chatEventBus: bus,
    getTurnRunner: () => ({ hasActiveTurnInSession: () => false, startTurn: () => ({}) }),
    getNowSetMax: () => 3,
    getNowSetMode: () => mode,
    routerChain: () => chain,
    routerComplete: async () => {
      const next = nextAnswers.shift()
      if (next === undefined) throw new Error('router stub has no answer')
      return next
    },
  })
  app.use('/api/captures', captures.captures)

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM captures; DELETE FROM router_decisions; DELETE FROM strand_tags; DELETE FROM strand_links; DELETE FROM now_set; DELETE FROM sessions;')
  events = []
  nextAnswers = []
  mode = 'auto'
  saveProviders({
    providers: [{ id: 'chosen', name: 'Chosen', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['model'], modelStatuses: { model: 'connected' } }],
    activeProvider: 'chosen', activeModel: 'model',
  })
})

function answer(obj: Record<string, unknown>): void {
  nextAnswers.push(JSON.stringify(obj))
}

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

function nowSetChanges(): string[][] {
  return events.filter(e => e.type === 'now_set_changed').map(e => (e as { strandIds: string[] }).strandIds)
}

describe('capture filing with an automatic now set', () => {
  it('never writes now_set and broadcasts the computed list once', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Haus Dach')
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.82, tags: [] })

    const res = await api('POST', '/api/captures', { text: 'roofer called back' })
    expect(res.status).toBe(201)
    expect(db.prepare('SELECT count(*) c FROM now_set').get()).toEqual({ c: 0 })
    expect(nowSetChanges()).toEqual([[strand.id]])
  })

  it('stays silent when the filing does not change the computed list', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Haus Dach')
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.82, tags: [] })
    await api('POST', '/api/captures', { text: 'first' })
    events = []

    // Second note, same strand, same day: the ranking is unchanged.
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.82, tags: [] })
    await api('POST', '/api/captures', { text: 'second' })
    expect(nowSetChanges()).toEqual([])
    expect(db.prepare('SELECT count(*) c FROM now_set').get()).toEqual({ c: 0 })
  })

  it('manual mode still pulls the strand into the table', async () => {
    mode = 'manual'
    const strand = sessionManager.createThread('1', 'main', 'Haus Dach')
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.82, tags: [] })

    await api('POST', '/api/captures', { text: 'roofer called back' })
    expect(db.prepare('SELECT strand_id FROM now_set').all()).toEqual([{ strand_id: strand.id }])
    expect(nowSetChanges()).toEqual([[strand.id]])
  })
})
