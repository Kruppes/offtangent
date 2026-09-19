/**
 * POST /api/speech/audio against a real database and a real express app.
 *
 * Covers the frozen contract the companion app builds against: auth, both
 * body forms, ownership (404), the 400 codes, 502 for a failing summary model
 * AND for a failing TTS service, and 503 when no local TTS is configured.
 * Neither the summary model nor the TTS service is ever really called — both
 * are injected, so this test makes no network call at all.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { initDatabase, SpeechSummaryUpstreamError, summarizeForSpeech, TtsFormatError } from '@axiom/core'
import type { Database } from '@axiom/core'
import type { TtsResponseFormat } from '@axiom/core/contracts'
import { createSpeechRouter } from './route.js'
import { clearSpeechSummaryCache } from './service.js'
import { SPEECH_TEXT_MAX_CHARS } from './schema.js'
import { LocalTtsError, type SynthesizeSpeechInput } from './tts.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string

/** What the injected summarizer does on the next call. */
let summaryBehaviour: 'real' | 'upstream' = 'real'
/** What the injected TTS does on the next call. */
let ttsBehaviour: 'ok' | 'fail' = 'ok'
/** What the injected settings loader reports. */
let ttsUrl = 'http://tts.invalid:7400'
/** Every synthesize call the service made. */
let synthCalls: SynthesizeSpeechInput[] = []
/** Whether the injected cloud TTS reports itself enabled, and how it behaves. */
let cloudEnabled = false
let cloudBehaviour: 'ok' | 'fail' | 'unsupported' = 'ok'
/** Every cloud synthesize call the service made. */
let cloudCalls: string[] = []
/** The `format` argument of every cloud synthesize call. */
let cloudFormats: (TtsResponseFormat | null)[] = []

/** Stand-in for what the Gemini path produces: Ogg magic, served as audio/ogg. */
const FAKE_CLOUD = { audio: Buffer.from('OggScloud'), contentType: 'audio/ogg' }

/** Stand-in for the WAV branch of the same provider. */
const FAKE_CLOUD_WAV = { audio: Buffer.from('RIFF....WAVEfmt '), contentType: 'audio/wav' }

/** Stand-in for OGG Opus bytes: the real magic bytes, then a little payload. */
const FAKE_OGG = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2, 0, 0, 0, 0, 0, 0])])

const LONG_REPORT = [
  '## Deploy-Bericht',
  '',
  'Der Deploy ist durch und alle Gates sind grün.',
  '',
  `Details unter https://offtangent.example.com/report. ${'Der Bericht enthält viele weitere Sätze über den Ablauf. '.repeat(20)}`,
].join('\n')

function insertSession(id: string, userId: number | null): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES (?, ?, 'main', 'Strand', 'interactive')`,
  ).run(id, userId)
}

function insertMessage(input: { content: string; userId?: number | null; sessionId?: string }): number {
  const result = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id)
     VALUES (?, ?, 'assistant', ?, 'main')`,
  ).run(input.sessionId ?? 'strand-1', input.userId ?? null, input.content)
  return Number(result.lastInsertRowid)
}

interface AudioResponse {
  status: number
  headers: { contentType: string | null; language: string | null; summaryChars: string | null }
  bytes: Buffer
  json: Record<string, unknown>
}

