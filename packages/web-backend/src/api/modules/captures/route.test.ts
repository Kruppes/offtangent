/**
 * /api/captures, /api/router/preview (SPEC 6.1) against a real SessionManager
 * and in-memory database. The router model is stubbed through the
 * `routerComplete` hook so the bands, apply and undo paths are exercised
 * without a provider.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, saveProviders, SessionManager } from '@axiom/core'
import type { AgentCore, Capture, Database, Decision, ResolvedRouterModel } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import {
  createCapturesService, CAPTURE_NUDGE_TEXT,
  CAPTURE_CONFIRM_BLOCK_ID, CAPTURE_CONFIRM_ANSWER,
} from './service.js'
import { sendCaptureDoorbell } from '../../../push/triggers.js'
import type { PushDoorbell, PushSender } from '../../../push/sender.js'
import { createStrandsRouters } from '../strands/route.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import type { ChatEvent } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let userToken: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let events: ChatEvent[] = []
let turns: Array<{ sessionId: string; text: string; agentId: string; turnModelOverride?: { providerId: string; modelId: string } }> = []
let busySessions: string[] = []
/** What the stubbed router answers next (JSON object or raw text). */
let nextAnswers: string[] = []
let calls = 0
/** Every user prompt the stubbed router was handed, newest last. */
let prompts: string[] = []
/** Every doorbell the captures path handed to the push sender. */
let doorbells: PushDoorbell[] = []
const pushSender = { sendDetached: (d: PushDoorbell) => { doorbells.push(d) } } as unknown as PushSender

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-routes-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'coder'), { recursive: true })
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  const bus = new ChatEventBus()
  bus.subscribe(e => events.push(e))

  const app = express()
  app.use(express.json())
  const getAgentCore = () => agentCore
  const captures = createCapturesRouters({
    db,
    getAgentCore,
    chatEventBus: bus,
    getTurnRunner: () => ({ hasActiveTurnInSession: (_user, id) => busySessions.includes(id), startTurn: (input) => { turns.push({ sessionId: input.sessionId, text: input.text, agentId: input.agentId, ...(input.turnModelOverride ? { turnModelOverride: input.turnModelOverride } : {}) }); return {} } }),
    routerChain: () => chain,
    // Filing pulls the strand into the CURATED now set here; the auto mode has
    // its own test (captures.now-auto.test.ts).
    getNowSetMode: () => 'manual',
    // Exactly the wiring app.ts uses: the service hands its doorbell to the
    // real trigger, the trigger to the sender.
    sendDoorbell: (input) => sendCaptureDoorbell(db, pushSender, input),
    routerComplete: async (_entry, prompt) => {
      calls += 1
      prompts.push(prompt)
      const next = nextAnswers.shift()
      if (next === undefined) throw new Error('router stub has no answer')
      return next
    },
  })
  app.use('/api/captures', captures.captures)
  app.use('/api/router', captures.router)
  const strands = createStrandsRouters({ db, getAgentCore, chatEventBus: bus, getNowSetMode: () => 'manual' })
  app.use('/api/strands', strands.strands)
  app.use('/api/tags', strands.tags)
  app.use('/api/now', strands.now)
  app.use('/api/resurface', strands.resurface)

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM captures; DELETE FROM router_decisions; DELETE FROM tags; DELETE FROM strand_tags; DELETE FROM strand_links; DELETE FROM now_set; DELETE FROM projects;')
  events = []
  turns = []
  nextAnswers = []
  prompts = []
  doorbells = []
  calls = 0
  busySessions = []
  saveProviders({
    providers: [{ id: 'chosen', name: 'Chosen', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['model'], modelStatuses: { model: 'connected' } }],
    activeProvider: 'chosen', activeModel: 'model',
  })
})

function createProject(id: string, name: string, userId = '1', archived = 0): string {
  db.prepare('INSERT INTO projects (id, user_id, name, archived) VALUES (?, ?, ?, ?)').run(id, userId, name, archived)
  return id
}

function projectOf(strandId: string): string | null {
  const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(strandId) as { project_id: string | null } | undefined
  return row?.project_id ?? null
}

