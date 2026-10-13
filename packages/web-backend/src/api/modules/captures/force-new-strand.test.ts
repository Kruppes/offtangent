/**
 * `forceNewStrand: true` — the home toggle "New strand (skip router)" on web
 * and Android.
 *
 * What is proven here:
 *   - the router is never called, even when an existing strand matches the
 *     text, and the capture is filed into a strand created for it
 *   - the decision row records the bypass for what it was: model
 *     `explicit-new-strand` plus its own rationale
 *     (`FORCED_NEW_STRAND_RATIONALE`), distinguishable from a news handoff
 *   - the strand title follows the normal derivation (first line of the text)
 *   - a voice capture honours the flag the same way
 *   - the flag outranks the quick mode, which would otherwise continue its own
 *     recent strand
 *   - `forceNewStrand` plus `strandId` and a non-boolean flag are refused
 *   - `forceNewStrand: false` leaves the capture on the router path
 *   - the flag outranks the filler guard: a "Danke dir!" with the toggle set
 *     opens a new strand, without the toggle it is still dismissed unrouted
 *   - the flag does NOT outrank the silence guard: a bare "Danke!" is a known
 *     Whisper silence artefact, and an empty recording never creates a strand
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager, FILLER_GUARD_MARKER } from '@axiom/core'
import type { AgentCore, Capture, Database, Decision, ResolvedRouterModel } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import { FORCED_NEW_STRAND_RATIONALE, NEW_STRAND_RATIONALE } from './service.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let turns: Array<{ sessionId: string; text: string }> = []
let routerCalls = 0

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-forcenew-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  const app = express()
  app.use(express.json())
  const captures = createCapturesRouters({
    db,
    getAgentCore: () => agentCore,
    chatEventBus: new ChatEventBus(),
    getTurnRunner: () => ({
      startTurn: (input) => {
        turns.push({ sessionId: input.sessionId, text: input.text })
        return {}
      },
    }),
    routerChain: () => chain,
    // The router, when it is asked at all, always wants to append to the
    // newest strand — the exact mistake the forced destination prevents.
    routerComplete: async () => {
      routerCalls += 1
      const newest = db.prepare('SELECT id FROM sessions ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined
      const proposal = newest
        ? { action: 'append', strandId: newest.id, intent: 'ask', confidence: 0.95, tags: [], rationale: 'stub appends', alternatives: [] }
        : { action: 'new_strand', newStrand: { title: 'Router strand', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.95, tags: [], rationale: 'stub opens', alternatives: [] }
      return JSON.stringify(proposal)
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
  turns = []
  routerCalls = 0
})

async function api(method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

async function force(text: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown>; capture: Capture; decision: Decision }> {
  const res = await api('POST', '/api/captures', { text, source: 'web', forceNewStrand: true, ...extra })
  return { status: res.status, body: res.body, capture: res.body.capture as Capture, decision: res.body.decision as Decision }
}

describe('POST /api/captures with forceNewStrand', () => {
  it('skips the router, opens a new strand and records the bypass in router_decisions', async () => {
    const existing = sessionManager.createThread('1', 'main', 'Winter tyres')
    const res = await force('Winter tyres\n\nWhich size fits the estate car?')

    expect(res.status).toBe(201)
    expect(routerCalls).toBe(0)
    expect(res.capture.status).toBe('filed')
    expect(res.capture.strandId).toBeTruthy()
    expect(res.capture.strandId).not.toBe(existing.id)
    expect(res.decision.action).toBe('new_strand')
    expect(res.decision.intent).toBe('ask')
    expect(res.decision.state).toBe('applied')

    const row = db.prepare('SELECT model, rationale, created_strand_id, state FROM router_decisions WHERE capture_id = ?')
      .get(res.capture.id) as { model: string; rationale: string; created_strand_id: string | null; state: string }
    expect(row.model).toBe('explicit-new-strand')
    expect(row.rationale).toBe(FORCED_NEW_STRAND_RATIONALE)
    expect(row.rationale).not.toBe(NEW_STRAND_RATIONALE)
    expect(row.created_strand_id).toBe(res.capture.strandId)
    expect(row.state).toBe('applied')

    const strand = db.prepare('SELECT title FROM sessions WHERE id = ?').get(res.capture.strandId!) as { title: string }
    expect(strand.title).toBe('Winter tyres')

    expect(turns).toHaveLength(1)
    expect(turns[0]!.sessionId).toBe(res.capture.strandId)
  })

  it('opens a fresh strand for every forced capture', async () => {
    const first = await force('Same thought twice')
    const second = await force('Same thought twice')

    expect(second.capture.strandId).not.toBe(first.capture.strandId)
    expect(routerCalls).toBe(0)
  })

  it('honours the flag for a voice capture from the home screen', async () => {
    sessionManager.createThread('1', 'main', 'Garden')
    const res = await force('Remind me what we planned for the garden hedge', { kind: 'voice', source: 'android' })

    expect(res.status).toBe(201)
    expect(routerCalls).toBe(0)
    expect(res.capture.kind).toBe('voice')
    expect(res.decision.action).toBe('new_strand')
    const row = db.prepare('SELECT rationale FROM router_decisions WHERE capture_id = ?').get(res.capture.id) as { rationale: string }
    expect(row.rationale).toBe(FORCED_NEW_STRAND_RATIONALE)
  })

  it('outranks the quick mode, which would continue its own recent strand', async () => {
    const first = await api('POST', '/api/captures', { text: 'What is the capital of Peru?', source: 'web', mode: 'quick' })
    expect(first.status).toBe(201)
    const quickStrand = (first.body.capture as Capture).strandId

    const res = await force('And what is the capital of Chile?', { mode: 'quick' })

    expect(res.status).toBe(201)
    expect(res.capture.strandId).toBeTruthy()
    expect(res.capture.strandId).not.toBe(quickStrand)
    const row = db.prepare('SELECT model, rationale FROM router_decisions WHERE capture_id = ?').get(res.capture.id) as { model: string; rationale: string }
    expect(row.model).toBe('explicit-new-strand')
    expect(row.rationale).toBe(FORCED_NEW_STRAND_RATIONALE)
  })

  it('outranks the filler guard: "Danke dir!" with the toggle opens a new strand', async () => {
    const existing = sessionManager.createThread('1', 'main', 'Some strand')
    const res = await force('Danke dir!')

    expect(res.status).toBe(201)
    expect(routerCalls).toBe(0)
    expect(res.capture.status).toBe('filed')
    expect(res.capture.strandId).toBeTruthy()
    expect(res.capture.strandId).not.toBe(existing.id)
    expect(res.decision.action).toBe('new_strand')
    const row = db.prepare('SELECT model, rationale FROM router_decisions WHERE capture_id = ?').get(res.capture.id) as { model: string; rationale: string }
    expect(row.model).toBe('explicit-new-strand')
    expect(row.rationale).toBe(FORCED_NEW_STRAND_RATIONALE)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.sessionId).toBe(res.capture.strandId)
  })

  it('still dismisses "Danke dir!" without the toggle, unrouted', async () => {
    sessionManager.createThread('1', 'main', 'Some strand')
    const res = await api('POST', '/api/captures', { text: 'Danke dir!', source: 'web' })

    expect(res.status).toBe(201)
    expect(routerCalls).toBe(0)
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(capture.status).toBe('dismissed')
    expect(capture.strandId ?? null).toBeNull()
    expect(decision.model).toBe('filler-guard')
    expect(decision.rationale).toBe(FILLER_GUARD_MARKER)
    expect(turns).toHaveLength(0)
  })

  it('stays behind the silence guard: a bare "Danke!" artefact opens no strand', async () => {
    const res = await force('Danke!')

    expect(res.status).toBe(201)
    expect(routerCalls).toBe(0)
    expect(res.capture.status).toBe('dismissed')
    expect(res.capture.strandId ?? null).toBeNull()
    expect(res.decision.model).toBe('silence-guard')
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).toEqual({ n: 0 })
    expect(turns).toHaveLength(0)
  })

  it('refuses forceNewStrand together with a named strand', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Existing strand')
    const res = await force('Question', { strandId: strand.id })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_destination')
    expect(db.prepare('SELECT COUNT(*) AS n FROM captures').get() as { n: number }).toEqual({ n: 0 })
  })

  it('refuses a non-boolean flag', async () => {
    const res = await api('POST', '/api/captures', { text: 'Question', source: 'web', forceNewStrand: 'yes' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_destination')
  })

  it('leaves forceNewStrand: false on the router path', async () => {
    sessionManager.createThread('1', 'main', 'Some strand')
    const res = await api('POST', '/api/captures', { text: 'A normal thought for the router', source: 'web', forceNewStrand: false })

    expect(res.status).toBe(201)
    expect(routerCalls).toBe(1)
    const decision = res.body.decision as Decision
    expect(decision.model).not.toBe('explicit-new-strand')
    expect(decision.rationale ?? '').not.toContain(FORCED_NEW_STRAND_RATIONALE)
  })
})
