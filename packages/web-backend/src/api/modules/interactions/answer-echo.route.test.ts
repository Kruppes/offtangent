/**
 * fix/interaction-answer-echo: an answered card is NOT echoed as a
 * `user_message` on the chat event bus.
 *
 * Before the fix `createSharedInteractionsService` broadcast every answer as
 * `{ type: 'user_message', source: 'web', text: <label> }` without a
 * `sourceConnectionId`. ws-chat turned that into `external_user_message` for
 * EVERY connection of the user, the answering app included, which rendered
 * "web (other channel): <label>" although the answer came from the app.
 *
 * Now the only live signal of an answer is the `interaction.updated` frame of
 * the repository write (sealed row, closedSurface = the real surface).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { createInteraction, ingestInteractionMessage, initDatabase, parseAskUserArgs } from '@axiom/core'
import type { Database, InteractionRecord } from '@axiom/core'
import { createInteractionsRouter, createSharedInteractionsService } from './route.js'
import { generateAccessToken } from '../../../auth.js'
import { registerInteractionBroadcast } from '../../../interaction-broadcast.js'
import type { ChatEvent } from '../../../chat-event-bus.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let events: ChatEvent[] = []
let offBroadcast: () => void = () => {}

const chatEventBus = { broadcast: (event: ChatEvent) => { events.push(event) }, subscribe: () => () => {} }

async function post(url: string, body: unknown, userAgent: string) {
  const res = await fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': userAgent },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }
}

function insertAskUser(): InteractionRecord {
  const parsed = parseAskUserArgs({
    blocking: true,
    questions: [{ id: 'q1', type: 'choice', question: 'Welche Strategie?', allowComment: true, options: [{ id: 'blue', label: 'Blue-Green' }, { id: 'roll', label: 'Rolling' }] }],
  }, { id: 'call_echo' })
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.error}`)
  const messageId = Number(db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES ('strand-1', 1, 'user', 'frag mich', 'main')`,
  ).run().lastInsertRowid)
  return createInteraction(db, {
    strandId: 'strand-1', userId: 1, messageId, agent: 'main', payload: parsed.value,
    toolCallId: 'call_echo', blockId: null, blocking: true,
  }).record
}

function insertLegacyCard(): { messageId: number; interaction: InteractionRecord } {
  const content = ['Your call.', '', '```offtangent', JSON.stringify({
    block: 'choice', id: 'b1', question: 'Hand this to Bob?',
    options: [{ id: 'yes', label: 'Hand over to Bob' }, { id: 'stay', label: 'Keep it here' }],
  }), '```'].join('\n')
  const messageId = Number(db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES ('strand-1', 1, 'assistant', ?, 'main')`,
  ).run(content).lastInsertRowid)
  const [interaction] = ingestInteractionMessage(db, { messageId, strandId: 'strand-1', userId: 1, agent: 'main', content })
  return { messageId, interaction: interaction! }
}

beforeAll(async () => {
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run()
  const routerOptions = {
    db,
    chatEventBus: chatEventBus as never,
    getTurnRunner: () => ({ startTurn: () => ({}) }) as never,
    getCaptureConfirmer: () => null,
  }
  const service = createSharedInteractionsService(routerOptions)
  const app = express()
  app.use(express.json())
  app.use('/api/interactions', createInteractionsRouter({ ...routerOptions, service }))
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  offBroadcast = registerInteractionBroadcast({ chatEventBus: chatEventBus as never })
})

afterAll(async () => {
  offBroadcast()
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
})

beforeEach(() => {
  db.prepare('DELETE FROM interaction_requests').run()
  db.prepare('DELETE FROM interactions').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare(`INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES ('strand-1', 1, 'main', 'S', 'interactive')`).run()
  events = []
})

describe('answer echo (fix/interaction-answer-echo)', () => {
  it('ask_user answer from the app: no user_message echo, one interaction.updated with closedSurface android', async () => {
    const card = insertAskUser()
    events = []
    const res = await post(`/api/interactions/${card.id}/answer`, { clientRequestId: 'cr-echo-1', answers: { q1: { selected: ['blue'] } } }, 'okhttp/4.12.0')
    expect(res.status).toBe(200)
    expect(events.filter(e => e.type === 'user_message')).toEqual([])
    const updated = events.filter(e => e.type === 'interaction.updated')
    // The answer write plus the resume bookkeeping: every frame carries the
    // answered row with the real surface, none says 'web'.
    expect(updated.length).toBeGreaterThanOrEqual(1)
    expect(updated[0]).toMatchObject({ userId: 1, sessionId: 'strand-1' })
    for (const frame of updated) {
      expect((frame as unknown as { interaction: Record<string, unknown> }).interaction).toMatchObject({ id: card.id, status: 'answered', closedSurface: 'android' })
    }
  })

  it('ask_user answer from the web: no user_message echo either', async () => {
    const card = insertAskUser()
    events = []
    const res = await post(`/api/interactions/${card.id}/answer`, { clientRequestId: 'cr-echo-2', answers: { q1: { selected: ['roll'] } } }, 'Mozilla/5.0')
    expect(res.status).toBe(200)
    expect(events.some(e => e.type === 'user_message')).toBe(false)
    const updated = events.find(e => e.type === 'interaction.updated') as unknown as { interaction: Record<string, unknown> }
    expect(updated.interaction).toMatchObject({ status: 'answered', closedSurface: 'web' })
  })

  it('legacy block answer (messageId + blockId): no user_message echo, the card closes via interaction.updated', async () => {
    const { messageId } = insertLegacyCard()
    events = []
    const res = await post('/api/interactions', { messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cm-echo-1' }, 'okhttp/4.12.0')
    expect(res.status).toBe(200)
    expect(events.some(e => e.type === 'user_message')).toBe(false)
    const updated = events.find(e => e.type === 'interaction.updated') as unknown as { interaction: Record<string, unknown> }
    expect(updated.interaction).toMatchObject({ status: 'answered', closedSurface: 'android' })
  })
})