async function api(
  method: string,
  url: string,
  body?: unknown,
  bearer = token,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

function answer(obj: Record<string, unknown>): void {
  nextAnswers.push(JSON.stringify(obj))
}

function messagesIn(strandId: string): Array<{ id: number; role: string; content: string; capture_id: string | null; metadata: string | null }> {
  return db.prepare('SELECT id, role, content, capture_id, metadata FROM chat_messages WHERE session_id = ? ORDER BY id').all(strandId) as never
}

describe('POST /api/captures', () => {
  it('rejects empty text, unknown persona and malformed strand', async () => {
    expect((await api('POST', '/api/captures', { text: '  ' })).status).toBe(400)
    expect((await api('POST', '/api/captures', { text: 'x', agentId: 'ghost' })).body.code).toBe('unknown_agent')
    expect((await api('POST', '/api/captures', { text: 'x', strandId: 'bad id' })).body.code).toBe('invalid_strand')
    expect((await api('POST', '/api/captures', { text: 'x', strandId: 'does-not-exist' })).body.code).toBe('invalid_strand')
    expect(calls).toBe(0)
  })

  it('files a high confidence append, tags the strand, pulls it into the now set and emits capture_routed', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Haus Dach')
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.82, tags: ['haus', 'handwerker'], rationale: 'roofer' })

    // A silent filing needs the client to say so: the router alone never
    // produces a note any more.
    const res = await api('POST', '/api/captures', { text: 'roofer called back, 4200 for the north side', clientMessageId: 'c-1', intent: 'note' })
    expect(res.status).toBe(201)
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(capture.status).toBe('filed')
    expect(capture.strandId).toBe(strand.id)
    expect(capture.messageId).not.toBeNull()
    expect(decision.state).toBe('applied')
    expect(decision.model).toBe('p:stub')
    expect(decision.tags).toEqual(['haus', 'handwerker'])
    expect(turns.length).toBe(0)

    // The capture row and nothing else: the text addresses nobody, so the
    // filing is silent.
    const rows = messagesIn(strand.id)
    expect(rows.map(r => r.role)).toEqual(['user'])
    expect(rows[0].capture_id).toBe(capture.id)

    const strands = (await api('GET', '/api/strands')).body.strands as Array<{ id: string; tags: string[]; nowRank: number | null; messageCount: number }>
    expect(strands[0].tags).toEqual(['handwerker', 'haus'])
    expect(strands[0].nowRank).toBe(1)
    expect(strands[0].messageCount).toBe(1)

    expect(events.map(e => e.type)).toEqual(['now_set_changed', 'user_message', 'capture_routed'])
    expect((events[2].decision as Decision).id).toBe(decision.id)

    // Idempotent retry: same key, no second router call, 200.
    const again = await api('POST', '/api/captures', { text: 'roofer called back, 4200 for the north side', clientMessageId: 'c-1', intent: 'note' })
    expect(again.status).toBe(200)
    expect((again.body.capture as Capture).id).toBe(capture.id)
    expect(calls).toBe(1)
  })

  it('runs a turn for intent ask in the high band, and reviews the filing without withholding the answer', async () => {
    const strand = sessionManager.createThread('1', 'coder', 'Deploy')
    answer({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.9 })
    const high = await api('POST', '/api/captures', { text: 'is the deploy green?' })
    expect((high.body.capture as Capture).status).toBe('filed')
    expect(turns).toEqual([{ sessionId: strand.id, text: 'is the deploy green?', agentId: 'coder' }])

    // Below the high band the router guard opens a new strand instead of
    // appending, so the filing is reviewable — but the answer is not withheld.
    answer({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.5 })
    const medium = await api('POST', '/api/captures', { text: 'and the canary?' })
    const mediumCapture = medium.body.capture as Capture
    expect(mediumCapture.status).toBe('needs_review')
    expect(mediumCapture.strandId).not.toBe(strand.id)
    expect(turns.length).toBe(2)
    expect(turns[1]).toEqual({ sessionId: mediumCapture.strandId, text: 'and the canary?', agentId: 'main' })
    expect(events.filter(e => e.type === 'capture_needs_review').length).toBe(1)

    // Confirming the filing afterwards is a filing decision, not a second
    // answer.
    const confirm = await api('POST', `/api/captures/${mediumCapture.id}/apply`, {})
    expect(confirm.status).toBe(200)
    expect((confirm.body.capture as Capture).status).toBe('filed')
    expect((confirm.body.decision as Decision).state).toBe('confirmed')
    expect(turns.length).toBe(2)
  })

  it('parks a low confidence capture as unsorted without creating anything', async () => {
    sessionManager.createThread('1', 'main', 'Something')
    answer({ action: 'new_strand', newStrand: { title: 'Maybe', personaId: 'main', tags: ['x'] }, confidence: 0.2, alternatives: [] })
    const res = await api('POST', '/api/captures', { text: 'random thought' })
    expect(res.status).toBe(201)
    expect((res.body.capture as Capture).status).toBe('unsorted')
    expect((res.body.decision as Decision).state).toBe('proposed')
    expect((res.body.decision as Decision).title).toBe('Maybe')
    expect(sessionManager.listThreads('1').length).toBe(1)
    expect(turns.length).toBe(0)

    const list = await api('GET', '/api/captures?status=unsorted')
    expect((list.body.captures as Capture[]).length).toBe(1)
    expect((list.body.decisions as Decision[]).length).toBe(1)
    expect(((await api('GET', '/api/captures?status=unsorted', undefined, userToken)).body.captures as Capture[]).length).toBe(0)
  })

  it('keeps the list shape and adds total, the count of the status filter across pages', async () => {
    sessionManager.createThread('1', 'main', 'Something')
    for (const text of ['synthetic one', 'synthetic two', 'synthetic three']) {
      answer({ action: 'new_strand', newStrand: { title: 'Maybe', personaId: 'main', tags: [] }, confidence: 0.2, alternatives: [] })
      expect((await api('POST', '/api/captures', { text })).status).toBe(201)
    }

    const page = await api('GET', '/api/captures?status=unsorted&limit=2')
    expect(page.status).toBe(200)
    // Existing fields stay as they were (the app reads them); total is additive.
    expect(Object.keys(page.body).sort()).toEqual(['captures', 'decisions', 'parts', 'total'])
    expect((page.body.captures as Capture[]).length).toBe(2)
    expect((page.body.decisions as Decision[]).length).toBe(2)
    expect(Object.keys(page.body.parts as Record<string, unknown>).length).toBe(2)
    expect(page.body.total).toBe(3)

    const rest = await api('GET', '/api/captures?status=unsorted&limit=2&offset=2')
    expect((rest.body.captures as Capture[]).length).toBe(1)
    expect(rest.body.total).toBe(3)

    expect((await api('GET', '/api/captures?status=filed')).body.total).toBe(0)
    expect((await api('GET', '/api/captures?status=all')).body.total).toBe(3)
    // The filter is bound as a parameter, never spliced into the SQL.
    expect((await api('GET', "/api/captures?status=unsorted'%20OR%201=1--")).status).toBe(400)
    // Another user counts only their own captures.
    expect((await api('GET', '/api/captures?status=unsorted', undefined, userToken)).body.total).toBe(0)

    // A dismissed capture leaves `all` and its count, but is counted by name.
    const first = (page.body.captures as Capture[])[0]!
    expect((await api('POST', `/api/captures/${first.id}/dismiss`, {})).status).toBe(200)
    expect((await api('GET', '/api/captures?status=all')).body.total).toBe(2)
    expect((await api('GET', '/api/captures?status=dismissed')).body.total).toBe(1)
  })

  it('creates a new strand for a high confidence new_strand and marks router failure as failed', async () => {
    sessionManager.createThread('1', 'main', 'Existing')
    answer({ action: 'new_strand', newStrand: { title: 'Dach Angebot Nord', personaId: 'coder', tags: ['dach'] }, intent: 'note', confidence: 0.75 })
    const res = await api('POST', '/api/captures', { text: 'new topic' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(capture.status).toBe('filed')
    expect(decision.createdStrandId).toBe(capture.strandId)
    const created = sessionManager.getThread('1', capture.strandId!)!
    expect(created.title).toBe('Dach Angebot Nord')
    expect(created).toMatchObject({ agentId: 'main', workingMode: 'auto' })
    expect(created.tags).toEqual(['dach'])

    // Malformed twice: repair retry, then synthetic decision, status failed.
    nextAnswers.push('nonsense', 'still nonsense')
    const failed = await api('POST', '/api/captures', { text: 'router is drunk' })
    expect((failed.body.capture as Capture).status).toBe('failed')
    expect((failed.body.decision as Decision).model).toBe('synthetic')
    expect((failed.body.decision as Decision).confidence).toBe(0)
  })

  it('never appends below the high band: a 0.66 append opens a new strand and keeps the target as an alternative', async () => {
    const stranger = sessionManager.createThread('1', 'main', 'Fremder Strand')
    answer({
      action: 'append', strandId: stranger.id, intent: 'note', confidence: 0.66, tags: ['offtangent'],
      rationale: 'passt vielleicht',
    })
    const res = await api('POST', '/api/captures', { text: 'Die Strand Zuordnung ist immer noch extrem lueckenhaft' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision

    expect(decision.action).toBe('new_strand')
    expect(decision.confidence).toBe(0.66)
    expect(capture.strandId).not.toBe(stranger.id)
    expect(decision.createdStrandId).toBe(capture.strandId)
    expect(messagesIn(stranger.id).length).toBe(0)
    const created = sessionManager.getThread('1', capture.strandId!)!
    expect(created.title).toBe('Die Strand Zuordnung ist immer noch extrem lueckenhaft')
    expect(decision.alternatives[0]).toMatchObject({ action: 'append', strandId: stranger.id })
    expect(decision.rationale).toContain('passt vielleicht')
    // Medium band: filed for review, no turn yet.
    expect(capture.status).toBe('needs_review')
  })

  it('offers the last user message of a candidate to the router and hides mute strands', async () => {
    const titled = sessionManager.createThread('1', 'main', 'Haus Dach')
    const mute = sessionManager.createThread('1', 'main')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', ?)")
      .run(titled.id, 'der dachdecker\nwollte 4200 haben')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'stumm')")
      .run(mute.id)
    answer({ action: 'new_strand', newStrand: { title: 'Neu', personaId: 'main', tags: [] }, confidence: 0.8 })
    await api('POST', '/api/captures', { text: 'was kostet das dach' })

    const prompt = prompts[prompts.length - 1]
    expect(prompt).toContain('"lastMessage": "der dachdecker wollte 4200 haben"')
    expect(prompt).not.toContain(mute.id)
  })

  it('skips the router for an explicit strandId and honours intent', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Explicit')
    const res = await api('POST', '/api/captures', { text: 'direct', strandId: strand.id, intent: 'ask' })
    expect(res.status).toBe(201)
    expect(calls).toBe(0)
    expect((res.body.decision as Decision).model).toBe('explicit')
    expect((res.body.capture as Capture).status).toBe('filed')
    expect(turns.length).toBe(1)
    expect((await api('POST', '/api/captures', { text: 'direct', strandId: strand.id }, userToken)).status).toBe(404)
  })
})

