/**
 * `GET /api/chat/history` exposes the `draft` block of a message as a plain
 * text field (puck assist waves, W1).
 *
 * The device that types a draft over a BLE keyboard reads this route and has
 * neither a markdown parser nor a way to guess which part of an answer was
 * prose. What is proven here:
 *   - an assistant message with a `draft` fence gets `draft: <plaintext>`
 *   - a message without one gets `draft: null` — never undefined, so a client
 *     can rely on the key existing
 *   - `content` is NOT rewritten: the fence stays in the message exactly like
 *     the fences of every other block kind, so no existing field changes
 *   - a broken draft fence is text, not a draft
 *   - a user message is never a draft source, even if the user typed a fence
 *   - the fields the puck already reads (`id`, `role`, `content`, `timestamp`)
 *     are untouched
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager, formatDraftFence } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken } from '../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined

interface HistoryMessage {
  id: number
  role: string
  content: string
  draft: string | null
  timestamp: string
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-chat-draft-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  const app = createApp({ db, getAgentCore: () => agentCore })
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
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions;')
})

function insert(sessionId: string, role: string, content: string): void {
  db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, ?, ?, ?)')
    .run(sessionId, role, content, 'bob')
}

async function history(sessionId: string): Promise<HistoryMessage[]> {
  const res = await fetch(`${baseUrl}/api/chat/history?session_id=${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { messages: HistoryMessage[] }
  return body.messages
}

const DRAFT = 'Sehr geehrter Herr Mueller,\n\nder Liefertermin ist KW 42, die Inbetriebnahme KW 43.\n\nViele Gruesse'

describe('GET /api/chat/history draft field', () => {
  it('serves the draft text of an assistant message and leaves content alone', async () => {
    const thread = sessionManager.createThread('1', 'bob', 'Mail an Mueller')
    const content = `Hier ist der Entwurf.\n\n${formatDraftFence(DRAFT)}\n\nPasst das?`
    insert(thread.id, 'user', 'Schreib mir eine kurze Mail an Herrn Mueller')
    insert(thread.id, 'assistant', content)

    const messages = await history(thread.id)
    expect(messages).toHaveLength(2)
    const assistant = messages.find(m => m.role === 'assistant')!
    expect(assistant.draft).toBe(DRAFT)
    // No markdown survived into the draft.
    expect(assistant.draft).not.toContain('```')
    expect(assistant.draft).not.toContain('**')
    // The message itself is byte-identical to what was stored: every surface
    // keeps degrading the fence itself, exactly as for the other block kinds.
    expect(assistant.content).toBe(content)
    // The fields the puck already reads are untouched.
    expect(assistant.id).toBeGreaterThan(0)
    expect(typeof assistant.timestamp).toBe('string')
  })

  it('reports draft: null for everything that is not a draft', async () => {
    const thread = sessionManager.createThread('1', 'bob', 'Ohne Entwurf')
    insert(thread.id, 'user', 'Wie weit ist es nach Graz?')
    insert(thread.id, 'assistant', 'Etwa zweihundert Kilometer.')
    // A choice block is a question, not a draft.
    insert(thread.id, 'assistant', '```offtangent\n{"block":"choice","id":"b1","question":"Welche?","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}\n```')
    // A half-written fence is text.
    insert(thread.id, 'assistant', '```offtangent\n{"block":"draft","text":"halb')

    const messages = await history(thread.id)
    expect(messages).toHaveLength(4)
    for (const message of messages) {
      expect(message.draft).toBeNull()
      // The key exists on every message, so a client never sees `undefined`.
      expect('draft' in message).toBe(true)
    }
  })

  it('never turns a fence the USER typed into a draft', async () => {
    const thread = sessionManager.createThread('1', 'bob', 'Nutzer tippt selbst')
    insert(thread.id, 'user', formatDraftFence('Das habe ich selbst geschrieben'))

    const messages = await history(thread.id)
    expect(messages[0].role).toBe('user')
    expect(messages[0].draft).toBeNull()
  })
})
