/**
 * The "filed as a note" confirmation card — the captures path and
 * `POST /api/interactions` wired together the way `app.ts` wires them, against
 * a real SessionManager and a real database.
 *
 * The router no longer has a "note" category: every capture it routes is an
 * `ask` and gets its answer, so no new capture ever produces this card. The
 * cards that already exist in strands from before still have to work, though:
 * a tap on "answer it" or "keep the note" must still resolve the capture. That
 * is why the card is written here directly through `writeConfirmationCard`,
 * exactly as an old row looks, on top of a capture the client filed with an
 * explicit `intent: 'note'` (the only way a note can still come into being).
 *
 * What is proven here:
 *   - a capture the router labels `note` becomes an `ask`: answered, no card
 *   - a capture typed into a chosen strand is answered, never asked about
 *   - a note the CLIENT declared stays silent (explicit beats heuristic)
 *   - on an existing card, "answer it" starts the ordinary answer run on the
 *     CAPTURE text and "keep the note" starts nothing but resolves the capture
 *   - the card exists exactly once, whatever retries happen
 *   - a low band capture has no strand, so it waits in the tray instead
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import {
  initDatabase, SessionManager, findInteractionBlock, readInteractionAnswers,
  renderInteractionMessageAsText,
} from '@axiom/core'
import type { AgentCore, Capture, Database, Decision, ResolvedRouterModel } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import { createInteractionsRouter } from '../interactions/route.js'
import {
  CAPTURE_CONFIRM_ANSWER, CAPTURE_CONFIRM_BLOCK_ID, CAPTURE_CONFIRM_KEEP, CAPTURE_CONFIRM_LABELS,
  CAPTURE_CONFIRM_QUESTION, CAPTURE_NUDGE_TEXT, captureConfirmContent, captureConfirmKey,
  writeConfirmationCard,
} from './service.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let turns: Array<{ sessionId: string; text: string; agentId: string }> = []
let nextAnswers: string[] = []
let doorbells: number = 0

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-note-confirm-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'coder'), { recursive: true })
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  const app = express()
  app.use(express.json())
  const getTurnRunner = () => ({
    startTurn: (input: { sessionId: string; text: string; agentId: string }) => {
      turns.push({ sessionId: input.sessionId, text: input.text, agentId: input.agentId })
      return {}
    },
  })
  const captureRouters = createCapturesRouters({
    db,
    getAgentCore: () => agentCore,
    getTurnRunner,
    routerChain: () => chain,
    sendDoorbell: () => { doorbells += 1 },
    routerComplete: async () => {
      const next = nextAnswers.shift()
      if (next === undefined) throw new Error('router stub has no answer')
      return next
    },
  })
  app.use('/api/captures', captureRouters.captures)
  // Exactly the wiring of app.ts: one captures service instance, handed to the
  // interactions router as the confirmer for capture-bound blocks.
  app.use('/api/interactions', createInteractionsRouter({
    db,
    getTurnRunner,
    getCaptureConfirmer: () => captureRouters.service,
  }))

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
  nextAnswers = []
  doorbells = 0
})

async function api(method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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

/** A strand with substance, so the router is really called. */
function candidate(): string {
  return sessionManager.createThread('1', 'main', 'Irgendein anderes Thema').id
}

function rowsIn(strandId: string): Array<{ id: number; role: string; content: string; capture_id: string | null; metadata: string | null; client_message_id: string | null }> {
  return db.prepare(
    'SELECT id, role, content, capture_id, metadata, client_message_id FROM chat_messages WHERE session_id = ? ORDER BY id',
  ).all(strandId) as never
}

function cards(captureId: string): Array<{ id: number; content: string; metadata: string | null }> {
  return db.prepare(
    `SELECT id, content, metadata FROM chat_messages WHERE capture_id = ? AND role = 'assistant' ORDER BY id`,
  ).all(captureId) as never
}

/**
 * A note as it still exists in old strands: a capture the client filed with an
 * explicit `intent: 'note'` in the medium band, plus the confirmation card the
 * server used to write next to it. The router itself never writes this card
 * any more (see the first describe block), so the card is written the way the
 * old code wrote it.
 */
async function fileNote(text = 'Winterreifen kaufen?', confidence = 0.55, clientMessageId?: string) {
  candidate()
  answer({
    action: 'new_strand', newStrand: { title: 'Wartung', personaId: 'coder', tags: [] },
    intent: 'note', confidence, rationale: 'eigene Liste',
  })
  const res = await api('POST', '/api/captures', { text, intent: 'note', ...(clientMessageId ? { clientMessageId } : {}) })
  const capture = res.body.capture as Capture
  const decision = res.body.decision as Decision
  const strand = sessionManager.getThread('1', capture.strandId!)!
  writeConfirmationCard(db, {
    userId: 1, strandId: strand.id, agentId: strand.agentId, captureId: capture.id, content: captureConfirmContent('de'),
  })
  const card = cards(capture.id)[0]
  return { res, capture, decision, card }
}

