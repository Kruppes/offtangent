/**
 * `GET /api/search` paging (W6b): `nextCursor` / `cursor` over 120 synthetic
 * hits. Three pages of 50/50/20, no duplicates, no gaps, a clean end, the
 * same total order as a single query would give, and 400 `invalid_cursor`
 * for every broken or foreign cursor. All content is synthetic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createSearchRouter, decodeSearchCursor, encodeSearchCursor, searchMessages } from './route.js'
import { generateAccessToken } from '../../../auth.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-search-paging-'))
  process.env.DATA_DIR = tempDataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'first', 'x', 'admin')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const app = express()
  app.use('/api/search', createSearchRouter({ db }))
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'first', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions;')
})

/** 120 synthetic hits: many exact rank ties (same text) plus different ranks. */
function seed120(): number[] {
  const a = sessionManager.createThread('1', 'main', 'Synthetic garden').id
  const b = sessionManager.createThread('1', 'main', 'Synthetic workshop').id
  const ids: number[] = []
  for (let i = 0; i < 120; i++) {
    const filler = i % 3 === 0 ? '' : ' with extra filler words '.repeat(i % 3)
    const text = i % 4 === 0 ? 'marigold marigold seedling' : `marigold seedling${filler}`
    ids.push(Number(db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
      .run(i % 2 ? a : b, 1, i % 5 ? 'user' : 'assistant', text, 'main', '2026-03-04 05:06:07').lastInsertRowid))
  }
  return ids
}

async function search(query: string) {
  const res = await fetch(`${baseUrl}/api/search?${query}`, { headers: { Authorization: `Bearer ${token}` } })
  return { status: res.status, body: await res.json() as Record<string, Json> }
}

async function allPages(q: string, limit: number) {
  const pages: Json[] = []
  let cursor: string | null = null
  do {
    const res = await search(`q=${q}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    expect(res.status).toBe(200)
    pages.push(res.body)
    cursor = res.body.nextCursor
    expect(pages.length).toBeLessThan(20)
  } while (cursor)
  return pages
}

describe('GET /api/search paging', () => {
  it('pages 120 hits as 50/50/20 without duplicates or gaps and ends cleanly', async () => {
    const ids = seed120()
    const pages = await allPages('marigold', 50)
    expect(pages.map(p => p.hits.length)).toEqual([50, 50, 20])
    expect(pages.map(p => p.truncated)).toEqual([true, true, false])
    expect(pages.map(p => p.nextCursor === null)).toEqual([false, false, true])
    const seen = pages.flatMap(p => p.hits.map((h: Json) => h.messageId))
    expect(new Set(seen).size).toBe(120)
    expect([...seen].sort((x, y) => x - y)).toEqual([...ids].sort((x, y) => x - y))

    // Same total order as one unpaged query (internal call, no 50 cap).
    const whole = searchMessages(db, 1, 'marigold', { limit: 500, includeArchived: false })
    expect(whole.hits.map(h => h.messageId)).toEqual(seen)
  })

  it('small pages give exactly the same sequence', async () => {
    seed120()
    const big = (await allPages('marigold', 50)).flatMap(p => p.hits.map((h: Json) => h.messageId))
    const small = await allPages('marigold', 7)
    expect(small).toHaveLength(Math.ceil(120 / 7))
    expect(small.flatMap(p => p.hits.map((h: Json) => h.messageId))).toEqual(big)
  })

  it('keeps the old answer for callers without a cursor', async () => {
    seed120()
    const res = await search('q=marigold')
    expect(res.body.hits).toHaveLength(20)
    expect(res.body.truncated).toBe(true)
    expect(typeof res.body.nextCursor).toBe('string')
    expect(Object.keys(res.body).sort()).toEqual(['hits', 'nextCursor', 'query', 'truncated'])
  })

  it('pages the LIKE fallback by message id too', () => {
    const s = sessionManager.createThread('1', 'main', 'Symbols').id
    for (let i = 0; i < 12; i++) {
      db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, ?, ?, ?)').run(s, 'user', `cost ${i} %% share`, 'main')
    }
    const first = searchMessages(db, 1, '%%', { limit: 5, includeArchived: false })
    expect(first.hits).toHaveLength(5)
    expect(decodeSearchCursor(first.nextCursor)?.m).toBe('like')
    const second = searchMessages(db, 1, '%%', { limit: 5, includeArchived: false, cursor: first.nextCursor! })
    const third = searchMessages(db, 1, '%%', { limit: 5, includeArchived: false, cursor: second.nextCursor! })
    const all = [...first.hits, ...second.hits, ...third.hits].map(h => h.messageId)
    expect(third.nextCursor).toBeNull()
    expect(all).toHaveLength(12)
    expect(new Set(all).size).toBe(12)
    expect(all).toEqual([...all].sort((x, y) => y - x))
  })

  it('answers 400 invalid_cursor for broken, foreign or mismatched cursors', async () => {
    seed120()
    const first = await search('q=marigold&limit=10')
    const good: string = first.body.nextCursor
    const decoded = decodeSearchCursor(good)!
    const bad = [
      'not-base64-!!',
      Buffer.from('{"v":1').toString('base64url'),
      Buffer.from('[]').toString('base64url'),
      encodeSearchCursor({ ...decoded, v: 2 as 1 }),
      encodeSearchCursor({ ...decoded, id: -1 }),
      encodeSearchCursor({ ...decoded, id: 1.5 }),
      encodeSearchCursor({ ...decoded, h: 'x' }),
      Buffer.from(JSON.stringify({ ...decoded, extra: 1 })).toString('base64url'),
      Buffer.from(JSON.stringify({ ...decoded, r: 'NaN' })).toString('base64url'),
      encodeSearchCursor({ ...decoded, m: 'like', r: undefined }),
      'a'.repeat(401),
    ]
    for (const cursor of bad) {
      expect(await search(`q=marigold&limit=10&cursor=${encodeURIComponent(cursor)}`), cursor).toEqual({
        status: 400, body: { error: 'Invalid cursor', code: 'invalid_cursor' },
      })
    }
    // A valid cursor of another query or filter does not continue this one.
    expect((await search(`q=seedling&limit=10&cursor=${good}`)).body.code).toBe('invalid_cursor')
    expect((await search(`q=marigold&limit=10&include_archived=1&cursor=${good}`)).body.code).toBe('invalid_cursor')
    expect((await search(`q=marigold&limit=10&cursor=${good}&cursor=${good}`)).body.code).toBe('invalid_cursor')
    // The good one still works, with another page size even.
    expect((await search(`q=marigold&limit=25&cursor=${good}`)).status).toBe(200)
  })
})
