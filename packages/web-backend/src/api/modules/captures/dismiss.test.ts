/**
 * Throwing a tray card away (SPEC 4.3), and the guard that keeps most of them
 * from ever appearing.
 *
 * The incident, in the product owner's words: "Es werden noch eine Handvoll
 * Unsorted Strands dargestellt. Keine Ahnung, wo die herkommen. Ich habe aber
 * keine Möglichkeit, die zu quittieren oder zu löschen. Die sind da einfach
 * für immer." Seven of the ten cards read `* Musik *` — Whisper's answer to a
 * microphone that recorded nothing — and the app's only button ("keep
 * unsorted") wrote nothing at all.
 *
 * What is proven here:
 *   - a tray card can be discarded, and then it is in no list any more
 *   - `?status=dismissed` still finds it: discarded is not deleted
 *   - undo brings it back with its proposal usable again
 *   - a filed capture cannot be discarded (409), the tray is the only source
 *   - discarding twice is a 200, not a 409 (double tap, offline retry)
 *   - a silent voice capture never reaches the router and never reaches the tray
 *   - the guard ignores `kind`, because the app posts dictation as text
 *   - spoken words ABOUT music are not silence
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager, SILENCE_GUARD_MARKER } from '@axiom/core'
import type { AgentCore, Capture, Database, Decision, ResolvedRouterModel } from '@axiom/core'
import { createCapturesRouters } from './route.js'
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
let turns: string[] = []
let nextAnswers: string[] = []
let calls = 0

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-dismiss-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })
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
    getTurnRunner: () => ({ startTurn: (input) => { turns.push(input.sessionId); return {} } }),
    routerChain: () => chain,
    routerComplete: async () => {
      calls += 1
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
  nextAnswers = []
  calls = 0
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

function answer(obj: Record<string, unknown>): void {
  nextAnswers.push(JSON.stringify(obj))
}

/**
 * A capture the router could not place: the card that waits in the tray.
 *
 * The candidate strand is not decoration. Without a strand that has substance
 * the router short-circuits to its synthetic 0.5 proposal and never asks the
 * model, which lands the capture in `needs_review` instead of the tray.
 */
async function trayCard(text = 'Maybe we should look at that thing again'): Promise<Capture> {
  sessionManager.createThread('1', 'main', 'Irgendein anderes Thema')
  answer({ action: 'new_strand', newStrand: { title: 'Something', personaId: 'bob', tags: [] }, intent: 'note', confidence: 0.2, rationale: 'no idea' })
  const res = await api('POST', '/api/captures', { text })
  const capture = res.body.capture as Capture
  expect(capture.status).toBe('unsorted')
  return capture
}

async function list(status: string): Promise<Capture[]> {
  return (await api('GET', `/api/captures?status=${status}`)).body.captures as Capture[]
}