describe('an ask is answered whatever the confidence band says', () => {
  /**
   * Two captures the product owner really sent, verbatim. Both were routed
   * `intent=ask`, `action=new_strand`, `confidence=0.55` — filed as
   * `needs_review` and then answered by nobody, for two days.
   */
  const ASK_A = 'die möglichkeit persönlichkeiten hinzuzufügen und anzupassen fehlt noch immer in front und backend'
  const ASK_B = 'viel zu viele fragen werden als note erfasst und dadurch nicht bearbeitet'

  /** One strand with substance, so the router is really asked. */
  function candidate(): string {
    return sessionManager.createThread('1', 'main', 'Irgendein anderes Thema').id
  }

  /** File one of the captures above the way the live router filed it. */
  async function fileMediumAsk(text: string): Promise<Capture> {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Personas', personaId: 'coder', tags: [] },
      intent: 'ask', confidence: 0.55, rationale: 'unsicher wohin',
    })
    const res = await api('POST', '/api/captures', { text })
    return res.body.capture as Capture
  }

  it('answers a medium band ask and still files it for review', async () => {
    const capture = await fileMediumAsk(ASK_A)

    // The filing stays reviewable: the band is about WHERE it belongs.
    expect(capture.status).toBe('needs_review')
    expect(events.filter(e => e.type === 'capture_needs_review')).toHaveLength(1)

    // The answer is not: the band is not about WHETHER an answer is owed.
    expect(turns).toEqual([{ sessionId: capture.strandId, text: ASK_A, agentId: 'main' }])

    // The turn owns the activity bump, so the strand counts one message, not two.
    const row = db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(capture.strandId) as { message_count: number }
    expect(row.message_count).toBe(0)
  })

  it('answers the second capture of the incident too', async () => {
    const capture = await fileMediumAsk(ASK_B)
    expect(capture.status).toBe('needs_review')
    expect(turns).toEqual([{ sessionId: capture.strandId, text: ASK_B, agentId: 'main' }])
  })

  it('does not answer twice when the review is confirmed after the answer arrived', async () => {
    const capture = await fileMediumAsk(ASK_A)
    expect(turns).toHaveLength(1)

    // The turn wrote its answer.
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'assistant', 'kommt')")
      .run(capture.strandId)

    const confirm = await api('POST', `/api/captures/${capture.id}/apply`, {})
    expect(confirm.status).toBe(200)
    expect((confirm.body.capture as Capture).status).toBe('filed')
    expect((confirm.body.decision as Decision).state).toBe('confirmed')
    expect(turns).toHaveLength(1)
  })

  it('does not answer twice when the review is confirmed while the turn is still running', async () => {
    const capture = await fileMediumAsk(ASK_A)
    expect(turns).toHaveLength(1)

    // No assistant row yet: the answer is still being generated. Confirming
    // the filing in that window must not start a second turn.
    expect(messagesIn(capture.strandId!).filter(m => m.role === 'assistant')).toEqual([])
    const confirm = await api('POST', `/api/captures/${capture.id}/apply`, {})
    expect(confirm.status).toBe(200)
    expect((confirm.body.capture as Capture).status).toBe('filed')
    expect(turns).toHaveLength(1)

    // And the activity count stays honest: nothing was bumped down for a turn
    // that was never started here.
    const row = db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(capture.strandId) as { message_count: number }
    expect(row.message_count).toBe(0)
  })

  it('still answers a needs_review ask that was filed before this change', async () => {
    // A row from the old behaviour: filed for review, intent ask, no turn ever
    // started. The catch-up on confirmation is what it depends on.
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Personas', personaId: 'coder', tags: [] },
      intent: 'note', confidence: 0.55, rationale: 'unsicher wohin',
    })
    // The old rows were notes; the router no longer produces one, so the
    // client states it to recreate that row.
    const res = await api('POST', '/api/captures', { text: 'winterreifen kaufen', intent: 'note' })
    const capture = res.body.capture as Capture
    expect(capture.status).toBe('needs_review')
    expect(turns).toEqual([])
    db.prepare("UPDATE router_decisions SET intent = 'ask' WHERE capture_id = ?").run(capture.id)
    db.prepare("UPDATE sessions SET agent_id = 'coder', working_mode = 'main' WHERE id = ?").run(capture.strandId)

    const confirm = await api('POST', `/api/captures/${capture.id}/apply`, {})
    expect(confirm.status).toBe(200)
    expect(turns).toEqual([{ sessionId: capture.strandId, text: 'winterreifen kaufen', agentId: 'coder' }])
    // One bump for the capture row, taken back by the belated turn, which does
    // its own bookkeeping from here on.
    const row = db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(capture.strandId) as { message_count: number }
    expect(row.message_count).toBe(0)
  })

  it('never answers into a foreign strand below the high band', async () => {
    const stranger = sessionManager.createThread('1', 'main', 'Fremder Strand')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'ganz anderes thema')")
      .run(stranger.id)
    answer({ action: 'append', strandId: stranger.id, intent: 'ask', confidence: 0.55, rationale: 'passt vielleicht' })

    const res = await api('POST', '/api/captures', { text: ASK_B })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision

    // `guardLowConfidenceAppend` opened a new strand, so the answer can only
    // land in a strand this capture created — never in a foreign history.
    expect(decision.action).toBe('new_strand')
    expect(capture.strandId).not.toBe(stranger.id)
    expect(messagesIn(stranger.id)).toHaveLength(1)
    expect(turns).toEqual([{ sessionId: capture.strandId, text: ASK_B, agentId: 'main' }])
  })

  it('answers a synthetic proposal too: the first capture of an empty instance', async () => {
    // No candidates at all, so `runRouter` short circuits to the synthetic
    // proposal (confidence forced to 0.5) without a model call. Its intent is
    // `ask` like every routed capture: there is no silent note category.
    const res = await api('POST', '/api/captures', { text: 'Kannst du mir bitte die Personas Seite bauen?' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(calls).toBe(0)
    expect(decision.model).toBe('synthetic')
    expect(decision.confidence).toBe(0.5)
    expect(decision.intent).toBe('ask')
    expect(capture.status).toBe('needs_review')
    expect(turns).toEqual([{ sessionId: capture.strandId, text: 'Kannst du mir bitte die Personas Seite bauen?', agentId: 'main' }])
  })

  it('runs no turn for a medium band note: only the intent decides, not the band', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Wartung', personaId: 'main', tags: [] },
      intent: 'ask', confidence: 0.55, rationale: 'eigene Liste',
    })
    // Only a client can still state a note; the router never proposes one.
    const res = await api('POST', '/api/captures', { text: 'Winterreifen kaufen. Bremsbeläge hinten sind durch.', intent: 'note' })
    const capture = res.body.capture as Capture
    expect(capture.status).toBe('needs_review')
    expect(turns).toEqual([])
    // A to-do list addresses nobody: no turn, and no question about it either.
    const assistant = messagesIn(capture.strandId!).filter(m => m.role === 'assistant')
    expect(assistant).toEqual([])
  })
})

