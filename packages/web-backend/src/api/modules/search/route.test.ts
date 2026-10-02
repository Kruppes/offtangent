/**
 * `GET /api/search` (W5b): message full text over the existing
 * `chat_messages_fts` index. Pins the answer shape, ownership, persona and
 * archive filters, the limit, FTS special characters and injection attempts,
 * and the rate limit. All content is synthetic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createSearchRouter, parseMarkedSnippet, SEARCH_PER_MINUTE, searchMessages } from './route.js'
import { generateAccessToken } from '../../../auth.js'

// JSON answers are walked freely in assertions; typing every path adds nothing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-search-'))
  process.env.DATA_DIR = tempDataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'first', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'second', 'x', 'user')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(3, 'third', 'x', 'user')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const app = express()
  app.use(express.json())
  app.use('/api/search', createSearchRouter({ db }))
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'first', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'second', role: 'user' })
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

function strand(title: string, userId = '1', agentId = 'main'): string {
  return sessionManager.createThread(userId, agentId, title).id
}

function message(sessionId: string, content: string, role = 'user', userId = 1, at = '2026-03-04 05:06:07'): number {
  return Number(db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, userId, role, content, 'main', at).lastInsertRowid)
}

async function search(query: string, bearer: string | null = token) {
  const headers: Record<string, string> = bearer ? { Authorization: `Bearer ${bearer}` } : {}
  const res = await fetch(`${baseUrl}/api/search?${query}`, { headers })
  return { status: res.status, body: await res.json() as Record<string, Json> }
}

describe('GET /api/search', () => {
  it('answers the pinned shape with plain snippets and highlight ranges', async () => {
    const s = strand('Synthetic shed')
    const id = message(s, 'We painted the garden shed in blue last spring.')
    const res = await search('q=shed')
    expect(res).toEqual({
      status: 200,
      body: {
        query: 'shed',
        hits: [{
          strandId: s,
          strandTitle: 'Synthetic shed',
          messageId: id,
          role: 'user',
          snippet: 'We painted the garden shed in blue last spring.',
          highlights: [[22, 26]],
          timestamp: '2026-03-04T05:06:07.000Z',
        }],
        truncated: false,
        // W6b, additive: no further page.
        nextCursor: null,
      },
    })
    const hit = res.body.hits[0]
    expect(hit.snippet.slice(hit.highlights[0][0], hit.highlights[0][1])).toBe('shed')
  })

  it('matches prefixes of every word (AND) and only user/assistant rows', async () => {
    const s = strand('Mixed')
    message(s, 'compost heap temperature notes')
    message(s, 'compost only')
    message(s, 'compost heap from a tool', 'tool')
    const res = await search('q=comp%20hea')
    expect(res.body.hits.map((h: { snippet: string }) => h.snippet)).toEqual(['compost heap temperature notes'])
  })

  it('answers 401 without a token', async () => {
    expect((await search('q=shed', null)).status).toBe(401)
  })

  it('never returns messages of another user', async () => {
    const foreign = strand('Foreign', '2')
    message(foreign, 'secret synthetic lighthouse', 'user', 2)
    const mine = strand('Mine')
    message(mine, 'my synthetic lighthouse')
    const first = await search('q=lighthouse')
    expect(first.body.hits.map((h: { strandId: string }) => h.strandId)).toEqual([mine])
    const second = await search('q=lighthouse', otherToken)
    expect(second.body.hits.map((h: { strandId: string }) => h.strandId)).toEqual([foreign])
  })

  it('filters archived strands and personas by the strand list rules', async () => {
    const live = strand('Live')
    const archived = strand('Archived')
    message(live, 'kayak trip')
    message(archived, 'kayak storage')
    db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(archived)
    expect((await search('q=kayak')).body.hits).toHaveLength(1)
    expect((await search('q=kayak&include_archived=1')).body.hits).toHaveLength(2)
    expect((await search('q=kayak&agent_id=main')).body.hits).toHaveLength(1)
    expect(await search('q=kayak&agent_id=nope-not-a-persona')).toEqual({
      status: 400, body: { error: 'Unknown agent_id', code: 'unknown_agent' },
    })
  })

  it('validates q and limit', async () => {
    expect(await search('')).toEqual({ status: 400, body: { error: 'q is required', code: 'invalid_q' } })
    expect((await search('q=%20%20')).status).toBe(400)
    expect(await search('q=a')).toEqual({ status: 400, body: { error: 'q must be 2 to 200 characters', code: 'invalid_q' } })
    expect((await search(`q=${'a'.repeat(201)}`)).status).toBe(400)
    expect((await search('q=ab&q=cd')).status).toBe(400)
    for (const limit of ['0', '51', '-1', '2.5', 'ten']) {
      expect(await search(`q=shed&limit=${limit}`)).toEqual({
        status: 400, body: { error: 'limit must be an integer from 1 to 50', code: 'invalid_limit' },
      })
    }
  })

  it('honours the limit and reports truncation', async () => {
    const s = strand('Many')
    for (let i = 0; i < 7; i++) message(s, `tulip bulb number ${i}`)
    const res = await search('q=tulip&limit=5')
    expect(res.body.hits).toHaveLength(5)
    expect(res.body.truncated).toBe(true)
    expect((await search('q=tulip&limit=50')).body.truncated).toBe(false)
  })

  it('treats FTS operators and special characters as text', async () => {
    const s = strand('Specials')
    message(s, 'alpha beta gamma')
    for (const q of ['"alpha', 'alpha*', 'alpha OR zzz', 'alpha NOT beta', 'NEAR(alpha beta)', 'content:alpha', '(alpha', 'alpha^', 'alpha -beta', '{alpha}']) {
      const res = await search(`q=${encodeURIComponent(q)}`)
      expect(res.status, q).toBe(200)
    }
    // OR is a plain word, so this needs a message containing "or" too.
    expect((await search(`q=${encodeURIComponent('alpha OR zzz')}`)).body.hits).toEqual([])
    expect((await search(`q=${encodeURIComponent('"alpha" beta*')}`)).body.hits).toHaveLength(1)
  })

  it('survives SQL injection attempts and leaks nothing', async () => {
    const mine = strand('Mine')
    message(mine, 'harmless synthetic text')
    const foreign = strand('Foreign', '2')
    message(foreign, 'harmless foreign text', 'user', 2)
    for (const q of [
      "harmless' OR '1'='1",
      'harmless"); DROP TABLE chat_messages; --',
      "harmless%' --",
      'harmless UNION SELECT password_hash FROM users',
      '%%',
      '_%',
    ]) {
      const res = await search(`q=${encodeURIComponent(q)}`)
      expect(res.status, q).toBe(200)
      expect(res.body.hits.every((h: { strandId: string }) => h.strandId === mine), q).toBe(true)
      expect(JSON.stringify(res.body)).not.toContain('foreign')
    }
    expect((db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get() as { c: number }).c).toBe(2)
  })

  it('rate limits per user with 429', async () => {
    const third = generateAccessToken({ userId: 3, username: 'third', role: 'user' })
    let last = 0
    for (let i = 0; i <= SEARCH_PER_MINUTE; i++) last = (await search('q=anything', third)).status
    expect(last).toBe(429)
    // Other users are not affected.
    expect((await search('q=anything')).status).toBe(200)
  })
})

describe('search internals', () => {
  it('parses marked snippets and drops stray markers', () => {
    expect(parseMarkedSnippet('a \uE000hit\uE001 b')).toEqual({ snippet: 'a hit b', highlights: [[2, 5]] })
    expect(parseMarkedSnippet('x\uE001y\uE000')).toEqual({ snippet: 'xy', highlights: [] })
  })

  it('falls back to an escaped LIKE search without the FTS index', () => {
    const s = strand('Fallback')
    message(s, 'rate is 100% sure')
    message(s, 'rate is 100 sure')
    const res = searchMessages(db, 1, '100%', { limit: 10, includeArchived: false })
    // "100%" has word characters, so FTS answers ("100" prefix) — both rows.
    expect(res.hits).toHaveLength(2)
    // Only symbols: the LIKE path, with % matched literally.
    const like = searchMessages(db, 1, '%%', { limit: 10, includeArchived: false })
    expect(like.hits).toEqual([])
  })
})
