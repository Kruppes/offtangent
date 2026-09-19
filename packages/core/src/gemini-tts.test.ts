import { describe, expect, it, vi } from 'vitest'
import { GEMINI_TTS_API_REVISION, parseGeminiAudioFormat, synthesizeGeminiPcm } from './gemini-tts.js'

function pcmBase64(samples: number[]): string {
  const buf = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2))
  return buf.toString('base64')
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

  it('wraps transport failures', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') })
    await expect(synthesizeGeminiPcm({ ...baseRequest, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow('Gemini TTS request failed: ECONNRESET')
  })
})
