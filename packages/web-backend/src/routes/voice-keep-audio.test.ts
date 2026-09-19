/**
 * Keeping the spoken recording (app 0.7.5).
 *
 * Two halves of one feature:
 *  - `POST /api/stt/transcribe?keepAudio=1` stores the uploaded recording
 *    through the normal upload path and answers with its descriptor. Without
 *    the flag nothing is written, which is what Telegram and the web client
 *    depend on.
 *  - `POST /api/chat/message` accepts those already stored uploads as
 *    `attachments`, so a voice message is ONE row: the audio as an attachment
 *    and the transcript as its content, without a second upload of the bytes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, parseUploadsMetadata } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken } from '../auth.js'

vi.mock('@axiom/core', async () => {
  const actual = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
  return {
    ...actual,
    transcribeAudio: vi.fn(async () => ({ transcript: 'the spoken words' })),
  }
})

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

const AUDIO = Buffer.from('fake m4a bytes, long enough to measure')

interface TranscribeBody {
  transcript?: string
  error?: string
  audio?: {
    kind: string
    originalName: string
    relativePath: string
    urlPath: string
    mimeType: string
    size: number
  }
}

interface MessageBody {
  message?: { id: number; content: string; metadata: string | null }
  error?: string
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offtangent-voice-keep-'))
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

function uploadsTree(): string[] {
  const root = path.join(tempDataDir, 'uploads')
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root)
  return out
}

async function transcribe(query: string): Promise<{ status: number; body: TranscribeBody }> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(AUDIO)], { type: 'audio/mp4' }), 'recording.m4a')
  const res = await fetch(`${baseUrl}/api/stt/transcribe${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  return { status: res.status, body: await res.json() as TranscribeBody }
}

async function postMessage(fields: Record<string, string>): Promise<{ status: number; body: MessageBody }> {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  const res = await fetch(`${baseUrl}/api/chat/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  return { status: res.status, body: await res.json() as MessageBody }
}

describe('POST /api/stt/transcribe', () => {
  it('keeps nothing on disk without the flag', async () => {
    const before = uploadsTree().length
    const { status, body } = await transcribe('')
    expect(status).toBe(200)
    expect(body.transcript).toBe('the spoken words')
    expect(body.audio).toBeUndefined()
    expect(uploadsTree().length).toBe(before)
  })

  it('stores the recording and returns its descriptor with keepAudio=1', async () => {
    const { status, body } = await transcribe('?keepAudio=1')
    expect(status).toBe(200)
    expect(body.transcript).toBe('the spoken words')
    const audio = body.audio
    expect(audio).toBeDefined()
    expect(audio!.kind).toBe('file')
    expect(audio!.mimeType).toBe('audio/mp4')
    expect(audio!.originalName).toBe('recording.m4a')
    expect(audio!.size).toBe(AUDIO.length)
    expect(audio!.urlPath).toBe(`/api/uploads/${audio!.relativePath}`)
    // The file is really there, under the normal date path.
    expect(uploadsTree()).toContain(audio!.relativePath)
    expect(fs.readFileSync(path.join(tempDataDir, 'uploads', audio!.relativePath)).equals(AUDIO)).toBe(true)
    expect(audio!.relativePath).toMatch(/^\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{24}-recording\.m4a$/)
  })

  it('takes the flag from the multipart body as well', async () => {
    const form = new FormData()
    form.append('keepAudio', 'true')
    form.append('file', new Blob([new Uint8Array(AUDIO)], { type: 'audio/mp4' }), 'body-flag.m4a')
    const res = await fetch(`${baseUrl}/api/stt/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const body = await res.json() as TranscribeBody
    expect(res.status).toBe(200)
    expect(body.audio?.originalName).toBe('body-flag.m4a')
  })

  it('refuses without a token', async () => {
    const res = await fetch(`${baseUrl}/api/stt/transcribe?keepAudio=1`, { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/chat/message with stored attachments', () => {
  it('files the kept recording and the transcript as one row', async () => {
    const kept = (await transcribe('?keepAudio=1')).body.audio!
    const { status, body } = await postMessage({
      content: 'the spoken words',
      agentId: 'main',
      clientMessageId: 'voice-1',
      attachments: JSON.stringify([kept]),
    })
    expect(status).toBe(201)
    expect(body.message!.content).toBe('the spoken words')
    const files = parseUploadsMetadata(body.message!.metadata)
    expect(files).toHaveLength(1)
    expect(files[0].relativePath).toBe(kept.relativePath)
    expect(files[0].mimeType).toBe('audio/mp4')
    expect(files[0].size).toBe(AUDIO.length)
    // One row, not two: the audio and its transcript are the same message.
    const rows = db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE client_message_id = ?').get('voice-1') as { c: number }
    expect(rows.c).toBe(1)
  })

  it('re-derives size and url from disk instead of trusting the caller', async () => {
    const kept = (await transcribe('?keepAudio=1')).body.audio!
    const { status, body } = await postMessage({
      content: 'lies about the file',
      agentId: 'main',
      clientMessageId: 'voice-2',
      attachments: JSON.stringify([{
        ...kept,
        size: 999999,
        urlPath: 'https://evil.example/steal',
        previewUrl: 'https://evil.example/steal',
        originalName: '../../etc/passwd',
        mimeType: 'not a mime type',
      }]),
    })
    expect(status).toBe(201)
    const file = parseUploadsMetadata(body.message!.metadata)[0]
    expect(file.size).toBe(AUDIO.length)
    expect(file.urlPath).toBe(`/api/uploads/${kept.relativePath}`)
    expect(file.originalName).toBe('passwd')
    expect(file.mimeType).toBe('application/octet-stream')
  })

  it('refuses a path that escapes the uploads directory', async () => {
    const { status, body } = await postMessage({
      content: 'traversal',
      agentId: 'main',
      clientMessageId: 'voice-3',
      attachments: JSON.stringify([{ relativePath: '../config/settings.json', mimeType: 'application/json' }]),
    })
    expect(status).toBe(400)
    expect(body.error).toContain('attachments')
  })

  it('refuses a file that does not exist', async () => {
    const { status } = await postMessage({
      content: 'ghost',
      agentId: 'main',
      clientMessageId: 'voice-4',
      attachments: JSON.stringify([{ relativePath: '2026/09/14/deadbeef-nothing.m4a', mimeType: 'audio/mp4' }]),
    })
    expect(status).toBe(400)
  })

  it('refuses more attachments than the per-message limit', async () => {
    const kept = (await transcribe('?keepAudio=1')).body.audio!
    const overLimit = Array.from({ length: 21 }, () => kept)
    const { status, body } = await postMessage({
      content: 'too many',
      agentId: 'main',
      clientMessageId: 'voice-5',
      attachments: JSON.stringify(overLimit),
    })
    expect(status).toBe(400)
    expect(body.error).toContain('20 attachments')
  })

  it('accepts a stack of stored attachments below the limit', async () => {
    const kept = (await transcribe('?keepAudio=1')).body.audio!
    const { status } = await postMessage({
      content: 'a lot, but allowed',
      agentId: 'main',
      clientMessageId: 'voice-5b',
      attachments: JSON.stringify(Array.from({ length: 20 }, () => kept)),
    })
    expect(status).toBe(201)
  })

  it('still refuses an empty message', async () => {
    const { status } = await postMessage({
      content: '',
      agentId: 'main',
      clientMessageId: 'voice-6',
      attachments: '[]',
    })
    expect(status).toBe(400)
  })

  it('accepts an attachment without any text', async () => {
    const kept = (await transcribe('?keepAudio=1')).body.audio!
    const { status, body } = await postMessage({
      content: '',
      agentId: 'main',
      clientMessageId: 'voice-7',
      attachments: JSON.stringify([kept]),
    })
    expect(status).toBe(201)
    expect(parseUploadsMetadata(body.message!.metadata)).toHaveLength(1)
  })
})
