/**
 * The three router guards over the real HTTP path (SPEC 4.1, 4.2, 4.3).
 *
 * Every case here is a row in the live database of 18 September:
 *   - capture b008c981 (`source: 'bench'`) named a strand the product owner
 *     was using and got a decision that claimed "Strand chosen by the user"
 *   - capture ffd77c2b ("Vielen Dank.", voice) was appended to an unrelated
 *     strand with confidence 0.87
 *   - six consecutive Puck captures in one night opened six strands, because
 *     each one was routed without knowing the one a minute earlier existed
 *
 * What is proven:
 *   - a programmatic source cannot name a strand it did not create (400)
 *   - a user surface still can, with its rationale unchanged
 *   - a programmatic source may write into its own strand, and the decision
 *     says who chose (`explicit-client`), never "the user"
 *   - pure courtesy never reaches the router and opens no strand
 *   - the second capture of a device gets the first one's strand as a hint,
 *     as a candidate and as a prompt field, and the model may still say no
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager, EXPLICIT_TARGET_FORBIDDEN, FILLER_GUARD_MARKER } from '@axiom/core'
import type { AgentCore, Capture, Database, Decision, ResolvedRouterModel } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let nextAnswers: string[] = []
let prompts: string[] = []
let calls = 0

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-guards-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })
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
    getTurnRunner: () => ({ startTurn: () => ({}) }),
    routerChain: () => chain,
    routerComplete: async (_entry, prompt) => {
      calls += 1
      prompts.push(prompt)
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
  nextAnswers = []
  prompts = []
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
 * A new strand the router opens for `text`, returned with its id. The router
 * is only asked when there is something to choose from: with an empty database
 * `runRouter` short circuits into its synthetic `new_strand`, so queueing an
 * answer there would leave it in the queue and derail the next call.
 */
async function openStrand(text: string, source: string, title = 'Device talk'): Promise<string> {
  const strands = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
  if (strands.n > 0) {
    answer({
      action: 'new_strand', strandId: null, newStrand: { title, personaId: 'main', tags: ['t'] },
      intent: 'note', confidence: 0.9, tags: ['t'], rationale: 'new', alternatives: [],
    })
  }
  const res = await api('POST', '/api/captures', { text, source })
  expect(res.status).toBe(201)
  return (res.body.capture as Capture).strandId!
}

