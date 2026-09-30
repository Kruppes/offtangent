/**
 * A router-chosen strand that is busy must never swallow a capture.
 *
 * Incident class: a phone capture without a strand was routed (append, high
 * band) into the strand whose long turn was still running. `file()` refused
 * with `strand_busy`, and the capture stayed `pending` with a `proposed`
 * decision: no message, no strand, no turn, no tray card. Three questions in a
 * row went nowhere.
 *
 * What is proven here:
 *   - a ROUTER append into a busy strand is filed and its answer is queued
 *     behind the running turn (the same queue a chat message typed into that
 *     strand waits in), and the decision says so
 *   - a strand the USER named keeps its `409 strand_busy` without writes
 *   - a filing that fails after routing for any other reason leaves the
 *     capture in the tray (`unsorted`, decision `proposed`, a routed frame),
 *     never `pending`
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Capture, Database, Decision, ResolvedRouterModel } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import { BUSY_STRAND_QUEUED_MARKER } from './service.js'
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
let turns: Array<{ sessionId: string; text: string }> = []
let busySessions: string[] = []
let nextAnswers: string[] = []
/** Runs inside the router call, i.e. between routing and filing. */
let duringRouting: (() => void) | null = null

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-busy-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })

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
    getTurnRunner: () => ({
      hasActiveTurnInSession: (_user, id) => busySessions.includes(id),
      startTurn: (input) => { turns.push({ sessionId: input.sessionId, text: input.text }); return {} },
    }),
    routerChain: () => chain,
    getNowSetMode: () => 'manual',
    routerComplete: async () => {
      duringRouting?.()
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
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM captures; DELETE FROM router_decisions; DELETE FROM tags; DELETE FROM strand_tags; DELETE FROM strand_links; DELETE FROM now_set;')
  events = []
  turns = []
  busySessions = []
  nextAnswers = []
  duringRouting = null
})

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

function answer(obj: Record<string, unknown>): void {
  nextAnswers.push(JSON.stringify(obj))
}

function userRowsIn(strandId: string): Array<{ content: string; capture_id: string | null }> {
  return db.prepare("SELECT content, capture_id FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id").all(strandId) as never
}

function storedCapture(id: string): { status: string; strand_id: string | null; message_id: number | null } {
  return db.prepare('SELECT status, strand_id, message_id FROM captures WHERE id = ?').get(id) as never
}

function storedDecisions(captureId: string): Array<{ state: string; rationale: string | null }> {
  return db.prepare('SELECT state, rationale FROM router_decisions WHERE capture_id = ? ORDER BY rowid').all(captureId) as never
}

describe('router append into a strand with a running turn', () => {
  it('files the capture and queues its answer behind the running turn', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Garden watering plan')
    busySessions.push(strand.id)
    answer({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.86, tags: [], rationale: 'follow-up on the watering plan' })

    const res = await post('/api/captures', { text: 'And how often should the hedge get water in autumn?', source: 'android', clientMessageId: 'busy-1' })

    expect(res.status).toBe(201)
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(capture.status).toBe('filed')
    expect(capture.strandId).toBe(strand.id)
    expect(capture.messageId).not.toBeNull()
    expect(decision.state).toBe('applied')
    expect(decision.rationale).toContain(BUSY_STRAND_QUEUED_MARKER)
    expect(storedCapture(capture.id)).toMatchObject({ status: 'filed', strand_id: strand.id })
    expect(userRowsIn(strand.id)).toEqual([{ content: 'And how often should the hedge get water in autumn?', capture_id: capture.id }])
    expect(turns.map(t => t.sessionId)).toEqual([strand.id])
    expect(events.some(e => e.type === 'capture_routed')).toBe(true)
  })

  it('files a note into a busy strand without starting a turn', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Garden watering plan')
    busySessions.push(strand.id)
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.9, tags: [], rationale: 'watering detail' })

    const res = await post('/api/captures', { text: 'hedge along the fence was dry again today', source: 'android' })

    expect(res.status).toBe(201)
    const capture = res.body.capture as Capture
    expect(capture.status).toBe('filed')
    expect(capture.strandId).toBe(strand.id)
    expect(turns).toEqual([])
  })

  it('leaves a strand the user named at 409 strand_busy, without writes', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Garden watering plan')
    busySessions.push(strand.id)

    const res = await post('/api/captures', { text: 'one more question', strandId: strand.id, intent: 'ask' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('strand_busy')
    expect(db.prepare('SELECT COUNT(*) AS n FROM captures').get()).toEqual({ n: 0 })
    expect(turns).toEqual([])
  })
})

describe('a filing that fails after routing', () => {
  it('puts the capture into the tray instead of leaving it pending', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Garden watering plan')
    answer({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.8, tags: [], rationale: 'watering' })
    // The target disappears between routing and filing (archived on another device).
    duringRouting = () => { db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(strand.id) }

    const res = await post('/api/captures', { text: 'Should the hedge get more water?', source: 'android' })

    expect(res.status).toBe(201)
    const capture = res.body.capture as Capture
    expect(capture.status).toBe('unsorted')
    expect(capture.strandId).toBeNull()
    expect(storedCapture(capture.id)).toEqual({ status: 'unsorted', strand_id: null, message_id: null })
    expect(storedDecisions(capture.id).map(d => d.state)).toEqual(['proposed'])
    expect(userRowsIn(strand.id)).toEqual([])
    expect(turns).toEqual([])
    const routed = events.filter(e => e.type === 'capture_routed')
    expect(routed).toHaveLength(1)
    expect((routed[0] as { capture?: Capture }).capture?.status).toBe('unsorted')
  })
})