describe('the router has no note category', () => {
  /**
   * "Notes" was removed as a routing category: the user never wanted a silent
   * filing and kept losing prompts to it. Whatever the model says about an
   * intent, a routed capture is an `ask` and gets its answer. The old guards
   * that corrected a wrong `note` afterwards are gone with it, so no
   * `capture guard: ... note ...` marker is written any more.
   */
  function candidate(): string {
    return sessionManager.createThread('1', 'main', 'Irgendein anderes Thema').id
  }

  function candidateWithAnswer(): string {
    const strand = sessionManager.createThread('1', 'main', 'Recorder')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'recorder bug')").run(strand.id)
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'assistant', 'fixed')").run(strand.id)
    return strand.id
  }

  it('answers a capture the model labels "note" when it opens a new strand', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Wartung', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.8, rationale: 'eigene Liste',
    })
    const res = await api('POST', '/api/captures', { text: 'Winterreifen kaufen.' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(decision.intent).toBe('ask')
    expect(decision.rationale).not.toMatch(/capture guard: (a )?note/)
    expect(turns).toEqual([{ sessionId: capture.strandId, text: 'Winterreifen kaufen.', agentId: 'main' }])
    const stored = db.prepare('SELECT intent FROM router_decisions WHERE id = ?').get(decision.id) as { intent: string }
    expect(stored.intent).toBe('ask')
  })

  it('answers a capture the model labels "note" when it appends to an existing strand', async () => {
    const strandId = candidateWithAnswer()
    answer({ action: 'append', strandId, intent: 'note', confidence: 0.9, rationale: 'gleicher Bug' })
    const res = await api('POST', '/api/captures', { text: 'Der Recorder bricht wieder ab.' })
    const decision = res.body.decision as Decision
    expect(decision.action).toBe('append')
    expect(decision.intent).toBe('ask')
    expect(turns).toEqual([{ sessionId: strandId, text: 'Der Recorder bricht wieder ab.', agentId: 'main' }])
  })

  it('writes no confirmation card for any routed capture', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Termin', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.8, rationale: 'eigener Termin',
    })
    const res = await api('POST', '/api/captures', { text: 'Termin beim Zahnarzt am Montag?' })
    const capture = res.body.capture as Capture
    const assistant = messagesIn(capture.strandId!).filter(m => m.role === 'assistant')
    expect(assistant.some(m => m.content.startsWith(CAPTURE_NUDGE_TEXT.de))).toBe(false)
    expect(assistant).toEqual([])
    expect((res.body.decision as Decision).intent).toBe('ask')
  })

  it('still honours a note the client states itself (explicit beats heuristic)', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Protokoll', personaId: 'main', tags: [] },
      intent: 'ask', confidence: 0.8, rationale: 'x',
    })
    const routed = await api('POST', '/api/captures', { text: 'nur fuers Protokoll', intent: 'note' })
    expect((routed.body.decision as Decision).intent).toBe('note')
    const strandId = candidateWithAnswer()
    const explicit = await api('POST', '/api/captures', { text: 'auch nur fuers Protokoll', strandId, intent: 'note' })
    expect((explicit.body.decision as Decision).intent).toBe('note')
    expect(turns).toEqual([])
  })

  it('answers a text typed into a chosen strand without a stated intent', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Explizit')
    const res = await api('POST', '/api/captures', { text: 'und das hier auch noch', strandId: strand.id })
    expect((res.body.decision as Decision).intent).toBe('ask')
    expect(turns).toEqual([{ sessionId: strand.id, text: 'und das hier auch noch', agentId: 'main' }])
  })
})

