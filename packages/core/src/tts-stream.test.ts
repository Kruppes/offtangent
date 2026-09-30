/**
 * The streaming OpenAI-compatible TTS path and its fallback.
 *
 * Two behaviours are worth a test of their own, because both are invisible in
 * a buffered result: that chunks leave the synthesizer before the upstream
 * body is finished, and that an unreachable primary endpoint silently becomes
 * a hosted OpenAI call instead of an error for the client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(),
}))

vi.mock('./provider-config.js', async () => {
  const actual = await vi.importActual<typeof import('./provider-config.js')>('./provider-config.js')
  return {
    ...actual,
    loadProvidersDecrypted: vi.fn(() => ({ providers: [] })),
    getApiKeyForProvider: vi.fn(async () => 'test-key'),
  }
})

import { loadConfig } from './config.js'
import { loadProvidersDecrypted } from './provider-config.js'
import {
  shouldStreamTts,
  synthesizeTts,
  synthesizeTtsStream,
  ttsHeaderTimeoutMs,
  TTS_BLOCK_TIMEOUT_MS,
  TTS_FALLBACK_MODEL,
  TTS_FIRST_BYTE_TIMEOUT_MS,
  formatFromAccept,
  isOfficialOpenAiBaseUrl,
} from './tts.js'

const loadConfigMock = vi.mocked(loadConfig)
const loadProvidersMock = vi.mocked(loadProvidersDecrypted)

const LOCAL_PROVIDER = {
  id: 'p-local',
  name: 'Local Voice',
  providerType: 'openai-compatible',
  provider: 'openai-compatible',
  baseUrl: 'http://speech.invalid:7400/v1',
  apiKey: 'local-token',
}

const OPENAI_PROVIDER = {
  id: 'p-openai',
  name: 'OpenAI',
  providerType: 'openai',
  provider: 'openai',
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk-test',
}

function ttsSettings(overrides: Record<string, unknown> = {}) {
  return {
    tts: {
      enabled: true,
      provider: 'openai',
      providerId: LOCAL_PROVIDER.id,
      openaiModel: 'voxtral-de-16k',
      openaiVoice: 'de_female',
      responseFormat: 'wav',
      ...overrides,
    },
  }
}

/** A response whose body arrives in separate chunks, like a chunked upstream. */
function chunkedResponse(chunks: string[], init: { status?: number } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'audio/wav' },
  })
}

interface FetchCall {
  url: string
  body: Record<string, unknown>
  authorization: string
}

/** Install a fetch stub and record every call the synthesizer makes. */
function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call: FetchCall = {
      url: String(url),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      authorization: String((init.headers as Record<string, string>).Authorization),
    }
    calls.push(call)
    return handler(call)
  })
  return calls
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const parts: Buffer[] = []
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(parts).toString()
}

describe('shouldStreamTts', () => {
  it('streams wav and pcm on the OpenAI-compatible path only', () => {
    expect(shouldStreamTts('openai', 'wav')).toBe(true)
    expect(shouldStreamTts('openai', 'pcm')).toBe(true)
    expect(shouldStreamTts('openai', 'mp3')).toBe(false)
    expect(shouldStreamTts('openai', 'opus')).toBe(false)
    expect(shouldStreamTts('gemini', 'wav')).toBe(false)
    expect(shouldStreamTts('deepgram', 'wav')).toBe(false)
    expect(shouldStreamTts('openai', undefined)).toBe(false)
  })
})

describe('isOfficialOpenAiBaseUrl', () => {
  it('tells the hosted API from a self-hosted clone', () => {
    expect(isOfficialOpenAiBaseUrl('https://api.openai.com/v1')).toBe(true)
    expect(isOfficialOpenAiBaseUrl('')).toBe(true)
    expect(isOfficialOpenAiBaseUrl(undefined)).toBe(true)
    expect(isOfficialOpenAiBaseUrl('http://speech.invalid:7400/v1')).toBe(false)
    expect(isOfficialOpenAiBaseUrl('https://api.openai.com.evil.example/v1')).toBe(false)
  })
})

describe('formatFromAccept', () => {
  it('reads the puck header and the raw-pcm types', () => {
    expect(formatFromAccept('audio/wav, audio/*;q=0.9')).toBe('wav')
    expect(formatFromAccept('audio/pcm')).toBe('pcm')
    expect(formatFromAccept('audio/L16;rate=16000')).toBe('pcm')
    expect(formatFromAccept('*/*')).toBeNull()
    expect(formatFromAccept(undefined)).toBeNull()
  })
})

