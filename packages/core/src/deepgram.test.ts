import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  transcribeDeepgram,
  synthesizeDeepgram,
  listDeepgramModels,
  encryptDeepgramApiKey,
  decryptDeepgramApiKey,
  extractDeepgramTranscript,
  DEEPGRAM_DEFAULT_STT_MODEL,
  DEEPGRAM_DEFAULT_TTS_MODEL,
} from './deepgram.js'
import { isEncrypted } from './encryption.js'

// ── Encryption round-trip ─────────────────────────────────────────────

describe('encryptDeepgramApiKey / decryptDeepgramApiKey', () => {
  it('round-trips a plaintext key', () => {
    const plaintext = 'dg_test_key_abc123'
    const encrypted = encryptDeepgramApiKey(plaintext)
    expect(encrypted).not.toBe(plaintext)
    expect(isEncrypted(encrypted)).toBe(true)
    expect(decryptDeepgramApiKey(encrypted)).toBe(plaintext)
  })

  it('returns empty string for empty input', () => {
    expect(encryptDeepgramApiKey('')).toBe('')
    expect(decryptDeepgramApiKey('')).toBe('')
  })

  it('is idempotent: encrypting an already-encrypted value returns it unchanged', () => {
    const plaintext = 'sk-deepgram-original'
    const once = encryptDeepgramApiKey(plaintext)
    const twice = encryptDeepgramApiKey(once)
    expect(twice).toBe(once)
    expect(decryptDeepgramApiKey(twice)).toBe(plaintext)
  })

  it('passes through a plaintext key when decrypting (legacy/freshly-edited config)', () => {
    expect(decryptDeepgramApiKey('not-encrypted-yet')).toBe('not-encrypted-yet')
  })

  it('falls back to plaintext when isEncrypted false-positives on a hex key', () => {
    // 40-char hex string — the exact shape of a Deepgram API key. This trips
    // the strict-base64 + length-divisible-by-4 + decodes-to-30-bytes checks
    // in `isEncrypted()`, but the AES-GCM auth tag check fails on decrypt.
    // The decrypt helper must return the value as-is so callers don't crash
    // on settings.json files corrupted by the old `isEncrypted ? raw : encrypt`
    // store path.
    const hexKey = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' // gitleaks:allow -- synthetic test fixture
    expect(hexKey).toHaveLength(40)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(decryptDeepgramApiKey(hexKey)).toBe(hexKey)
      expect(warnSpy).toHaveBeenCalledOnce()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ── extractDeepgramTranscript ─────────────────────────────────────────

describe('extractDeepgramTranscript', () => {
  it('pulls transcript from the first alternative of the first channel', () => {
    const payload = {
      results: {
        channels: [
          { alternatives: [{ transcript: 'hello world' }] },
        ],
      },
    }
    expect(extractDeepgramTranscript(payload)).toBe('hello world')
  })

  it('returns empty string (not null) for an empty transcript', () => {
    const payload = { results: { channels: [{ alternatives: [{ transcript: '' }] }] } }
    expect(extractDeepgramTranscript(payload)).toBe('')
  })

  it('returns null for malformed payloads', () => {
    expect(extractDeepgramTranscript(null)).toBeNull()
    expect(extractDeepgramTranscript({})).toBeNull()
    expect(extractDeepgramTranscript({ results: {} })).toBeNull()
    expect(extractDeepgramTranscript({ results: { channels: [] } })).toBeNull()
    expect(extractDeepgramTranscript({ results: { channels: [{}] } })).toBeNull()
    expect(extractDeepgramTranscript({ results: { channels: [{ alternatives: [] }] } })).toBeNull()
  })
})

// ── transcribeDeepgram ────────────────────────────────────────────────

describe('transcribeDeepgram', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockOk(transcript: string): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        results: { channels: [{ alternatives: [{ transcript }] }] },
      }),
    })
  }

  it('sends correct URL, headers, and body', async () => {
    const fetchMock = mockOk('hello world')
    globalThis.fetch = fetchMock

    const buffer = Buffer.from('fake-audio-bytes')
    const transcript = await transcribeDeepgram(buffer, 'dg-key-xyz', {
      model: 'nova-3',
      language: 'en',
    })

    expect(transcript).toBe('hello world')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, options] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.origin).toBe('https://api.deepgram.com')
    expect(parsed.pathname).toBe('/v1/listen')
    expect(parsed.searchParams.get('model')).toBe('nova-3')
    expect(parsed.searchParams.get('language')).toBe('en')
    expect(parsed.searchParams.get('punctuate')).toBe('true')
    expect(parsed.searchParams.get('smart_format')).toBe('true')

    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Token dg-key-xyz')
    expect(options.headers['Content-Type']).toBe('audio/ogg')
    expect(options.body).toBe(buffer)
  })

  it('uses the default model when none specified', async () => {
    const fetchMock = mockOk('text')
    globalThis.fetch = fetchMock

    await transcribeDeepgram(Buffer.from('a'), 'k')

    const [url] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.searchParams.get('model')).toBe(DEEPGRAM_DEFAULT_STT_MODEL)
    expect(parsed.searchParams.has('language')).toBe(false)
  })

  it('honors a custom mimeType hint', async () => {
    const fetchMock = mockOk('text')
    globalThis.fetch = fetchMock

    await transcribeDeepgram(Buffer.from('a'), 'k', { mimeType: 'audio/wav' })

    const options = fetchMock.mock.calls[0][1]
    expect(options.headers['Content-Type']).toBe('audio/wav')
  })

  it('honors a custom baseUrl (e.g. for self-hosted proxies / tests)', async () => {
    const fetchMock = mockOk('text')
    globalThis.fetch = fetchMock

    await transcribeDeepgram(Buffer.from('a'), 'k', { baseUrl: 'https://proxy.example.com/' })

    const [url] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.origin).toBe('https://proxy.example.com')
    expect(parsed.pathname).toBe('/v1/listen')
  })

  it('trims whitespace from the transcript', async () => {
    const fetchMock = mockOk('   hi   \n')
    globalThis.fetch = fetchMock

    const transcript = await transcribeDeepgram(Buffer.from('a'), 'k')
    expect(transcript).toBe('hi')
  })

  it('throws when the API key is empty', async () => {
    await expect(transcribeDeepgram(Buffer.from('a'), '')).rejects.toThrow(
      /API key is not configured/,
    )
  })

  it('throws when the buffer is empty', async () => {
    await expect(transcribeDeepgram(Buffer.alloc(0), 'k')).rejects.toThrow(
      /audio buffer is empty/,
    )
  })

  it('reports auth failures clearly on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    })

    await expect(transcribeDeepgram(Buffer.from('a'), 'bad-key')).rejects.toThrow(
      /authentication failed.*HTTP 401/,
    )
  })

  it('reports rate-limit failures clearly on 429', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Too Many Requests'),
    })

    await expect(transcribeDeepgram(Buffer.from('a'), 'k')).rejects.toThrow(
      /rate-limited.*HTTP 429/,
    )
  })

  it('wraps network errors in a deterministic message', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(transcribeDeepgram(Buffer.from('a'), 'k')).rejects.toThrow(
      /Deepgram STT request failed: ECONNREFUSED/,
    )
  })

  it('throws when the response is malformed (no transcript field)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ results: { channels: [] } }),
    })

    await expect(transcribeDeepgram(Buffer.from('a'), 'k')).rejects.toThrow(
      /did not contain a transcript/,
    )
  })
})