describe('the applied intent in the API payload', () => {
  /**
   * The app labels a capture "filed as note — no reply". The value it needs is
   * the intent that was actually applied, and it travels with the decision that
   * ships next to every capture — on create, in the list, on apply, on undo and
   * in the `capture_routed` frame. No extra field on the capture itself.
   */
  it('ships the applied intent next to the capture on every captures response', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Wartung')
    answer({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.9, rationale: 'liste' })
    // A note only exists when the client states it; the router never makes one.
    const created = await api('POST', '/api/captures', { text: 'Winterreifen kaufen', intent: 'note' })
    const capture = created.body.capture as Capture
    expect((created.body.decision as Decision).intent).toBe('note')

    const list = await api('GET', '/api/captures?status=filed')
    const listed = (list.body.decisions as Decision[]).find(d => d.captureId === capture.id)!
    expect(listed.intent).toBe('note')

    const target = sessionManager.createThread('1', 'main', 'Anderswo')
    const moved = await api('POST', `/api/captures/${capture.id}/undo`, { strandId: target.id })
    expect((moved.body.decision as Decision).intent).toBe('note')
    const confirmed = await api('POST', `/api/captures/${capture.id}/apply`, {})
    expect((confirmed.body.decision as Decision).intent).toBe('note')

    expect(events.filter(e => e.type === 'capture_routed').every(e => (e.decision as Decision).intent === 'note')).toBe(true)
  })
})

