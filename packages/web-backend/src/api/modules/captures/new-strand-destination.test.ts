/**
 * `destination: 'new_strand'` — a capture the client declares as the start of
 * its own conversation (the "ask a question about this story" path of a news
 * board).
 *
 * What is proven here:
 *   - the router is never called and the capture is `filed` into a strand that
 *     was created for it, with intent `ask` so the turn runs
 *   - a SECOND such capture never lands in the strand of the first one, even
 *     though the text is nearly identical — this is the guarantee the feature
 *     exists for
 *   - the client's `strandTitle` names the strand, trimmed to 60 characters;
 *     without one the first line of the text is used
 *   - the decision row is countable (`model: 'explicit-new-strand'`) and says
 *     who chose
 *   - `strandId` plus `destination: 'new_strand'` is a contradiction and is
 *     refused, instead of one silently winning over the other
 *   - a client that sends no `destination` is routed exactly as before
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
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-newstrand-'))
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

async function ask(text: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown>; capture: Capture; decision: Decision }> {
  const res = await api('POST', '/api/captures', { text, source: 'web', destination: 'new_strand', ...extra })
  return { status: res.status, body: res.body, capture: res.body.capture as Capture, decision: res.body.decision as Decision }
}

describe('POST /api/captures with destination=new_strand', () => {
  it('opens a strand of its own and answers there, without asking the router', async () => {
    const res = await ask('Artikel: Modellstart\n\nWas bedeutet das für uns?', { strandTitle: 'Modellstart' })

    expect(res.status).toBe(201)
    expect(routerCalls).toBe(0)
    expect(res.capture.status).toBe('filed')
    expect(res.decision.action).toBe('new_strand')
    expect(res.decision.intent).toBe('ask')
    expect(res.decision.state).toBe('applied')
    expect(res.capture.strandId).toBeTruthy()

    const row = db.prepare('SELECT model, rationale, created_strand_id FROM router_decisions WHERE capture_id = ?')
      .get(res.capture.id) as { model: string; rationale: string; created_strand_id: string | null }
    expect(row.model).toBe('explicit-new-strand')
    expect(row.rationale).toContain('New strand chosen by the user')
    expect(row.created_strand_id).toBe(res.capture.strandId)

    const strand = db.prepare('SELECT title FROM sessions WHERE id = ?').get(res.capture.strandId!) as { title: string }
    expect(strand.title).toBe('Modellstart')

    expect(turns).toHaveLength(1)
    expect(turns[0]!.sessionId).toBe(res.capture.strandId)
  })

  it('never continues the strand of an earlier capture, however similar the text', async () => {
    const first = await ask('Artikel: Modellstart\n\nWas bedeutet das für uns?', { strandTitle: 'Modellstart' })
    const second = await ask('Artikel: Modellstart\n\nWas bedeutet das für uns?', { strandTitle: 'Modellstart' })

    expect(second.capture.strandId).toBeTruthy()
    expect(second.capture.strandId).not.toBe(first.capture.strandId)
    expect(routerCalls).toBe(0)
    expect(turns.map(t => t.sessionId)).toEqual([first.capture.strandId, second.capture.strandId])
  })

  it('falls back to the first line of the text and trims an overlong title', async () => {
    const withoutTitle = await ask('Erste Zeile als Titel\n\nUnd die Frage darunter.')
    const long = 'x'.repeat(200)
    const overlong = await ask('Frage', { strandTitle: long })

    const first = db.prepare('SELECT title FROM sessions WHERE id = ?').get(withoutTitle.capture.strandId!) as { title: string }
    const second = db.prepare('SELECT title FROM sessions WHERE id = ?').get(overlong.capture.strandId!) as { title: string }
    expect(first.title).toBe('Erste Zeile als Titel')
    expect(second.title).toHaveLength(60)
  })

  it('refuses the contradiction of a named strand plus a forced new one', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Bestehender Strand')
    const res = await ask('Frage', { strandId: strand.id })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_destination')
    expect(db.prepare('SELECT COUNT(*) AS n FROM captures').get() as { n: number }).toEqual({ n: 0 })
  })

  it('leaves a capture without the field on the router path', async () => {
    const res = await api('POST', '/api/captures', { text: 'Ganz normale Notiz zum Ablegen.', source: 'web' })

    expect(res.status).toBe(201)
    const decision = res.body.decision as Decision
    expect(decision.model).not.toBe('explicit-new-strand')
    expect(decision.rationale).not.toContain('New strand chosen by the user')
  })
})
