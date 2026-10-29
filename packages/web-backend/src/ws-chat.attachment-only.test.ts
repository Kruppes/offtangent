/**
 * Regression (2026-10-29, session 6c7f8bcb, rows 490079/490080): the Android
 * app posts photos without text via `POST /api/chat/message` and then sends
 * the `skipSave` frame. Its JSON encoder drops `content: ""` (default value,
 * `encodeDefaults = false`), so the frame had no `content` at all and the
 * handler died in `parsed.content.startsWith('/')`: no turn for the photos,
 * no error for the client. The voice note four seconds later started a turn
 * that did not see the photos.
 *
 * Covers the WS path end to end with the real TurnRunner:
 *  - a skipSave frame WITHOUT `content` starts a turn with its images;
 *  - photos (no text) followed by a voice note → ONE turn with all files;
 *  - a frame that throws inside the handler answers with an error frame.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase, TurnRunner } from '@axiom/core'
import type { AgentCore, ResponseChunk, Database, UploadDescriptor } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { ChatEventBus } from './chat-event-bus.js'

let previousDataDir: string | undefined
let tempDataDir: string

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-attach-'))
  process.env.DATA_DIR = tempDataDir
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

function upload(name: string, kind: 'image' | 'file' = 'image', mimeType = 'image/jpeg'): UploadDescriptor {
  const relativePath = `2026/10/29/${name}`
  return { kind, originalName: name, storedName: name, relativePath, urlPath: `/api/uploads/${relativePath}`, mimeType, size: 10 }
}

interface Frames { all: Array<Record<string, unknown>>; ws: WebSocket }

function connect(port: number, token: string): Promise<Frames> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/chat?token=${token}`)
    const frames: Frames = { all: [], ws }
    ws.on('message', (data) => { frames.all.push(JSON.parse(data.toString()) as Record<string, unknown>) })
    ws.on('open', () => resolve(frames))
    ws.on('error', reject)
  })
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  expect(cond()).toBe(true)
}

async function harness(holdMs: number) {
  const db: Database = initDatabase(':memory:')
  const sessionManager = {
    getOrCreateSession: vi.fn((userId: string, source: string, agentId?: string) => (
      { id: `sess-${agentId ?? 'main'}`, userId, source, startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    getSession: vi.fn((userId: string, agentId?: string) => (
      { id: `sess-${agentId ?? 'main'}`, userId, source: 'web', startedAt: 0, lastActivity: 0, messageCount: 0, summaryWritten: false, restored: false })),
  }
  const calls: Array<{ text: string; files: string[] }> = []
  const sendMessage = vi.fn(async function* (_u: string, text: string, _s?: string, attachments?: UploadDescriptor[]): AsyncGenerator<ResponseChunk> {
    calls.push({ text, files: (attachments ?? []).map(a => a.originalName) })
    yield { type: 'text', text: 'ok' }
    yield { type: 'done' }
  })
  const agentCore = { sendMessage, abort: vi.fn(), getSessionManager: () => sessionManager } as unknown as AgentCore
  const runner = new TurnRunner({ db, getAgent: () => agentCore, retryPolicy: { enabled: false }, attachmentOnlyHoldMs: holdMs })
  const app = createApp({ db })
  const server = http.createServer(app)
  const { wss } = setupWebSocketChat(server, db, agentCore, undefined, new ChatEventBus(), null, runner)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port
  const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  /** The row `POST /api/chat/message` stores before the skipSave frame. */
  const storedRow = (clientMessageId: string, content: string, files: UploadDescriptor[]) => db.prepare(
    "INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, client_message_id) VALUES ('sess-main', 1, 'user', ?, ?, 'main', ?)",
  ).run(content, JSON.stringify({ files }), clientMessageId)
  return {
    db, port, token, calls, storedRow,
    close: async () => {
      await new Promise<void>((r) => setTimeout(r, 20))
      for (const c of wss.clients) c.terminate()
      wss.close()
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
    },
  }
}

describe('ws-chat: photos without text (Android skipSave frame without content)', () => {
  it('a skipSave frame without `content` starts a turn with its images', async () => {
    const h = await harness(50)
    try {
      const photos = [upload('46195.jpg'), upload('46196.jpg')]
      h.storedRow('cm-photo', '', photos)
      const c = await connect(h.port, h.token)
      // Exactly what the app sends: no `content` key (encodeDefaults = false).
      c.ws.send(JSON.stringify({ type: 'message', agentId: 'main', clientMessageId: 'cm-photo', skipSave: true, attachments: photos }))
      await until(() => h.calls.length === 1)
      expect(h.calls[0]).toEqual({ text: '', files: ['46195.jpg', '46196.jpg'] })
      expect(c.all.some(f => f.type === 'message_ack' && f.clientMessageId === 'cm-photo')).toBe(true)
      expect(c.all.some(f => f.type === 'error')).toBe(false)
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('photos first, voice note seconds later: ONE turn with the photos and the recording', async () => {
    const h = await harness(2_000)
    try {
      const photos = [upload('46195.jpg'), upload('46196.jpg')]
      const recording = upload('recording-2026-10-29-091734.m4a', 'file', 'audio/mp4')
      h.storedRow('cm-photo', '', photos)
      const c = await connect(h.port, h.token)
      c.ws.send(JSON.stringify({ type: 'message', agentId: 'main', clientMessageId: 'cm-photo', skipSave: true, attachments: photos }))
      await until(() => c.all.some(f => f.type === 'message_ack' && f.clientMessageId === 'cm-photo'))
      await new Promise(r => setTimeout(r, 300))
      expect(h.calls).toHaveLength(0)

      h.storedRow('cm-voice', 'Was ist auf den Fotos?', [recording])
      c.ws.send(JSON.stringify({ type: 'message', content: 'Was ist auf den Fotos?', agentId: 'main', clientMessageId: 'cm-voice', skipSave: true, attachments: [recording] }))
      await until(() => h.calls.length === 1)
      await new Promise(r => setTimeout(r, 2_300))
      expect(h.calls).toEqual([
        { text: 'Was ist auf den Fotos?', files: ['46195.jpg', '46196.jpg', 'recording-2026-10-29-091734.m4a'] },
      ])
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('a frame that is not an object answers with an error instead of vanishing', async () => {
    const h = await harness(50)
    try {
      const c = await connect(h.port, h.token)
      c.ws.send('null')
      await until(() => c.all.some(f => f.type === 'error'))
      c.ws.close()
    } finally {
      await h.close()
    }
  })
})