describe('apply and undo', () => {
  it('applies an alternative to an unsorted capture and undo before an answer is a true move', async () => {
    const a = sessionManager.createThread('1', 'main', 'A')
    const b = sessionManager.createThread('1', 'main', 'B')
    answer({
      action: 'append', strandId: a.id, confidence: 0.3, intent: 'note',
      alternatives: [{ action: 'append', strandId: b.id, confidence: 0.25, reason: 'maybe B' }],
    })
    const created = await api('POST', '/api/captures', { text: 'where do I go' })
    const captureId = (created.body.capture as Capture).id
    expect((created.body.capture as Capture).status).toBe('unsorted')

    const applied = await api('POST', `/api/captures/${captureId}/apply`, { action: 'append', strandId: b.id })
    expect(applied.status).toBe(200)
    expect((applied.body.capture as Capture).strandId).toBe(b.id)
    expect((applied.body.capture as Capture).status).toBe('filed')
    expect((applied.body.decision as Decision).model).toBe('user')
    expect((applied.body.decision as Decision).state).toBe('applied')
    expect(messagesIn(b.id).length).toBe(1)

    // Undo with a new target: the row moves, the old decision is undone.
    const moved = await api('POST', `/api/captures/${captureId}/undo`, { strandId: a.id })
    expect(moved.status).toBe(200)
    expect((moved.body.capture as Capture).status).toBe('moved')
    expect((moved.body.capture as Capture).strandId).toBe(a.id)
    expect(messagesIn(b.id).length).toBe(0)
    expect(messagesIn(a.id).length).toBe(1)
    expect(sessionManager.getThread('1', b.id)!.messageCount).toBe(0)
    const states = (db.prepare('SELECT state FROM router_decisions WHERE capture_id = ? ORDER BY rowid').all(captureId) as { state: string }[]).map(r => r.state)
    expect(states).toEqual(['superseded', 'undone', 'applied'])

    // Undo without a target: back to unsorted, and a second undo is a no-op 200.
    const back = await api('POST', `/api/captures/${captureId}/undo`, {})
    expect((back.body.capture as Capture).status).toBe('unsorted')
    expect((back.body.capture as Capture).strandId).toBeNull()
    expect(messagesIn(a.id).length).toBe(0)
    const twice = await api('POST', `/api/captures/${captureId}/undo`, {})
    expect(twice.status).toBe(200)
    expect((twice.body.decision as Decision).state).toBe('undone')
  })

  it('deletes a strand the undone decision created when it is empty', async () => {
    sessionManager.createThread('1', 'main', 'Existing')
    answer({ action: 'new_strand', newStrand: { title: 'Fresh', personaId: 'main', tags: [] }, confidence: 0.8 })
    const created = await api('POST', '/api/captures', { text: 'brand new' })
    const capture = created.body.capture as Capture
    expect(sessionManager.getThread('1', capture.strandId!)).not.toBeNull()
    await api('POST', `/api/captures/${capture.id}/undo`, {})
    expect(sessionManager.getThread('1', capture.strandId!)).toBeNull()
  })

  it('after an answer exists the undo badges, links and re-files as a fresh capture', async () => {
    const a = sessionManager.createThread('1', 'main', 'Deploy talk')
    const b = sessionManager.createThread('1', 'main', 'Roof')
    answer({ action: 'append', strandId: a.id, confidence: 0.9, intent: 'ask' })
    const created = await api('POST', '/api/captures', { text: 'roofer quote?' })
    const capture = created.body.capture as Capture
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'assistant', 'answer', 'main')").run(a.id)

    const undone = await api('POST', `/api/captures/${capture.id}/undo`, { strandId: b.id })
    expect(undone.status).toBe(200)
    const fresh = undone.body.capture as Capture
    expect(fresh.id).not.toBe(capture.id)
    expect(fresh.strandId).toBe(b.id)
    expect(fresh.text).toBe('moved from Deploy talk\nroofer quote?')
    expect(messagesIn(a.id).length).toBe(2)
    expect(JSON.parse(messagesIn(a.id)[0].metadata!)).toEqual({ misfiled: true })
    expect(messagesIn(b.id)[0].content).toContain('moved from Deploy talk')
    const old = db.prepare('SELECT status FROM captures WHERE id = ?').get(capture.id) as { status: string }
    expect(old.status).toBe('moved')
    const links = db.prepare('SELECT from_strand, to_strand, kind FROM strand_links').all() as Array<{ from_strand: string; to_strand: string; kind: string }>
    expect(links).toEqual([{ from_strand: a.id, to_strand: b.id, kind: 'moved_from' }])
    expect(turns.length).toBe(1)
  })

  it('refuses foreign captures and stale decisions', async () => {
    const a = sessionManager.createThread('1', 'main', 'A')
    answer({ action: 'append', strandId: a.id, confidence: 0.9 })
    const created = await api('POST', '/api/captures', { text: 'mine' })
    const id = (created.body.capture as Capture).id
    expect((await api('POST', `/api/captures/${id}/apply`, {}, userToken)).status).toBe(404)
    expect((await api('POST', `/api/captures/${id}/undo`, {}, userToken)).status).toBe(404)
    expect((await api('POST', `/api/captures/${id}/apply`, { decisionId: 'stale' })).status).toBe(409)
  })
})