describe('synthesizeTtsStream', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    loadConfigMock.mockReset()
    loadProvidersMock.mockReset()
    loadProvidersMock.mockReturnValue({ providers: [LOCAL_PROVIDER, OPENAI_PROVIDER] } as never)
  })

  it('hands the first chunk on while the upstream is still speaking', async () => {
    loadConfigMock.mockReturnValue(ttsSettings())
    // The upstream keeps the body open after the first chunk; a buffering
    // implementation would block here until `close()` below.
    let push: (chunk: string) => void = () => {}
    let finish: () => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('RIFF-head'))
        push = chunk => controller.enqueue(new TextEncoder().encode(chunk))
        finish = () => controller.close()
      },
    })
    const calls = stubFetch(() => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    }))

    const result = await synthesizeTtsStream('Hallo Welt', { format: 'wav', sampleRate: 16_000 })
    expect(result).not.toBeNull()
    expect(result!.contentType).toBe('audio/wav')
    expect(result!.source).toBe('primary')
    expect(result!.sampleRate).toBe(16_000)

    const iterator = result!.stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(Buffer.from(first.value as Buffer).toString()).toBe('RIFF-head')

    push('chunk-1')
    finish()
    const second = await iterator.next()
    expect(Buffer.from(second.value as Buffer).toString()).toBe('chunk-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://speech.invalid:7400/v1/audio/speech')
    expect(calls[0]!.body.model).toBe('voxtral-de-16k')
    expect(calls[0]!.body.response_format).toBe('wav')
    expect(calls[0]!.body.sample_rate).toBe(16_000)
  })

  it('returns null for a container that cannot be streamed', async () => {
    loadConfigMock.mockReturnValue(ttsSettings())
    stubFetch(() => chunkedResponse(['never']))
    expect(await synthesizeTtsStream('Hallo', { format: 'mp3' })).toBeNull()
  })

  it('returns null for a provider without a streaming path', async () => {
    loadConfigMock.mockReturnValue(ttsSettings({ provider: 'gemini' }))
    stubFetch(() => chunkedResponse(['never']))
    expect(await synthesizeTtsStream('Hallo', { format: 'wav' })).toBeNull()
  })

  it('falls back to hosted OpenAI when the primary endpoint refuses the connection', async () => {
    loadConfigMock.mockReturnValue(ttsSettings())
    const calls = stubFetch((call) => {
      if (call.url.startsWith('http://speech.invalid')) {
        throw new Error('connect ECONNREFUSED')
      }
      return chunkedResponse(['openai-audio'])
    })

    const result = await synthesizeTtsStream('Hallo Welt', { format: 'wav', sampleRate: 16_000 })
    expect(result!.source).toBe('fallback')
    expect(await collect(result!.stream)).toBe('openai-audio')

    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toBe('https://api.openai.com/v1/audio/speech')
    expect(calls[1]!.body.model).toBe(TTS_FALLBACK_MODEL)
    // The hosted API rejects unknown body fields and does not know the
    // self-hosted voice id, so neither travels there.
    expect(calls[1]!.body.sample_rate).toBeUndefined()
    expect(calls[1]!.body.voice).toBe('nova')
    // A rate we did not get is not claimed back to the client.
    expect(result!.sampleRate).toBeUndefined()
  })

  it('falls back on a 5xx of the primary endpoint', async () => {
    loadConfigMock.mockReturnValue(ttsSettings())
    const calls = stubFetch((call) => {
      if (call.url.startsWith('http://speech.invalid')) {
        return new Response('boom', { status: 502 })
      }
      return chunkedResponse(['openai-audio'])
    })

    const result = await synthesizeTtsStream('Hallo Welt', { format: 'wav' })
    expect(result!.source).toBe('fallback')
    expect(calls).toHaveLength(2)
  })

  it('does not fall back on a 4xx, which is a request the fallback would fail too', async () => {
    loadConfigMock.mockReturnValue(ttsSettings())
    const calls = stubFetch(() => new Response('text too long', { status: 413 }))

    await expect(synthesizeTtsStream('Hallo Welt', { format: 'wav' }))
      .rejects.toThrow(/HTTP 413/)
    expect(calls).toHaveLength(1)
  })

  it('surfaces the primary failure when no hosted OpenAI provider is configured', async () => {
    loadConfigMock.mockReturnValue(ttsSettings())
    loadProvidersMock.mockReturnValue({ providers: [LOCAL_PROVIDER] } as never)
    const calls = stubFetch(() => {
      throw new Error('connect ECONNREFUSED')
    })

    await expect(synthesizeTtsStream('Hallo Welt', { format: 'wav' }))
      .rejects.toThrow(/ECONNREFUSED/)
    expect(calls).toHaveLength(1)
  })
})

