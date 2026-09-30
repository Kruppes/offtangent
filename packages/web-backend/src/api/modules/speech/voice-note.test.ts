/**
 * POST /api/speech/voice-note and the per-user voice-reply switch, against a
 * real database and a real express app. The voice itself is injected — no
 * test ever talks to a provider.
 *
 * Covered: the contract shape, idempotency, one generation for concurrent
 * callers, the error codes, ownership (a foreign message answers 404 like a
 * missing one), user rows being refused, the metadata merge keeping existing
 * attachments, and that the history hands the note out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import {
  initDatabase,
  SpeechSummaryEmptyError,
  VoiceNoteUnconfiguredError,
  VoiceNoteUpstreamError,
  type CreatedVoiceNote,
  type Database,
} from '@axiom/core'
import { createSpeechRouter } from './route.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string

/** What the injected generator does on the next call. */
let behaviour: 'ok' | 'empty' | 'upstream' | 'unconfigured' | 'slow' = 'ok'
/** Every raw text the generator was handed. */
let seen: string[] = []
/** How often the generator actually ran. */
let runs = 0
/** What the generator claims Gemini reported; null = provider sent nothing. */
let reportedUsage: { promptTokens: number; completionTokens: number } | null = null
/** When set, the injected generator includes this variant in the returned voiceNote. */
let reportedVariant: 'full' | 'summary' | undefined = undefined

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
  metadata?: string | null
}): number {
  const result = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id)
     VALUES (?, ?, ?, ?, ?, 'main')`,
  ).run(
    input.sessionId ?? 'strand-1',
    input.userId ?? null,
    input.role ?? 'assistant',
    input.content,
    input.metadata ?? null,
  )
  return Number(result.lastInsertRowid)
}

async function post(
  path: string,
  body: unknown,
  auth: string | null = token,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

async function call(
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown,
  auth: string | null = token,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

const LONG_ANSWER = `Der Lauf ist durch. ${'Es gibt dazu noch einige weitere Sätze über den Ablauf. '.repeat(20)}`

/** Frames the router broadcast. */
let frames: Array<Record<string, unknown>> = []

beforeAll(async () => {
  process.env.JWT_SECRET = 'voice-note-test-secret'
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'x', 'admin')").run()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'other', 'x', 'user')").run()
  token = generateAccessToken({ userId: 1, username: 'owner', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })

  const app = express()
  app.use(express.json())
  app.use('/api/speech', createSpeechRouter({
    db,
    createVoiceNote: async (raw): Promise<CreatedVoiceNote> => {
      seen.push(raw)
      runs += 1
      if (behaviour === 'empty') throw new SpeechSummaryEmptyError('nothing to speak')
      if (behaviour === 'upstream') throw new VoiceNoteUpstreamError('the voice said no')
      if (behaviour === 'unconfigured') throw new VoiceNoteUnconfiguredError()
      if (behaviour === 'slow') await new Promise(resolve => setTimeout(resolve, 60))
      const noteBase = {
        url: `/api/uploads/voice-note-${runs}.ogg`,
        mimeType: 'audio/ogg',
        seconds: 12.5,
        spokenChars: 140,
        sourceChars: raw.length,
        model: 'gemini-3.8-flash-lite-tts',
        voice: 'Charon',
        createdAt: '2026-09-24T10:00:00.000Z',
        ...(reportedVariant !== undefined ? { variant: reportedVariant } : {}),
      }
      return {
        voiceNote: noteBase,
        upload: {
          kind: 'file', storedName: 'voice.ogg', relativePath: 'x/voice.ogg',
          urlPath: `/api/uploads/voice-note-${runs}.ogg`,
          originalName: 'voice-note.ogg', mimeType: 'audio/ogg', size: 1234,
        },
        script: {
          text: 'Der Lauf ist durch.', language: 'de', sourceChars: raw.length, summaryChars: 19,
          model: 'test:model', passthrough: false,
        },
        chunks: 1,
        usage: reportedUsage,
      }
    },
    onVoiceNote: frame => { frames.push(frame as unknown as Record<string, unknown>) },
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
  behaviour = 'ok'
  seen = []
  runs = 0
  reportedUsage = null
  reportedVariant = undefined
  frames = []
  db.prepare('DELETE FROM token_usage').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM user_settings').run()
  insertSession('strand-1', 1)
  insertSession('strand-2', 2)
})

describe('POST /api/speech/voice-note', () => {
  it('rejects an unauthenticated call', async () => {
    const res = await post('/api/speech/voice-note', { messageId: 1 }, null)
    expect(res.status).toBe(401)
  })

  it('creates the note, answers the contract shape and persists it', async () => {
    const id = insertMessage({ content: LONG_ANSWER, userId: null })
    const res = await post('/api/speech/voice-note', { messageId: id })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      voiceNote: {
        url: '/api/uploads/voice-note-1.ogg',
        mimeType: 'audio/ogg',
        seconds: 12.5,
        spokenChars: 140,
        sourceChars: LONG_ANSWER.length,
        model: 'gemini-3.8-flash-lite-tts',
        voice: 'Charon',
        createdAt: '2026-09-24T10:00:00.000Z',
      },
    })
    expect(seen).toEqual([LONG_ANSWER])

    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(id) as { metadata: string }
    expect(JSON.parse(row.metadata).voiceNote.url).toBe('/api/uploads/voice-note-1.ogg')
  })

  it('broadcasts one voice_note frame with the strand and the message', async () => {
    const id = insertMessage({ content: LONG_ANSWER, userId: null })
    await post('/api/speech/voice-note', { messageId: id })

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ userId: 1, sessionId: 'strand-1', messageId: id })
    expect((frames[0]!.voiceNote as { url: string }).url).toBe('/api/uploads/voice-note-1.ogg')
  })

  it('returns the existing note without generating a second one', async () => {
    const id = insertMessage({ content: LONG_ANSWER, userId: null })
    const first = await post('/api/speech/voice-note', { messageId: id })
    const second = await post('/api/speech/voice-note', { messageId: id })

    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(runs).toBe(1)
  })

  it('lets concurrent callers share one generation', async () => {
    behaviour = 'slow'
    const id = insertMessage({ content: LONG_ANSWER, userId: null })
    const [a, b, c] = await Promise.all([
      post('/api/speech/voice-note', { messageId: id }),
      post('/api/speech/voice-note', { messageId: id }),
      post('/api/speech/voice-note', { messageId: id }),
    ])

    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect(a.body).toEqual(b.body)
    expect(b.body).toEqual(c.body)
    expect(runs).toBe(1)
  })

  it('keeps the attachments that already hang on the message', async () => {
    const metadata = JSON.stringify({
      kind: 'answer',
      files: [{ kind: 'file', storedName: 'b.pdf', relativePath: 'a/b.pdf', urlPath: '/api/uploads/b.pdf', originalName: 'b.pdf', mimeType: 'application/pdf', size: 10 }],
    })
    const id = insertMessage({ content: LONG_ANSWER, userId: null, metadata })
    await post('/api/speech/voice-note', { messageId: id })

    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(id) as { metadata: string }
    const parsed = JSON.parse(row.metadata)
    expect(parsed.kind).toBe('answer')
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0].urlPath).toBe('/api/uploads/b.pdf')
    expect(parsed.voiceNote.url).toBe('/api/uploads/voice-note-1.ogg')
  })

  it('answers 404 for a foreign message and never runs the voice', async () => {
    const id = insertMessage({ content: LONG_ANSWER, userId: null, sessionId: 'strand-2' })
    const res = await post('/api/speech/voice-note', { messageId: id })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(runs).toBe(0)
  })

  it('answers 404 for a message that does not exist', async () => {
    const res = await post('/api/speech/voice-note', { messageId: 999999 })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('refuses a user message: only an answer gets a voice note', async () => {
    const id = insertMessage({ content: LONG_ANSWER, userId: 1, role: 'user' })
    const res = await post('/api/speech/voice-note', { messageId: id })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(runs).toBe(0)
  })

  it('answers 400 invalid_body without a messageId', async () => {
    const res = await post('/api/speech/voice-note', { text: 'kein Verweis' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_body' })
  })

  it('answers 400 empty when nothing speakable is left', async () => {
    behaviour = 'empty'
    const id = insertMessage({ content: '```\ncode only\n```', userId: null })
    const res = await post('/api/speech/voice-note', { messageId: id })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'empty' })
  })

  it('answers 502 when the voice fails', async () => {
    behaviour = 'upstream'
    const id = insertMessage({ content: LONG_ANSWER, userId: null })
    const res = await post('/api/speech/voice-note', { messageId: id })

    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'upstream' })
  })

  it('answers 503 when no Gemini voice is configured', async () => {
    behaviour = 'unconfigured'
    const id = insertMessage({ content: LONG_ANSWER, userId: null })
    const res = await post('/api/speech/voice-note', { messageId: id })

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'tts_unconfigured' })
  })

  it('retries after a failure instead of caching the error', async () => {
    behaviour = 'upstream'
    const id = insertMessage({ content: LONG_ANSWER, userId: null })
    expect((await post('/api/speech/voice-note', { messageId: id })).status).toBe(502)

    behaviour = 'ok'
    const res = await post('/api/speech/voice-note', { messageId: id })
    expect(res.status).toBe(200)
    expect(runs).toBe(2)
  })

  it('includes variant in the response when the generator produced it', async () => {
    reportedVariant = 'full'
    const id = insertMessage({ content: LONG_ANSWER, userId: null })
    const res = await post('/api/speech/voice-note', { messageId: id })

    expect(res.status).toBe(200)
    expect((res.body.voiceNote as Record<string, unknown>).variant).toBe('full')
  })

  it('omits variant from the response when the generator did not produce it', async () => {
    reportedVariant = undefined
    const id = insertMessage({ content: LONG_ANSWER, userId: null })
    const res = await post('/api/speech/voice-note', { messageId: id })

    expect(res.status).toBe(200)
    expect('variant' in (res.body.voiceNote as Record<string, unknown>)).toBe(false)
  })
})

describe('GET/PUT /api/speech/voice-replies', () => {
  it('rejects an unauthenticated call', async () => {
    expect((await call('GET', '/api/speech/voice-replies', undefined, null)).status).toBe(401)
  })

  it('is off by default', async () => {
    expect(await call('GET', '/api/speech/voice-replies')).toEqual({ status: 200, body: { enabled: false } })
  })

  it('stores the switch per user', async () => {
    const put = await call('PUT', '/api/speech/voice-replies', { enabled: true })
    expect(put).toEqual({ status: 200, body: { enabled: true } })

    expect((await call('GET', '/api/speech/voice-replies')).body).toEqual({ enabled: true })
    // The other user is untouched.
    expect((await call('GET', '/api/speech/voice-replies', undefined, otherToken)).body)
      .toEqual({ enabled: false })

    await call('PUT', '/api/speech/voice-replies', { enabled: false })
    expect((await call('GET', '/api/speech/voice-replies')).body).toEqual({ enabled: false })
  })

  it('rejects a body without a boolean', async () => {
    const res = await call('PUT', '/api/speech/voice-replies', { enabled: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_body' })
  })
})

describe('voice note accounting', () => {
  it('books the provider token counts, and only estimates when none came back', async () => {
    reportedUsage = { promptTokens: 31, completionTokens: 1840 }
    const withUsage = insertMessage({ content: 'Der Lauf ist durch, alles gruen.' })
    await post('/api/speech/voice-note', { messageId: withUsage }, token)

    const booked = db.prepare(
      'SELECT provider, model, prompt_tokens, completion_tokens, estimated_cost FROM token_usage ORDER BY id DESC LIMIT 1',
    ).get() as Record<string, unknown>
    expect(booked.provider).toBe('gemini')
    expect(booked.model).toBe('gemini-3.8-flash-lite-tts')
    expect(booked.prompt_tokens).toBe(31)
    expect(booked.completion_tokens).toBe(1840)
    expect(booked.estimated_cost as number).toBeGreaterThan(0)

    // No usage block from the provider: the row is an estimate, never missing.
    reportedUsage = null
    const withoutUsage = insertMessage({ content: 'Zweite Antwort, ebenfalls fertig.' })
    await post('/api/speech/voice-note', { messageId: withoutUsage }, token)

    const estimated = db.prepare(
      'SELECT prompt_tokens, completion_tokens FROM token_usage ORDER BY id DESC LIMIT 1',
    ).get() as { prompt_tokens: number; completion_tokens: number }
    expect(estimated.completion_tokens).toBeGreaterThan(0)
    expect(estimated.completion_tokens).not.toBe(1840)
    expect(db.prepare('SELECT count(*) c FROM token_usage').get()).toEqual({ c: 2 })
  })
})
