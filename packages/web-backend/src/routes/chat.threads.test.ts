/**
 * Offtangent Stufe 1, REST side:
 * - POST /api/chat/message accepts `sessionId` (multipart field, like
 *   `agentId`) and routes the upload prelude into THAT thread; refusals map
 *   to 404 / 409 / 403 per contract.
 * - GET /api/chat/history?session_id= must also serve ENDED sessions —
 *   otherwise reopening an old thread shows an empty conversation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager } from '@axiom/core'
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

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-chat-threads-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')

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

async function postMessage(fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  const res = await fetch(`${baseUrl}/api/chat/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('POST /api/chat/message with sessionId', () => {
  it('persists the message in the named thread instead of the active session', async () => {
    const other = sessionManager.createThread('1', 'bob', 'other')
    sessionManager.activateSession('1', other.id, 'bob')
    const target = sessionManager.createThread('1', 'bob', 'target')

    const { status, body } = await postMessage({ content: 'hello thread', agentId: 'bob', sessionId: target.id })
    expect(status).toBe(201)
    expect((body.message as { session_id: string }).session_id).toBe(target.id)
    // The REST prelude only checks access; activation (parking `other`)
    // belongs to the serialized turn, so the slot is untouched here.
    expect(sessionManager.getSession('1', 'bob')?.id).toBe(other.id)
  })

  it('404s for an unknown thread, 409 for another persona, 403 for a foreign one', async () => {
    const unknown = await postMessage({ content: 'x', agentId: 'bob', sessionId: 'a1b2c3d4-0000-4000-8000-000000000000' })
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('session_not_found')

    const bobThread = sessionManager.createThread('1', 'bob', 'bob')
    const mismatch = await postMessage({ content: 'x', agentId: 'main', sessionId: bobThread.id })
    expect(mismatch.status).toBe(409)
    expect(mismatch.body.code).toBe('session_agent_mismatch')

    const foreign = sessionManager.createThread('2', 'bob', 'theirs')
    const forbidden = await postMessage({ content: 'x', agentId: 'bob', sessionId: foreign.id })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.code).toBe('session_forbidden')

    expect(db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()).toEqual({ c: 0 })
  })

  it('rejects a malformed sessionId', async () => {
    const { status, body } = await postMessage({ content: 'x', agentId: 'bob', sessionId: 'not a session id' })
    expect(status).toBe(400)
    expect(body.error).toBe('Invalid sessionId')
  })

  it('without sessionId keeps the legacy behaviour (active session of the persona)', async () => {
    const { status, body } = await postMessage({ content: 'legacy', agentId: 'bob' })
    expect(status).toBe(201)
    const sessionId = (body.message as { session_id: string }).session_id
    expect(sessionId).toBe(sessionManager.getSession('1', 'bob')?.id)
  })
})

describe('GET /api/chat/history for ended threads', () => {
  it('returns the messages of a session that has already ended', async () => {
    const thread = sessionManager.createThread('1', 'bob', 'old')
    db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, ?, ?, ?)')
      .run(thread.id, 'user', 'question from last week', 'bob')
    db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, ?, ?, ?)')
      .run(thread.id, 'assistant', 'answer from last week', 'bob')
    db.prepare("UPDATE sessions SET ended_at = datetime('now'), summary_written = 1 WHERE id = ?").run(thread.id)

    const res = await fetch(`${baseUrl}/api/chat/history?session_id=${thread.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: Array<{ content: string; session_type: string; source: string }> }
    expect(body.messages.map(m => m.content).sort()).toEqual(['answer from last week', 'question from last week'])
    expect(body.messages[0].session_type).toBe('interactive')
    expect(body.messages[0].source).toBe('web')
  })
})