describe('projects in routing (SPEC 4.2b)', () => {
  it('sets the project of a new strand and gives it back on undo', async () => {
    createProject('p_wartung', 'Project Beta')
    sessionManager.createThread('1', 'main', 'Existing')
    answer({
      action: 'new_strand',
      newStrand: { title: 'Bremsbelaege hinten', personaId: 'main', tags: ['bremsen'], projectId: 'p_wartung' },
      intent: 'note', confidence: 0.8, rationale: 'brake pads belong to the bike log',
    })
    const res = await api('POST', '/api/captures', { text: 'rear brake pads are done, order new ones' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(capture.status).toBe('filed')
    expect(decision.projectId).toBe('p_wartung')
    expect(decision.projectSuggestion).toBeNull()
    expect(projectOf(capture.strandId!)).toBe('p_wartung')

    // The project list reached the model, as the first block of the prompt.
    expect(prompts[0].startsWith('Projects of this user (id, name):')).toBe(true)
    expect(prompts[0]).toContain('Project Beta')

    // Undo before an answer: the created strand is deleted, so the project
    // assignment is gone with it.
    await api('POST', `/api/captures/${capture.id}/undo`, {})
    expect(sessionManager.getThread('1', capture.strandId!)).toBeNull()
    expect(projectOf(capture.strandId!)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE project_id IS NOT NULL').get()).toEqual({ c: 0 })
  })

  it('keeps the project when an unsorted new_strand decision is confirmed by the product owner', async () => {
    createProject('p_demo', 'Demo App')
    sessionManager.createThread('1', 'main', 'Existing')
    answer({
      action: 'new_strand',
      newStrand: { title: 'Pricing page conversion', personaId: 'main', tags: [], projectId: 'p_demo' },
      confidence: 0.3,
    })
    const created = await api('POST', '/api/captures', { text: 'the pricing page converts badly' })
    const capture = created.body.capture as Capture
    expect(capture.status).toBe('unsorted')
    expect((created.body.decision as Decision).projectId).toBe('p_demo')

    const applied = await api('POST', `/api/captures/${capture.id}/apply`, {})
    const filed = applied.body.capture as Capture
    expect(filed.status).toBe('filed')
    expect(projectOf(filed.strandId!)).toBe('p_demo')
  })

  it('stores a project suggestion for an existing strand without applying it', async () => {
    const project = createProject('p_alpha', 'Project Alpha')
    const strand = sessionManager.createThread('1', 'main', 'Loop planner ideas')
    answer({
      action: 'append', strandId: strand.id, intent: 'note', confidence: 0.8,
      projectSuggestion: { projectId: project, confidence: 0.7, reason: 'the strand is about the loop planner' },
    })
    const res = await api('POST', '/api/captures', { text: 'the elevation filter should be a slider' })
    const decision = res.body.decision as Decision
    expect(decision.projectSuggestion).toEqual({
      projectId: 'p_alpha', confidence: 0.7, reason: 'the strand is about the loop planner',
    })
    // Suggest, do not auto apply: the strand is untouched.
    expect(projectOf(strand.id)).toBeNull()

    // And it is delivered again through the list endpoint, for a later card.
    const list = await api('GET', '/api/captures?status=filed')
    expect((list.body.decisions as Decision[])[0].projectSuggestion?.projectId).toBe('p_alpha')
  })

  it('drops a weak suggestion and one for a strand that already has a project', async () => {
    const project = createProject('p_gamma', 'Project Gamma')
    const loose = sessionManager.createThread('1', 'main', 'Tile ideas')
    const taken = sessionManager.createThread('1', 'main', 'Tile printing', 'p_gamma')

    answer({
      action: 'append', strandId: loose.id, confidence: 0.8,
      projectSuggestion: { projectId: project, confidence: 0.4, reason: 'not sure' },
    })
    const weak = await api('POST', '/api/captures', { text: 'maybe a hex grid' })
    expect((weak.body.decision as Decision).projectSuggestion).toBeNull()

    answer({
      action: 'append', strandId: taken.id, confidence: 0.8,
      projectSuggestion: { projectId: project, confidence: 0.95, reason: 'already there' },
    })
    const occupied = await api('POST', '/api/captures', { text: 'the printer ran out of filament' })
    expect((occupied.body.decision as Decision).projectSuggestion).toBeNull()
    expect(projectOf(taken.id)).toBe('p_gamma')
  })

  it('treats an invented project id as a malformed answer and never files into it', async () => {
    createProject('p_real', 'Project Delta')
    sessionManager.createThread('1', 'main', 'Existing')
    answer({ action: 'new_strand', newStrand: { title: 'Ghost', personaId: 'main', tags: [], projectId: 'p_ghost' }, confidence: 0.9 })
    answer({ action: 'new_strand', newStrand: { title: 'Ghost', personaId: 'main', tags: [], projectId: 'p_ghost' }, confidence: 0.9 })
    const res = await api('POST', '/api/captures', { text: 'invented project' })
    expect(calls).toBe(2)
    expect(prompts[1]).toContain('previous answer was rejected')
    expect((res.body.capture as Capture).status).toBe('failed')
    expect((res.body.decision as Decision).model).toBe('synthetic')
    expect((res.body.decision as Decision).projectId).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE project_id IS NOT NULL').get()).toEqual({ c: 0 })
  })

  it('works unchanged when the user has no projects and when the model ignores them', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Dinner')
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.8, tags: ['essen'] })
    const res = await api('POST', '/api/captures', { text: 'what do I cook tonight' })
    expect((res.body.capture as Capture).status).toBe('filed')
    const decision = res.body.decision as Decision
    expect(decision.projectId).toBeNull()
    expect(decision.projectSuggestion).toBeNull()
    expect(prompts[0]).not.toContain('Projects of this user')
    expect(prompts[0].startsWith('Route this capture.')).toBe(true)
  })

  it('files without a project when the proposed project vanished before filing', async () => {
    createProject('p_gone', 'Gone soon')
    sessionManager.createThread('1', 'main', 'Existing')
    answer({ action: 'new_strand', newStrand: { title: 'Late', personaId: 'main', tags: [], projectId: 'p_gone' }, confidence: 0.3 })
    const created = await api('POST', '/api/captures', { text: 'slow decision' })
    const capture = created.body.capture as Capture
    expect((created.body.decision as Decision).projectId).toBe('p_gone')

    db.prepare('DELETE FROM projects WHERE id = ?').run('p_gone')
    const applied = await api('POST', `/api/captures/${capture.id}/apply`, {})
    expect(applied.status).toBe(200)
    const filed = applied.body.capture as Capture
    expect(filed.status).toBe('filed')
    expect(projectOf(filed.strandId!)).toBeNull()
  })
})

describe('POST /api/router/preview', () => {
  it('is admin only and writes nothing', async () => {
    const a = sessionManager.createThread('1', 'main', 'A')
    expect((await api('POST', '/api/router/preview', { text: 'x' }, userToken)).status).toBe(403)
    answer({ action: 'append', strandId: a.id, confidence: 0.9, intent: 'note', rationale: 'because' })
    const res = await api('POST', '/api/router/preview', { text: 'x' })
    expect(res.status).toBe(200)
    const decision = res.body.decision as Record<string, unknown>
    expect(decision.strandId).toBe(a.id)
    expect(decision.confidence).toBe(0.9)
    expect(decision.model).toBe('p:stub')

    // The preview shows what would really happen, guard included: an append
    // below the high band previews as a new strand with the target kept.
    answer({ action: 'append', strandId: a.id, confidence: 0.66, intent: 'note', rationale: 'because' })
    const guarded = (await api('POST', '/api/router/preview', { text: 'x' })).body.decision as Record<string, unknown>
    expect(guarded.action).toBe('new_strand')
    expect(guarded.strandId).toBeNull()
    expect(guarded.confidence).toBe(0.66)
    expect((guarded.alternatives as Array<{ strandId: string }>)[0].strandId).toBe(a.id)

    expect((db.prepare('SELECT COUNT(*) AS c FROM captures').get() as { c: number }).c).toBe(0)
  })
})