describe('synthesizeTts (buffered OpenAI path)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    loadConfigMock.mockReset()
    loadProvidersMock.mockReset()
    loadProvidersMock.mockReturnValue({ providers: [LOCAL_PROVIDER, OPENAI_PROVIDER] } as never)
  })

  it('uses the same fallback and reports which endpoint spoke', async () => {
    loadConfigMock.mockReturnValue(ttsSettings({ responseFormat: 'mp3' }))
    const calls = stubFetch((call) => {
      if (call.url.startsWith('http://speech.invalid')) throw new Error('connect ECONNREFUSED')
      return new Response(Buffer.from('mp3-bytes'), { status: 200 })
    })

    const result = await synthesizeTts('Hallo Welt')
    expect(result.audio.toString()).toBe('mp3-bytes')
    expect(result.contentType).toBe('audio/mpeg')
    expect(result.source).toBe('fallback')
    expect(calls).toHaveLength(2)
  })

  it('keeps the configured voice and model when the primary answers', async () => {
    loadConfigMock.mockReturnValue(ttsSettings({ responseFormat: 'mp3' }))
    const calls = stubFetch(() => new Response(Buffer.from('mp3-bytes'), { status: 200 }))

    const result = await synthesizeTts('Hallo Welt')
    expect(result.source).toBe('primary')
    expect(calls[0]!.body.voice).toBe('de_female')
    expect(calls[0]!.body.model).toBe('voxtral-de-16k')
  })
})

describe('header timeout per container', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    loadConfigMock.mockReset()
    loadProvidersMock.mockReset()
    loadProvidersMock.mockReturnValue({ providers: [LOCAL_PROVIDER, OPENAI_PROVIDER] } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('picks the short budget for a stream and the long one for a block', () => {
    expect(ttsHeaderTimeoutMs('wav')).toBe(TTS_FIRST_BYTE_TIMEOUT_MS)
    expect(ttsHeaderTimeoutMs('pcm')).toBe(TTS_FIRST_BYTE_TIMEOUT_MS)
    expect(ttsHeaderTimeoutMs('mp3')).toBe(TTS_BLOCK_TIMEOUT_MS)
    expect(ttsHeaderTimeoutMs('opus')).toBe(TTS_BLOCK_TIMEOUT_MS)
    expect(ttsHeaderTimeoutMs('flac')).toBe(TTS_BLOCK_TIMEOUT_MS)
  })

  it('lets a block container speak past the streaming budget', async () => {
    // mp3 and opus are muxed after the last sample, so the endpoint answers
    // only when the whole text is spoken. Aborting after 3 s would make every
    // reply longer than a sentence unplayable.
    loadConfigMock.mockReturnValue(ttsSettings({ responseFormat: 'mp3' }))
    let captured: AbortSignal | undefined
    let release: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      captured = init.signal as AbortSignal
      return new Promise<Response>((resolve) => { release = resolve })
    })

    vi.useFakeTimers()
    const pending = synthesizeTts('Hallo Welt')
    await vi.advanceTimersByTimeAsync(TTS_FIRST_BYTE_TIMEOUT_MS + 5_000)
    expect(captured?.aborted).toBe(false)

    release(new Response(Buffer.from('mp3-bytes'), { status: 200 }))
    const result = await pending
    expect(result.source).toBe('primary')
    expect(result.audio.toString()).toBe('mp3-bytes')
  })

  it('still gives up on a silent stream container after the short budget', async () => {
    loadConfigMock.mockReturnValue(ttsSettings())
    const urls: string[] = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      urls.push(String(url))
      if (String(url).startsWith('http://speech.invalid')) {
        const signal = init.signal as AbortSignal
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('The operation was aborted')))
        })
      }
      return Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('openai-audio'))
            controller.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'audio/wav' } },
      ))
    })

    vi.useFakeTimers()
    const pending = synthesizeTtsStream('Hallo Welt', { format: 'wav' })
    await vi.advanceTimersByTimeAsync(TTS_FIRST_BYTE_TIMEOUT_MS + 10)
    const result = await pending
    expect(result!.source).toBe('fallback')
    expect(urls).toHaveLength(2)
  })
})