describe('POST /api/captures/:id/dismiss', () => {
  it('takes the card out of every list but keeps it findable', async () => {
    const capture = await trayCard()
    events = []

    const res = await api('POST', `/api/captures/${capture.id}/dismiss`)
    expect(res.status).toBe(200)
    expect((res.body.capture as Capture).status).toBe('dismissed')

    // Gone from the tray, gone from `all` — which is what the app reads.
    expect(await list('unsorted')).toEqual([])
    expect((await list('all')).map(c => c.id)).toEqual([])
    // But not deleted: asked for by name it is still there, with its text.
    const dismissed = await list('dismissed')
    expect(dismissed.map(c => c.id)).toEqual([capture.id])
    expect(dismissed[0].text).toBe('Maybe we should look at that thing again')
    // The proposal is resolved, so nothing can be applied behind the user's back.
    expect((res.body.decision as Decision).state).toBe('superseded')
    // The clients hear about it on the socket, so an open app loses the card
    // without a refresh.
    expect(events.some(e => e.type === 'capture_routed')).toBe(true)
  })

  it('is idempotent: a second discard is a 200 with the same state', async () => {
    const capture = await trayCard()
    expect((await api('POST', `/api/captures/${capture.id}/dismiss`)).status).toBe(200)
    const again = await api('POST', `/api/captures/${capture.id}/dismiss`)
    expect(again.status).toBe(200)
    expect((again.body.capture as Capture).status).toBe('dismissed')
    expect((await list('dismissed')).length).toBe(1)
  })

  it('refuses a capture that is not in the tray', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Haus Dach')
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.9, tags: [], rationale: 'fits' })
    const filed = (await api('POST', '/api/captures', { text: 'the roofer called back' })).body.capture as Capture
    expect(filed.status).toBe('filed')

    const res = await api('POST', `/api/captures/${filed.id}/dismiss`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('not_in_tray')
    expect((await list('all')).map(c => c.id)).toEqual([filed.id])
  })

  it('404s an unknown capture', async () => {
    expect((await api('POST', '/api/captures/nope/dismiss')).status).toBe(404)
  })

  it('brings the card back on undo, proposal intact', async () => {
    const capture = await trayCard()
    await api('POST', `/api/captures/${capture.id}/dismiss`)

    const undone = await api('POST', `/api/captures/${capture.id}/undo`, {})
    expect(undone.status).toBe(200)
    expect((undone.body.capture as Capture).status).toBe('unsorted')
    // Proposed again, and with no resolution timestamp: the card offers its
    // choices exactly like before the discard.
    const decision = undone.body.decision as Decision
    expect(decision.state).toBe('proposed')
    expect(decision.resolvedAt).toBeNull()
    expect((await list('unsorted')).map(c => c.id)).toEqual([capture.id])
    expect(await list('dismissed')).toEqual([])

    // And it can still be filed normally afterwards.
    const filed = await api('POST', `/api/captures/${capture.id}/apply`, {})
    expect(filed.status).toBe(200)
    expect((filed.body.capture as Capture).status).toBe('filed')
  })
})

describe('silence guard', () => {
  it('parks a silent voice capture without calling the router', async () => {
    const res = await api('POST', '/api/captures', { text: '* Musik *', kind: 'voice', source: 'puck' })
    expect(res.status).toBe(201)
    const capture = res.body.capture as Capture
    expect(capture.status).toBe('dismissed')
    expect(calls).toBe(0)
    expect(turns).toEqual([])
    expect(await list('unsorted')).toEqual([])
    expect((await list('all'))).toEqual([])
    // The reason is on the record, not swallowed.
    expect((res.body.decision as Decision).rationale).toBe(SILENCE_GUARD_MARKER)
    expect((await list('dismissed')).map(c => c.text)).toEqual(['* Musik *'])
  })

  it('does not run on a silent capture aimed at a chosen strand either', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Haus Dach')
    const res = await api('POST', '/api/captures', { text: 'Thank you.', kind: 'voice', strandId: strand.id })
    expect((res.body.capture as Capture).status).toBe('dismissed')
    expect(turns).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(strand.id)).toEqual({ c: 0 })
  })

  it('catches a transcript the client posted as text, because the app does', async () => {
    // Measured, not assumed: every Android capture in the live database is
    // `kind: 'text'`, including two of the twelve `* Musik *` cards. A guard
    // that trusted `kind` would have left exactly those in the tray.
    const res = await api('POST', '/api/captures', { text: '* Musik *', kind: 'text', source: 'android' })
    expect(res.body.capture).toMatchObject({ status: 'dismissed' })
    expect(await list('unsorted')).toEqual([])
  })

  it('stays out of the way of speech about music', async () => {
    sessionManager.createThread('1', 'main', 'Irgendein anderes Thema')
    // Spoken, but actual words.
    answer({ action: 'new_strand', newStrand: { title: 'Film', personaId: 'bob', tags: [] }, intent: 'note', confidence: 0.8, rationale: 'note' })
    const spoken = await api('POST', '/api/captures', { text: 'Musik aufnehmen für den Film', kind: 'voice' })
    expect((spoken.body.capture as Capture).status).toBe('filed')
    // The router saw it: the guard did not swallow the capture.
    expect(calls).toBe(1)
  })

  it('answers a retried clientMessageId with the same dismissed capture', async () => {
    const first = await api('POST', '/api/captures', { text: '[Applaus]', kind: 'voice', clientMessageId: 'retry-1' })
    const second = await api('POST', '/api/captures', { text: '[Applaus]', kind: 'voice', clientMessageId: 'retry-1' })
    expect(second.status).toBe(200)
    expect((second.body.capture as Capture).id).toBe((first.body.capture as Capture).id)
    expect((await list('dismissed')).length).toBe(1)
  })
})
