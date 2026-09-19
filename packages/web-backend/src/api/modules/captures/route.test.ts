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
import { initDatabase, saveProviders, SessionManager, findInteractionBlock } from '@axiom/core'
import type { AgentCore, Capture, Database, Decision, ResolvedRouterModel } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import {
  createCapturesService, NOTE_IN_DIALOG_MARKER, ADDRESSED_NOTE_MARKER, DOUBTFUL_NOTE_MARKER, CAPTURE_NUDGE_TEXT,
  CAPTURE_CONFIRM_BLOCK_ID, CAPTURE_CONFIRM_QUESTION, CAPTURE_CONFIRM_LABELS,
  CAPTURE_CONFIRM_KEEP, CAPTURE_CONFIRM_ANSWER,
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
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })
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
  const strands = createStrandsRouters({ db, getAgentCore, chatEventBus: bus })
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

    const res = await api('POST', '/api/captures', { text: 'roofer called back, 4200 for the north side', clientMessageId: 'c-1' })
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
    const again = await api('POST', '/api/captures', { text: 'roofer called back, 4200 for the north side', clientMessageId: 'c-1' })
    expect(again.status).toBe(200)
    expect((again.body.capture as Capture).id).toBe(capture.id)
    expect(calls).toBe(1)
  })

  it('runs a turn for intent ask in the high band, and reviews the filing without withholding the answer', async () => {
    const strand = sessionManager.createThread('1', 'bob', 'Deploy')
    answer({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.9 })
    const high = await api('POST', '/api/captures', { text: 'is the deploy green?' })
    expect((high.body.capture as Capture).status).toBe('filed')
    expect(turns).toEqual([{ sessionId: strand.id, text: 'is the deploy green?', agentId: 'bob' }])

    // Below the high band the router guard opens a new strand instead of
    // appending, so the filing is reviewable — but the answer is not withheld.
    answer({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.5 })
    const medium = await api('POST', '/api/captures', { text: 'and the canary?' })
    const mediumCapture = medium.body.capture as Capture
    expect(mediumCapture.status).toBe('needs_review')
    expect(mediumCapture.strandId).not.toBe(strand.id)
    expect(turns.length).toBe(2)
    expect(turns[1]).toEqual({ sessionId: mediumCapture.strandId, text: 'and the canary?', agentId: 'bob' })
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

  it('creates a new strand for a high confidence new_strand and marks router failure as failed', async () => {
    sessionManager.createThread('1', 'main', 'Existing')
    answer({ action: 'new_strand', newStrand: { title: 'Dach Angebot Nord', personaId: 'bob', tags: ['dach'] }, intent: 'note', confidence: 0.75 })
    const res = await api('POST', '/api/captures', { text: 'new topic' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(capture.status).toBe('filed')
    expect(decision.createdStrandId).toBe(capture.strandId)
    const created = sessionManager.getThread('1', capture.strandId!)!
    expect(created.title).toBe('Dach Angebot Nord')
    expect(created.agentId).toBe('bob')
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
      action: 'new_strand', newStrand: { title: 'Personas', personaId: 'bob', tags: [] },
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
    expect(turns).toEqual([{ sessionId: capture.strandId, text: ASK_A, agentId: 'bob' }])

    // The turn owns the activity bump, so the strand counts one message, not two.
    const row = db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(capture.strandId) as { message_count: number }
    expect(row.message_count).toBe(0)
  })

  it('answers the second capture of the incident too', async () => {
    const capture = await fileMediumAsk(ASK_B)
    expect(capture.status).toBe('needs_review')
    expect(turns).toEqual([{ sessionId: capture.strandId, text: ASK_B, agentId: 'bob' }])
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
      action: 'new_strand', newStrand: { title: 'Personas', personaId: 'bob', tags: [] },
      intent: 'note', confidence: 0.55, rationale: 'unsicher wohin',
    })
    const res = await api('POST', '/api/captures', { text: 'winterreifen kaufen' })
    const capture = res.body.capture as Capture
    expect(capture.status).toBe('needs_review')
    expect(turns).toEqual([])
    db.prepare("UPDATE router_decisions SET intent = 'ask' WHERE capture_id = ?").run(capture.id)

    const confirm = await api('POST', `/api/captures/${capture.id}/apply`, {})
    expect(confirm.status).toBe(200)
    expect(turns).toEqual([{ sessionId: capture.strandId, text: 'winterreifen kaufen', agentId: 'bob' }])
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
    // proposal (intent `note`, confidence forced to 0.5) without a model call.
    // `guardAddressedNote` upgrades the intent from the text, which is why
    // `syntheticProposal` itself does not need to guess one.
    const res = await api('POST', '/api/captures', { text: 'Kannst du mir bitte die Personas Seite bauen?' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(calls).toBe(0)
    expect(decision.model).toBe('synthetic')
    expect(decision.confidence).toBe(0.5)
    expect(decision.intent).toBe('ask')
    expect(decision.rationale).toContain(ADDRESSED_NOTE_MARKER)
    expect(capture.status).toBe('needs_review')
    expect(turns).toEqual([{ sessionId: capture.strandId, text: 'Kannst du mir bitte die Personas Seite bauen?', agentId: 'main' }])
  })

  it('runs no turn for a medium band note: only the intent decides, not the band', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Werkstatt', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.55, rationale: 'eigene Liste',
    })
    const res = await api('POST', '/api/captures', { text: 'Winterreifen kaufen. Bremsbeläge hinten sind durch.' })
    const capture = res.body.capture as Capture
    expect(capture.status).toBe('needs_review')
    expect(turns).toEqual([])
    // A to-do list addresses nobody: no turn, and no question about it either.
    const assistant = messagesIn(capture.strandId!).filter(m => m.role === 'assistant')
    expect(assistant).toEqual([])
  })
})

