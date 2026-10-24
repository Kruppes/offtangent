/**
 * S1-A: the id-based interaction endpoints over the `interactions` table.
 *
 *   POST /api/interactions/:id/answer   idempotent via clientRequestId, 409 with status
 *   POST /api/interactions/:id/dismiss  state only, NO turn
 *   PUT  /api/interactions/:id/draft    partial answers
 *   GET  /api/strands/:id/interactions?status=open
 *
 * Plus the legacy adapter: `POST /api/interactions` (messageId + blockId)
 * writes through the table, so an id-based replay sees the same answer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { getInteraction, ingestInteractionMessage, initDatabase, interactionEvents } from '@axiom/core'
import type { Database, InteractionRecord } from '@axiom/core'
import { createInteractionsRouter, createSharedInteractionsService, createStrandInteractionsRouter } from './route.js'
import { generateAccessToken } from '../../../auth.js'
import { registerInteractionBroadcast } from '../../../interaction-broadcast.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let turns: Array<{ sessionId: string; text: string }> = []
let failTurns = 0
let thirdToken: string

const FENCE = [
  '```offtangent',
  JSON.stringify({
    block: 'choice',
    id: 'b1',
    question: 'Hand this to Bob?',
    options: [{ id: 'yes', label: 'Hand over to Bob' }, { id: 'stay', label: 'Keep it here' }],
  }),
  '```',
].join('\n')

function insertCard(sessionId = 'strand-1', userId: number | null = 1, fence = FENCE): { messageId: number; interaction: InteractionRecord } {
  const content = `Your call.\n\n${fence}`
  const messageId = Number(db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, 'assistant', ?, 'main')`,
  ).run(sessionId, userId, content).lastInsertRowid)
  const [interaction] = ingestInteractionMessage(db, { messageId, strandId: sessionId, userId, agent: 'main', content })
  return { messageId, interaction: interaction! }
}

async function call(method: string, url: string, body?: unknown, authToken = token) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }
}

beforeAll(async () => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(3, 'third', 'x', 'user')
  const routerOptions = {
    db,
    getTurnRunner: () => ({
      startTurn: (input: { sessionId: string; text: string }) => {
        if (failTurns > 0) { failTurns -= 1; throw new Error('runner down') }
        turns.push({ sessionId: input.sessionId, text: input.text })
        return {}
      },
    }),
    getCaptureConfirmer: () => null,
  }
  const service = createSharedInteractionsService(routerOptions)
  const app = express()
  app.use(express.json())
  app.use('/api/interactions', createInteractionsRouter({ ...routerOptions, service }))
  app.use('/api/strands', createStrandInteractionsRouter({ service }))
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
  thirdToken = generateAccessToken({ userId: 3, username: 'third', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
})

beforeEach(() => {
  turns = []
  failTurns = 0
  db.prepare('DELETE FROM interaction_requests').run()
  db.prepare('DELETE FROM interactions').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare(`INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES ('strand-1', 1, 'main', 'S', 'interactive')`).run()
})

describe('POST /api/interactions/:id/answer', () => {
  it('answers, files the user turn and starts exactly one turn', async () => {
    const { interaction } = insertCard()
    const res = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'cr-1' })
    expect(res.status).toBe(200)
    expect(turns).toHaveLength(1)
    expect(getInteraction(db, interaction.id)).toMatchObject({ status: 'answered', closeSource: 'answer' })
  })

  it('idempotency: the same clientRequestId and value twice is one answer and one turn', async () => {
    const { interaction } = insertCard()
    const first = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'cr-1' })
    const second = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'cr-1' })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.json.idempotent).toBe(true)
    expect(turns).toHaveLength(1)
    const userRows = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user'").get() as { n: number }
    expect(userRows.n).toBe(1)
  })

  it('409: a second call with different content reports the current status and stored answer', async () => {
    const { interaction } = insertCard()
    await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'cr-1' })
    const other = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'stay', clientRequestId: 'cr-2' })
    expect(other.status).toBe(409)
    expect(other.json).toMatchObject({ code: 'already_answered', status: 'answered', value: 'yes' })
    expect(turns).toHaveLength(1)
  })

  it('404 for a foreign user, 400 without clientRequestId', async () => {
    const { interaction } = insertCard()
    expect((await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'x' }, otherToken)).status).toBe(404)
    expect((await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes' })).status).toBe(400)
  })
})

describe('POST /api/interactions/:id/dismiss', () => {
  it('dismiss without turn: closes the card and the turn counter stays the same', async () => {
    const { interaction } = insertCard()
    const before = turns.length
    const userRowsBefore = (db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user'").get() as { n: number }).n
    const res = await call('POST', `/api/interactions/${interaction.id}/dismiss`, {})
    expect(res.status).toBe(200)
    expect(turns.length).toBe(before)
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user'").get() as { n: number }).n).toBe(userRowsBefore)
    expect(getInteraction(db, interaction.id)).toMatchObject({ status: 'dismissed', closeSource: 'dismiss' })
    // A late answer after dismiss is a conflict, not a second state.
    const late = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'cr-late' })
    expect(late.status).toBe(409)
    expect(late.json.status).toBe('dismissed')
  })
})

describe('PUT /api/interactions/:id/draft and the WS bridge', () => {
  it('stores the draft and emits a draft event for the strand', async () => {
    const { interaction } = insertCard()
    const events: Array<{ type: string }> = []
    const off = interactionEvents.on(event => { events.push(event) })
    try {
      const res = await call('PUT', `/api/interactions/${interaction.id}/draft`, { answers: { b1: 'yes' } })
      expect(res.status).toBe(200)
    } finally {
      off()
    }
    expect(getInteraction(db, interaction.id)?.draft).toEqual({ b1: 'yes' })
    expect(events.map(e => e.type)).toContain('draft')
  })
})

describe('write responses and frames carry the sealed payload (privacy V3)', () => {
  // Decision 2026-10-24: the payload is not dropped but sealed (see
  // interaction-seal.ts); the secret case itself is covered in
  // privacy-secret-wiring.test.ts. Here: the payload is present everywhere.
  it('answer response, 409 body, open and updated frames all carry the payload', async () => {
    const frames: Array<Record<string, any>> = []
    const off = registerInteractionBroadcast({ chatEventBus: { broadcast: (event: Record<string, any>) => { frames.push(event) } } as never })
    try {
      const { interaction } = insertCard()
      const answered = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'cr-1' })
      expect(answered.status).toBe(200)
      expect(answered.json.interaction).toMatchObject({ id: interaction.id, status: 'answered', payload: { kind: 'choice', id: 'b1' } })
      const conflict = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'stay', clientRequestId: 'cr-2' })
      expect(conflict.status).toBe(409)
      expect(conflict.json.interaction).toMatchObject({ payload: { kind: 'choice', id: 'b1' } })
    } finally {
      off()
    }
    const open = frames.find(f => f.type === 'interaction.open')
    const updated = frames.find(f => f.type === 'interaction.updated')
    expect(open?.interaction.payload).toMatchObject({ kind: 'choice', id: 'b1' })
    expect(open).toMatchObject({ userId: 1, sessionId: 'strand-1' })
    expect(updated?.interaction).toMatchObject({ status: 'answered', payload: { kind: 'choice', id: 'b1' } })
  })
})

describe('GET /api/strands/:id/interactions', () => {
  it('lists open cards only with ?status=open', async () => {
    const first = insertCard()
    await call('POST', `/api/interactions/${first.interaction.id}/dismiss`, {})
    const second = insertCard()
    const res = await call('GET', '/api/strands/strand-1/interactions?status=open')
    expect(res.status).toBe(200)
    expect((res.json.interactions as InteractionRecord[]).map(i => i.id)).toEqual([second.interaction.id])
    expect((await call('GET', '/api/strands/strand-1/interactions?status=bogus')).status).toBe(400)
  })
})

describe('legacy POST /api/interactions writes through the table', () => {
  it('an answer via messageId+blockId closes the row; the id endpoint then replays it', async () => {
    const { messageId, interaction } = insertCard()
    const legacy = await call('POST', '/api/interactions', { messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cm-1' })
    expect(legacy.status).toBe(200)
    expect(getInteraction(db, interaction.id)).toMatchObject({ status: 'answered' })
    const replay = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'cm-1' })
    expect(replay.status).toBe(200)
    expect(turns).toHaveLength(1)
  })
})

const turnCount = () => turns.length
const userRows = () => (db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user'").get() as { n: number }).n

describe('review 1, finding 1: ownership incl. cards and strands without owner', () => {
  beforeEach(() => {
    db.prepare(`INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES ('strand-null', NULL, 'main', 'N', 'interactive')`).run()
    db.prepare(`INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES ('strand-2', 2, 'main', 'B', 'interactive')`).run()
  })

  it('a foreign user gets 404 on list, answer, dismiss and draft of a NULL-owner card', async () => {
    const { interaction } = insertCard('strand-null', null)
    expect(interaction.userId).toBeNull()
    expect((await call('GET', '/api/strands/strand-null/interactions', undefined, otherToken)).status).toBe(404)
    expect((await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'n1' }, otherToken)).status).toBe(404)
    expect((await call('POST', `/api/interactions/${interaction.id}/dismiss`, {}, otherToken)).status).toBe(404)
    expect((await call('PUT', `/api/interactions/${interaction.id}/draft`, { answers: { b1: 'yes' } }, otherToken)).status).toBe(404)
    expect(getInteraction(db, interaction.id)).toMatchObject({ status: 'open', draft: null })
    expect(turnCount()).toBe(0)
  })

  it('a NULL-owner card on an owned strand is hidden from the strand owner too', async () => {
    const { interaction } = insertCard('strand-2', null)
    const list = await call('GET', '/api/strands/strand-2/interactions', undefined, otherToken)
    expect(list.status).toBe(200)
    expect(list.json.interactions).toEqual([])
    expect((await call('POST', `/api/interactions/${interaction.id}/dismiss`, {}, otherToken)).status).toBe(404)
  })

  it('the admin role may read and operate a NULL-owner card', async () => {
    const { interaction } = insertCard('strand-null', null)
    const list = await call('GET', '/api/strands/strand-null/interactions')
    expect(list.status).toBe(200)
    expect((list.json.interactions as InteractionRecord[]).map(i => i.id)).toEqual([interaction.id])
    expect((await call('PUT', `/api/interactions/${interaction.id}/draft`, { answers: { b1: 'yes' } })).status).toBe(200)
    expect((await call('POST', `/api/interactions/${interaction.id}/dismiss`, {})).status).toBe(200)
  })

  it('foreign user on an owned card: dismiss and draft are 404 and change nothing', async () => {
    const { interaction } = insertCard('strand-2', 2)
    expect((await call('POST', `/api/interactions/${interaction.id}/dismiss`, {}, thirdToken)).status).toBe(404)
    expect((await call('PUT', `/api/interactions/${interaction.id}/draft`, { answers: { b1: 'x' } }, thirdToken)).status).toBe(404)
    expect(getInteraction(db, interaction.id)).toMatchObject({ status: 'open', draft: null })
  })
})

describe('review 1, finding 3: idempotency key bound to card and value', () => {
  it('the same key on a second card is 409 with the status of the first card, no transition', async () => {
    const first = insertCard()
    expect((await call('POST', `/api/interactions/${first.interaction.id}/answer`, { value: 'yes', clientRequestId: 'shared' })).status).toBe(200)
    const second = insertCard()
    expect(second.interaction.status).toBe('open')
    const clash = await call('POST', `/api/interactions/${second.interaction.id}/answer`, { value: 'yes', clientRequestId: 'shared' })
    expect(clash.status).toBe(409)
    expect(clash.json).toMatchObject({ code: 'idempotency_conflict', status: 'answered' })
    expect(clash.json.interaction?.id).toBe(first.interaction.id)
    expect(getInteraction(db, second.interaction.id)!.status).not.toBe('answered')
    expect(turnCount()).toBe(1)
  })

  it('the same key with another value on the same card is 409, no second answer', async () => {
    const { interaction } = insertCard()
    await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'k' })
    const clash = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'stay', clientRequestId: 'k' })
    expect(clash.status).toBe(409)
    expect(clash.json.code).toBe('idempotency_conflict')
    expect(getInteraction(db, interaction.id)!.answer!.value).toBe('yes')
  })

  it('a key bound to a card that is still open does not let another card transition', async () => {
    const first = insertCard()
    await call('POST', `/api/interactions/${first.interaction.id}/answer`, { value: 'yes', clientRequestId: 'k2' })
    const second = insertCard()
    const res = await call('POST', `/api/interactions/${second.interaction.id}/answer`, { value: 'stay', clientRequestId: 'k2' })
    expect(res.status).toBe(409)
    expect(getInteraction(db, second.interaction.id)).toMatchObject({ status: 'open', answer: null })
  })
})

describe('review 1, finding 4: strict state contract at the endpoints', () => {
  for (const status of ['superseded', 'dismissed', 'answered', 'expired'] as const) {
    it(`answer and dismiss on a ${status} card do not change it (409/410), the legacy door too`, async () => {
      const { messageId, interaction } = insertCard()
      db.prepare(`UPDATE interactions SET status = ?, close_source = ?, closed_at = '2026-10-24T00:00:00.000Z', answer = ? WHERE id = ?`).run(
        status,
        status === 'answered' ? 'answer' : status === 'dismissed' ? 'dismiss' : status === 'expired' ? 'timeout' : 'user_continued',
        status === 'answered' ? JSON.stringify({ value: 'stay', label: 'Keep it here', answeredAt: '2026-10-24T00:00:00.000Z', clientRequestId: 'old', resumed: true }) : null,
        interaction.id,
      )
      const byId = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: `c-${status}` })
      expect([409, 410]).toContain(byId.status)
      expect(byId.json.status).toBe(status)
      const legacy = await call('POST', '/api/interactions', { messageId, blockId: 'b1', value: 'yes', clientMessageId: `l-${status}` })
      expect([409, 410]).toContain(legacy.status)
      if (status !== 'dismissed') {
        const dismiss = await call('POST', `/api/interactions/${interaction.id}/dismiss`, {})
        expect(dismiss.status).toBe(409)
        expect(dismiss.json.status).toBe(status)
      }
      expect(getInteraction(db, interaction.id)!.status).toBe(status)
      expect(turnCount()).toBe(0)
    })
  }

  it('a superseded card is 409 superseded on the legacy door (no answer after supersede)', async () => {
    const { messageId, interaction } = insertCard()
    db.prepare(`UPDATE interactions SET status = 'superseded', close_source = 'user_continued', closed_at = '2026-10-24T00:00:00.000Z' WHERE id = ?`).run(interaction.id)
    const legacy = await call('POST', '/api/interactions', { messageId, blockId: 'b1', value: 'yes', clientMessageId: 'l-s' })
    expect(legacy.status).toBe(409)
    expect(legacy.json.status).toBe('superseded')
  })
})

describe('review 1, finding 6: an answer row supersedes the other open cards with an event', () => {
  it('answering card 2 supersedes the older open card 1 (DB and interaction.updated)', async () => {
    const first = insertCard()
    const second = insertCard()
    const events: Array<{ type: string; interaction: InteractionRecord }> = []
    const off = interactionEvents.on(e => { events.push(e as never) })
    try {
      expect((await call('POST', `/api/interactions/${second.interaction.id}/answer`, { value: 'yes', clientRequestId: 's6' })).status).toBe(200)
    } finally { off() }
    // Card 1 was already superseded by the newer card (newer_question); the
    // answer row must not reopen or double-close it.
    expect(getInteraction(db, first.interaction.id)!.status).toBe('superseded')
    expect(events.some(e => e.type === 'updated' && e.interaction.id === second.interaction.id && e.interaction.status === 'answered')).toBe(true)
  })
})

describe('review 1, finding 8: blocking=0', () => {
  it('an answer to a non-blocking card is stored and emitted, the turn counter stays the same', async () => {
    const { interaction: created } = insertCard()
    // A non-blocking card (tool-call cards, S1-B); set on the row directly.
    db.prepare('UPDATE interactions SET blocking = 0 WHERE id = ?').run(created.id)
    const interaction = getInteraction(db, created.id)!
    expect(interaction.blocking).toBe(false)
    const events: string[] = []
    const off = interactionEvents.on(e => { events.push(`${e.type}:${e.interaction.status}`) })
    const before = turnCount()
    const rowsBefore = userRows()
    let res
    try {
      res = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'nb' })
    } finally { off() }
    expect(res.status).toBe(200)
    expect(res.json.resumed).toBe(false)
    expect(turnCount()).toBe(before)
    expect(userRows()).toBe(rowsBefore)
    expect(getInteraction(db, interaction.id)).toMatchObject({ status: 'answered' })
    expect(events).toContain('updated:answered')
  })
})

describe('review 1, finding 9: resumed only after the turn really started', () => {
  it('a failed startTurn stores resumed=false and answers 502 retryable; the retry only starts the turn', async () => {
    const { interaction } = insertCard()
    failTurns = 1
    const first = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'r9' })
    expect(first.status).toBe(502)
    expect(first.json.retryable).toBe(true)
    expect(getInteraction(db, interaction.id)).toMatchObject({ status: 'answered', answer: { resumed: false } })
    expect(userRows()).toBe(1)
    expect(turnCount()).toBe(0)
    const retry = await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'r9' })
    expect(retry.status).toBe(200)
    expect(retry.json.resumed).toBe(true)
    expect(userRows()).toBe(1)
    expect(turnCount()).toBe(1)
    expect(getInteraction(db, interaction.id)!.answer!.resumed).toBe(true)
    // A third call is a plain replay: no further turn.
    expect((await call('POST', `/api/interactions/${interaction.id}/answer`, { value: 'yes', clientRequestId: 'r9' })).status).toBe(200)
    expect(turnCount()).toBe(1)
  })
})
