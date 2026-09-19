/**
 * Wait state on the capture path (plan 2026-09-19, Fix 1 / D4 / D5).
 *
 * A capture whose answer turn is stuck behind another turn of the same persona
 * used to produce nothing at all: no frame, no field, just a card that sat
 * quiet for 20 minutes (incident 2026-09-18). These tests pin the three
 * surfaces that now carry it: the `turn` field of `POST /api/captures`, the
 * `turn_queued` event on the ChatEventBus, and `pendingTurn` on
 * `GET /api/strands/:id`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import { createStrandsRouters } from '../strands/route.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import type { ChatEvent } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let events: ChatEvent[] = []
let startedTurns: string[] = []

/** What the stubbed AgentCore reports for the NEXT turn of a persona. */
let queueState: { position: number; blockedBy: { agentId: string; sessionId: string | null } | null } = {
  position: 1,
  blockedBy: null,
}
/** What the stubbed AgentCore reports as a not-yet-started turn, per strand. */
let pendingTurns = new Map<string, { position: number; blockedBy: { agentId: string; sessionId: string | null } | null }>()

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-turn-queue-routes-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = {
    getSessionManager: () => sessionManager,
    describeQueue: (_agentId: string) => queueState,
    describePendingTurn: (_agentId: string, sessionId: string) => pendingTurns.get(sessionId) ?? null,
    getPendingMessageCount: () => 0,
  } as unknown as AgentCore
  const bus = new ChatEventBus()
  bus.subscribe(e => events.push(e))

  const app = express()
  app.use(express.json())
  const getAgentCore = () => agentCore
  const captures = createCapturesRouters({
    db,
    getAgentCore,
    chatEventBus: bus,
    getTurnRunner: () => ({
      hasActiveTurnInSession: () => false,
      startTurn: (input) => { startedTurns.push(input.sessionId); return {} },
    }),
    routerChain: () => [],
    routerComplete: async () => { throw new Error('router must not be called in these tests') },
  })
  app.use('/api/captures', captures.captures)
  const strands = createStrandsRouters({ db, getAgentCore, chatEventBus: bus })
  app.use('/api/strands', strands.strands)

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
  events = []
  startedTurns = []
  queueState = { position: 1, blockedBy: null }
  pendingTurns = new Map()
})

function post(pathname: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }))
}

function get(pathname: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return fetch(`${baseUrl}${pathname}`, { headers: { authorization: `Bearer ${token}` } })
    .then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }))
}

/** Two strands of ONE persona: the blocker and the one the capture goes to. */
function twoStrands(): { blocker: string; target: string } {
  const blocker = sessionManager.createThread('1', 'main', 'Hotfix Deploy')
  const target = sessionManager.createThread('1', 'main', 'Umzug')
  return { blocker: blocker.id, target: target.id }
}

describe('captures: queued turn visibility', () => {
  it('returns the wait state and broadcasts turn_queued when the persona is busy', async () => {
    const { blocker, target } = twoStrands()
    queueState = { position: 2, blockedBy: { agentId: 'main', sessionId: blocker } }

    const res = await post('/api/captures', { text: 'Wann fahren wir?', strandId: target, intent: 'ask' })
    expect(res.status).toBe(201)
    expect(startedTurns).toEqual([target])
    expect(res.body.turn).toEqual({
      queued: true,
      position: 2,
      blockedBy: { agentId: 'main', sessionId: blocker, title: 'Hotfix Deploy' },
    })

    const queuedEvents = events.filter(e => e.type === 'turn_queued')
    expect(queuedEvents).toHaveLength(1)
    expect(queuedEvents[0]).toMatchObject({
      userId: 1,
      sessionId: target,
      agentId: 'main',
      position: 2,
      blockedBy: { agentId: 'main', sessionId: blocker, title: 'Hotfix Deploy' },
    })
  })

  it('stays silent when the turn starts right away', async () => {
    const { target } = twoStrands()
    queueState = { position: 1, blockedBy: null }

    const res = await post('/api/captures', { text: 'Noch eine Frage?', strandId: target, intent: 'ask' })
    expect(res.status).toBe(201)
    expect(startedTurns).toEqual([target])
    expect(res.body.turn).toEqual({ queued: false, position: 1, blockedBy: null })
    expect(events.filter(e => e.type === 'turn_queued')).toEqual([])
  })

  it('reports a blocker without a title instead of failing the capture', async () => {
    const { target } = twoStrands()
    const untitled = sessionManager.createThread('1', 'main', '')
    queueState = { position: 3, blockedBy: { agentId: 'main', sessionId: untitled.id } }

    const res = await post('/api/captures', { text: 'Und noch eine?', strandId: target, intent: 'ask' })
    expect(res.body.turn).toEqual({
      queued: true,
      position: 3,
      blockedBy: { agentId: 'main', sessionId: untitled.id, title: null },
    })
  })

  it('carries no turn field when the capture is filed as a silent note', async () => {
    const { target } = twoStrands()
    queueState = { position: 2, blockedBy: { agentId: 'main', sessionId: target } }

    const res = await post('/api/captures', { text: 'Nur eine Notiz', strandId: target, intent: 'note' })
    expect(res.status).toBe(201)
    expect(startedTurns).toEqual([])
    expect(res.body.turn).toBeNull()
    expect(events.filter(e => e.type === 'turn_queued')).toEqual([])
  })
})

describe('strands: pendingTurn', () => {
  it('exposes a turn that is enqueued but not started yet', async () => {
    const { blocker, target } = twoStrands()
    pendingTurns.set(target, { position: 2, blockedBy: { agentId: 'main', sessionId: blocker } })

    const res = await get(`/api/strands/${target}`)
    expect(res.status).toBe(200)
    expect((res.body.strand as Record<string, unknown>).pendingTurn).toEqual({
      queued: true,
      position: 2,
      blockedBy: { agentId: 'main', sessionId: blocker, title: 'Hotfix Deploy' },
    })
  })

  it('is null when the strand has nothing waiting', async () => {
    const { target } = twoStrands()
    const res = await get(`/api/strands/${target}`)
    expect(res.status).toBe(200)
    expect((res.body.strand as Record<string, unknown>).pendingTurn).toBeNull()
  })
})