describe('note into a live dialog', () => {
  /** A strand a persona has already answered in: the interactive dialog case. */
  function dialogStrand(title: string, agentId = 'bob'): string {
    const strand = sessionManager.createThread('1', agentId, title)
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'der zeilenumbruch im recorder ist komisch')").run(strand.id)
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'assistant', 'ich schau es mir an')").run(strand.id)
    return strand.id
  }

  it('upgrades a note into a strand with assistant history to ask, starts the turn and says so in the rationale', async () => {
    const strandId = dialogStrand('Recorder UI')
    answer({ action: 'append', strandId, intent: 'note', confidence: 0.9, rationale: 'gleicher Recorder Bug' })

    const text = 'Ich habe keine Push Notification bekommen. Schau dir den Zeilenumbruch bitte nochmal an.'
    const res = await api('POST', '/api/captures', { text })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision

    expect(decision.intent).toBe('ask')
    expect(decision.rationale).toContain(NOTE_IN_DIALOG_MARKER)
    expect(decision.rationale).toContain('gleicher Recorder Bug')
    expect(capture.status).toBe('filed')
    expect(turns).toEqual([{ sessionId: strandId, text, agentId: 'bob' }])

    // The applied intent is what the stored row and the API payload carry, so
    // `router_decisions` stays countable and the app can label the capture.
    const stored = db.prepare('SELECT intent, rationale FROM router_decisions WHERE id = ?').get(decision.id) as { intent: string; rationale: string }
    expect(stored.intent).toBe('ask')
    expect(stored.rationale).toContain(NOTE_IN_DIALOG_MARKER)
    const list = await api('GET', '/api/captures?status=filed')
    expect((list.body.decisions as Decision[])[0].intent).toBe('ask')
    const routed = events.find(e => e.type === 'capture_routed')
    expect((routed?.decision as Decision).intent).toBe('ask')
  })

  it('leaves a note in a strand without any assistant answer alone', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Werkstatt')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'winterreifen kaufen')").run(strand.id)
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.9, rationale: 'gleiche Werkstattliste' })

    const res = await api('POST', '/api/captures', { text: 'Bremsbelaege hinten sind durch' })
    const decision = res.body.decision as Decision
    expect(decision.intent).toBe('note')
    expect(decision.rationale).toBe('gleiche Werkstattliste')
    expect(turns.length).toBe(0)
  })

  it('does not claim a new_strand: that one belongs to the text backstop, not to this guard', async () => {
    dialogStrand('Recorder UI')
    answer({
      action: 'new_strand', newStrand: { title: 'Push fehlt + Recorder Bug', personaId: 'bob', tags: [] },
      intent: 'note', confidence: 0.8, rationale: 'eigenes Thema',
    })
    const res = await api('POST', '/api/captures', { text: 'Schau dir den Recorder bitte mal an, da fehlt die Push' })
    const decision = res.body.decision as Decision
    expect(decision.action).toBe('new_strand')
    // A strand that does not exist yet has no history, so this guard stays
    // out; the text backstop below is what answers the capture.
    expect(decision.rationale).not.toContain(NOTE_IN_DIALOG_MARKER)
    expect(decision.intent).toBe('ask')
  })

  it('respects an intent the client states itself, in both paths', async () => {
    const strandId = dialogStrand('Recorder UI', 'main')
    answer({ action: 'append', strandId, intent: 'ask', confidence: 0.9, rationale: 'x' })
    const routed = await api('POST', '/api/captures', { text: 'nur fuers Protokoll', intent: 'note' })
    expect((routed.body.decision as Decision).intent).toBe('note')
    expect((routed.body.decision as Decision).rationale).not.toContain(NOTE_IN_DIALOG_MARKER)
    expect(turns.length).toBe(0)

    const explicit = await api('POST', '/api/captures', { text: 'auch nur fuers Protokoll', strandId, intent: 'note' })
    expect((explicit.body.decision as Decision).intent).toBe('note')
    expect(turns.length).toBe(0)
  })

  it('does not reach an append the low confidence guard already turned into a new strand (known gap)', async () => {
    const strandId = dialogStrand('Recorder UI')
    answer({ action: 'append', strandId, intent: 'note', confidence: 0.5, rationale: 'vielleicht dort' })
    const res = await api('POST', '/api/captures', { text: 'und der Umbruch ist immer noch komisch' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    // SPEC 4.4 turns the sub-0.7 append into a new strand before this guard
    // sees it, and a fresh strand has no history to judge. Documented in
    // FOLLOWUPS.md. The text of this capture names no addressee either, so
    // the backstop stays out as well and the note survives.
    expect(decision.action).toBe('new_strand')
    expect(decision.intent).toBe('note')
    expect(capture.status).toBe('needs_review')
    expect(turns.length).toBe(0)
  })

  it('starts the turn on confirmation when the guard upgraded a medium band append into the dialog', async () => {
    const strandId = dialogStrand('Recorder UI')
    // 0.7 keeps the append (the low confidence guard starts below it) and the
    // band is high, so this is the guard's own path end to end.
    answer({ action: 'append', strandId, intent: 'note', confidence: 0.7, rationale: 'gleicher Bug' })
    const res = await api('POST', '/api/captures', { text: 'und der Umbruch ist immer noch komisch' })
    const decision = res.body.decision as Decision
    expect(decision.action).toBe('append')
    expect(decision.intent).toBe('ask')
    expect(turns.length).toBe(1)
  })
})

