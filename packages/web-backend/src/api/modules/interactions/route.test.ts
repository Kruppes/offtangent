/**
 * POST /api/interactions (SPEC 7.4c) against a real database and a real
 * express app. Covers the whole contract: idempotency, 409 already_answered,
 * 410 stale, ownership, and the fact that an answer is filed as an ordinary
 * user message in the strand.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { initDatabase, readInteractionAnswers } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createInteractionsRouter } from './route.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let turns: Array<{ sessionId: string; text: string }> = []
let turnRunnerAvailable = true
/** Every capture-bound block the captures service was asked to resolve. */
let confirmations: Array<{ userId: number; captureId: string; blockId: string; choice: string }> = []
/** What the stubbed captures service answers; null means "not wired at all". */
let confirmerResult: { handled: boolean; resumed: boolean } | null = { handled: true, resumed: true }

const CHOICE_FENCE = [
  '```offtangent',
  JSON.stringify({
    block: 'choice',
    id: 'b1',
    question: 'Hand this to Bob?',
    options: [
      { id: 'yes', label: 'Hand over to Bob' },
      { id: 'stay', label: 'Keep it here' },
    ],
  }),
  '```',
].join('\n')

function messageContent(fence = CHOICE_FENCE): string {
  return `That is a decision for you.\n\n${fence}`
}

function insertSession(id: string, userId = 1): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES (?, ?, 'main', 'Strand', 'interactive')`,
  ).run(id, userId)
}

function insertBlockMessage(input: {
  sessionId?: string
  userId?: number
  content?: string
  metadata?: string | null
  captureId?: string | null
} = {}): number {
  const sessionId = input.sessionId ?? 'strand-1'
  const result = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, capture_id)
     VALUES (?, ?, 'assistant', ?, ?, 'main', ?)`,
  ).run(sessionId, input.userId ?? 1, input.content ?? messageContent(), input.metadata ?? null, input.captureId ?? null)
  return Number(result.lastInsertRowid)
}

async function post(body: unknown, authToken = token): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> }
}

beforeAll(async () => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')

  const app = express()
  app.use(express.json())
  app.use('/api/interactions', createInteractionsRouter({
    db,
    getTurnRunner: () => turnRunnerAvailable
      ? { startTurn: (input) => { turns.push({ sessionId: input.sessionId, text: input.text }); return {} } }
      : null,
    // The captures service in app.ts. A block that hangs off a capture is
    // resolved there, because "keep the note" must run no turn at all and
    // "answer it" must run the turn on the capture text.
    getCaptureConfirmer: () => confirmerResult === null
      ? null
      : {
        confirmNoteFiling: (userId, input) => {
          confirmations.push({ userId, ...input })
          return confirmerResult!
        },
      },
  }))

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
})

beforeEach(() => {
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM sessions').run()
  insertSession('strand-1')
  turns = []
  turnRunnerAvailable = true
  confirmations = []
  confirmerResult = { handled: true, resumed: true }
})