describe('the router never files a silent note', () => {
  it('turns a router "note" into an ask: answered, no card, no doorbell', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Wartung', personaId: 'coder', tags: [] },
      intent: 'note', confidence: 0.55, rationale: 'eigene Liste',
    })
    const res = await api('POST', '/api/captures', { text: 'Winterreifen kaufen?' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision

    expect(decision.intent).toBe('ask')
    expect(cards(capture.id)).toEqual([])
    expect(doorbells).toBe(0)
    expect(turns).toEqual([{ sessionId: capture.strandId, text: 'Winterreifen kaufen?', agentId: 'main' }])
    // No guard marker either: there is nothing left to correct.
    const stored = db.prepare('SELECT intent, rationale FROM router_decisions WHERE id = ?').get(decision.id) as { intent: string; rationale: string }
    expect(stored.intent).toBe('ask')
    expect(stored.rationale).not.toContain('capture guard: a note')
  })

  it('answers a text without any address marker too, instead of filing it silently', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Puck', personaId: 'coder', tags: [] },
      intent: 'note', confidence: 0.9, rationale: 'self note',
    })
    const res = await api('POST', '/api/captures', { text: 'Puck firmware validation: persistent queue delivery works.' })
    const capture = res.body.capture as Capture
    expect((res.body.decision as Decision).intent).toBe('ask')
    expect(cards(capture.id)).toEqual([])
    expect(turns).toHaveLength(1)
  })

  it('stays silent only when the client stated the note itself', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Wartung', personaId: 'coder', tags: [] },
      intent: 'ask', confidence: 0.9, rationale: 'x',
    })
    const res = await api('POST', '/api/captures', { text: 'Winterreifen kaufen?', intent: 'note' })
    const capture = res.body.capture as Capture
    expect((res.body.decision as Decision).intent).toBe('note')
    expect(cards(capture.id)).toEqual([])
    expect(turns).toEqual([])

    // Same rule on the explicit-strand path.
    const strand = sessionManager.createThread('1', 'main', 'Explizit')
    const second = await api('POST', '/api/captures', { text: 'auch nur fuers Protokoll', strandId: strand.id, intent: 'note' })
    expect(cards((second.body.capture as Capture).id)).toEqual([])
    expect(turns).toEqual([])

    // Without a stated intent a text typed into a chosen strand is a line in
    // a conversation and gets its answer, whatever it looks like: no card, no
    // silent filing.
    const third = await api('POST', '/api/captures', { text: 'und das hier auch noch', strandId: strand.id })
    expect(cards((third.body.capture as Capture).id)).toEqual([])
    expect((third.body.decision as Decision).intent).toBe('ask')
    const fourth = await api('POST', '/api/captures', { text: 'und der Termin am Montag?', strandId: strand.id })
    expect(cards((fourth.body.capture as Capture).id)).toEqual([])
    expect(turns).toEqual([
      { sessionId: strand.id, text: 'und das hier auch noch', agentId: 'main' },
      { sessionId: strand.id, text: 'und der Termin am Montag?', agentId: 'main' },
    ])
  })

  it('answers an ask without a card: an answer needs no permission', async () => {
    candidate()
    answer({ action: 'new_strand', newStrand: { title: 'Deploy', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.9 })
    const res = await api('POST', '/api/captures', { text: 'ist der deploy gruen' })
    const capture = res.body.capture as Capture
    expect(cards(capture.id)).toEqual([])
    expect(turns).toHaveLength(1)
  })
})

describe('an existing card still renders and points at its capture', () => {
  it('is one choice card with prose above it, tagged as the server\'s own question', async () => {
    const { capture, decision, card } = await fileNote()
    expect(decision.intent).toBe('note')
    expect(capture.status).toBe('needs_review')
    expect(turns).toEqual([])
    expect(cards(capture.id)).toHaveLength(1)

    const block = findInteractionBlock(card.content, CAPTURE_CONFIRM_BLOCK_ID)
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('choice')
    expect(block!.supported).toBe(true)
    expect(block!.question).toBe(CAPTURE_CONFIRM_QUESTION.de)
    expect(block!.options.map(o => o.id)).toEqual([CAPTURE_CONFIRM_KEEP, CAPTURE_CONFIRM_ANSWER])
    expect(block!.options.map(o => o.label)).toEqual([
      CAPTURE_CONFIRM_LABELS.de[CAPTURE_CONFIRM_KEEP], CAPTURE_CONFIRM_LABELS.de[CAPTURE_CONFIRM_ANSWER],
    ])
    expect(card.content.startsWith(CAPTURE_NUDGE_TEXT.de)).toBe(true)
    const asText = renderInteractionMessageAsText(card.content)
    expect(asText).toContain(CAPTURE_NUDGE_TEXT.de)
    expect(asText).not.toContain('```')
    expect(card.metadata).toContain('capture_nudge')
    const strandRows = rowsIn(capture.strandId!)
    expect(strandRows.map(r => r.role)).toEqual(['user', 'assistant'])
    expect(strandRows[1].capture_id).toBe(capture.id)
  })
})