describe('a note that talks to you (text backstop)', () => {
  /** The capture of the incident, verbatim, the way it was dictated. */
  const INCIDENT = 'Ich habe keine Push Notification bekommen, nachdem du deine Aufgabe gerade beendet hattest. Und der Zeilenumbruch im Recorder ist immer noch komisch. Schau dir den bitte mal auf einem Screenshot in Originalgröße an.'

  /**
   * One strand with substance, so the router is really asked: without a single
   * candidate `runRouter` short circuits to the synthetic proposal and the
   * stubbed answer below would never be read.
   */
  function candidate(): string {
    return sessionManager.createThread('1', 'main', 'Irgendein anderes Thema').id
  }

  it('answers the incident capture even though it opens a fresh strand', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Push fehlt + Recorder Umbruch', personaId: 'bob', tags: ['bug'] },
      intent: 'note', confidence: 0.8, rationale: 'eigenes Thema, keine passende Strand-Historie',
    })

    const res = await api('POST', '/api/captures', { text: INCIDENT })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision

    expect(decision.action).toBe('new_strand')
    expect(decision.intent).toBe('ask')
    expect(decision.rationale).toContain(ADDRESSED_NOTE_MARKER)
    // The model keeps its own words behind the marker.
    expect(decision.rationale).toContain('eigenes Thema')
    expect(capture.status).toBe('filed')
    expect(turns).toEqual([{ sessionId: capture.strandId, text: INCIDENT, agentId: 'bob' }])

    // Countable in router_decisions, and separable from the dialog guard.
    const stored = db.prepare('SELECT intent, rationale FROM router_decisions WHERE id = ?').get(decision.id) as { intent: string; rationale: string }
    expect(stored.intent).toBe('ask')
    expect(stored.rationale).toContain(ADDRESSED_NOTE_MARKER)
    expect(stored.rationale).not.toContain(NOTE_IN_DIALOG_MARKER)
    const routed = events.find(e => e.type === 'capture_routed')
    expect((routed?.decision as Decision).intent).toBe('ask')
  })

  it('leaves a real self-note in a new strand a note, without a turn', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Werkstatt', personaId: 'main', tags: ['auto'] },
      intent: 'note', confidence: 0.8, rationale: 'eigene Liste',
    })
    const res = await api('POST', '/api/captures', { text: 'Winterreifen kaufen. Bremsbeläge hinten sind durch.' })
    const decision = res.body.decision as Decision
    expect(decision.intent).toBe('note')
    expect(decision.rationale).toBe('eigene Liste')
    expect(turns.length).toBe(0)
  })

  it('keeps a capture that calls itself a note a note, second person and all', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Reifen', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.8, rationale: 'Merkzettel',
    })
    const res = await api('POST', '/api/captures', { text: 'Nur als Notiz: du musst noch die Reifen wechseln.' })
    const decision = res.body.decision as Decision
    expect(decision.intent).toBe('note')
    expect(decision.rationale).not.toContain(ADDRESSED_NOTE_MARKER)
    expect(turns.length).toBe(0)
  })

  it('never overrides an intent the client states itself (SPEC 4.1)', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Recorder', personaId: 'main', tags: [] },
      intent: 'ask', confidence: 0.8, rationale: 'x',
    })
    const res = await api('POST', '/api/captures', { text: 'Schau dir den Recorder bitte mal an', intent: 'note' })
    const decision = res.body.decision as Decision
    expect(decision.intent).toBe('note')
    expect(decision.rationale).not.toContain(ADDRESSED_NOTE_MARKER)
    expect(turns.length).toBe(0)
  })

  it('writes exactly one marker when the capture drops into a live dialog', async () => {
    const strand = sessionManager.createThread('1', 'bob', 'Recorder UI')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'umbruch')").run(strand.id)
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'assistant', 'schau ich mir an')").run(strand.id)
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.9, rationale: 'gleicher Bug' })

    const res = await api('POST', '/api/captures', { text: 'Kannst du den Zeilenumbruch fixen?' })
    const decision = res.body.decision as Decision
    expect(decision.intent).toBe('ask')
    // The first guard that fires owns the rationale, the second stays silent.
    expect(decision.rationale).toContain(NOTE_IN_DIALOG_MARKER)
    expect(decision.rationale).not.toContain(ADDRESSED_NOTE_MARKER)
    expect(turns.length).toBe(1)
  })

  it('also catches the note the low confidence guard turned into a new strand', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Recorder UI')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'umbruch')").run(strand.id)
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.5, rationale: 'vielleicht dort' })
    // Second person plus question mark: two classes, no doubt left.
    const res = await api('POST', '/api/captures', { text: 'Kannst du mal nachsehen, warum der Deploy rot ist?' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(decision.action).toBe('new_strand')
    expect(decision.intent).toBe('ask')
    expect(decision.rationale).toContain(ADDRESSED_NOTE_MARKER)
    // Medium band: the filing is reviewable, the answer is not deferred, and
    // confirming the filing afterwards does not answer a second time.
    expect(capture.status).toBe('needs_review')
    expect(turns).toEqual([{ sessionId: capture.strandId, text: 'Kannst du mal nachsehen, warum der Deploy rot ist?', agentId: 'main' }])
    await api('POST', `/api/captures/${capture.id}/apply`, {})
    expect(turns.length).toBe(1)
  })
})

