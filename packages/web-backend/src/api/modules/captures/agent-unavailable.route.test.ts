/**
 * POST /api/captures while the agent core is not up yet (W7 D1).
 *
 * ADHD capture principle: a capture that reached the server is never lost.
 * The row is stored first; without a core the routing cannot run. The answer
 * has to say so honestly ("stored, routing pending") and a client retry with
 * the same `clientMessageId` must neither duplicate the capture nor fail.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, saveProviders, SessionManager } from '@axiom/core'
import type { AgentCore, Database, ResolvedRouterModel } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined
let core: AgentCore | null = null
let sessionManager: SessionManager
let nextAnswers: string[] = []

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-nocore-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const app = express()
  app.use(express.json())
  const captures = createCapturesRouters({
    db,
    getAgentCore: () => core,
    chatEventBus: new ChatEventBus(),
    getTurnRunner: () => ({ hasActiveTurnInSession: () => false, startTurn: () => ({}) }),
    routerChain: () => chain,
    getNowSetMode: () => 'manual',
    routerComplete: async () => {
      const next = nextAnswers.shift()
      if (next === undefined) throw new Error('router stub has no answer')
      return next
    },
  })
  app.use('/api/captures', captures.captures)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM captures; DELETE FROM router_decisions;')
  core = null
  nextAnswers = []
  saveProviders({
    providers: [{ id: 'chosen', name: 'Chosen', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['model'], modelStatuses: { model: 'connected' } }],
    activeProvider: 'chosen', activeModel: 'model',
  })
})

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/captures`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

const captureCount = () => (db.prepare('SELECT COUNT(*) AS n FROM captures').get() as { n: number }).n

describe('POST /api/captures without an agent core', () => {
  it.each([
    ['destination new_strand', { destination: 'new_strand' }],
    ['quick mode', { mode: 'quick' }],
  ])('%s: stores the capture and answers 202 routing_pending instead of 503', async (_label, extra) => {
    const res = await post({ text: 'A synthetic question while the core boots?', clientMessageId: `cm-nocore-${_label.replace(/\W+/g, '-')}`, ...extra })
    expect(res.status).toBe(202)
    expect(res.body.code).toBe('routing_pending')
    expect((res.body.capture as { id: string; status: string }).status).toBe('unsorted')
    expect(captureCount()).toBe(1)
  })

  it('a retry with the same clientMessageId does not duplicate the capture', async () => {
    const first = await post({ text: 'A synthetic thought, sent twice', clientMessageId: 'cm-nocore-2', destination: 'new_strand' })
    const second = await post({ text: 'A synthetic thought, sent twice', clientMessageId: 'cm-nocore-2', destination: 'new_strand' })
    expect(second.body.code).toBe('routing_pending')
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect((second.body.capture as { id: string }).id).toBe((first.body.capture as { id: string }).id)
    expect(captureCount()).toBe(1)
  })

  it('a retry after the core came up resolves to the same stored capture (200, no duplicate)', async () => {
    const first = await post({ text: 'A synthetic thought before the core was up', clientMessageId: 'cm-nocore-3', destination: 'new_strand' })
    expect(first.status).toBe(202)
    core = { getSessionManager: () => sessionManager } as unknown as AgentCore
    const retry = await post({ text: 'A synthetic thought before the core was up', clientMessageId: 'cm-nocore-3', destination: 'new_strand' })
    expect(retry.status).toBe(200)
    expect(retry.body.code).toBeUndefined()
    expect((retry.body.capture as { id: string }).id).toBe((first.body.capture as { id: string }).id)
    // Parked in the tray with its proposal: apply/dismiss still work on it.
    expect((retry.body.decision as { state: string }).state).toBe('proposed')
    expect(captureCount()).toBe(1)
  })

  it('the router path parks a confident filing and also answers 202', async () => {
    // A strand to file into exists, so the router runs and answers confidently.
    core = { getSessionManager: () => sessionManager } as unknown as AgentCore
    const strand = sessionManager.createThread('1', 'main', 'Synthetic strand')
    core = null
    nextAnswers.push(JSON.stringify({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.95, tags: [], rationale: 'synthetic' }))
    const res = await post({ text: 'A synthetic note for the synthetic strand', clientMessageId: 'cm-nocore-4' })
    expect(res.status).toBe(202)
    expect(res.body.code).toBe('routing_pending')
    expect((res.body.capture as { status: string }).status).toBe('unsorted')
    expect(captureCount()).toBe(1)
  })
})