describe('answering the card', () => {
  it('starts the ordinary answer run on the capture text and resolves the capture', async () => {
    const { capture, decision, card } = await fileNote('Fuer Demo App die Preisseite umstellen?')
    expect(decision.state).toBe('applied')

    const res = await api('POST', '/api/interactions', {
      messageId: card.id, blockId: CAPTURE_CONFIRM_BLOCK_ID, value: CAPTURE_CONFIRM_ANSWER, clientMessageId: 'tap-1',
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ applied: true, resumed: true, idempotent: false, value: CAPTURE_CONFIRM_ANSWER })

    // The turn runs on the CAPTURE text, not on the label that was tapped.
    expect(turns).toEqual([{ sessionId: capture.strandId, text: 'Fuer Demo App die Preisseite umstellen?', agentId: 'main' }])
    // And no stray user row: the tapped label is not something the user said.
    expect(rowsIn(capture.strandId!).map(r => r.role)).toEqual(['user', 'assistant'])

    // The capture is done now, and the decision says who decided.
    const fresh = (await api('GET', '/api/captures?status=all')).body.captures as Capture[]
    expect(fresh.find(c => c.id === capture.id)!.status).toBe('filed')
    const stored = db.prepare('SELECT state, resolved_at FROM router_decisions WHERE id = ?').get(decision.id) as { state: string; resolved_at: string | null }
    expect(stored.state).toBe('confirmed')
    expect(stored.resolved_at).not.toBeNull()

    // The card collapses to its chip: the answer lives in the message metadata.
    const answered = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(card.id) as { metadata: string }
    const answers = readInteractionAnswers(answered.metadata)
    expect(answers[CAPTURE_CONFIRM_BLOCK_ID]).toMatchObject({
      value: CAPTURE_CONFIRM_ANSWER,
      label: CAPTURE_CONFIRM_LABELS.de[CAPTURE_CONFIRM_ANSWER],
      clientMessageId: 'tap-1',
      resumed: true,
    })
    // The metadata tag survives, so the card stays out of "has anybody
    // answered here?" queries.
    expect(answered.metadata).toContain('capture_nudge')
  })

  it('keeps the note without a turn when the user says so', async () => {
    const { capture, decision, card } = await fileNote()

    const res = await api('POST', '/api/interactions', {
      messageId: card.id, blockId: CAPTURE_CONFIRM_BLOCK_ID, value: CAPTURE_CONFIRM_KEEP, clientMessageId: 'tap-keep',
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ applied: true, resumed: false, label: CAPTURE_CONFIRM_LABELS.de[CAPTURE_CONFIRM_KEEP] })
    expect(turns).toEqual([])

    const fresh = (await api('GET', '/api/captures?status=all')).body.captures as Capture[]
    expect(fresh.find(c => c.id === capture.id)!.status).toBe('filed')
    const stored = db.prepare('SELECT state FROM router_decisions WHERE id = ?').get(decision.id) as { state: string }
    expect(stored.state).toBe('confirmed')
    // Nothing was written into the strand: keeping a note is a silent decision.
    expect(rowsIn(capture.strandId!).map(r => r.role)).toEqual(['user', 'assistant'])
  })

  it('answers the same card only once: a second tap is 409, a replay is idempotent', async () => {
    const { card } = await fileNote()
    const first = await api('POST', '/api/interactions', {
      messageId: card.id, blockId: CAPTURE_CONFIRM_BLOCK_ID, value: CAPTURE_CONFIRM_ANSWER, clientMessageId: 'tap-1',
    })
    expect(first.status).toBe(200)
    expect(turns).toHaveLength(1)

    // Same request again (a dropped response, a reconnect): applied, no second turn.
    const replay = await api('POST', '/api/interactions', {
      messageId: card.id, blockId: CAPTURE_CONFIRM_BLOCK_ID, value: CAPTURE_CONFIRM_ANSWER, clientMessageId: 'tap-1',
    })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ applied: true, idempotent: true })
    expect(turns).toHaveLength(1)

    // A different decision after the fact is a conflict, not a second turn.
    const conflict = await api('POST', '/api/interactions', {
      messageId: card.id, blockId: CAPTURE_CONFIRM_BLOCK_ID, value: CAPTURE_CONFIRM_KEEP, clientMessageId: 'tap-2',
    })
    expect(conflict.status).toBe(409)
    expect(conflict.body.code).toBe('already_answered')
    expect(turns).toHaveLength(1)
  })

  it('refuses a value that is not one of the two options', async () => {
    const { card } = await fileNote()
    const res = await api('POST', '/api/interactions', {
      messageId: card.id, blockId: CAPTURE_CONFIRM_BLOCK_ID, value: 'maybe', clientMessageId: 'tap-x',
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_value')
    expect(turns).toEqual([])
  })
})