describe('the doubt band: a note that might be addressed at you', () => {
  /** The capture of the incident, verbatim. Two marker classes, so: strong. */
  const INCIDENT = 'Ich habe keine Push Notification bekommen, nachdem du deine Aufgabe gerade beendet hattest. Und der Zeilenumbruch im Recorder ist immer noch komisch. Schau dir den bitte mal auf einem Screenshot in Originalgröße an.'

  /** One strand with substance so the router is really asked (see above). */
  function candidate(): string {
    return sessionManager.createThread('1', 'main', 'Irgendein anderes Thema').id
  }

  function assistantRows(strandId: string) {
    return messagesIn(strandId).filter(m => m.role === 'assistant')
  }

  it('files the note, starts no turn, asks once and rings once', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Zahnarzt', personaId: 'bob', tags: ['termin'] },
      intent: 'note', confidence: 0.8, rationale: 'eigener Termin',
    })

    const res = await api('POST', '/api/captures', { text: 'Termin beim Zahnarzt am Montag?' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision

    // The band does NOT upgrade the intent: no turn, no unsolicited answer.
    expect(decision.intent).toBe('note')
    expect(capture.status).toBe('filed')
    expect(turns).toEqual([])

    // Exactly one question, in the strand the capture was filed into, German
    // because the capture is German.
    const rows = messagesIn(capture.strandId!)
    expect(rows.map(r => r.role)).toEqual(['user', 'assistant'])
    expect(rows[1].content).toContain(CAPTURE_NUDGE_TEXT.de)
    expect(findInteractionBlock(rows[1].content, CAPTURE_CONFIRM_BLOCK_ID)?.question).toBe(CAPTURE_CONFIRM_QUESTION.de)
    expect(rows[1].capture_id).toBe(capture.id)

    // Countable in router_decisions, separate from both other guards.
    const stored = db.prepare('SELECT intent, rationale FROM router_decisions WHERE id = ?').get(decision.id) as { intent: string; rationale: string }
    expect(stored.intent).toBe('note')
    expect(stored.rationale).toContain(DOUBTFUL_NOTE_MARKER)
    expect(stored.rationale).toContain('eigener Termin')
    expect(stored.rationale).not.toContain(ADDRESSED_NOTE_MARKER)
    expect(stored.rationale).not.toContain(NOTE_IN_DIALOG_MARKER)

    // The doorbell: a real question, so it must survive suppress-when-online=turn.
    expect(doorbells).toHaveLength(1)
    expect(doorbells[0]).toMatchObject({ kind: 'question', strandId: capture.strandId, agentId: 'bob', userId: 1 })
    expect(doorbells[0].messageId).toBe(rows[1].id)

    // And the strand looks like something is waiting: activity was bumped for
    // both rows, so it sorts to the top of the list.
    const row = db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(capture.strandId) as { message_count: number }
    expect(row.message_count).toBe(2)
  })

  it('asks in English when the capture is English', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Dentist', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.8, rationale: 'own appointment',
    })
    const res = await api('POST', '/api/captures', { text: 'Dentist appointment on the 4th of November?' })
    const capture = res.body.capture as Capture
    const rows = assistantRows(capture.strandId!)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain(CAPTURE_NUDGE_TEXT.en)
    const block = findInteractionBlock(rows[0].content, CAPTURE_CONFIRM_BLOCK_ID)
    expect(block?.question).toBe(CAPTURE_CONFIRM_QUESTION.en)
    expect(block?.options.map(o => o.label)).toEqual([
      CAPTURE_CONFIRM_LABELS.en[CAPTURE_CONFIRM_KEEP], CAPTURE_CONFIRM_LABELS.en[CAPTURE_CONFIRM_ANSWER],
    ])
  })

  it('says nothing for a strong capture: that one gets a real answer', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Push fehlt + Recorder Umbruch', personaId: 'bob', tags: ['bug'] },
      intent: 'note', confidence: 0.8, rationale: 'eigenes Thema',
    })
    const res = await api('POST', '/api/captures', { text: INCIDENT })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(decision.intent).toBe('ask')
    expect(decision.rationale).toContain(ADDRESSED_NOTE_MARKER)
    expect(decision.rationale).not.toContain(DOUBTFUL_NOTE_MARKER)
    expect(turns).toHaveLength(1)
    expect(assistantRows(capture.strandId!)).toEqual([])
    expect(doorbells).toEqual([])
  })

  it('files a capture without a single marker in silence: no turn, no card, no doorbell', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Werkstatt', personaId: 'main', tags: ['auto'] },
      intent: 'note', confidence: 0.8, rationale: 'eigene Liste',
    })
    const res = await api('POST', '/api/captures', { text: 'Winterreifen kaufen. Bremsbeläge hinten sind durch.' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(decision.intent).toBe('note')
    // No marker means no doubt: nothing in the rationale, nothing in the
    // strand, nothing on the phone. This is the regression guard for the week
    // in which every note got a card and eleven of twelve landed on machine
    // written test notes.
    expect(decision.rationale).toBe('eigene Liste')
    expect(doorbells).toEqual([])
    expect(turns).toEqual([])
    expect(assistantRows(capture.strandId!)).toEqual([])
  })

  it('says nothing for a capture that declares itself a note', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Reifen', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.8, rationale: 'Merkzettel',
    })
    const res = await api('POST', '/api/captures', { text: 'Nur als Notiz: du musst noch die Reifen wechseln.' })
    const capture = res.body.capture as Capture
    expect((res.body.decision as Decision).intent).toBe('note')
    // Not even the confirmation card: the capture says in prose what it is,
    // and that beats the heuristic exactly like a client-set intent does.
    expect(assistantRows(capture.strandId!)).toEqual([])
    expect(doorbells).toEqual([])
  })

  it('yields to the live dialog guard: an upgraded note is answered, not asked about', async () => {
    const strand = sessionManager.createThread('1', 'bob', 'Recorder UI')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'umbruch')").run(strand.id)
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'assistant', 'schau ich mir an')").run(strand.id)
    // Only a question mark: weak on its own, but the strand is a live dialog.
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.9, rationale: 'gleicher Bug' })
    const res = await api('POST', '/api/captures', { text: 'Und der Umbruch?' })
    const decision = res.body.decision as Decision
    expect(decision.intent).toBe('ask')
    expect(decision.rationale).toContain(NOTE_IN_DIALOG_MARKER)
    expect(decision.rationale).not.toContain(DOUBTFUL_NOTE_MARKER)
    expect(turns).toHaveLength(1)
    expect(assistantRows(strand.id).map(r => r.content)).toEqual(['schau ich mir an'])
    expect(doorbells).toEqual([])
  })

  it('never asks about an intent the client states itself (SPEC 4.1)', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Zahnarzt', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.8, rationale: 'x',
    })
    const res = await api('POST', '/api/captures', { text: 'Termin beim Zahnarzt am Montag?', intent: 'note' })
    const capture = res.body.capture as Capture
    expect((res.body.decision as Decision).rationale).not.toContain(DOUBTFUL_NOTE_MARKER)
    expect(assistantRows(capture.strandId!)).toEqual([])
    expect(doorbells).toEqual([])
  })

  it('does not turn the strand into a live dialog: the next note stays a note', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Zahnarzt', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.8, rationale: 'termin',
    })
    const first = await api('POST', '/api/captures', { text: 'Termin beim Zahnarzt am Montag?' })
    const strandId = (first.body.capture as Capture).strandId!
    expect(assistantRows(strandId)).toHaveLength(1)

    answer({ action: 'append', strandId, intent: 'note', confidence: 0.9, rationale: 'gleicher Termin' })
    const second = await api('POST', '/api/captures', { text: 'Zahnarzt Adresse Hauptstrasse 4' })
    const decision = second.body.decision as Decision
    expect(decision.intent).toBe('note')
    expect(decision.rationale).not.toContain(NOTE_IN_DIALOG_MARKER)
    expect(turns).toEqual([])
  })

  it('leaves an unsorted capture alone: there is no strand to ask in', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Zahnarzt', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.2, rationale: 'rate nur',
    })
    const res = await api('POST', '/api/captures', { text: 'Termin beim Zahnarzt am Montag?' })
    const capture = res.body.capture as Capture
    expect(capture.status).toBe('unsorted')
    expect(capture.strandId).toBe(null)
    expect((res.body.decision as Decision).rationale).not.toContain(DOUBTFUL_NOTE_MARKER)
    expect(doorbells).toEqual([])
  })

  it('asks in the medium band too: the review card is not a doorbell', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Zahnarzt', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.5, rationale: 'unsicher',
    })
    const res = await api('POST', '/api/captures', { text: 'Termin beim Zahnarzt am Montag?' })
    const capture = res.body.capture as Capture
    // Filed for review, so the strand exists and the question can be asked in
    // it. The review card only exists inside the app; the doorbell is what
    // reaches a phone that is in a pocket.
    expect(capture.status).toBe('needs_review')
    const rows = assistantRows(capture.strandId!)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain(CAPTURE_NUDGE_TEXT.de)
    expect(doorbells).toHaveLength(1)
    expect(turns).toEqual([])
  })

  it('takes the question with the capture when the filing is undone', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Zahnarzt', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.8, rationale: 'termin',
    })
    const res = await api('POST', '/api/captures', { text: 'Termin beim Zahnarzt am Montag?' })
    const capture = res.body.capture as Capture
    const strandId = capture.strandId!
    expect(messagesIn(strandId)).toHaveLength(2)

    // No persona ever answered here (the question is not an answer), so this
    // is a true move and the created strand goes away with it.
    const undone = await api('POST', `/api/captures/${capture.id}/undo`, {})
    expect((undone.body.capture as Capture).status).toBe('unsorted')
    expect(messagesIn(strandId)).toEqual([])
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(strandId)).toBeUndefined()
  })

  it('runs an ordinary turn when the user answers the question in the strand', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Zahnarzt', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.8, rationale: 'termin',
    })
    const first = await api('POST', '/api/captures', { text: 'Termin beim Zahnarzt am Montag?' })
    const strandId = (first.body.capture as Capture).strandId!
    expect(turns).toEqual([])

    // The answer is an ordinary message in the strand. Over the web socket
    // that is `turnRunner.startTurn` unconditionally (ws-chat.ts); the same
    // shape through the explicit strand path of the captures API:
    const reply = await api('POST', '/api/captures', { text: 'Ja, ruf da mal an', strandId, intent: 'ask' })
    expect(reply.status).toBe(201)
    expect(turns).toEqual([{ sessionId: strandId, text: 'Ja, ruf da mal an', agentId: 'main' }])
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
    const strand = sessionManager.createThread('1', 'main', 'Werkstatt')
    answer({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.9, rationale: 'liste' })
    const created = await api('POST', '/api/captures', { text: 'Winterreifen kaufen' })
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
    createProject('p_werkstatt', 'WerkstattLog')
    sessionManager.createThread('1', 'main', 'Existing')
    answer({
      action: 'new_strand',
      newStrand: { title: 'Bremsbelaege hinten', personaId: 'main', tags: ['bremsen'], projectId: 'p_werkstatt' },
      intent: 'note', confidence: 0.8, rationale: 'brake pads belong to the bike log',
    })
    const res = await api('POST', '/api/captures', { text: 'rear brake pads are done, order new ones' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(capture.status).toBe('filed')
    expect(decision.projectId).toBe('p_werkstatt')
    expect(decision.projectSuggestion).toBeNull()
    expect(projectOf(capture.strandId!)).toBe('p_werkstatt')

    // The project list reached the model, as the first block of the prompt.
    expect(prompts[0].startsWith('Projects of this user (id, name):')).toBe(true)
    expect(prompts[0]).toContain('WerkstattLog')

    // Undo before an answer: the created strand is deleted, so the project
    // assignment is gone with it.
    await api('POST', `/api/captures/${capture.id}/undo`, {})
    expect(sessionManager.getThread('1', capture.strandId!)).toBeNull()
    expect(projectOf(capture.strandId!)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE project_id IS NOT NULL').get()).toEqual({ c: 0 })
  })

  it('keeps the project when an unsorted new_strand decision is confirmed by the product owner', async () => {
    createProject('p_halfway', 'Halfway')
    sessionManager.createThread('1', 'main', 'Existing')
    answer({
      action: 'new_strand',
      newStrand: { title: 'Pricing page conversion', personaId: 'main', tags: [], projectId: 'p_halfway' },
      confidence: 0.3,
    })
    const created = await api('POST', '/api/captures', { text: 'the pricing page converts badly' })
    const capture = created.body.capture as Capture
    expect(capture.status).toBe('unsorted')
    expect((created.body.decision as Decision).projectId).toBe('p_halfway')

    const applied = await api('POST', `/api/captures/${capture.id}/apply`, {})
    const filed = applied.body.capture as Capture
    expect(filed.status).toBe('filed')
    expect(projectOf(filed.strandId!)).toBe('p_halfway')
  })

  it('stores a project suggestion for an existing strand without applying it', async () => {
    const project = createProject('p_looplab', 'Looplab')
    const strand = sessionManager.createThread('1', 'main', 'Loop planner ideas')
    answer({
      action: 'append', strandId: strand.id, intent: 'note', confidence: 0.8,
      projectSuggestion: { projectId: project, confidence: 0.7, reason: 'the strand is about the loop planner' },
    })
    const res = await api('POST', '/api/captures', { text: 'the elevation filter should be a slider' })
    const decision = res.body.decision as Decision
    expect(decision.projectSuggestion).toEqual({
      projectId: 'p_looplab', confidence: 0.7, reason: 'the strand is about the loop planner',
    })
    // Suggest, do not auto apply: the strand is untouched.
    expect(projectOf(strand.id)).toBeNull()

    // And it is delivered again through the list endpoint, for a later card.
    const list = await api('GET', '/api/captures?status=filed')
    expect((list.body.decisions as Decision[])[0].projectSuggestion?.projectId).toBe('p_looplab')
  })

  it('drops a weak suggestion and one for a strand that already has a project', async () => {
    const project = createProject('p_kachel', 'Kachelwerk')
    const loose = sessionManager.createThread('1', 'main', 'Tile ideas')
    const taken = sessionManager.createThread('1', 'main', 'Tile printing', 'p_kachel')

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
    expect(projectOf(taken.id)).toBe('p_kachel')
  })

  it('treats an invented project id as a malformed answer and never files into it', async () => {
    createProject('p_real', 'Solarpunkt')
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
    const res = await api('POST', '/api/captures', { text: 'some thought', strandId: strand.id, ...selection })
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
    const res = await api('POST', '/api/captures', { text: 'some thought', strandId: strand.id, ...selection })
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
