/**
 * Streaming dictation upload (puck firmware 0.11.0).
 *
 * `POST /api/stt/transcribe-raw` takes raw 16 kHz mono PCM with
 * `Transfer-Encoding: chunked`, so a device can upload while it is still
 * recording. The length of the recording is unknown when the first byte
 * leaves, which is exactly why the WAV header is written here and not there.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken } from '../auth.js'
import { buildWavHeader } from './stt.js'

const seen: { audio: Buffer; filename: string | undefined; language: string | undefined } = {
  audio: Buffer.alloc(0),
  filename: undefined,
  language: undefined,
}

vi.mock('@axiom/core', async () => {
  const actual = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
  return {
    ...actual,
    transcribeAudio: vi.fn(async (audio: Buffer, opts: { language?: string, filename?: string }) => {
      seen.audio = Buffer.from(audio)
      seen.filename = opts?.filename
      seen.language = opts?.language
      return { transcript: 'was gesagt wurde' }
    }),
  }
})

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offtangent-stt-raw-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(tempDataDir, 'config', 'settings.json'),
    JSON.stringify({ language: 'de', stt: { enabled: true, provider: 'whisper-url', whisperUrl: 'http://localhost:1/x' } }),
  )

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'speaker', 'x', 'user')

  const agentCore = {
    getSessionManager: () => ({
      getOrCreateSession: (userId: string, source: string, agentId?: string) => ({
        id: `s-${agentId ?? 'main'}`, userId, source, startedAt: 0, lastActivity: 0, messageCount: 0, summaryWritten: false, restored: false,
      }),
      assertSessionAccess: (_userId: string, sessionId: string) => ({ id: sessionId }),
    }),
  } as unknown as AgentCore

  const app = createApp({ db, getAgentCore: () => agentCore })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'speaker', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

/** A block of PCM samples the way the recorder hands them over. */
function pcmBlock(samples: number, value: number): Buffer {
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2)
  return buf
}

/**
 * Sends the body the way the device does: chunk by chunk, with a pause
 * between the chunks and no Content-Length at all.
 */
async function streamRaw(
  blocks: Buffer[],
  query = '',
  auth = true,
): Promise<{ status: number, body: { transcript?: string, error?: string } }> {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const block of blocks) {
        controller.enqueue(new Uint8Array(block))
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      controller.close()
    },
  })
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
  if (auth) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${baseUrl}/api/stt/transcribe-raw${query}`, {
    method: 'POST',
    headers,
    body: stream,
    // Node needs this to send a request body as a stream.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  return { status: res.status, body: await res.json() as { transcript?: string, error?: string } }
}

describe('POST /api/stt/transcribe-raw', () => {
  it('transcribes a chunked stream and writes the WAV header itself', async () => {
    seen.audio = Buffer.alloc(0)
    const blocks = [pcmBlock(4000, 1200), pcmBlock(4000, -900), pcmBlock(2000, 300)]
    const { status, body } = await streamRaw(blocks)
    expect(status).toBe(200)
    expect(body.transcript).toBe('was gesagt wurde')

    const pcmBytes = blocks.reduce((sum, b) => sum + b.length, 0)
    expect(seen.audio.length).toBeGreaterThan(0)
    const audio = seen.audio
    // The header is complete and honest about the length only the server knew.
    expect(audio.length).toBe(44 + pcmBytes)
    expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(audio.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(audio.readUInt32LE(4)).toBe(36 + pcmBytes)
    expect(audio.readUInt32LE(40)).toBe(pcmBytes)
    expect(audio.readUInt16LE(22)).toBe(1)        // mono
    expect(audio.readUInt32LE(24)).toBe(16000)    // default rate
    expect(audio.readUInt16LE(34)).toBe(16)       // bits
    // And the samples arrived in the order they were spoken.
    expect(audio.subarray(44).equals(Buffer.concat(blocks))).toBe(true)
    expect(seen.language).toBe('de')
    expect(seen.filename).toBe('stream.wav')
  })

  it('takes the sample rate from the query', async () => {
    const { status } = await streamRaw([pcmBlock(6000, 500)], '?rate=8000')
    expect(status).toBe(200)
    expect(seen.audio.readUInt32LE(24)).toBe(8000)
  })

  it('falls back to 16 kHz for an impossible rate', async () => {
    const { status } = await streamRaw([pcmBlock(6000, 500)], '?rate=999999')
    expect(status).toBe(200)
    expect(seen.audio.readUInt32LE(24)).toBe(16000)
  })

  it('refuses a stream that carries no audio', async () => {
    const { status, body } = await streamRaw([pcmBlock(100, 5)])
    expect(status).toBe(400)
    expect(body.error).toContain('too short')
  })

  it('needs a token like every other route', async () => {
    const { status } = await streamRaw([pcmBlock(6000, 500)], '', false)
    expect(status).toBe(401)
  })
})

describe('buildWavHeader', () => {
  it('describes mono 16 bit PCM at the given rate', () => {
    const header = buildWavHeader(32000, 16000)
    expect(header.length).toBe(44)
    expect(header.readUInt32LE(28)).toBe(32000)   // byte rate = rate * 2
    expect(header.readUInt16LE(32)).toBe(2)       // block align
    expect(header.readUInt32LE(40)).toBe(32000)
  })
})