// ── synthesizeDeepgram ────────────────────────────────────────────────

describe('synthesizeDeepgram', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockAudio(bytes: Uint8Array): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    })
  }

  it('sends correct URL, headers, and JSON body', async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4])
    const fetchMock = mockAudio(audioBytes)
    globalThis.fetch = fetchMock

    const audio = await synthesizeDeepgram('Hello world', 'dg-key', {
      model: 'aura-2-thalia-en',
      encoding: 'mp3',
    })

    expect(audio).toBeInstanceOf(Buffer)
    expect(audio.length).toBe(4)
    expect(Array.from(audio)).toEqual([1, 2, 3, 4])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, options] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.origin).toBe('https://api.deepgram.com')
    expect(parsed.pathname).toBe('/v1/speak')
    expect(parsed.searchParams.get('model')).toBe('aura-2-thalia-en')
    expect(parsed.searchParams.get('encoding')).toBe('mp3')

    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Token dg-key')
    expect(options.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(options.body)).toEqual({ text: 'Hello world' })
  })

  it('falls back to default model and mp3 encoding', async () => {
    const fetchMock = mockAudio(new Uint8Array([0]))
    globalThis.fetch = fetchMock

    await synthesizeDeepgram('hi', 'k')

    const [url] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.searchParams.get('model')).toBe(DEEPGRAM_DEFAULT_TTS_MODEL)
    expect(parsed.searchParams.get('encoding')).toBe('mp3')
  })

  it('trims input text before sending', async () => {
    const fetchMock = mockAudio(new Uint8Array([0]))
    globalThis.fetch = fetchMock

    await synthesizeDeepgram('   hello   ', 'k')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.text).toBe('hello')
  })

  it('rejects empty input', async () => {
    await expect(synthesizeDeepgram('   ', 'k')).rejects.toThrow(/input text is empty/)
  })

  it('rejects missing API key', async () => {
    await expect(synthesizeDeepgram('hi', '')).rejects.toThrow(/API key is not configured/)
  })

  it('rejects payloads larger than the 2000-char Deepgram limit', async () => {
    const huge = 'a'.repeat(2001)
    await expect(synthesizeDeepgram(huge, 'k')).rejects.toThrow(/2001 chars, max is 2000/)
  })

  it('reports auth failure on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Bad key'),
    })

    await expect(synthesizeDeepgram('hi', 'bad')).rejects.toThrow(
      /authentication failed.*HTTP 401/,
    )
  })

  it('reports rate-limit on 429', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('slow down'),
    })

    await expect(synthesizeDeepgram('hi', 'k')).rejects.toThrow(/rate-limited.*HTTP 429/)
  })

  it('reports upstream errors on 5xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('try again later'),
    })

    await expect(synthesizeDeepgram('hi', 'k')).rejects.toThrow(/upstream error.*HTTP 503/)
  })

  it('wraps network errors with context', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))

    await expect(synthesizeDeepgram('hi', 'k')).rejects.toThrow(
      /Deepgram TTS request failed: ENOTFOUND/,
    )
  })
})

