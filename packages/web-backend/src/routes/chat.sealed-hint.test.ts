/**
 * `GET /api/chat/history` reports the secrets a user message sealed
 * (privacy plan 2026-09-26, step 1 — bug found in report T4).
 *
 * The chat page renders the hint "1 secret stored safely" from `sealedCount`,
 * which the live `message_ack` frame delivers. The page then (re)loads the
 * transcript from this route, which replaces `messages.value` — so without
 * the field here the hint disappears a moment after it appeared, and only the
 * lock chip survives.
 *
 * What is proven here:
 *   - a user row whose handles were sealed IN that row reports them in
 *     `sealed: [{ slug, kind }]`
 *   - a LATER row that merely mentions the same handle again reports nothing:
 *     the hint belongs to the message that sealed the value, not to every
 *     message that uses it
 *   - two fresh handles in one row are counted as two
 *   - an assistant row never reports handles (it has no sealing boundary)
 *   - a handle that is not (or no longer) in the store is not claimed
 *   - `content` stays exactly as stored, and `sealed` is always an array
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager, sealSecret, invalidateSecretHandleCache } from '@axiom/core'
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
let previousKey: string | undefined

interface HistoryMessage {
  id: number
  role: string
  content: string
  sealed: Array<{ slug: string; kind: string }>
}

/** Synthetic secret values, assembled at runtime so no scanner sees a token. */
const ROUTER_PASSWORD = ['Nordwind', '42', '!'].join('-')
const DEPLOY_TOKEN = ['ghp', '_', 'A'.repeat(20), '7', 'z'.repeat(16)].join('')
const DOOR_PIN = ['4', '7', '1', '1'].join('')

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  previousKey = process.env.ENCRYPTION_KEY
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-chat-sealed-'))
  process.env.DATA_DIR = tempDataDir
  process.env.ENCRYPTION_KEY = ['test', 'only', 'sealed', 'hint', 'key'].join('-')
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'coder'), { recursive: true })
  invalidateSecretHandleCache()

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
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousKey
  invalidateSecretHandleCache()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions;')
})

function insert(sessionId: string, role: string, content: string): number {
  const info = db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, ?, ?, ?)')
    .run(sessionId, role, content, 'coder')
  return Number(info.lastInsertRowid)
}

async function history(sessionId: string): Promise<HistoryMessage[]> {
  const res = await fetch(`${baseUrl}/api/chat/history?session_id=${encodeURIComponent(sessionId)}&limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { messages: HistoryMessage[] }
  // The route answers newest first; the transcript order is easier to read.
  return [...body.messages].reverse()
}

describe('GET /api/chat/history reports the secrets a message sealed', () => {
  it('reports the handle that was sealed out of this very message', async () => {
    const slug = sealSecret(ROUTER_PASSWORD, 'password', 'test')
    insert('web-sealed-1', 'user', `the router password is {{secret:${slug}}}`)

    const rows = await history('web-sealed-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sealed).toEqual([{ slug, kind: 'password' }])
    expect(rows[0]!.content).toBe(`the router password is {{secret:${slug}}}`)
  })

  it('does not repeat the hint on a later message that reuses the handle', async () => {
    const slug = sealSecret(DEPLOY_TOKEN, 'github-token', 'test')
    insert('web-sealed-2', 'user', `deploy with {{secret:${slug}}}`)
    insert('web-sealed-2', 'assistant', 'done')
    insert('web-sealed-2', 'user', `use {{secret:${slug}}} again please`)

    const rows = await history('web-sealed-2')
    expect(rows.map(r => r.sealed)).toEqual([
      [{ slug, kind: 'github-token' }],
      [],
      [],
    ])
  })

  it('counts two fresh handles of one message as two', async () => {
    const pin = sealSecret(DOOR_PIN, 'pin', 'test')
    const pw = sealSecret(`${ROUTER_PASSWORD}-second`, 'password', 'test')
    insert('web-sealed-3', 'user', `pin {{secret:${pin}}} and password {{secret:${pw}}}`)

    const rows = await history('web-sealed-3')
    expect(rows[0]!.sealed.map(s => s.slug).sort()).toEqual([pin, pw].sort())
  })

  it('never reports handles on an assistant row', async () => {
    const slug = sealSecret(`${DEPLOY_TOKEN}x`, 'github-token', 'test')
    insert('web-sealed-4', 'assistant', `I used {{secret:${slug}}}`)

    const rows = await history('web-sealed-4')
    expect(rows[0]!.sealed).toEqual([])
  })

  it('does not claim a handle that is not in the store', async () => {
    insert('web-sealed-5', 'user', 'text with {{secret:never-existed}} in it')

    const rows = await history('web-sealed-5')
    expect(rows[0]!.sealed).toEqual([])
  })

  it('always answers with an array, also without any handle', async () => {
    insert('web-sealed-6', 'user', 'plain text without a secret')

    const rows = await history('web-sealed-6')
    expect(Array.isArray(rows[0]!.sealed)).toBe(true)
    expect(rows[0]!.sealed).toEqual([])
  })
})
