/**
 * Message chronology, the two independent causes of "my messages slide under
 * yours" (bug report 2026-09-15):
 *
 *  1. TIMEZONE. `chat_messages.timestamp` is SQLite's `datetime('now')`, i.e.
 *     `YYYY-MM-DD HH:MM:SS` in UTC *without* a zone marker. A client that hands
 *     that string to `new Date(...)` (JS) reads it as LOCAL time and is two
 *     hours off in Europe/Berlin. Mixed with a locally created ISO timestamp of
 *     an optimistically rendered own message the two are no longer comparable.
 *
 *  2. NO TIEBREAKER. Second resolution plus `ORDER BY timestamp` alone leaves
 *     the order of rows written in the same second undefined. `id` is the
 *     insertion order and the only exact tiebreaker we have.
 *
 * Both are asserted end-to-end against the REST history endpoint and against
 * the WS/REST task timelines.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-chronology-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')

  const sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
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
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM tasks; DELETE FROM tool_calls;')
})

interface HistoryRow {
  id: number
  role: string
  content: string
  timestamp: string
  timestampUtc?: string
}

function seedSession(sessionId: string): void {
  db.prepare(
    "INSERT INTO sessions (id, user_id, source, type, started_at) VALUES (?, '1', 'web', 'interactive', ?)",
  ).run(sessionId, '2026-09-15 06:15:53')
}

/** Insert rows that all share one wall-clock second, in a defined order. */
function seedSameSecond(sessionId: string, second: string, roles: Array<[string, string]>): void {
  const insert = db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, timestamp, agent_id) VALUES (?, 1, ?, ?, ?, ?)',
  )
  for (const [role, content] of roles) insert.run(sessionId, role, content, second, 'main')
}

async function history(query: string): Promise<HistoryRow[]> {
  const res = await fetch(`${baseUrl}/api/chat/history?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { messages: HistoryRow[] }
  return body.messages
}

describe('REST history keeps the written order', () => {
  it('reverses the newest-first page back into insertion order when every row shares a second', async () => {
    seedSession('sess-tie')
    seedSameSecond('sess-tie', '2026-09-15 07:35:00', [
      ['user', 'erste frage'],
      ['assistant', 'erste antwort'],
      ['user', 'zweite frage'],
      ['assistant', 'zweite antwort'],
      ['user', 'dritte frage'],
      ['assistant', 'dritte antwort'],
    ])

    // This is what `loadRecentHistory()` in the web frontend does: pull the
    // newest page (timestamp DESC) and reverse it for rendering.
    const page = await history('limit=50')
    const rendered = [...page].reverse()

    expect(rendered.map(m => m.content)).toEqual([
      'erste frage',
      'erste antwort',
      'zweite frage',
      'zweite antwort',
      'dritte frage',
      'dritte antwort',
    ])
    // Ascending ids are the actual contract: reversal of a DESC page may only
    // ever produce the insertion order.
    const ids = rendered.map(m => m.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })

  it('paginates deterministically across page boundaries in the same second', async () => {
    seedSession('sess-page')
    const roles: Array<[string, string]> = []
    for (let i = 0; i < 10; i++) {
      roles.push([i % 2 === 0 ? 'user' : 'assistant', `m${i}`])
    }
    seedSameSecond('sess-page', '2026-09-15 07:35:00', roles)

    const first = await history('limit=5&page=1')
    const second = await history('limit=5&page=2')
    // Page 1 is the newest block, page 2 the one before it; each page is
    // reversed for rendering and the older page goes on top.
    const rendered = [...[...second].reverse(), ...[...first].reverse()].map(m => m.content)

    expect(rendered).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'])
  })
})

describe('REST history timestamps are unambiguous', () => {
  it('emits ISO-8601 with an explicit UTC marker', async () => {
    seedSession('sess-iso')
    seedSameSecond('sess-iso', '2026-09-15 06:15:53', [['user', 'hallo']])

    const [row] = await history('limit=50')
    expect(row!.timestamp).toMatch(ISO_UTC)
    expect(row!.timestampUtc).toMatch(ISO_UTC)
    expect(row!.timestampUtc).toBe(row!.timestamp)
    expect(new Date(row!.timestamp).toISOString()).toBe('2026-09-15T06:15:53.000Z')
  })

  it('an optimistic own message stays newer than the server rows it follows', async () => {
    // The client renders its own bubble with `new Date().toISOString()` (true
    // UTC). The server row was written a second EARLIER. Whatever the client's
    // timezone is, sorting the two must keep the server row first.
    seedSession('sess-tz')
    const serverSecond = '2026-09-15 07:35:00'
    seedSameSecond('sess-tz', serverSecond, [['assistant', 'antwort von 07:35']])

    const [row] = await history('limit=50')
    const optimisticIso = new Date(Date.parse('2026-09-15T07:35:01Z')).toISOString()

    // A naive client: `new Date(wire)`. With the naked SQLite string this is
    // off by the local UTC offset; in Europe/Berlin (+02:00) it lands two
    // hours in the past, which is what made own messages slide.
    const serverMs = new Date(row!.timestamp).getTime()
    const optimisticMs = new Date(optimisticIso).getTime()
    expect(optimisticMs - serverMs).toBe(1000)
  })
})

describe('the raw wire fields stay backwards compatible', () => {
  it('keeps every column the Android app decodes', async () => {
    seedSession('sess-compat')
    db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content, metadata, timestamp, agent_id, client_message_id) VALUES (?, 1, 'user', 'x', ?, ?, 'main', 'cm-1')",
    ).run('sess-compat', '{"kind":"thinking"}', '2026-09-15 06:15:53')

    const [row] = await history('limit=50') as unknown as Array<Record<string, unknown>>
    for (const key of ['id', 'session_id', 'user_id', 'role', 'content', 'metadata', 'timestamp', 'agent_id', 'client_message_id', 'source']) {
      expect(row, `missing wire field ${key}`).toHaveProperty(key)
    }
    // `Instant.parse` in the app (ThreadDisplay.parseTimestampMillis) is the
    // primary path and only accepts a zone marker.
    expect(row!.timestamp as string).toMatch(ISO_UTC)
  })
})

describe('POST /api/chat/message answers with one timestamp format on every branch', () => {
  it('returns the same shape for a fresh insert and for the idempotent retry', async () => {
    const form = (): FormData => {
      const f = new FormData()
      f.append('content', 'hallo')
      f.append('clientMessageId', 'cm-retry-1')
      return f
    }
    const first = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form(),
    })
    expect(first.status).toBe(201)
    const firstBody = await first.json() as { message: Record<string, unknown> }

    const second = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form(),
    })
    expect(second.status).toBe(200)
    const secondBody = await second.json() as { message: Record<string, unknown> }

    expect(firstBody.message.timestamp as string).toMatch(ISO_UTC)
    expect(secondBody.message.timestamp as string).toMatch(ISO_UTC)
    expect(secondBody.message.timestampUtc as string).toMatch(ISO_UTC)
    expect(secondBody.message.id).toBe(firstBody.message.id)
  })
})