describe('capture model selection', () => {
  const selection = { modelProviderId: 'chosen', modelId: 'model' }
  const override = { providerId: 'chosen', modelId: 'model' }

  it.each([
    { modelProviderId: 'chosen' }, { modelId: 'model' },
    { modelProviderId: null, modelId: null }, { modelProviderId: ' ', modelId: 'model' },
    { modelProviderId: 3, modelId: 'model' }, { modelProviderId: 'missing', modelId: 'model' },
    { modelProviderId: 'chosen', modelId: 'disabled' },
  ])('rejects invalid or unavailable selection %j without writing a capture', async fields => {
    expect((await api('POST', '/api/captures', { text: 'x', ...fields })).status).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS n FROM captures').get()).toEqual({ n: 0 })
  })

  it('rejects an errored model with a clear code before routing or writing', async () => {
    saveProviders({ providers: [{ id: 'chosen', name: 'Chosen', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['model'], modelStatuses: { model: 'error' } }] })
    const result = await api('POST', '/api/captures', { text: 'question', ...selection })
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('model_unavailable')
    expect(calls).toBe(0)
    expect(turns).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM captures').get()).toEqual({ n: 0 })
  })

  it('passes an explicit append override without replacing the existing pin; retries do not run again', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Existing')
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('original', 'original-model', strand.id)
    const body = { text: 'question', intent: 'ask', strandId: strand.id, clientMessageId: 'model-retry', ...selection }
    expect((await api('POST', '/api/captures', body)).status).toBe(201)
    expect(turns[0]?.turnModelOverride).toEqual(override)
    expect(db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get(strand.id))
      .toEqual({ model_provider_id: 'original', model_id: 'original-model' })
    expect((await api('POST', '/api/captures', body)).status).toBe(200)
    expect(turns).toHaveLength(1)
  })

  it('pins a router-created strand and passes the selection to its first turn', async () => {
    sessionManager.createThread('1', 'main', 'Candidate')
    answer({ action: 'new_strand', newStrand: { title: 'New', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.9, tags: [] })
    const res = await api('POST', '/api/captures', { text: 'question', intent: 'ask', ...selection })
    expect(res.status).toBe(201)
    const capture = res.body.capture as Capture
    expect(turns[0]?.turnModelOverride).toEqual(override)
    expect(db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get(capture.strandId))
      .toEqual({ model_provider_id: 'chosen', model_id: 'model' })
  })

  it('restores the override from storage when a note is confirmed after service recreation', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Existing')
    const res = await api('POST', '/api/captures', { text: 'some thought', strandId: strand.id, intent: 'note', ...selection })
    const capture = res.body.capture as Capture
    expect(turns).toHaveLength(0)
    const restarted = createCapturesService({ db, getAgentCore: () => ({ getSessionManager: () => sessionManager }) as unknown as AgentCore,
      getTurnRunner: () => ({ startTurn: input => { turns.push(input) } }) })
    expect(restarted.confirmNoteFiling(1, { captureId: capture.id, blockId: CAPTURE_CONFIRM_BLOCK_ID, choice: CAPTURE_CONFIRM_ANSWER }).resumed).toBe(true)
    expect(turns[0]?.turnModelOverride).toEqual(override)
  })

  it('retains selection while unsorted and pins it when later filed into a new strand', async () => {
    sessionManager.createThread('1', 'main', 'Candidate')
    answer({ action: 'new_strand', newStrand: { title: 'Deferred', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.2, tags: [] })
    const res = await api('POST', '/api/captures', { text: 'question', intent: 'ask', ...selection })
    const capture = res.body.capture as Capture
    expect(capture.status).toBe('unsorted')
    expect(turns).toHaveLength(0)
    const applied = await api('POST', `/api/captures/${capture.id}/apply`, { action: 'new_strand', title: 'Chosen later' })
    expect(applied.status).toBe(200)
    expect(turns[0]?.turnModelOverride).toEqual(override)
    expect(db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get((applied.body.capture as Capture).strandId))
      .toEqual({ model_provider_id: 'chosen', model_id: 'model' })
  })

  it('rejects a persisted selection that becomes unavailable before note confirmation', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Existing')
    const res = await api('POST', '/api/captures', { text: 'some thought', strandId: strand.id, intent: 'note', ...selection })
    const capture = res.body.capture as Capture
    saveProviders({ providers: [] })
    const restarted = createCapturesService({ db, getAgentCore: () => ({ getSessionManager: () => sessionManager }) as unknown as AgentCore,
      getTurnRunner: () => ({ startTurn: input => { turns.push(input) } }) })
    expect(() => restarted.confirmNoteFiling(1, { captureId: capture.id, blockId: CAPTURE_CONFIRM_BLOCK_ID, choice: CAPTURE_CONFIRM_ANSWER }))
      .toThrow(expect.objectContaining({ status: 400, code: 'model_unavailable' }))
    expect(turns).toHaveLength(0)
  })

  it('returns 404 for foreign strands and 409 for busy owned strands without writes', async () => {
    const foreign = sessionManager.createThread('2', 'main', 'Foreign')
    expect((await api('POST', '/api/captures', { text: 'x', strandId: foreign.id, ...selection })).status).toBe(404)
    const own = sessionManager.createThread('1', 'main', 'Own')
    busySessions.push(own.id)
    expect((await api('POST', '/api/captures', { text: 'x', strandId: own.id, ...selection })).status).toBe(409)
    expect(db.prepare('SELECT COUNT(*) AS n FROM captures').get()).toEqual({ n: 0 })
  })
})


it('keeps an explicitly selected specialist direct, while topic-only auto creates a Main Auto strand', async () => {
  const automatic = await api('POST', '/api/captures', { text: 'Plan a samplebot campaign', destination: 'new_strand' })
  const autoCapture = automatic.body.capture as Capture
  expect(sessionManager.getThread('1', autoCapture.strandId!)).toMatchObject({ agentId: 'main', workingMode: 'auto' })
  const direct = await api('POST', '/api/captures', { text: 'Code a parser', destination: 'new_strand', agentId: 'coder' })
  const directCapture = direct.body.capture as Capture
  expect(sessionManager.getThread('1', directCapture.strandId!)).toMatchObject({ agentId: 'coder', workingMode: 'main' })
})