describe('POST /api/interactions', () => {
  it('applies an answer, files it as a user message and resumes the turn', async () => {
    const messageId = insertBlockMessage()
    const res = await post({ messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cmid-1' })

    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ applied: true, resumed: true, idempotent: false, label: 'Hand over to Bob' })

    const filed = db.prepare(
      "SELECT content, session_id, client_message_id FROM chat_messages WHERE role = 'user'",
    ).all() as { content: string; session_id: string; client_message_id: string }[]
    expect(filed).toHaveLength(1)
    expect(filed[0]!.content).toBe('Hand over to Bob')
    expect(filed[0]!.session_id).toBe('strand-1')
    expect(filed[0]!.client_message_id).toBe('cmid-1')
    expect(turns).toEqual([{ sessionId: 'strand-1', text: 'Hand over to Bob' }])
  })

  it('records the answer in the metadata of the block message (no schema change)', async () => {
    const messageId = insertBlockMessage({ metadata: JSON.stringify({ kind: 'thinking-free', files: [] }) })
    await post({ messageId, blockId: 'b1', value: 'stay', clientMessageId: 'cmid-2' })

    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(messageId) as { metadata: string }
    const parsed = JSON.parse(row.metadata) as Record<string, unknown>
    expect(parsed.kind).toBe('thinking-free')
    const answers = readInteractionAnswers(row.metadata)
    expect(answers.b1).toMatchObject({ value: 'stay', label: 'Keep it here', clientMessageId: 'cmid-2', resumed: true })
    expect(answers.b1!.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('is idempotent for a repeated clientMessageId: one answer, one turn', async () => {
    const messageId = insertBlockMessage()
    const first = await post({ messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cmid-3' })
    const second = await post({ messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cmid-3' })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.json).toMatchObject({ applied: true, idempotent: true, label: 'Hand over to Bob' })

    const userRows = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user'").get() as { n: number }
    expect(userRows.n).toBe(1)
    expect(turns).toHaveLength(1)
  })

  it('answers a second, different answer with 409 already_answered and the stored value', async () => {
    const messageId = insertBlockMessage()
    await post({ messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cmid-4' })
    const conflict = await post({ messageId, blockId: 'b1', value: 'stay', clientMessageId: 'cmid-5' })

    expect(conflict.status).toBe(409)
    expect(conflict.json.code).toBe('already_answered')
    expect(conflict.json.value).toBe('yes')
    expect(conflict.json.label).toBe('Hand over to Bob')
    expect(turns).toHaveLength(1)
  })

  it('answers a deleted strand with 410 stale', async () => {
    const messageId = insertBlockMessage()
    // The strand went away (SPEC 7.5b delete) but the row is still on screen.
    db.prepare('DELETE FROM sessions WHERE id = ?').run('strand-1')

    const res = await post({ messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cmid-6' })
    expect(res.status).toBe(410)
    expect(res.json.code).toBe('stale')
    expect(turns).toHaveLength(0)
  })

  it('answers an expired block with 410 stale', async () => {
    const expiredFence = [
      '```offtangent',
      JSON.stringify({
        block: 'confirm',
        id: 'c1',
        question: 'Still send it?',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      '```',
    ].join('\n')
    const messageId = insertBlockMessage({ content: messageContent(expiredFence) })

    const res = await post({ messageId, blockId: 'c1', value: 'yes', clientMessageId: 'cmid-7' })
    expect(res.status).toBe(410)
    expect(res.json.code).toBe('stale')
  })

  it('rejects a value that is not an option of the block', async () => {
    const messageId = insertBlockMessage()
    const res = await post({ messageId, blockId: 'b1', value: 'maybe', clientMessageId: 'cmid-8' })
    expect(res.status).toBe(400)
    expect(res.json.code).toBe('invalid_value')
  })

  it('404s an unknown block and an unknown message', async () => {
    const messageId = insertBlockMessage()
    expect((await post({ messageId, blockId: 'nope', value: 'yes', clientMessageId: 'c1' })).status).toBe(404)
    expect((await post({ messageId: messageId + 999, blockId: 'b1', value: 'yes', clientMessageId: 'c2' })).status).toBe(404)
  })

  it('does not let another user answer my card', async () => {
    const messageId = insertBlockMessage()
    const res = await post({ messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cmid-9' }, otherToken)

    expect(res.status).toBe(404)
    expect(res.json.code).toBe('unknown_message')
    expect(turns).toHaveLength(0)
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 1, blockId: 'b1', value: 'yes', clientMessageId: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it.each([
    ['no body fields', {}],
    ['a missing clientMessageId', { messageId: 1, blockId: 'b1', value: 'yes' }],
    ['an empty value', { messageId: 1, blockId: 'b1', value: '', clientMessageId: 'x' }],
    ['a numeric value', { messageId: 1, blockId: 'b1', value: 7, clientMessageId: 'x' }],
    ['an empty multi value', { messageId: 1, blockId: 'b1', value: [], clientMessageId: 'x' }],
  ])('rejects %s with 400', async (_name, body) => {
    expect((await post(body)).status).toBe(400)
  })

  it('files the answer even without a turn runner (degradation, not failure)', async () => {
    turnRunnerAvailable = false
    const messageId = insertBlockMessage()
    const res = await post({ messageId, blockId: 'b1', value: 'stay', clientMessageId: 'cmid-10' })

    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ applied: true, resumed: false })
    const filed = db.prepare("SELECT content FROM chat_messages WHERE role = 'user'").get() as { content: string }
    expect(filed.content).toBe('Keep it here')
  })

  it('answers a confirm block with its default yes/no options', async () => {
    const confirmFence = [
      '```offtangent',
      JSON.stringify({ block: 'confirm', id: 'c9', question: 'Delete the draft?', destructive: true }),
      '```',
    ].join('\n')
    const messageId = insertBlockMessage({ content: messageContent(confirmFence) })

    const res = await post({ messageId, blockId: 'c9', value: 'no', clientMessageId: 'cmid-11' })
    expect(res.status).toBe(200)
    expect(res.json.label).toBe('No')
  })

  it('refuses to answer a draft block: it is output, not a question', async () => {
    // Puck assist waves (W1): a `draft` carries the text a device types, there
    // is nothing to tap. It is deliberately NOT answerable, so an id pointing
    // at one gets the same 404 an id that does not exist gets — no separate
    // error class for a client to special-case.
    const draftFence = [
      '```offtangent',
      JSON.stringify({ block: 'draft', text: 'Sehr geehrter Herr Mueller,\n\nKW 42 passt.' }),
      '```',
    ].join('\n')
    const messageId = insertBlockMessage({ content: messageContent(draftFence) })

    const res = await post({ messageId, blockId: 'draft', value: 'yes', clientMessageId: 'cmid-draft' })
    expect(res.status).toBe(404)
    expect(res.json.code).toBe('unknown_block')
    // Nothing was written: no answer state, no user message, no turn.
    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(messageId) as { metadata: string | null }
    expect(readInteractionAnswers(row.metadata ?? '{}')).toEqual({})
  })

  it('ignores a block that only exists as broken JSON', async () => {
    const broken = '```offtangent\n{ "block": "choice", "id": "b1"\n```'
    const messageId = insertBlockMessage({ content: messageContent(broken) })

    const res = await post({ messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cmid-12' })
    expect(res.status).toBe(404)
    expect(res.json.code).toBe('unknown_block')
  })
})

describe('a block that belongs to a capture', () => {
  it('hands the answer to the captures service and files no user message', async () => {
    const messageId = insertBlockMessage({ captureId: 'cap-1' })
    const res = await post({ messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cmid-cap' })

    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ applied: true, resumed: true, idempotent: false, label: 'Hand over to Bob' })
    expect(confirmations).toEqual([{ userId: 1, captureId: 'cap-1', blockId: 'b1', choice: 'yes' }])

    // No user row and no generic turn: the label the user tapped is not the
    // question, the capture text is, and the captures service owns that turn.
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user'").get()).toEqual({ n: 0 })
    expect(turns).toEqual([])

    // The answer state is written all the same, so the card collapses.
    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(messageId) as { metadata: string }
    expect(readInteractionAnswers(row.metadata).b1).toMatchObject({ value: 'yes', resumed: true, clientMessageId: 'cmid-cap' })

    // And a second tap is still a conflict.
    const again = await post({ messageId, blockId: 'b1', value: 'stay', clientMessageId: 'cmid-cap-2' })
    expect(again.status).toBe(409)
    expect(confirmations).toHaveLength(1)
  })

  it('reports resumed=false when the captures service started nothing', async () => {
    confirmerResult = { handled: true, resumed: false }
    const messageId = insertBlockMessage({ captureId: 'cap-2' })
    const res = await post({ messageId, blockId: 'b1', value: 'stay', clientMessageId: 'cmid-keep' })
    expect(res.json).toMatchObject({ applied: true, resumed: false })
    expect(turns).toEqual([])
  })

  it('falls back to the ordinary path when the service does not claim the block', async () => {
    confirmerResult = { handled: false, resumed: false }
    const messageId = insertBlockMessage({ captureId: 'cap-3' })
    const res = await post({ messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cmid-generic' })

    expect(res.status).toBe(200)
    expect(confirmations).toHaveLength(1)
    expect(turns).toEqual([{ sessionId: 'strand-1', text: 'Hand over to Bob' }])
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user'").get()).toEqual({ n: 1 })
  })

  it('never asks the service about a message without a capture', async () => {
    const messageId = insertBlockMessage()
    await post({ messageId, blockId: 'b1', value: 'yes', clientMessageId: 'cmid-plain' })
    expect(confirmations).toEqual([])
    expect(turns).toEqual([{ sessionId: 'strand-1', text: 'Hand over to Bob' }])
  })
})

/**
 * The contract declares five kinds. Two of them render as a card in the web
 * frontend today, but the Android app already draws `multi` and `handover`
 * too — and those answered `404 unknown_block` here (measured against
 * https://offtangent.example.com on 2026-09-15). A declared kind that cannot
 * be answered is a broken contract, so the server now accepts an answer for
 * every kind and keeps validating the value against the block's own options.
 */
describe('every kind the contract declares can be answered', () => {
  function fenceOf(kind: string, id: string): string {
    return [
      '```offtangent',
      JSON.stringify({
        block: kind,
        id,
        question: 'Which one?',
        options: [
          { id: 'a', label: 'Option A' },
          { id: 'b', label: 'Option B' },
        ],
      }),
      '```',
    ].join('\n')
  }

  for (const kind of ['choice', 'multi', 'confirm', 'handover', 'schedule']) {
    it(`accepts an answer to a ${kind} block`, async () => {
      const messageId = insertBlockMessage({ content: messageContent(fenceOf(kind, `k-${kind}`)) })
      const res = await post({ messageId, blockId: `k-${kind}`, value: 'a', clientMessageId: `cmid-${kind}` })

      expect(res.status).toBe(200)
      expect(res.json).toMatchObject({ applied: true, label: 'Option A' })
      const filed = db.prepare("SELECT content FROM chat_messages WHERE role = 'user'").get() as { content: string }
      expect(filed.content).toBe('Option A')
    })
  }

  it('takes a list of ids for multi and files every label', async () => {
    const messageId = insertBlockMessage({ content: messageContent(fenceOf('multi', 'm1')) })
    const res = await post({ messageId, blockId: 'm1', value: ['a', 'b'], clientMessageId: 'cmid-multi-list' })

    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ applied: true, label: 'Option A, Option B' })
    expect(res.json.value).toEqual(['a', 'b'])
  })

  it('refuses a list for a kind that is not multi', async () => {
    const messageId = insertBlockMessage({ content: messageContent(fenceOf('handover', 'h2')) })
    const res = await post({ messageId, blockId: 'h2', value: ['a'], clientMessageId: 'cmid-h2' })

    expect(res.status).toBe(400)
    expect(res.json.code).toBe('invalid_value')
  })

  it('still refuses an option the block does not have', async () => {
    const messageId = insertBlockMessage({ content: messageContent(fenceOf('schedule', 's2')) })
    const res = await post({ messageId, blockId: 's2', value: 'c', clientMessageId: 'cmid-s2' })

    expect(res.status).toBe(400)
    expect(res.json.code).toBe('invalid_value')
  })

  it('answers the second card of a message too, which the renderer degrades to text', async () => {
    const content = `${messageContent(fenceOf('choice', 'first'))}\n\n${fenceOf('multi', 'second')}`
    const messageId = insertBlockMessage({ content })

    const res = await post({ messageId, blockId: 'second', value: ['b'], clientMessageId: 'cmid-second' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ applied: true, label: 'Option B' })
  })
})
