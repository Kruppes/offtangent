import { describe, expect, it, vi } from 'vitest'
import { GEMINI_TTS_API_REVISION, parseGeminiAudioFormat, readGeminiTtsUsage, synthesizeGeminiPcm } from './gemini-tts.js'

function pcmBase64(samples: number[]): string {
  const buf = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2))
  return buf.toString('base64')
}

/** Build a RIFF/WAVE container the way Gemini 3.8 answers: fmt, data, then a `C2PA` trailer. */
function wavBase64(options: {
  samples: number[]
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
  audioFormat?: number
  /** Extra chunks placed before `data`; an odd size exercises the RIFF pad byte. */
  leadingChunks?: Array<{ id: string; body: Buffer }>
  trailingChunks?: Array<{ id: string; body: Buffer }>
}): string {
  const channels = options.channels ?? 1
  const sampleRate = options.sampleRate ?? 24_000
  const bits = options.bitsPerSample ?? 16
  const audioFormat = options.audioFormat ?? 1

  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(audioFormat, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * channels * (bits / 8), 8)
  fmt.writeUInt16LE(channels * (bits / 8), 12)
  fmt.writeUInt16LE(bits, 14)

  const data = Buffer.alloc(options.samples.length * 2)
  options.samples.forEach((s, i) => data.writeInt16LE(s, i * 2))

  const chunk = (id: string, body: Buffer): Buffer => {
    const header = Buffer.alloc(8)
    header.write(id, 0, 4, 'ascii')
    header.writeUInt32LE(body.length, 4)
    const pad = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
    return Buffer.concat([header, body, pad])
  }

  const chunks = [
    chunk('fmt ', fmt),
    ...(options.leadingChunks ?? []).map(c => chunk(c.id, c.body)),
    chunk('data', data),
    ...(options.trailingChunks ?? []).map(c => chunk(c.id, c.body)),
  ]
  const payload = Buffer.concat(chunks)
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 4, 'ascii')
  riff.writeUInt32LE(4 + payload.length, 4)
  riff.write('WAVE', 8, 4, 'ascii')
  return Buffer.concat([riff, payload]).toString('base64')
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const baseRequest = { text: 'Hallo Welt', model: 'gemini-3.1-flash-tts-preview', voice: 'Charon', apiKey: 'k-test' }

describe('parseGeminiAudioFormat', () => {
  it('prefers the dedicated fields over the MIME parameters', () => {
    expect(parseGeminiAudioFormat({ mime_type: 'audio/l16; rate=48000; channels=2', sample_rate: 24_000, channels: 1 }))
      .toEqual({ sampleRate: 24_000, channels: 1 })
  })

  it('reads the 2.5-style MIME without channels and defaults to mono', () => {
    expect(parseGeminiAudioFormat({ mime_type: 'audio/L16;codec=pcm;rate=24000' }))
      .toEqual({ sampleRate: 24_000, channels: 1 })
  })

  it('falls back to 24 kHz mono when nothing is declared', () => {
    expect(parseGeminiAudioFormat({})).toEqual({ sampleRate: 24_000, channels: 1 })
  })
})

describe('synthesizeGeminiPcm usage reporting', () => {
  it('reads the Interactions usage block (total_input_tokens / total_output_tokens)', async () => {
    const fetchImpl = vi.fn(async () => okResponse({
      status: 'completed',
      usage: { total_tokens: 52, total_input_tokens: 5, total_output_tokens: 47 },
      steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcmBase64([1, 2]), mime_type: 'audio/l16; rate=24000; channels=1' }] }],
    }))
    const seen: Array<{ promptTokens: number; completionTokens: number }> = []

    await synthesizeGeminiPcm({ ...baseRequest, onUsage: usage => seen.push(usage), fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(seen).toEqual([{ promptTokens: 5, completionTokens: 47 }])
  })

  it('still understands the generateContent-style usageMetadata', async () => {
    const fetchImpl = vi.fn(async () => okResponse({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcmBase64([1, 2]), mime_type: 'audio/l16; rate=24000; channels=1' }] }],
      usageMetadata: { promptTokenCount: 27, candidatesTokenCount: 1840, totalTokenCount: 1867 },
    }))
    const seen: Array<{ promptTokens: number; completionTokens: number }> = []

    await synthesizeGeminiPcm({ ...baseRequest, onUsage: usage => seen.push(usage), fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(seen).toEqual([{ promptTokens: 27, completionTokens: 1840 }])
  })

  it('stays silent when the reply has no usage block', async () => {
    const fetchImpl = vi.fn(async () => okResponse({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcmBase64([1, 2]), mime_type: 'audio/l16; rate=24000; channels=1' }] }],
    }))
    const seen: unknown[] = []

    await synthesizeGeminiPcm({ ...baseRequest, onUsage: usage => seen.push(usage), fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(seen).toEqual([])
    expect(readGeminiTtsUsage({ usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } })).toBeNull()
    expect(readGeminiTtsUsage({})).toBeNull()
  })
})