describe('exactly one card per capture', () => {
  it('writes nothing on a retried capture', async () => {
    const { capture } = await fileNote('Winterreifen kaufen?', 0.55, 'client-key-1')
    expect(cards(capture.id)).toHaveLength(1)

    // The retry the app sends after a dropped response: same key, same
    // capture, no second routing and no second card.
    const again = await api('POST', '/api/captures', { text: 'Winterreifen kaufen?', clientMessageId: 'client-key-1' })
    expect(again.status).toBe(200)
    expect((again.body.capture as Capture).id).toBe(capture.id)
    expect(cards(capture.id)).toHaveLength(1)
  })

  it('writes nothing when the same capture is routed a second time', async () => {
    // The failure a check-then-insert would lose: the card write runs twice
    // for one capture (a retried route, a reconnect, a replayed request).
    const { capture, card } = await fileNote()
    const strandId = capture.strandId!

    const second = writeConfirmationCard(db, {
      userId: 1,
      strandId,
      agentId: 'coder',
      captureId: capture.id,
      content: captureConfirmContent('de'),
    })
    expect(second).toBeNull()
    expect(cards(capture.id)).toHaveLength(1)
    expect(cards(capture.id)[0].id).toBe(card.id)
    expect(rowsIn(strandId)).toHaveLength(2)

    // The key is what carries the guarantee, and it is per capture.
    const stored = db.prepare('SELECT client_message_id FROM chat_messages WHERE id = ?').get(card.id) as { client_message_id: string }
    expect(stored.client_message_id).toBe(captureConfirmKey(capture.id))
  })

  it('takes the card with the capture when the filing is undone', async () => {
    const { capture } = await fileNote()
    const strandId = capture.strandId!
    expect(rowsIn(strandId)).toHaveLength(2)

    const undone = await api('POST', `/api/captures/${capture.id}/undo`, {})
    expect((undone.body.capture as Capture).status).toBe('unsorted')
    // Card and capture row are both gone, and so is the strand they created.
    expect(cards(capture.id)).toEqual([])
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(strandId)).toBeUndefined()

    // A capture filed by hand afterwards is the user's own decision, so it
    // gets no card — and the freed key means nothing blocks a future one.
    const target = sessionManager.createThread('1', 'main', 'Ziel')
    const applied = await api('POST', `/api/captures/${capture.id}/apply`, { action: 'append', strandId: target.id })
    expect((applied.body.capture as Capture).status).toBe('filed')
    expect(cards(capture.id)).toEqual([])
  })
})

describe('the low band has no strand to ask in', () => {
  it('parks the capture in the tray instead of inventing a strand', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Egal', personaId: 'main', tags: [] },
      intent: 'note', confidence: 0.3, rationale: 'rate nur',
    })
    const res = await api('POST', '/api/captures', { text: 'Irgendein Gedanke' })
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision

    // Nothing was filed, so there is nothing to confirm and no card anywhere.
    expect(capture.status).toBe('unsorted')
    expect(capture.strandId).toBe(null)
    expect(capture.messageId).toBe(null)
    expect(cards(capture.id)).toEqual([])
    expect(turns).toEqual([])
    expect(doorbells).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({ n: 0 })

    // It is not done either: the decision was never applied, and the capture
    // is in the tray the client polls and renders as the routing chip.
    expect(decision.state).toBe('proposed')
    const tray = (await api('GET', '/api/captures?status=unsorted')).body.captures as Capture[]
    expect(tray.map(c => c.id)).toContain(capture.id)

    // Confirming it from the tray files it — by hand, so still no card.
    const applied = await api('POST', `/api/captures/${capture.id}/apply`, {})
    expect((applied.body.capture as Capture).status).toBe('filed')
    expect(cards(capture.id)).toEqual([])
  })
})
