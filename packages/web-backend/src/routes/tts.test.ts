/**
 * POST /api/tts: the per-request audio format and sample rate.
 *
 * The synthesizer itself is mocked — this covers the HTTP contract only:
 * which format the route resolves (body over `Accept` over setting), which
 * headers it answers with, and which bad input is a 400 instead of a 500.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'node:http'
import express from 'express'
import { TtsFormatError } from '@axiom/core'
import type { SynthesizeOptions, SynthesizeResult } from '@axiom/core'
import { createTtsRouter, formatFromAccept, parsePreviewSettings } from './tts.js'
import { generateAccessToken } from '../auth.js'

/** Every call the route made into the synthesizer. */
let calls: Array<{ text: string; options: SynthesizeOptions }> = []
/** What the mocked synthesizer does next. */
let behaviour: 'ok' | 'format-error' | 'boom' = 'ok'
/** Whether the mocked settings report TTS as enabled. */
let enabled = true

vi.mock('@axiom/core', async () => {
  const actual = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
  return {
    ...actual,
    loadTtsSettings: () => ({ ...LOADED_SETTINGS, enabled }),
    loadProviders: () => ({
      providers: [
        { id: 'p-google', name: 'Google', providerType: 'google', provider: 'google', apiKey: 'secret-1' },
        { id: 'p-openai', name: 'OpenAI', providerType: 'openai', provider: 'openai', apiKey: 'secret-2' },
        { id: 'p-anthropic', name: 'Anthropic', providerType: 'anthropic', provider: 'anthropic', apiKey: 'secret-3' },
      ],
    }),
    synthesizeTts: async (text: string, options: SynthesizeOptions = {}): Promise<SynthesizeResult> => {
      calls.push({ text, options })
      if (behaviour === 'format-error') {
        throw new actual.TtsFormatError('TTS provider `gemini` cannot produce `mp3` audio. Supported formats: opus, wav.')
      }
      if (behaviour === 'boom') throw new Error('provider exploded')
      const format = options.format ?? 'opus'
      const map: Record<string, { contentType: string; extension: string }> = {
        mp3: { contentType: 'audio/mpeg', extension: 'mp3' },
        wav: { contentType: 'audio/wav', extension: 'wav' },
        opus: { contentType: 'audio/ogg', extension: 'ogg' },
        flac: { contentType: 'audio/flac', extension: 'flac' },
      }
      const described = map[format]!
      const result: SynthesizeResult = { audio: Buffer.from('audio-bytes'), ...described }
      // Mirror the core rule: the header only appears when we resampled.
      if (options.sampleRate && format === 'wav') result.sampleRate = options.sampleRate
      return result
    },
  }
})

const LOADED_SETTINGS = {
  enabled: true,
  provider: 'gemini' as const,
  providerId: '',
  openaiModel: 'gpt-4o-mini-tts',
  openaiVoice: 'nova',
  openaiInstructions: '',
  mistralVoice: '',
  responseFormat: 'opus' as const,
  deepgramModel: 'aura-2-thalia-en',
  geminiModel: 'gemini-3.1-flash-tts-preview',
  geminiVoice: 'Charon',
  geminiStyle: '',
}

let server: http.Server
let baseUrl: string
let token: string
let userToken: string

interface TtsResponse {
  status: number
  contentType: string | null
  disposition: string | null
  sampleRate: string | null
  bytes: Buffer
  json: Record<string, unknown>
}

async function postTts(
  body: unknown,
  headers: Record<string, string> = {},
  path = '/api/tts',
  bearer = token,
): Promise<TtsResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      ...headers,
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
    contentType: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
    sampleRate: res.headers.get('x-tts-sample-rate'),
    bytes,
    json,
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'tts-route-test-secret'
  token = generateAccessToken({ userId: 1, username: 'owner', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'guest', role: 'user' })

  const app = express()
  app.use(express.json())
  app.use('/api/tts', createTtsRouter())
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(() => {
  calls = []
  behaviour = 'ok'
  enabled = true
})

describe('formatFromAccept', () => {
  it('returns null without a header', () => {
    expect(formatFromAccept(undefined)).toBeNull()
    expect(formatFromAccept('')).toBeNull()
  })

  it('maps the concrete audio types', () => {
    expect(formatFromAccept('audio/wav')).toBe('wav')
    expect(formatFromAccept('audio/x-wav')).toBe('wav')
    expect(formatFromAccept('audio/ogg')).toBe('opus')
    expect(formatFromAccept('audio/mpeg')).toBe('mp3')
    expect(formatFromAccept('audio/flac')).toBe('flac')
  })

  it('stays unopinionated for wildcards', () => {
    expect(formatFromAccept('audio/*')).toBeNull()
    expect(formatFromAccept('*/*')).toBeNull()
    expect(formatFromAccept('application/json')).toBeNull()
  })

  it('reads the firmware header of the puck', () => {
    expect(formatFromAccept('audio/wav, audio/*;q=0.9')).toBe('wav')
  })

  it('honours q values and ignores q=0', () => {
    expect(formatFromAccept('audio/mpeg;q=0.3, audio/wav;q=0.8')).toBe('wav')
    expect(formatFromAccept('audio/wav;q=0, audio/ogg')).toBe('opus')
    expect(formatFromAccept('audio/wav;q=0')).toBeNull()
  })

  it('takes the first of equally weighted types', () => {
    expect(formatFromAccept('audio/ogg, audio/wav')).toBe('opus')
  })

  it('ignores case and whitespace', () => {
    expect(formatFromAccept('  AUDIO/WAV ; q=1 ')).toBe('wav')
  })
})