describe('synthesizeGeminiPcm', () => {
  it('sends the Interactions request with key, pinned revision and store=false', async () => {
    const fetchImpl = vi.fn(async () => okResponse({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcmBase64([1, -2, 3]), mime_type: 'audio/l16; rate=24000; channels=1' }] }],
    }))

    const pcm = await synthesizeGeminiPcm({ ...baseRequest, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(Array.from(pcm.samples)).toEqual([1, -2, 3])
    expect(pcm.sampleRate).toBe(24_000)
    expect(pcm.channels).toBe(1)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    const headers = init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('k-test')
    expect(headers['Api-Revision']).toBe(GEMINI_TTS_API_REVISION)
    expect(url).not.toContain('key=')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      model: 'gemini-3.1-flash-tts-preview',
      input: 'Hallo Welt',
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Charon' }] },
      store: false,
    })
  })

  it('honours a custom base URL with trailing slash', async () => {
    const fetchImpl = vi.fn(async () => okResponse({
      steps: [{ content: [{ type: 'audio', data: pcmBase64([0]) }] }],
    }))
    await synthesizeGeminiPcm({ ...baseRequest, baseUrl: 'http://proxy.local/v1beta/', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('http://proxy.local/v1beta/interactions')
  })

  it('concatenates several audio blocks in order', async () => {
    const fetchImpl = vi.fn(async () => okResponse({
      status: 'completed',
      steps: [{ type: 'model_output', content: [
        { type: 'audio', data: pcmBase64([10, 20]), mime_type: 'audio/l16; rate=24000; channels=1' },
        { type: 'text', text: 'ignored' },
        { type: 'audio', data: pcmBase64([30]), mime_type: 'audio/l16; rate=24000; channels=1' },
      ] }],
    }))
    const pcm = await synthesizeGeminiPcm({ ...baseRequest, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(Array.from(pcm.samples)).toEqual([10, 20, 30])
  })

  it('surfaces the Google error message on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.', code: 'unauthenticated' } }),
      { status: 400 },
    ))
    await expect(synthesizeGeminiPcm({ ...baseRequest, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow('Gemini TTS returned HTTP 400: API key not valid. Please pass a valid API key.')
  })

  it('fails loudly when the reply has no audio block', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'nope' }] }] }))
    await expect(synthesizeGeminiPcm({ ...baseRequest, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/no audio block/)
  })

  it('rejects interactions that did not complete', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ status: 'failed', steps: [] }))
    await expect(synthesizeGeminiPcm({ ...baseRequest, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/status "failed"/)
  })

  it('decodes a WAV container and ignores the C2PA trailer (Gemini 3.8)', async () => {
    const data = wavBase64({
      samples: [100, -200, 300, -400],
      sampleRate: 24_000,
      channels: 1,
      // An odd-sized unknown chunk before `data` must be skipped with its pad byte.
      leadingChunks: [{ id: 'LIST', body: Buffer.from([1, 2, 3]) }],
      trailingChunks: [{ id: 'C2PA', body: Buffer.alloc(6012, 0x7f) }],
    })
    const fetchImpl = vi.fn(async () => okResponse({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'audio', data, mime_type: 'audio/wav' }] }],
    }))

    const pcm = await synthesizeGeminiPcm({ ...baseRequest, model: 'gemini-3.8-flash-lite-tts', fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(Array.from(pcm.samples)).toEqual([100, -200, 300, -400])
    expect(pcm.sampleRate).toBe(24_000)
    expect(pcm.channels).toBe(1)
  })

  it('detects a WAV container by its RIFF magic even without a wav MIME type', async () => {
    const data = wavBase64({ samples: [7, -7], sampleRate: 48_000, channels: 2 })
    const fetchImpl = vi.fn(async () => okResponse({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'audio', data, mime_type: 'application/octet-stream' }] }],
    }))

    const pcm = await synthesizeGeminiPcm({ ...baseRequest, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(Array.from(pcm.samples)).toEqual([7, -7])
    expect(pcm.sampleRate).toBe(48_000)
    expect(pcm.channels).toBe(2)
  })

  it('concatenates several WAV blocks without their headers', async () => {
    const fetchImpl = vi.fn(async () => okResponse({
      status: 'completed',
      steps: [{ type: 'model_output', content: [
        { type: 'audio', data: wavBase64({ samples: [1, 2] }), mime_type: 'audio/wav' },
        { type: 'audio', data: wavBase64({ samples: [3], trailingChunks: [{ id: 'C2PA', body: Buffer.alloc(11, 5) }] }), mime_type: 'audio/wav' },
      ] }],
    }))

    const pcm = await synthesizeGeminiPcm({ ...baseRequest, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(Array.from(pcm.samples)).toEqual([1, 2, 3])
    expect(pcm.sampleRate).toBe(24_000)
  })

  it('rejects a WAV container that is not 16-bit PCM', async () => {
    const data = wavBase64({ samples: [1, 2], audioFormat: 3, bitsPerSample: 32 })
    const fetchImpl = vi.fn(async () => okResponse({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'audio', data, mime_type: 'audio/wav' }] }],
    }))
    await expect(synthesizeGeminiPcm({ ...baseRequest, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/unsupported WAV encoding \(format 3, 32 bit\)/)
  })

  it('wraps transport failures', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') })
    await expect(synthesizeGeminiPcm({ ...baseRequest, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow('Gemini TTS request failed: ECONNRESET')
  })
})