// ── listDeepgramModels ─────────────────────────────────────────────────

describe('listDeepgramModels', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  function mockJson(payload: unknown) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    })
  }

  it('GETs /v1/models with the bearer token and returns parsed lists', async () => {
    const fetchMock = mockJson({
      stt: [{
        name: 'Nova-3',
        canonical_name: 'nova-3-general',
        architecture: 'nova-3',
        languages: ['en'],
        version: '2024-12-09.0',
        uuid: 'uuid-stt-1',
        batch: true,
        streaming: true,
        formatted_output: true,
      }],
      tts: [{
        name: 'Aura-2 — Thalia',
        canonical_name: 'aura-2-thalia-en',
        architecture: 'aura-2',
        languages: ['en'],
        version: '2024-11-01.0',
        uuid: 'uuid-tts-1',
      }],
    })
    globalThis.fetch = fetchMock

    const result = await listDeepgramModels('test-key')

    expect(result.stt).toHaveLength(1)
    expect(result.stt[0]?.canonical_name).toBe('nova-3-general')
    expect(result.tts).toHaveLength(1)
    expect(result.tts[0]?.canonical_name).toBe('aura-2-thalia-en')

    const [url, options] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.origin).toBe('https://api.deepgram.com')
    expect(parsed.pathname).toBe('/v1/models')
    expect(parsed.search).toBe('') // include_outdated omitted by default
    expect(options.method).toBe('GET')
    expect(options.headers.Authorization).toBe('Token test-key')
  })

  it('passes ?include_outdated=true when opted in', async () => {
    const fetchMock = mockJson({ stt: [], tts: [] })
    globalThis.fetch = fetchMock

    await listDeepgramModels('k', { includeOutdated: true })

    const [url] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.searchParams.get('include_outdated')).toBe('true')
  })

  it('returns empty arrays when one of the categories is missing', async () => {
    globalThis.fetch = mockJson({ stt: [{ canonical_name: 'nova-3' }] })

    const result = await listDeepgramModels('k')
    expect(result.stt).toHaveLength(1)
    expect(result.tts).toEqual([])
  })

  it('rejects missing API key', async () => {
    await expect(listDeepgramModels('')).rejects.toThrow(/API key is not configured/)
  })

  it('reports auth failure on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Bad key'),
    })

    await expect(listDeepgramModels('bad')).rejects.toThrow(/authentication failed.*HTTP 401/)
  })

  it('wraps network errors with context', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))

    await expect(listDeepgramModels('k')).rejects.toThrow(/Deepgram models request failed: ENOTFOUND/)
  })

  it('falls back to empty arrays for malformed payloads', async () => {
    globalThis.fetch = mockJson(['not', 'an', 'object'])

    const result = await listDeepgramModels('k')
    expect(result).toEqual({ stt: [], tts: [] })
  })
})