async function postAudio(body: unknown, auth: string | null = token): Promise<AudioResponse> {
  const res = await fetch(`${baseUrl}/api/speech/audio`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const bytes = Buffer.from(await res.arrayBuffer())
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  } catch {
    json = {}
  }
  return {
    status: res.status,
    headers: {
      contentType: res.headers.get('content-type'),
      language: res.headers.get('x-speech-language'),
      summaryChars: res.headers.get('x-speech-summary-chars'),
    },
    bytes,
    json,
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'speech-audio-test-secret'
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'x', 'admin')").run()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'other', 'x', 'user')").run()
  token = generateAccessToken({ userId: 1, username: 'owner', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })

  const app = express()
  // A second mount with a larger body limit. The app mounts the router behind
  // the default `express.json()` (100 kB), so a body above SPEECH_TEXT_MAX_CHARS
  // is rejected by express with 413 long before the schema sees it. This mount
  // is the only way to reach — and therefore verify — the 400 text_too_large
  // branch of the contract over real HTTP.
  app.use('/api/speech-large', express.json({ limit: '1mb' }), createSpeechRouter({
    db,
    summarize: async raw => summarizeForSpeech(raw, {
      complete: async () => ({ text: 'Kurzfassung.', model: 'test-provider:test-model' }),
    }),
    synthesize: async input => {
      synthCalls.push(input)
      return FAKE_OGG
    },
    loadTtsConfig: () => ({ baseUrl: ttsUrl, timeoutMs: 30000 }),
  }))
  app.use(express.json())
  app.use('/api/speech', createSpeechRouter({
    db,
    summarize: async raw => {
      if (summaryBehaviour === 'upstream') throw new SpeechSummaryUpstreamError('provider said no')
      return summarizeForSpeech(raw, {
        complete: async () => ({
          text: 'Der Deploy ist durch. Alle Gates sind grün.',
          model: 'test-provider:test-model',
        }),
      })
    },
    synthesize: async input => {
      synthCalls.push(input)
      if (ttsBehaviour === 'fail') throw new LocalTtsError('TTS service unreachable: connect ECONNREFUSED')
      return FAKE_OGG
    },
    loadTtsConfig: () => ({ baseUrl: ttsUrl, timeoutMs: 30000 }),
    loadCloudTtsConfig: () => ({ enabled: cloudEnabled }),
    synthesizeCloud: async (text, format) => {
      cloudCalls.push(text)
      cloudFormats.push(format)
      if (cloudBehaviour === 'fail') throw new Error('Gemini TTS returned HTTP 429: quota')
      if (cloudBehaviour === 'unsupported') {
        throw new TtsFormatError('TTS provider `gemini` cannot produce `mp3` audio. Supported formats: opus, wav.')
      }
      return format === 'wav' ? FAKE_CLOUD_WAV : FAKE_CLOUD
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
  summaryBehaviour = 'real'
  ttsBehaviour = 'ok'
  ttsUrl = 'http://tts.invalid:7400'
  synthCalls = []
  cloudEnabled = false
  cloudBehaviour = 'ok'
  cloudCalls = []
  cloudFormats = []
  clearSpeechSummaryCache()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM sessions').run()
  insertSession('strand-1', 1)
})

describe('POST /api/speech/audio', () => {
  it('rejects an unauthenticated call', async () => {
    const res = await postAudio({ text: 'Hallo' }, null)
    expect(res.status).toBe(401)
    expect(synthCalls).toEqual([])
  })

  it('answers OGG bytes with the contract headers for a stored message', async () => {
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id })

    expect(res.status).toBe(200)
    expect(res.headers.contentType).toBe('audio/ogg')
    expect(res.headers.language).toBe('de')
    expect(res.headers.summaryChars).toBe('43')
    expect(res.bytes.equals(FAKE_OGG)).toBe(true)
    expect(res.bytes.subarray(0, 4).toString('ascii')).toBe('OggS')
  })

  it('speaks the summary with the Telegram default voice and the German language name', async () => {
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    await postAudio({ messageId: id })

    expect(synthCalls).toHaveLength(1)
    expect(synthCalls[0]).toMatchObject({
      text: 'Der Deploy ist durch. Alle Gates sind grün.',
      language: 'de',
      baseUrl: 'http://tts.invalid:7400',
      timeoutMs: 30000,
    })
  })

  it('accepts a raw text body and reports the English language', async () => {
    const res = await postAudio({ text: 'The container is healthy and the smoke test passed.' })
    expect(res.status).toBe(200)
    expect(res.headers.language).toBe('en')
    expect(res.headers.summaryChars).toBe('51')
    expect(synthCalls[0].language).toBe('en')
    expect(synthCalls[0].text).toBe('The container is healthy and the smoke test passed.')
  })

  it('answers 404 for an unknown message id', async () => {
    const res = await postAudio({ messageId: 987654 })
    expect(res.status).toBe(404)
    expect(res.json).toEqual({ error: 'not_found' })
    expect(synthCalls).toEqual([])
  })

  it('answers 404 for a message of another user', async () => {
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id }, otherToken)
    expect(res.status).toBe(404)
    expect(res.json).toEqual({ error: 'not_found' })
    expect(synthCalls).toEqual([])
  })

  it('answers 400 empty when nothing speakable is left', async () => {
    const id = insertMessage({ content: '```\nconst a = 1\n```', userId: 1 })
    const res = await postAudio({ messageId: id })
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'empty' })
    expect(synthCalls).toEqual([])
  })

  it('answers 400 invalid_body for a body with neither messageId nor text', async () => {
    const res = await postAudio({})
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'invalid_body' })
  })

  it('answers 400 invalid_message_id for a malformed message id', async () => {
    const res = await postAudio({ messageId: 'not-a-number' })
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'invalid_message_id' })
  })

  it('answers 400 text_too_large for an oversized inline text', async () => {
    const res = await fetch(`${baseUrl}/api/speech-large/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: 'x'.repeat(SPEECH_TEXT_MAX_CHARS + 1) }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'text_too_large' })
    expect(synthCalls).toEqual([])
  })

  it('answers 502 upstream when the summary model fails', async () => {
    summaryBehaviour = 'upstream'
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id })
    expect(res.status).toBe(502)
    expect(res.json).toEqual({ error: 'upstream' })
    expect(synthCalls).toEqual([])
  })

  it('answers 502 upstream when the TTS service fails', async () => {
    ttsBehaviour = 'fail'
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id })
    expect(res.status).toBe(502)
    expect(res.json).toEqual({ error: 'upstream' })
    expect(synthCalls).toHaveLength(1)
  })

  it('answers 503 tts_unconfigured when no local TTS url is configured', async () => {
    ttsUrl = ''
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id })
    expect(res.status).toBe(503)
    expect(res.json).toEqual({ error: 'tts_unconfigured' })
    expect(synthCalls).toEqual([])
  })

  it('speaks with the cloud voice when it is enabled, even if a local box is configured', async () => {
    cloudEnabled = true
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id })
    expect(res.status).toBe(200)
    expect(res.headers.contentType).toBe('audio/ogg')
    expect(res.headers.language).toBe('de')
    expect(res.bytes.equals(FAKE_CLOUD.audio)).toBe(true)
    expect(cloudCalls).toEqual(['Der Deploy ist durch. Alle Gates sind grün.'])
    expect(synthCalls).toEqual([])
  })

  it('answers 502 upstream when the cloud voice fails and does not fall back to the local box', async () => {
    cloudEnabled = true
    cloudBehaviour = 'fail'
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id })
    expect(res.status).toBe(502)
    expect(res.json).toEqual({ error: 'upstream' })
    expect(cloudCalls).toHaveLength(1)
    expect(synthCalls).toEqual([])
  })

  it('uses the cloud voice without any local url configured', async () => {
    cloudEnabled = true
    ttsUrl = ''
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id })
    expect(res.status).toBe(200)
    expect(cloudCalls).toHaveLength(1)
  })

  it('hands the requested format to the cloud voice and answers with its content type', async () => {
    cloudEnabled = true
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id, format: 'wav' })
    expect(res.status).toBe(200)
    expect(res.headers.contentType).toBe('audio/wav')
    expect(res.bytes.equals(FAKE_CLOUD_WAV.audio)).toBe(true)
    expect(cloudFormats).toEqual(['wav'])
  })

  it('passes null as the format when the body does not ask for one', async () => {
    cloudEnabled = true
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id })
    expect(res.status).toBe(200)
    expect(res.headers.contentType).toBe('audio/ogg')
    expect(cloudFormats).toEqual([null])
  })

  it('answers 400 invalid_format for a format outside the whitelist', async () => {
    cloudEnabled = true
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id, format: 'aiff' })
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'invalid_format' })
    expect(cloudCalls).toEqual([])
  })

  it('answers 400 unsupported_format when the provider cannot build the container', async () => {
    cloudEnabled = true
    cloudBehaviour = 'unsupported'
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id, format: 'mp3' })
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'unsupported_format' })
    expect(cloudFormats).toEqual(['mp3'])
    expect(synthCalls).toEqual([])
  })

  it('ignores the format on the local path, which always answers audio/ogg', async () => {
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const res = await postAudio({ messageId: id, format: 'wav' })
    expect(res.status).toBe(200)
    expect(res.headers.contentType).toBe('audio/ogg')
    expect(synthCalls).toHaveLength(1)
  })

  it('reuses the cached summary but synthesizes every request', async () => {
    const id = insertMessage({ content: LONG_REPORT, userId: 1 })
    const first = await postAudio({ messageId: id })
    const second = await postAudio({ messageId: id })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(synthCalls).toHaveLength(2)
    expect(synthCalls[0].text).toBe(synthCalls[1].text)
  })
})
