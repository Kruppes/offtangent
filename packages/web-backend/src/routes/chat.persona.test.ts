/**
 * Axiom-Companion M1: REST side of multi-persona + cursor sync + idempotency.
 *
 * - GET /api/chat/history: `since_id` (ascending gap fetch), `agent_id` filter,
 *   both optional; default behaviour must stay byte-identical for the web UI.
 * - POST /api/chat/message: `agentId`, `clientMessageId` (201 first, 200 +
 *   `duplicate: true` on retry, files not stored twice).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken } from '../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let tempDataDir: string
let previousDataDir: string | undefined
const sessionCalls: Array<[string, string, string | undefined]> = []

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-chat-persona-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
  db.prepare("INSERT INTO sessions (id, user_id, source, agent_id) VALUES ('s-main', '1', 'web', 'main')").run()
  db.prepare("INSERT INTO sessions (id, user_id, source, agent_id) VALUES ('s-bob', '1', 'web', 'bob')").run()

  const agentCore = {
    getSessionManager: () => ({
      getOrCreateSession: (userId: string, source: string, agentId?: string) => {
        sessionCalls.push([userId, source, agentId])
        return { id: `s-${agentId ?? 'main'}`, userId, source, startedAt: 0, lastActivity: 0, messageCount: 0, summaryWritten: false, restored: false }
      },
    }),
  } as unknown as AgentCore

  const app = createApp({ db, getAgentCore: () => agentCore })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

function insert(userId: number, sessionId: string, agentId: string, content: string, ts: string): number {
  const r = db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sessionId, userId, 'user', content, agentId, ts)
  return Number(r.lastInsertRowid)
}

interface HistoryBody {
  messages: Array<{ id: number; session_id: string; content: string; agent_id: string; client_message_id: string | null; source: string | null }>
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

async function history(query: string, bearer = token): Promise<{ status: number; body: HistoryBody }> {
  const res = await fetch(`${baseUrl}/api/chat/history${query}`, { headers: { Authorization: `Bearer ${bearer}` } })
  return { status: res.status, body: await res.json() as HistoryBody }
}

describe('GET /api/chat/history cursor + persona filter', () => {
  const ids: number[] = []
  beforeAll(() => {
    ids.push(insert(1, 's-main', 'main', 'm1', '2026-09-12 10:00:00'))
    ids.push(insert(1, 's-bob', 'bob', 'b1', '2026-09-12 10:00:01'))
    ids.push(insert(1, 's-main', 'main', 'm2', '2026-09-12 10:00:02'))
    ids.push(insert(1, 's-bob', 'bob', 'b2', '2026-09-12 10:00:03'))
    ids.push(insert(1, 's-bob', 'bob', 'b3', '2026-09-12 10:00:04'))
    insert(2, 's-other', 'bob', 'not mine', '2026-09-12 10:00:05')
  })

  it('without new params behaves as before: newest first, paginated, but now exposes agent_id', async () => {
    const { status, body } = await history('?limit=2')
    expect(status).toBe(200)
    expect(body.messages.map(m => m.content)).toEqual(['b3', 'b2'])
    expect(body.messages[0].agent_id).toBe('bob')
    expect(body.messages[0].client_message_id).toBeNull()
    expect(body.messages[0].source).toBe('web')
    expect(body.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 })
  })

  it('since_id returns only rows after the cursor, ascending by id, never other users rows', async () => {
    const { body } = await history(`?since_id=${ids[1]}`)
    expect(body.messages.map(m => m.content)).toEqual(['m2', 'b2', 'b3'])
    expect(body.messages.map(m => m.id)).toEqual(ids.slice(2))
    expect(body.pagination.total).toBe(3)
    expect(body.pagination.page).toBe(1)
  })

  it('since_id=0 is the "everything I have never seen" bootstrap', async () => {
    const { body } = await history('?since_id=0&limit=100')
    expect(body.messages.map(m => m.content)).toEqual(['m1', 'b1', 'm2', 'b2', 'b3'])
  })

  it('since_id respects limit so a big gap is fetched in batches', async () => {
    const { body } = await history(`?since_id=0&limit=2`)
    expect(body.messages.map(m => m.content)).toEqual(['m1', 'b1'])
    const { body: next } = await history(`?since_id=${body.messages[1].id}&limit=2`)
    expect(next.messages.map(m => m.content)).toEqual(['m2', 'b2'])
  })

  it('agent_id filters one persona and combines with since_id', async () => {
    const { body } = await history('?agent_id=bob')
    expect(body.messages.map(m => m.content)).toEqual(['b3', 'b2', 'b1'])
    expect(body.pagination.total).toBe(3)

    const { body: gap } = await history(`?agent_id=bob&since_id=${ids[1]}`)
    expect(gap.messages.map(m => m.content)).toEqual(['b2', 'b3'])

    const { body: main } = await history('?agent_id=main')
    expect(main.messages.map(m => m.content)).toEqual(['m2', 'm1'])
  })

  it('rejects unknown agent_id and malformed since_id with 400', async () => {
    expect((await history('?agent_id=gekko')).status).toBe(400)
    expect((await history('?since_id=abc')).status).toBe(400)
    expect((await history('?since_id=-1')).status).toBe(400)
  })

  it('scopes the cursor to the caller', async () => {
    const { body } = await history('?since_id=0', otherToken)
    expect(body.messages.map(m => m.content)).toEqual(['not mine'])
  })

  it('combines session_id + since_id (+ agent_id): only newer rows of THAT thread, ascending', async () => {
    // How the thread view syncs: it holds a cursor per thread and polls the
    // gap. Rows of the sibling thread must never leak into that gap, and the
    // batch must be ascending so it can be appended as-is.
    const { body } = await history(`?session_id=s-bob&since_id=${ids[1]}&limit=100`)
    expect(body.messages.map(m => m.content)).toEqual(['b2', 'b3'])
    expect(body.messages.map(m => m.session_id)).toEqual(['s-bob', 's-bob'])
    expect(body.messages.map(m => m.id)).toEqual([...body.messages.map(m => m.id)].sort((a, b) => a - b))
    // `total` counts the rows after the cursor within the same filter.
    expect(body.pagination).toEqual({ page: 1, limit: 100, total: 2, totalPages: 1 })

    // The persona filter is redundant for a thread but must not change anything.
    const { body: withAgent } = await history(`?session_id=s-bob&since_id=${ids[1]}&agent_id=bob&limit=100`)
    expect(withAgent.messages.map(m => m.content)).toEqual(['b2', 'b3'])

    // ... and a contradicting persona yields nothing instead of the sibling's rows.
    const { body: mismatch } = await history(`?session_id=s-bob&since_id=0&agent_id=main`)
    expect(mismatch.messages).toEqual([])

    // Bootstrap of one thread: everything of that session, ascending.
    const { body: boot } = await history('?session_id=s-main&since_id=0&limit=100')
    expect(boot.messages.map(m => m.content)).toEqual(['m1', 'm2'])

    // Paging through one thread by cursor.
    const { body: page1 } = await history('?session_id=s-bob&since_id=0&limit=2')
    expect(page1.messages.map(m => m.content)).toEqual(['b1', 'b2'])
    const { body: page2 } = await history(`?session_id=s-bob&since_id=${page1.messages[1].id}&limit=2`)
    expect(page2.messages.map(m => m.content)).toEqual(['b3'])
    const { body: done } = await history(`?session_id=s-bob&since_id=${page2.messages[0].id}&limit=2`)
    expect(done.messages).toEqual([])
  })
})

describe('POST /api/chat/message persona + idempotency', () => {
  async function post(fields: Record<string, string>, file?: { name: string; content: string }, bearer = token) {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    if (file) form.append('files', new Blob([file.content], { type: 'text/plain' }), file.name)
    const res = await fetch(`${baseUrl}/api/chat/message`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}` }, body: form })
    return { status: res.status, body: await res.json() as { message: Record<string, unknown>; duplicate?: boolean; error?: string } }
  }

  it('attributes the row and the session to the requested persona and returns the row id', async () => {
    sessionCalls.length = 0
    const { status, body } = await post({ content: 'to bob', agentId: 'bob' })
    expect(status).toBe(201)
    expect(body.message.agent_id).toBe('bob')
    expect(body.message.session_id).toBe('s-bob')
    expect(typeof body.message.id).toBe('number')
    expect(sessionCalls).toEqual([['1', 'web', 'bob']])
    const row = db.prepare('SELECT agent_id, client_message_id FROM chat_messages WHERE id = ?').get(body.message.id) as { agent_id: string; client_message_id: string | null }
    expect(row).toEqual({ agent_id: 'bob', client_message_id: null })
  })

  it("defaults to 'main' without agentId (web UI unchanged)", async () => {
    const { status, body } = await post({ content: 'legacy' })
    expect(status).toBe(201)
    expect(body.message.agent_id).toBe('main')
    expect(body.message.session_id).toBe('s-main')
  })

  it('rejects unknown agentId and malformed clientMessageId', async () => {
    expect((await post({ content: 'x', agentId: 'gekko' })).status).toBe(400)
    expect((await post({ content: 'x', clientMessageId: 'bad key' })).status).toBe(400)
  })

  it('stores the key, and a retry returns 200 + the same row without a second upload', async () => {
    const first = await post({ content: 'with file', agentId: 'bob', clientMessageId: 'rest-1' }, { name: 'a.txt', content: 'hello' })
    expect(first.status).toBe(201)
    expect(first.body.message.client_message_id).toBe('rest-1')
    const uploadsBefore = countFiles(path.join(tempDataDir, 'uploads'))

    const retry = await post({ content: 'with file', agentId: 'bob', clientMessageId: 'rest-1' }, { name: 'a.txt', content: 'hello' })
    expect(retry.status).toBe(200)
    expect(retry.body.duplicate).toBe(true)
    expect(retry.body.message.id).toBe(first.body.message.id)
    expect(retry.body.message.metadata).toBe(first.body.message.metadata)
    expect(countFiles(path.join(tempDataDir, 'uploads'))).toBe(uploadsBefore)

    const rows = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE client_message_id = 'rest-1'").get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it('answers 409 when a key is reused for another persona', async () => {
    const first = await post({ content: 'a', agentId: 'bob', clientMessageId: 'rest-persona' })
    expect(first.status).toBe(201)
    const other = await post({ content: 'a', agentId: 'main', clientMessageId: 'rest-persona' })
    expect(other.status).toBe(409)
    expect(other.body.error).toMatch(/another persona/)
  })

  it('keys are per user: another user may reuse the same key', async () => {
    const mine = await post({ content: 'a', clientMessageId: 'shared' })
    const theirs = await post({ content: 'b', clientMessageId: 'shared' }, undefined, otherToken)
    expect(mine.status).toBe(201)
    expect(theirs.status).toBe(201)
    expect(theirs.body.message.id).not.toBe(mine.body.message.id)
  })
})

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let n = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1
  }
  return n
}
