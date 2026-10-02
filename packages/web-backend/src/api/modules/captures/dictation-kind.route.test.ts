/**
 * The dictation mark of a capture (web redesign W5d).
 *
 * Product rule: a dictated capture keeps ONLY its text, never audio; what
 * survives of the dictation is a mark. The mark is not a new field: the
 * capture contract has always had `kind` with the whitelist
 * `text | voice | image | file`, stored in `captures.kind` (NOT NULL, default
 * `text`) and returned with every capture, and the companion app's tray already
 * draws a microphone for `kind: 'voice'`. The web Home sends `kind: 'voice'`
 * for a dictated capture and no `kind` for a typed one.
 *
 * Pinned here, because the app reads the same endpoints:
 *   - a capture without `kind` is `text`, exactly as before
 *   - `kind: 'voice'` is stored and comes back from POST and GET
 *   - an unknown or wrongly typed `kind` is a 400 `invalid_kind`, nothing stored
 *   - GET /api/captures keeps its shape (`captures`, `decisions`, `parts`,
 *     `total`) and every capture keeps its keys; `kind` is one of them
 *   - the body carries no audio and the capture no attachment
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Capture, Database, ResolvedRouterModel } from '@axiom/core'
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
let splitCalls = 0

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

/** The keys every listed capture had before W5d; the app parses them. */
const CAPTURE_KEYS = ['agentId', 'attachments', 'clientMessageId', 'createdAt', 'filedAt', 'id', 'kind', 'messageId', 'source', 'status', 'strandId', 'text']

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-dictation-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'main'), { recursive: true })
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
    getNowSetMode: () => 'manual',
    routerComplete: async () => {
      const next = nextAnswers.shift()
      if (next === undefined) throw new Error('router stub has no answer')
      return next
    },
    // A one sentence capture never reaches the split model; if it did, the
    // split falls back to one part and the counter shows it.
    splitComplete: async () => { splitCalls += 1; throw new Error('no split in this test') },
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
  splitCalls = 0
  sessionManager.createThread('1', 'main', 'Some other topic')
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

/** The router leaves the card in the tray, so it shows up under `unsorted`. */
function unsure(): void {
  nextAnswers.push(JSON.stringify({ action: 'new_strand', newStrand: { title: 'Maybe', personaId: 'main', tags: [] }, intent: 'note', confidence: 0.2, alternatives: [], rationale: 'unsure' }))
}

describe('capture dictation mark (kind)', () => {
  it('stores a capture without kind as text and a dictated one as voice, both without attachments', async () => {
    unsure()
    const typed = await api('POST', '/api/captures', { text: 'A synthetic typed note', source: 'web', clientMessageId: 'typed-1', attachments: [] })
    expect(typed.status).toBe(201)
    expect((typed.body.capture as Capture).kind).toBe('text')

    unsure()
    const dictated = await api('POST', '/api/captures', { text: 'A synthetic dictated note', source: 'web', clientMessageId: 'dictated-1', attachments: [], kind: 'voice' })
    expect(dictated.status).toBe(201)
    const capture = dictated.body.capture as Capture
    expect(capture.kind).toBe('voice')
    expect(capture.attachments).toEqual([])
    expect(capture.source).toBe('web')

    // Nothing but text and mark: the attachments column stays empty.
    const row = db.prepare('SELECT kind, attachments FROM captures WHERE id = ?').get(capture.id) as { kind: string; attachments: string | null }
    expect(row.kind).toBe('voice')
    expect(row.attachments).toBeNull()
    expect(splitCalls).toBe(0)
  })

  it('refuses an unknown or wrongly typed kind with 400 invalid_kind and stores nothing', async () => {
    for (const kind of ['dictated', 'VOICE', 'audio', '', 1, true, null, ['voice'], { mode: 'voice' }]) {
      const res = await api('POST', '/api/captures', { text: 'A synthetic note', kind })
      expect({ kind, status: res.status, code: res.body.code }).toEqual({ kind, status: 400, code: 'invalid_kind' })
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM captures').get() as { n: number }).n).toBe(0)
  })

  it('keeps the GET /api/captures shape and returns the mark on every capture', async () => {
    unsure()
    await api('POST', '/api/captures', { text: 'A synthetic typed note', source: 'web' })
    unsure()
    await api('POST', '/api/captures', { text: 'A synthetic dictated note', source: 'web', kind: 'voice' })

    const page = await api('GET', '/api/captures?status=unsorted&limit=50&offset=0')
    expect(page.status).toBe(200)
    expect(Object.keys(page.body).sort()).toEqual(['captures', 'decisions', 'parts', 'total'])
    expect(page.body.total).toBe(2)
    const listed = page.body.captures as Array<Record<string, unknown>>
    for (const item of listed) expect(Object.keys(item).sort()).toEqual(CAPTURE_KEYS)
    expect(Object.fromEntries(listed.map(item => [item.text, item.kind]))).toEqual({
      'A synthetic typed note': 'text',
      'A synthetic dictated note': 'voice',
    })
    expect((page.body.decisions as unknown[]).length).toBe(2)

    const all = await api('GET', '/api/captures?status=all')
    expect((all.body.captures as Capture[]).map(item => item.kind).sort()).toEqual(['text', 'voice'])
  })
})
