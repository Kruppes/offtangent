/**
 * `GET /api/chat/history` hands the voice note of an answer to the client.
 *
 * A voice note travels exactly like an attachment: inside the row's
 * `metadata` document, which the history returns verbatim. This test nails
 * that down for BOTH history branches the app uses — the paged read and the
 * `since_id` sync cursor — so a later change to the select list cannot
 * silently drop the note.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, mergeVoiceNoteMetadata, type Database, type VoiceNote } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken } from '../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

const NOTE: VoiceNote = {
  url: '/api/uploads/2026/voice-note-1.ogg',
  mimeType: 'audio/ogg',
  seconds: 42.5,
  spokenChars: 780,
  sourceChars: 4200,
  model: 'gemini-3.8-flash-lite-tts',
  voice: 'Charon',
  createdAt: '2026-09-24T10:00:00.000Z',
}

interface HistoryMessage {
  id: number
  role: string
  content: string
  metadata: string | null
}

async function history(query: string): Promise<HistoryMessage[]> {
  const res = await fetch(`${baseUrl}/api/chat/history?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { messages: HistoryMessage[] }).messages
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-voice-note-history-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, type) VALUES ('strand-1', 1, 'main', 'interactive')").run()

  const app = createApp({ db })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.prepare('DELETE FROM chat_messages').run()
})

function insertAnswer(metadata: string | null): number {
  const result = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id)
     VALUES ('strand-1', 1, 'assistant', 'Der Lauf ist durch.', ?, 'main')`,
  ).run(metadata)
  return Number(result.lastInsertRowid)
}

describe('GET /api/chat/history with a voice note', () => {
  it('returns the note in the paged branch', async () => {
    const id = insertAnswer(mergeVoiceNoteMetadata(null, NOTE))
    const messages = await history('session_id=strand-1')

    const row = messages.find(m => m.id === id)!
    expect(JSON.parse(row.metadata!).voiceNote).toEqual(NOTE)
  })

  it('returns the note in the since_id sync branch, next to the attachments', async () => {
    const withFile = JSON.stringify({
      files: [{ kind: 'file', originalName: 'report.pdf', storedName: 'report.pdf', relativePath: '2026/report.pdf', urlPath: '/api/uploads/2026/report.pdf', mimeType: 'application/pdf', size: 99 }],
    })
    const id = insertAnswer(mergeVoiceNoteMetadata(withFile, NOTE))
    const messages = await history(`session_id=strand-1&since_id=${id - 1}`)

    const row = messages.find(m => m.id === id)!
    const parsed = JSON.parse(row.metadata!)
    expect(parsed.voiceNote).toEqual(NOTE)
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0].urlPath).toBe('/api/uploads/2026/report.pdf')
  })

  it('leaves an answer without a note alone', async () => {
    const id = insertAnswer(null)
    const row = (await history('session_id=strand-1')).find(m => m.id === id)!
    expect(row.metadata).toBeNull()
  })
})
