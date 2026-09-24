/**
 * The HTTP surface of split-on-intake: the new endpoints and the new body
 * fields, exercised through the real express router and the real auth
 * middleware, so the wiring (route -> controller -> service) is covered and
 * not only the service.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager } from '@axiom/core'
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
let routerAnswers: string[] = []
let splitAnswers: string[] = []

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

interface PartView { index: number; title: string | null; text: string; sentenceIds: number[]; decision: { state: string } }

const TEXT = 'Das Dach tropft seit dem Sturm. Ich brauche endlich einen Dachdecker. Das Auto muss zum Service. Der Termin waere am Montag.'
const DACH_PART = 'Das Dach tropft seit dem Sturm, ich brauche einen Dachdecker.'
const AUTO_PART = 'Das Auto muss zum Service, Termin am Montag.'

const TWO_TOPICS = JSON.stringify({
  topics: [{ id: 'A', title: 'Dach', sentenceIds: [1, 2] }, { id: 'B', title: 'Auto', sentenceIds: [3, 4] }],
  uncertain: [], splitConfidence: 0.93, rationale: 'zwei getrennte Sachen',
})

function newStrand(title: string, confidence = 0.9): string {
  return JSON.stringify({
    action: 'new_strand', strandId: null, secondaryStrandId: null,
    newStrand: { title, personaId: 'main', tags: [], projectId: null },
    intent: 'note', confidence, tags: [], rationale: `strand ${title}`, alternatives: [],
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the wire shape, read as the client reads it
type Json = any

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json() as Json }
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-split-routes-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  const sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  const app = express()
  app.use(express.json())
  const captures = createCapturesRouters({
    db,
    getAgentCore: () => agentCore,
    chatEventBus: new ChatEventBus(),
    getTurnRunner: () => ({ startTurn: () => ({}) }),
    routerChain: () => chain,
    getNowSetMode: () => 'manual',
    routerComplete: async () => {
      const next = routerAnswers.shift()
      if (next === undefined) throw new Error('router stub has no answer')
      return next
    },
    splitComplete: async () => {
      const next = splitAnswers.shift()
      if (next === undefined) throw new Error('split stub has no answer')
      return next
    },
  })
  app.use('/api/captures', captures.captures)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM captures; DELETE FROM router_decisions; DELETE FROM tags; DELETE FROM strand_tags; DELETE FROM now_set;')
  routerAnswers = []
  splitAnswers = []
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, type, agent_id, title, started_at, last_activity, archived)
     VALUES ('s-existing', 1, '1', 'interactive', 'main', 'Dachrinne', datetime('now','-1 day'), datetime('now','-1 day'), 0)`,
  ).run()
})

async function postSplitCapture(): Promise<string> {
  splitAnswers = [TWO_TOPICS, DACH_PART, AUTO_PART]
  routerAnswers = [newStrand('Dach'), newStrand('Auto')]
  const created = await call('POST', '/api/captures', { text: TEXT, kind: 'voice', source: 'puck' })
  expect(created.status).toBe(201)
  return created.json.capture.id as string
}

describe('split-on-intake over HTTP', () => {
  it('GET /api/captures/:id returns the parts and the split verdict', async () => {
    const id = await postSplitCapture()
    const res = await call('GET', `/api/captures/${id}`)
    expect(res.status).toBe(200)
    expect(res.json.partCount).toBe(2)
    expect((res.json.parts as PartView[]).map(p => [p.index, p.title, p.text])).toEqual([
      [0, 'Dach', DACH_PART],
      [1, 'Auto', AUTO_PART],
    ])
    expect(res.json.parts[1].sentenceIds).toEqual([3, 4])
    expect(res.json.split).toEqual({ confidence: 0.93, rationale: 'zwei getrennte Sachen', gated: false })
    expect(res.json.capture.text).toBe(TEXT)
    expect(res.json.decision.partIndex).toBe(0)
    expect(res.json.sentences).toEqual([
      'Das Dach tropft seit dem Sturm.',
      'Ich brauche endlich einen Dachdecker.',
      'Das Auto muss zum Service.',
      'Der Termin waere am Montag.',
    ])
  })

  it('GET /api/captures lists parts next to the part 0 decisions', async () => {
    const id = await postSplitCapture()
    const res = await call('GET', '/api/captures?status=all')
    expect(res.status).toBe(200)
    expect(res.json.decisions).toHaveLength(1)
    expect((res.json.parts as Record<string, PartView[]>)[id].map(p => p.index)).toEqual([0, 1])
  })

  it('POST /api/captures/:id/undo with partIndex undoes exactly that part', async () => {
    const id = await postSplitCapture()
    const res = await call('POST', `/api/captures/${id}/undo`, { partIndex: 1 })
    expect(res.status).toBe(200)
    const parts = (await call('GET', `/api/captures/${id}`)).json.parts
    expect((parts as PartView[]).map(p => p.decision.state)).toEqual(['applied', 'undone'])
  })

  it('POST /api/captures/:id/undo without partIndex undoes every part', async () => {
    const id = await postSplitCapture()
    const res = await call('POST', `/api/captures/${id}/undo`, {})
    expect(res.status).toBe(200)
    expect(res.json.capture.status).toBe('unsorted')
    expect(res.json.capture.strandId).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get() as { c: number }).c).toBe(0)
  })

  it('POST /api/captures/:id/keep-as-one re-routes the original text as one', async () => {
    const id = await postSplitCapture()
    routerAnswers = [newStrand('Alles zusammen')]
    const res = await call('POST', `/api/captures/${id}/keep-as-one`, {})
    expect(res.status).toBe(200)
    expect(res.json.capture.id).toBe(id)
    expect(res.json.capture.status).toBe('filed')
    expect(res.json.decision.partCount).toBe(1)
    expect(res.json.decision.partText).toBeNull()
    expect(res.json).toHaveProperty('turn')
    const rows = db.prepare('SELECT content, part_index, metadata FROM chat_messages').all() as Array<Record<string, unknown>>
    expect(rows).toEqual([{ content: TEXT, part_index: 0, metadata: null }])
    const view = (await call('GET', `/api/captures/${id}`)).json
    expect(view.partCount).toBe(1)
    expect(view.parts[0].text).toBe(TEXT)
    // Every part decision of the split is superseded, nothing is deleted.
    const states = (db.prepare('SELECT state FROM router_decisions').all() as Array<{ state: string }>).map(r => r.state)
    expect(states.filter(s => s === 'superseded').length).toBeGreaterThanOrEqual(2)
  })

  it('every write answers with the current parts, the same shape as the detail view', async () => {
    splitAnswers = [TWO_TOPICS, DACH_PART, AUTO_PART]
    routerAnswers = [newStrand('Dach'), newStrand('Auto')]
    const created = await call('POST', '/api/captures', { text: TEXT, kind: 'voice', source: 'puck' })
    expect(created.status).toBe(201)
    expect(created.json.partCount).toBe(2)
    expect((created.json.parts as PartView[]).map(p => [p.index, p.title, p.text, p.sentenceIds])).toEqual([
      [0, 'Dach', DACH_PART, [1, 2]],
      [1, 'Auto', AUTO_PART, [3, 4]],
    ])
    const id = created.json.capture.id as string

    const undone = await call('POST', `/api/captures/${id}/undo`, { partIndex: 1 })
    expect(undone.status).toBe(200)
    expect(undone.json.partCount).toBe(2)
    expect((undone.json.parts as PartView[]).map(p => p.decision.state)).toEqual(['applied', 'undone'])
    expect(undone.json.parts).toEqual((await call('GET', `/api/captures/${id}`)).json.parts)

    routerAnswers = [newStrand('Alles zusammen')]
    const one = await call('POST', `/api/captures/${id}/keep-as-one`, {})
    expect(one.json.partCount).toBe(1)
    expect((one.json.parts as PartView[]).map(p => [p.index, p.text])).toEqual([[0, TEXT]])
    expect(one.json.parts[0].decision.id).toBe(one.json.decision.id)
  })

  it('a capture that was not split answers every write with its one part', async () => {
    routerAnswers = [newStrand('Kurz')]
    const created = await call('POST', '/api/captures', { text: 'Nur ein kurzer Gedanke.', kind: 'text', source: 'web' })
    expect(created.status).toBe(201)
    expect(created.json.partCount).toBe(1)
    expect((created.json.parts as PartView[]).map(p => [p.index, p.title, p.text, p.sentenceIds])).toEqual([
      [0, null, 'Nur ein kurzer Gedanke.', []],
    ])
    const id = created.json.capture.id as string
    const undone = await call('POST', `/api/captures/${id}/undo`, {})
    expect(undone.json.partCount).toBe(1)
    expect(undone.json.parts[0].decision.id).toBe(undone.json.decision.id)
  })

  it('POST /api/captures/:id/keep-as-one is idempotent: a second call routes nothing', async () => {
    const id = await postSplitCapture()
    routerAnswers = [newStrand('Alles zusammen')]
    const first = await call('POST', `/api/captures/${id}/keep-as-one`, {})
    expect(first.status).toBe(200)
    expect(routerAnswers).toHaveLength(0)
    // No router answer is left on purpose: a second routing would throw.
    const second = await call('POST', `/api/captures/${id}/keep-as-one`, {})
    expect(second.status).toBe(200)
    expect(second.json.decision.id).toBe(first.json.decision.id)
    expect(second.json.partCount).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 })
  })

  it('POST /api/captures/:id/keep-as-one twice at once routes once and answers both', async () => {
    const id = await postSplitCapture()
    routerAnswers = [newStrand('Alles zusammen')]
    const [a, b] = await Promise.all([
      call('POST', `/api/captures/${id}/keep-as-one`, {}),
      call('POST', `/api/captures/${id}/keep-as-one`, {}),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.json.decision.id).toBe(b.json.decision.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({ n: 1 })
  })

  it('rejects a bad partIndex and an unknown part', async () => {
    const id = await postSplitCapture()
    expect((await call('POST', `/api/captures/${id}/undo`, { partIndex: -1 })).status).toBe(400)
    expect((await call('POST', `/api/captures/${id}/apply`, { partIndex: 9 })).status).toBe(404)
  })
})