describe('POST /api/tts', () => {
  it('uses the saved setting when neither body nor Accept ask for a format', async () => {
    const res = await postTts({ text: 'Kurzer Testsatz.' })
    expect(res.status).toBe(200)
    expect(calls[0]!.options.format).toBeUndefined()
    expect(res.contentType).toContain('audio/ogg')
    expect(res.disposition).toBe('inline; filename="speech.ogg"')
    expect(res.sampleRate).toBeNull()
  })

  it('takes the format from the body', async () => {
    const res = await postTts({ text: 'Kurzer Testsatz.', format: 'wav' })
    expect(res.status).toBe(200)
    expect(calls[0]!.options.format).toBe('wav')
    expect(res.contentType).toContain('audio/wav')
    expect(res.disposition).toBe('inline; filename="speech.wav"')
  })

  it('falls back to the Accept header when the body names no format', async () => {
    const res = await postTts({ text: 'Kurzer Testsatz.' }, { Accept: 'audio/wav, audio/*;q=0.9' })
    expect(res.status).toBe(200)
    expect(calls[0]!.options.format).toBe('wav')
    expect(res.contentType).toContain('audio/wav')
  })

  it('lets the body win over the Accept header', async () => {
    const res = await postTts({ text: 'Kurzer Testsatz.', format: 'mp3' }, { Accept: 'audio/wav' })
    expect(res.status).toBe(200)
    expect(calls[0]!.options.format).toBe('mp3')
    expect(res.contentType).toContain('audio/mpeg')
    expect(res.disposition).toBe('inline; filename="speech.mp3"')
  })

  it('ignores a wildcard Accept header and keeps the setting', async () => {
    const res = await postTts({ text: 'Kurzer Testsatz.' }, { Accept: '*/*' })
    expect(res.status).toBe(200)
    expect(calls[0]!.options.format).toBeUndefined()
    expect(res.contentType).toContain('audio/ogg')
  })

  it('passes the sample rate through and reports it back', async () => {
    const res = await postTts({ text: 'Kurzer Testsatz.', format: 'wav', sampleRate: 16000 })
    expect(res.status).toBe(200)
    expect(calls[0]!.options.sampleRate).toBe(16000)
    expect(res.sampleRate).toBe('16000')
  })

  it('does not report a sample rate that was not applied', async () => {
    const res = await postTts({ text: 'Kurzer Testsatz.', format: 'opus', sampleRate: 16000 })
    expect(res.status).toBe(200)
    expect(res.sampleRate).toBeNull()
  })

  it('answers 400 for a format outside the whitelist', async () => {
    const res = await postTts({ text: 'Kurzer Testsatz.', format: 'aiff' })
    expect(res.status).toBe(400)
    expect(String(res.json.error)).toContain('format must be one of')
    expect(calls).toEqual([])
  })

  it('answers 400 for a non-integer or out-of-range sample rate', async () => {
    for (const sampleRate of [7999, 48001, 16000.5, 'loud']) {
      const res = await postTts({ text: 'Kurzer Testsatz.', format: 'wav', sampleRate })
      expect(res.status).toBe(400)
      expect(String(res.json.error)).toContain('sampleRate must be an integer between 8000 and 48000')
    }
    expect(calls).toEqual([])
  })

  it('turns an unsupported provider/format pair into 400, not 500', async () => {
    behaviour = 'format-error'
    const res = await postTts({ text: 'Kurzer Testsatz.', format: 'mp3' })
    expect(res.status).toBe(400)
    expect(String(res.json.error)).toContain('cannot produce `mp3`')
  })

  it('still answers 500 for a real provider failure', async () => {
    behaviour = 'boom'
    const res = await postTts({ text: 'Kurzer Testsatz.' })
    expect(res.status).toBe(500)
    expect(String(res.json.error)).toContain('TTS generation failed')
  })

  it('answers 403 when TTS is switched off, before any format check', async () => {
    enabled = false
    const res = await postTts({ text: 'Kurzer Testsatz.', format: 'aiff' })
    expect(res.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('rejects an unauthenticated call', async () => {
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Kurzer Testsatz.' }),
    })
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('exports the format error type the route maps to 400', () => {
    expect(new TtsFormatError('x')).toBeInstanceOf(Error)
    expect(new TtsFormatError('x').name).toBe('TtsFormatError')
  })
})

describe('POST /api/tts/preview', () => {
  const preview = (body: unknown, headers: Record<string, string> = {}, bearer = token) =>
    postTts(body, headers, '/api/tts/preview', bearer)

  it('plays while TTS is switched off, because that is what a preview is for', async () => {
    enabled = false
    const res = await preview({ text: 'Kurzer Testsatz.' })
    expect(res.status).toBe(200)
    expect(calls[0]!.options.settings).toEqual({ enabled: true })
  })

  it('hands the unsaved form to the synthesizer instead of ignoring it', async () => {
    const res = await preview({
      text: 'Kurzer Testsatz.',
      settings: { provider: 'gemini', geminiVoice: 'Kore', geminiStyle: 'Fluestere:', responseFormat: 'wav' },
    })
    expect(res.status).toBe(200)
    expect(calls[0]!.options.settings).toEqual({
      enabled: true, provider: 'gemini', geminiVoice: 'Kore', geminiStyle: 'Fluestere:', responseFormat: 'wav',
    })
  })

  it('takes format and Accept like the main route', async () => {
    const res = await preview({ text: 'Kurzer Testsatz.', format: 'wav', sampleRate: 16_000 })
    expect(res.status).toBe(200)
    expect(calls[0]!.options.format).toBe('wav')
    expect(res.contentType).toContain('audio/wav')
    expect(res.disposition).toBe('inline; filename="preview.wav"')
    expect(res.sampleRate).toBe('16000')

    const viaAccept = await preview({ text: 'Kurzer Testsatz.' }, { Accept: 'audio/mpeg' })
    expect(calls[1]!.options.format).toBe('mp3')
    expect(viaAccept.contentType).toContain('audio/mpeg')
  })

  it('refuses unsaved settings from a non-admin instead of ignoring them', async () => {
    const res = await preview({ text: 'Kurzer Testsatz.', settings: { geminiVoice: 'Kore' } }, {}, userToken)
    expect(res.status).toBe(403)
    expect(calls).toEqual([])
    // Without overrides a normal user may still preview the saved voice, and
    // an empty block from a client that always sends one is no override.
    const plain = await preview({ text: 'Kurzer Testsatz.' }, {}, userToken)
    expect(plain.status).toBe(200)
    const empty = await preview({ text: 'Kurzer Testsatz.', settings: {} }, {}, userToken)
    expect(empty.status).toBe(200)
    expect(calls[1]!.options.settings).toEqual({ enabled: true })
  })

  it('answers 400 for a malformed settings block or an unknown format', async () => {
    expect((await preview({ text: 'x', settings: { provider: 'polly' } })).status).toBe(400)
    expect((await preview({ text: 'x', settings: { geminiVoice: 7 } })).status).toBe(400)
    expect((await preview({ text: 'x', settings: [] })).status).toBe(400)
    expect((await preview({ text: 'x', format: 'aiff' })).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('maps an unsupported provider/format pair to 400', async () => {
    behaviour = 'format-error'
    const res = await preview({ text: 'Kurzer Testsatz.', format: 'mp3' })
    expect(res.status).toBe(400)
    expect(String(res.json.error)).toContain('cannot produce')
  })
})

describe('parsePreviewSettings', () => {
  it('never lets a client smuggle a Deepgram key into the call', () => {
    const parsed = parsePreviewSettings({ deepgramApiKey: 'leak', geminiVoice: 'Kore' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.settings).toEqual({ enabled: true, geminiVoice: 'Kore' })
      expect(parsed.settings).not.toHaveProperty('deepgramApiKey')
    }
  })

  it('treats an empty or enabled-only block as no override', () => {
    expect(parsePreviewSettings({})).toEqual({ ok: true, settings: undefined })
    expect(parsePreviewSettings({ enabled: false })).toEqual({ ok: true, settings: undefined })
    expect(parsePreviewSettings({ deepgramApiKey: 'leak' })).toEqual({ ok: true, settings: undefined })
  })
})

describe('GET /api/tts/catalog', () => {
  it('hides the provider accounts from a non-admin, like /api/providers does', async () => {
    const res = await fetch(`${baseUrl}/api/tts/catalog`, { headers: { Authorization: `Bearer ${userToken}` } })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.accounts).toEqual([])
    expect(body.providers).toEqual(['openai', 'mistral', 'deepgram', 'gemini'])
  })

  it('lists the static catalogs and the accounts that can back a TTS provider, without keys', async () => {
    const res = await fetch(`${baseUrl}/api/tts/catalog`, { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.providers).toEqual(['openai', 'mistral', 'deepgram', 'gemini'])
    expect(body.formats).toEqual(['mp3', 'wav', 'opus', 'flac'])
    expect((body.formatsByProvider as Record<string, string[]>).gemini).toEqual(['opus', 'wav'])
    expect((body.gemini as { defaultVoice: string }).defaultVoice).toBe('Charon')
    expect((body.gemini as { voices: unknown[] }).voices.length).toBe(30)
    expect((body.openai as { voices: Array<{ name: string }> }).voices.some(v => v.name === 'nova')).toBe(true)
    expect(body.accounts).toEqual([
      { id: 'p-google', name: 'Google', providerType: 'google', ttsProvider: 'gemini' },
      { id: 'p-openai', name: 'OpenAI', providerType: 'openai', ttsProvider: 'openai' },
    ])
    expect(JSON.stringify(body)).not.toContain('secret-')
  })
})
