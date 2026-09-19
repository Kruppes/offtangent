/**
 * The minimal local-TTS client of the speech module. The service under test is
 * replaced by a stub http server on 127.0.0.1 — no call ever leaves the
 * process's own loopback, and the real Mac Studio box is never contacted.
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { LocalTtsError, synthesizeSpeech, DEFAULT_TTS_VOICE } from './tts.js'

interface SeenRequest {
  url: string
  body: { text?: string; voice?: string; lang?: string }
}

let server: http.Server | null = null

async function startStub(handler: (req: SeenRequest, res: http.ServerResponse) => void): Promise<{
  baseUrl: string
  seen: SeenRequest[]
}> {
  const seen: SeenRequest[] = []
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const parsed: SeenRequest = {
        url: req.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as SeenRequest['body'],
      }
      seen.push(parsed)
      handler(parsed, res)
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, seen }
}

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = null
})

describe('synthesizeSpeech', () => {
  it('posts text, voice and language name to /tts and returns the audio bytes', async () => {
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.from([1, 2, 3, 4])])
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/ogg' })
      res.end(ogg)
    })

    const audio = await synthesizeSpeech({
      text: 'Der Deploy ist durch.',
      language: 'de',
      baseUrl: `${stub.baseUrl}/`,
      timeoutMs: 5000,
    })

    expect(audio.equals(ogg)).toBe(true)
    expect(stub.seen).toHaveLength(1)
    expect(stub.seen[0].url).toBe('/tts')
    expect(stub.seen[0].body).toEqual({
      text: 'Der Deploy ist durch.',
      voice: DEFAULT_TTS_VOICE,
      lang: 'German',
    })
  })

  it('maps the english summary language to the English voice language', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/ogg' })
      res.end(Buffer.from('OggS-en'))
    })

    await synthesizeSpeech({ text: 'All gates are green.', language: 'en', baseUrl: stub.baseUrl, timeoutMs: 5000 })
    expect(stub.seen[0].body.lang).toBe('English')
  })

  it('throws LocalTtsError with the service detail on an error status', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ detail: 'model not loaded' }))
    })

    await expect(synthesizeSpeech({
      text: 'x', language: 'de', baseUrl: stub.baseUrl, timeoutMs: 5000,
    })).rejects.toThrow(/model not loaded/)
  })

  it('throws LocalTtsError when the service answers with no audio', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/ogg' })
      res.end()
    })

    await expect(synthesizeSpeech({
      text: 'x', language: 'de', baseUrl: stub.baseUrl, timeoutMs: 5000,
    })).rejects.toBeInstanceOf(LocalTtsError)
  })

  it('throws LocalTtsError when the service cannot be reached', async () => {
    // Port 1 on loopback: nothing listens there, the connect fails at once.
    await expect(synthesizeSpeech({
      text: 'x', language: 'de', baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000,
    })).rejects.toBeInstanceOf(LocalTtsError)
  })
})
