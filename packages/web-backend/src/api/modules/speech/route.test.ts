/**
 * POST /api/speech/summary against a real database and a real express app.
 * Covers the whole contract the companion app builds against: auth, the two
 * body forms, ownership (404), the short-message passthrough, the 400 for an
 * empty message and the 502 for a failing model. The model itself is never
 * called — the summarizer is injected.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { initDatabase, SpeechSummaryUpstreamError, summarizeForSpeech } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createSpeechRouter } from './route.js'
import { clearSpeechSummaryCache } from './service.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string

/** What the injected summarizer does on the next call. */
let behaviour: 'real' | 'upstream' = 'real'
/** Every raw text the summarizer was handed. */
let seen: string[] = []

const TABLE_REPORT = [
  '## Deploy-Bericht',
  '',
  'Der Deploy ist durch und alle Gates sind grün.',
  '',
  '| Gate | Baseline | Final |',
  '|---|---|---|',
  '| Tests | 3352 | 3372 |',
  '| Lint | 0 | 0 |',
  '',
  `Details unter https://offtangent.example.com/report und in \`packages/web-backend/src/app.ts\`. ${'Der Bericht enthält viele weitere Sätze über den Ablauf. '.repeat(20)}`,
].join('\n')

function insertSession(id: string, userId: number | null): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES (?, ?, 'main', 'Strand', 'interactive')`,
  ).run(id, userId)
}

function insertMessage(input: {
  content: string
  userId?: number | null
  sessionId?: string
  role?: string
}): number {
  const result = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id)
     VALUES (?, ?, ?, ?, 'main')`,
  ).run(input.sessionId ?? 'strand-1', input.userId ?? null, input.role ?? 'assistant', input.content)
  return Number(result.lastInsertRowid)
}

async function post(body: unknown, auth: string | null = token): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/speech/summary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'speech-summary-test-secret'
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'x', 'admin')").run()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'other', 'x', 'user')").run()
  token = generateAccessToken({ userId: 1, username: 'owner', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })

  const app = express()
  app.use(express.json())
  app.use('/api/speech', createSpeechRouter({
    db,
    summarize: async raw => {
      seen.push(raw)
      if (behaviour === 'upstream') throw new SpeechSummaryUpstreamError('provider said no')
      // The real pipeline with a stubbed model: cleaning, language detection
      // and the passthrough rule are exercised for real.
      return summarizeForSpeech(raw, {
        complete: async () => ({
          text: 'Der Deploy ist durch. Alle Gates sind grün. Als Nächstes kommt die App.',
          model: 'test-provider:test-model',
        }),
      })
    },
  }))

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
})

beforeEach(() => {
  behaviour = 'real'
  seen = []
  clearSpeechSummaryCache()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM sessions').run()
  insertSession('strand-1', 1)
})

describe('POST /api/speech/summary', () => {
  it('rejects an unauthenticated call', async () => {
    const res = await post({ text: 'Hallo' }, null)
    expect(res.status).toBe(401)
  })

  it('summarizes a stored message and answers the contract shape', async () => {
    const id = insertMessage({ content: TABLE_REPORT, userId: 1 })
    const res = await post({ messageId: id })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      text: 'Der Deploy ist durch. Alle Gates sind grün. Als Nächstes kommt die App.',
      language: 'de',
      sourceChars: TABLE_REPORT.length,
      summaryChars: 71,
    })
    expect(seen).toEqual([TABLE_REPORT])
  })

  it('reads a short message out as it stands, cleaned', async () => {
    const id = insertMessage({
      content: '## ✅ Fertig\n\nDer Container läuft, siehe `packages/core/src/app.ts` und https://example.com/x.',
      userId: 1,
    })
    const res = await post({ messageId: id })

    expect(res.status).toBe(200)
    expect(res.body.language).toBe('de')
    const text = res.body.text as string
    expect(text).toMatch(/^Fertig Der Container läuft/)
    expect(text).not.toMatch(/[#*`|]/)
    expect(text).not.toContain('http')
    expect(res.body.summaryChars).toBe(text.length)
    expect(res.body.sourceChars).toBeGreaterThan(text.length)
  })

  it('accepts a raw text body for a bubble that was never stored', async () => {
    const res = await post({ text: 'The container is healthy and the smoke test passed.' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      text: 'The container is healthy and the smoke test passed.',
      language: 'en',
      sourceChars: 51,
      summaryChars: 51,
    })
  })

  it('answers 404 for an unknown message id', async () => {
    const res = await post({ messageId: 987654 })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('answers 404 for a message of another user', async () => {
    const id = insertMessage({ content: TABLE_REPORT, userId: 1 })
    const res = await post({ messageId: id }, otherToken)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(seen).toEqual([])
  })

  it('accepts an assistant row without user_id when the strand belongs to the caller', async () => {
    const id = insertMessage({ content: 'Der Container läuft wieder.', userId: null, sessionId: 'strand-1' })
    const res = await post({ messageId: id })
    expect(res.status).toBe(200)
    expect(res.body.text).toBe('Der Container läuft wieder.')
  })

  it('answers 404 for an assistant row in a foreign strand', async () => {
    insertSession('strand-2', 2)
    const id = insertMessage({ content: 'Fremder Strand.', userId: null, sessionId: 'strand-2' })
    const res = await post({ messageId: id })
    expect(res.status).toBe(404)
  })

  it('answers 400 empty when nothing speakable is left', async () => {
    const id = insertMessage({ content: '```\nconst a = 1\n```', userId: 1 })
    const res = await post({ messageId: id })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'empty' })
  })

  it('answers 400 empty for an empty text body', async () => {
    const res = await post({ text: '   \n\n' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'empty' })
  })

  it('answers 400 for a body with neither messageId nor text', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_body')
  })

  it('answers 400 for a malformed message id', async () => {
    const res = await post({ messageId: 'not-a-number' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_message_id')
  })

  it('answers 502 upstream when the model fails, never an empty summary', async () => {
    behaviour = 'upstream'
    const id = insertMessage({ content: TABLE_REPORT, userId: 1 })
    const res = await post({ messageId: id })
    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'upstream' })
  })

  it('serves a repeated request for the same message from the cache', async () => {
    const id = insertMessage({ content: TABLE_REPORT, userId: 1 })
    const first = await post({ messageId: id })
    const second = await post({ messageId: id })
    expect(first.body).toEqual(second.body)
    expect(seen).toHaveLength(1)
  })

  it('prefers messageId when a body carries both forms', async () => {
    const id = insertMessage({ content: 'Der Strand ist wieder frei.', userId: 1 })
    const res = await post({ messageId: id, text: 'Etwas ganz anderes.' })
    expect(res.status).toBe(200)
    expect(res.body.text).toBe('Der Strand ist wieder frei.')
  })
})
