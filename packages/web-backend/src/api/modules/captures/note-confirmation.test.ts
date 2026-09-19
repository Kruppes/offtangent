/**
 * "A note always asks before it counts as done" — the captures path and
 * `POST /api/interactions` wired together the way `app.ts` wires them, against
 * a real SessionManager and a real database.
 *
 * The incident this pins: captures with `intent=note`, `confidence=0.55`,
 * `status=needs_review`, `state=applied` sat in a strand and nothing ever
 * asked about them or answered them. For the product owner that is a dead
 * strand — reported twice, in those words.
 *
 * The second incident it pins, from the opposite direction: for a week EVERY
 * note the router decided got a card. Eleven of the twelve cards that rule
 * produced landed on machine written test notes, and not one of them was
 * addressed to anybody. So the card belongs to the doubt band alone.
 *
 * What is proven here:
 *   - a note whose text MIGHT address the persona produces exactly one card
 *   - a note without a single address marker produces none, and rings nothing
 *   - a note the CLIENT declared produces none (explicit beats heuristic)
 *   - "answer it" starts the ordinary answer run on the CAPTURE text
 *   - "keep the note" starts nothing but still resolves the capture
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
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })
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
 * File a note through the router and hand back capture, decision and card id.
 *
 * The default text carries exactly one address marker (the question mark),
 * because that is the only band that produces a card: it reads as a memo just
 * as easily as as a question to the persona, which is the doubt the card is
 * for.
 */
async function fileNote(text = 'Winterreifen kaufen?', confidence = 0.55, clientMessageId?: string) {
  candidate()
  answer({
    action: 'new_strand', newStrand: { title: 'Werkstatt', personaId: 'bob', tags: [] },
    intent: 'note', confidence, rationale: 'eigene Liste',
  })
  const res = await api('POST', '/api/captures', { text, ...(clientMessageId ? { clientMessageId } : {}) })
  const capture = res.body.capture as Capture
  const decision = res.body.decision as Decision
  const card = cards(capture.id)[0]
  return { res, capture, decision, card }
}

describe('a note asks for confirmation before it counts as done', () => {
  it('writes exactly one choice card into the strand and runs no turn', async () => {
    const { capture, decision, card } = await fileNote()

    // The reported state, verbatim: note, medium band, filed for review.
    expect(decision.intent).toBe('note')
    expect(decision.confidence).toBe(0.55)
    expect(capture.status).toBe('needs_review')
    // ... and the answer to it: no turn, but not silence either.
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

    // The prose above the card carries the fact for every surface without a
    // card renderer, and the degradation never shows raw JSON.
    expect(card.content.startsWith(CAPTURE_NUDGE_TEXT.de)).toBe(true)
    const asText = renderInteractionMessageAsText(card.content)
    expect(asText).toContain(CAPTURE_NUDGE_TEXT.de)
    expect(asText).toContain(`1. ${CAPTURE_CONFIRM_LABELS.de[CAPTURE_CONFIRM_KEEP]}`)
    expect(asText).toContain(`2. ${CAPTURE_CONFIRM_LABELS.de[CAPTURE_CONFIRM_ANSWER]}`)
    expect(asText).not.toContain('```')
    expect(asText).not.toContain('"block"')

    // It hangs off the capture and is marked as the server's own question, so
    // it never counts as a persona answer.
    expect(card.metadata).toContain('capture_nudge')
    const strandRows = rowsIn(capture.strandId!)
    expect(strandRows.map(r => r.role)).toEqual(['user', 'assistant'])
    expect(strandRows[1].capture_id).toBe(capture.id)

    // The card is worth a push: it is rare by construction, and one the user
    // never sees is the silence this mechanism exists against.
    expect(doorbells).toBe(1)
  })

  it('stays silent for a note that addresses nobody', async () => {
    // The regression this pins, measured in production: a card on every note
    // fired eleven times out of twelve on automated test notes from a device.
    // No marker in the text means no doubt, and no doubt means no question.
    const { capture, decision } = await fileNote('Puck firmware validation: persistent queue delivery works. Test note 000049')

    expect(decision.intent).toBe('note')
    expect(cards(capture.id)).toEqual([])
    expect(turns).toEqual([])
    expect(doorbells).toBe(0)
    // Filed, and filed silently: the strand holds the note and nothing else.
    expect(rowsIn(capture.strandId!).map(r => r.role)).toEqual(['user'])
    // The doubt band marker counts questions asked, so it stays unwritten.
    const stored = db.prepare('SELECT rationale FROM router_decisions WHERE id = ?').get(decision.id) as { rationale: string }
    expect(stored.rationale).not.toContain('may address you')
  })

  it('does not ask about a capture that calls itself a note', async () => {
    // One marker plus the user's own word about their text: the word wins.
    const { capture } = await fileNote('Nur als Notiz: Winterreifen kaufen?')
    expect(cards(capture.id)).toEqual([])
    expect(turns).toEqual([])
  })

  it('asks nothing when the client stated the intent itself', async () => {
    candidate()
    answer({
      action: 'new_strand', newStrand: { title: 'Werkstatt', personaId: 'bob', tags: [] },
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

    // Without a stated intent the text decides, on this path too: a plain
    // note stays silent ...
    const third = await api('POST', '/api/captures', { text: 'und das hier auch noch', strandId: strand.id })
    expect(cards((third.body.capture as Capture).id)).toEqual([])
    expect(turns).toEqual([])

    // ... one that might be a question gets the card ...
    const fourth = await api('POST', '/api/captures', { text: 'und der Termin am Montag?', strandId: strand.id })
    expect(cards((fourth.body.capture as Capture).id)).toHaveLength(1)
    expect(turns).toEqual([])

    // ... and one that clearly talks to the persona gets an answer instead of
    // a card. Without this, a sentence typed into a strand the user picked
    // himself would be filed and answered by nobody.
    const fifth = await api('POST', '/api/captures', { text: 'Schau dir das bitte nochmal an', strandId: strand.id })
    const addressed = fifth.body.capture as Capture
    expect(cards(addressed.id)).toEqual([])
    expect((fifth.body.decision as Decision).intent).toBe('ask')
    expect(turns).toEqual([{ sessionId: strand.id, text: 'Schau dir das bitte nochmal an', agentId: 'main' }])
  })

  it('answers nothing for an ask: an answer needs no permission', async () => {
    candidate()
    answer({ action: 'new_strand', newStrand: { title: 'Deploy', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.9 })
    const res = await api('POST', '/api/captures', { text: 'ist der deploy gruen' })
    const capture = res.body.capture as Capture
    expect(cards(capture.id)).toEqual([])
    expect(turns).toHaveLength(1)
  })
})

describe('answering the card', () => {
  it('starts the ordinary answer run on the capture text and resolves the capture', async () => {
    const { capture, decision, card } = await fileNote('Fuer Halfway die Preisseite umstellen?')
    expect(decision.state).toBe('applied')

    const res = await api('POST', '/api/interactions', {
      messageId: card.id, blockId: CAPTURE_CONFIRM_BLOCK_ID, value: CAPTURE_CONFIRM_ANSWER, clientMessageId: 'tap-1',
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ applied: true, resumed: true, idempotent: false, value: CAPTURE_CONFIRM_ANSWER })

    // The turn runs on the CAPTURE text, not on the label that was tapped.
    expect(turns).toEqual([{ sessionId: capture.strandId, text: 'Fuer Halfway die Preisseite umstellen?', agentId: 'bob' }])
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
      agentId: 'bob',
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

  it('takes the card with the capture when the filing is undone, and asks again when it is re-routed', async () => {
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