describe('explicit strand targeting', () => {
  it('rejects a bench harness that names a strand it did not create', async () => {
    const strandId = await openStrand('Idee fuer Abendessen: Ofengemuese', 'web', 'Idee fuer Abendessen')
    const res = await api('POST', '/api/captures', {
      text: 'Sag dem Geraet bitte in einem kurzen Satz, was es nach dem Aufwachen anzeigen soll.',
      source: 'bench',
      strandId,
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(EXPLICIT_TARGET_FORBIDDEN)
    // Nothing was written: no capture, no decision, and above all no message
    // in the strand the product owner was using.
    const messages = db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?').get(strandId) as { n: number }
    expect(messages.n).toBe(1)
    const captured = db.prepare('SELECT COUNT(*) AS n FROM captures WHERE source = ?').get('bench') as { n: number }
    expect(captured.n).toBe(0)
  })

  it('rejects the same call from a puck and from a test harness', async () => {
    const strandId = await openStrand('Notiz', 'web')
    for (const source of ['puck', 'test', 'task']) {
      const res = await api('POST', '/api/captures', { text: 'irgendwas', source, strandId })
      expect(res.status, source).toBe(400)
      expect(res.body.code, source).toBe(EXPLICIT_TARGET_FORBIDDEN)
    }
  })

  it('leaves the user surfaces alone', async () => {
    const strandId = await openStrand('Notiz', 'web')
    for (const source of ['web', 'android', 'ios']) {
      const res = await api('POST', '/api/captures', { text: `von ${source}`, source, strandId })
      expect(res.status, source).toBe(201)
      const decision = res.body.decision as Decision
      expect(decision.model, source).toBe('explicit')
      expect(decision.rationale, source).toBe('Strand chosen by the user')
    }
    expect(calls).toBe(0) // an explicit target skips the router, as before
  })

  it('lets a client write into the strand it created itself, without claiming a user did', async () => {
    const strandId = await openStrand('Messreihe gestartet', 'bench', 'Messreihe')
    const res = await api('POST', '/api/captures', { text: 'Messwert 2: 41.8', source: 'bench', strandId })
    expect(res.status).toBe(201)
    const decision = res.body.decision as Decision
    expect(decision.model).toBe('explicit-client')
    expect(decision.rationale).toContain('created by this client')
    expect(decision.rationale).toContain('bench')
    expect(decision.rationale).not.toContain('chosen by the user')
    expect((res.body.capture as Capture).strandId).toBe(strandId)
  })
})

describe('filler gate', () => {
  /**
   * The incident text itself. It is also a known silent-clip artefact, so the
   * silence guard reaches it first; what matters here is the outcome the
   * capture ffd77c2b did not get: no router call, no strand, no 0.87.
   */
  it('never asks the router where the incident thank you belongs', async () => {
    const res = await api('POST', '/api/captures', { text: 'Vielen Dank.', kind: 'voice', source: 'puck' })
    expect(res.status).toBe(201)
    expect(calls).toBe(0)
    const capture = res.body.capture as Capture
    expect(capture.status).toBe('dismissed')
    expect(capture.strandId).toBeNull()
    expect((res.body.decision as Decision).confidence).toBe(0)
    const strands = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(strands.n).toBe(0)
  })

  it('puts down composed courtesy the silence list does not know', async () => {
    for (const text of ['Danke dir!', 'Alles klar, danke.', 'Perfekt, danke nochmal']) {
      const res = await api('POST', '/api/captures', { text, kind: 'voice', source: 'puck' })
      expect(res.status, text).toBe(201)
      const capture = res.body.capture as Capture
      const decision = res.body.decision as Decision
      expect(capture.status, text).toBe('dismissed')
      expect(capture.strandId, text).toBeNull()
      expect(decision.confidence, text).toBe(0)
      expect(decision.rationale, text).toBe(FILLER_GUARD_MARKER)
      expect(decision.model, text).toBe('filler-guard')
    }
    expect(calls).toBe(0)
    // The whole point: no strand was opened and none was appended to.
    const strands = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(strands.n).toBe(0)
  })

  it('keeps the dismissed capture auditable and undoable', async () => {
    const res = await api('POST', '/api/captures', { text: 'Danke dir!', source: 'puck' })
    const capture = res.body.capture as Capture
    const list = await api('GET', '/api/captures?status=dismissed')
    expect((list.body.captures as Capture[]).map(c => c.id)).toContain(capture.id)
    const undone = await api('POST', `/api/captures/${capture.id}/undo`)
    expect(undone.status).toBe(200)
  })

  it('still routes a capture that only looks polite', async () => {
    await openStrand('Werkstatttermin am Freitag', 'web', 'Werkstatt')
    answer({
      action: 'new_strand', strandId: null, newStrand: { title: 'Bremsbelaege', personaId: 'main', tags: ['auto'] },
      intent: 'note', confidence: 0.9, tags: ['auto'], rationale: 'neu', alternatives: [],
    })
    const res = await api('POST', '/api/captures', { text: 'Danke fuer die Bremsbelaege, die passen.', source: 'puck' })
    expect(res.status).toBe(201)
    expect(calls).toBe(1)
    expect((res.body.capture as Capture).strandId).not.toBeNull()
  })

  it('lets a bare answer reach the router', async () => {
    const strandId = await openStrand('Soll der Wecker um sieben klingeln?', 'web', 'Wecker')
    answer({
      action: 'append', strandId, intent: 'note', confidence: 0.8, tags: ['x'],
      rationale: 'Antwort auf die Frage', alternatives: [],
    })
    const res = await api('POST', '/api/captures', { text: 'Ja', source: 'puck' })
    expect(res.status).toBe(201)
    expect(calls).toBe(1)
    expect((res.body.capture as Capture).status).not.toBe('dismissed')
  })
})

describe('device affinity', () => {
  it('hands the previous strand of the same device to the router', async () => {
    const strandId = await openStrand('Der Wecker soll morgens die Temperatur zeigen', 'puck', 'Wecker')

    answer({
      action: 'append', strandId, intent: 'note', confidence: 0.9, tags: ['wecker'],
      rationale: 'gleiche Unterhaltung', alternatives: [],
    })
    const res = await api('POST', '/api/captures', { text: 'Und die Uhrzeit gross darunter', kind: 'voice', source: 'puck' })
    expect(res.status).toBe(201)

    const prompt = prompts[prompts.length - 1]
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1)) as {
      deviceHint?: { strandId: string; source: string; ageMinutes: number }
      candidates: Array<{ strandId: string }>
    }
    expect(payload.deviceHint).toBeDefined()
    expect(payload.deviceHint!.strandId).toBe(strandId)
    expect(payload.deviceHint!.source).toBe('puck')
    expect(payload.deviceHint!.ageMinutes).toBe(0)
    // The hint is worthless when the model cannot inspect what it points at.
    expect(payload.candidates.map(c => c.strandId)).toContain(strandId)
    expect((res.body.capture as Capture).strandId).toBe(strandId)

    const strands = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(strands.n).toBe(1)
  })

  it('gives no hint for the first capture of a device', async () => {
    await openStrand('Ein Strand aus dem Browser', 'web', 'Browser')
    answer({
      action: 'new_strand', strandId: null, newStrand: { title: 'Erste Aeusserung', personaId: 'main', tags: ['x'] },
      intent: 'note', confidence: 0.9, tags: ['x'], rationale: 'neu', alternatives: [],
    })
    await api('POST', '/api/captures', { text: 'Erste Aeusserung am Geraet', kind: 'voice', source: 'puck' })
    expect(calls).toBe(1)
    expect(prompts[prompts.length - 1]).not.toContain('deviceHint')
  })

  it('does not carry the hint across sources', async () => {
    await openStrand('Puck sagt etwas ueber den Wecker', 'puck')
    answer({
      action: 'new_strand', strandId: null, newStrand: { title: 'Web', personaId: 'main', tags: ['x'] },
      intent: 'note', confidence: 0.9, tags: ['x'], rationale: 'neu', alternatives: [],
    })
    await api('POST', '/api/captures', { text: 'Etwas voellig anderes aus dem Browser', source: 'web' })
    expect(prompts[prompts.length - 1]).not.toContain('deviceHint')
  })

  it('stays a hint: the model may open a new strand anyway', async () => {
    await openStrand('Der Wecker soll morgens die Temperatur zeigen', 'puck', 'Wecker')
    answer({
      action: 'new_strand', strandId: null, newStrand: { title: 'Zahnarzt', personaId: 'main', tags: ['gesundheit'] },
      intent: 'note', confidence: 0.9, tags: ['gesundheit'], rationale: 'Themenwechsel', alternatives: [],
    })
    const res = await api('POST', '/api/captures', { text: 'Ich brauche einen Termin beim Zahnarzt', source: 'puck' })
    expect(res.status).toBe(201)
    expect(prompts[prompts.length - 1]).toContain('deviceHint')
    const strands = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(strands.n).toBe(2)
  })
})
