/**
 * `GET /api/strands?q=` (web redesign W1): title + message content search,
 * against a real SessionManager and an in-memory database with the FTS index.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database, Thread } from '@axiom/core'
import { createStrandsRouters } from './route.js'
import { escapeLike, searchStrands, toFtsPrefixQuery } from './search.js'
import { parseSearchQuery } from './schema.js'
import { generateAccessToken } from '../../../auth.js'

type Strand = Thread & { matchSnippet?: string }

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
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strand-search-'))
  process.env.DATA_DIR = tempDataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'first', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'second', 'x', 'user')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  const app = express()
  app.use(express.json())
  const routers = createStrandsRouters({ db, getAgentCore: () => agentCore, getNowSetMode: () => 'manual' })
  app.use('/api/strands', routers.strands)
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

function strand(title: string, userId = '1', activity?: string): Thread {
  const created = sessionManager.createThread(userId, 'main', title)
  if (activity) db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(activity, created.id)
  return created
}

function message(sessionId: string, content: string, role: 'user' | 'assistant' | 'tool' = 'user', userId = 1): void {
  db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, ?, ?, ?)').run(sessionId, userId, role, content, 'main')
}

async function list(query: string, bearer = token): Promise<{ status: number; strands: Strand[]; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/strands?${query}`, { headers: { Authorization: `Bearer ${bearer}` } })
  const body = await res.json() as Record<string, unknown>
  return { status: res.status, strands: (body.strands as Strand[] | undefined) ?? [], body }
}

describe('strand search query helpers', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b')
  })

  it('builds quoted prefix terms and drops FTS syntax', () => {
    expect(toFtsPrefixQuery('roof repair')).toBe('"roof"* "repair"*')
    expect(toFtsPrefixQuery('a" OR NEAR(x*')).toBe('"a"* "OR"* "NEAR"* "x"*')
    expect(toFtsPrefixQuery('%%__')).toBe('"__"*')
    expect(toFtsPrefixQuery('%% -- ')).toBeNull()
  })

  it('validates q: blank is no search, 2..200 characters, single string only', () => {
    expect(parseSearchQuery(undefined)).toEqual({ ok: true, value: undefined })
    expect(parseSearchQuery('   ')).toEqual({ ok: true, value: undefined })
    expect(parseSearchQuery(' ab ')).toEqual({ ok: true, value: 'ab' })
    expect(parseSearchQuery('a')).toMatchObject({ ok: false, code: 'invalid_q' })
    expect(parseSearchQuery('x'.repeat(201))).toMatchObject({ ok: false, code: 'invalid_q' })
    expect(parseSearchQuery('x'.repeat(200))).toMatchObject({ ok: true })
    expect(parseSearchQuery(['ab', 'cd'])).toMatchObject({ ok: false, code: 'invalid_q' })
  })

  it('returns message hits with a plain excerpt before title-only hits', () => {
    const byTitle = strand('Garden lamp plan')
    const byMessage = strand('Unrelated title')
    message(byMessage.id, 'We should replace the lamp in the hallway before winter.')
    const hits = searchStrands(db, 1, 'lamp', { includeArchived: false })
    expect(hits.ids).toEqual([byMessage.id, byTitle.id])
    expect(hits.snippets.get(byMessage.id)).toContain('lamp')
    expect(hits.snippets.has(byTitle.id)).toBe(false)
  })
})

describe('GET /api/strands?q=', () => {
  it('finds strands by title and by message content, with a snippet for message hits', async () => {
    const titleHit = strand('Quarterly budget review', '1', '2026-09-01 10:00:00')
    const messageHit = strand('Weekly sync', '1', '2026-09-02 10:00:00')
    const miss = strand('Something else', '1', '2026-09-03 10:00:00')
    message(messageHit.id, 'The budget for the trip needs another look.')
    message(miss.id, 'Nothing to see here.')

    const res = await list('q=budget')
    expect(res.status).toBe(200)
    // List order is kept: latest activity first.
    expect(res.strands.map(s => s.id)).toEqual([messageHit.id, titleHit.id])
    expect(res.strands[0]!.matchSnippet).toContain('budget')
    expect(res.strands[1]!.matchSnippet).toBeUndefined()
  })

  it('matches the word being typed as a prefix and is case-insensitive', async () => {
    const hit = strand('Plain')
    message(hit.id, 'Photosynthesis explained in short.', 'assistant')
    expect((await list('q=PHOTOSYN')).strands.map(s => s.id)).toEqual([hit.id])
  })

  it('ignores tool rows and strands of other users', async () => {
    const own = strand('Own strand')
    message(own.id, 'secretword appears only in a tool row', 'tool')
    const foreign = strand('Foreign strand', '2')
    message(foreign.id, 'secretword in a foreign strand', 'user', 2)
    expect((await list('q=secretword')).strands).toEqual([])
    expect((await list('q=secretword', otherToken)).strands.map(s => s.id)).toEqual([foreign.id])
  })

  it('treats SQL and LIKE special characters literally', async () => {
    const percent = strand('Discount 100% off')
    const underscore = strand('file_name notes')
    strand('filename notes')
    strand('Discount 1000 off')
    expect((await list(`q=${encodeURIComponent('100%')}`)).strands.map(s => s.id)).toEqual([percent.id])
    expect((await list(`q=${encodeURIComponent('e_n')}`)).strands.map(s => s.id)).toEqual([underscore.id])
    const injection = await list(`q=${encodeURIComponent("x' OR '1'='1")}`)
    expect(injection.status).toBe(200)
    expect(injection.strands).toEqual([])
    const fts = await list(`q=${encodeURIComponent('"unbalanced NEAR(')}`)
    expect(fts.status).toBe(200)
  })

  it('hides archived strands unless include_archived=1', async () => {
    const archived = strand('Archived harbour notes')
    sessionManager.updateThread('1', archived.id, { archived: true })
    const live = strand('Live harbour notes')
    expect((await list('q=harbour')).strands.map(s => s.id)).toEqual([live.id])
    expect((await list('q=harbour&include_archived=1')).strands.map(s => s.id).sort()).toEqual([archived.id, live.id].sort())
  })

  it('paginates the hits with limit/offset and combines with other filters', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const s = strand(`Meadow ${i}`, '1', `2026-09-0${i + 1} 10:00:00`)
      ids.unshift(s.id)
    }
    strand('Other topic', '1', '2026-09-09 10:00:00')
    const first = await list('q=meadow&limit=2&offset=0')
    const second = await list('q=meadow&limit=2&offset=2')
    const third = await list('q=meadow&limit=2&offset=4')
    expect([...first.strands, ...second.strands, ...third.strands].map(s => s.id)).toEqual(ids)
    expect(third.strands).toHaveLength(1)
    expect((await list('q=meadow&agent_id=main&limit=100')).strands).toHaveLength(5)
    expect((await list('q=meadow&unread=1')).status).toBe(200)
  })

  it('rejects a too short, too long or repeated q with 400 invalid_q', async () => {
    expect((await list('q=a')).body).toMatchObject({ code: 'invalid_q' })
    expect((await list(`q=${'x'.repeat(201)}`)).status).toBe(400)
    expect((await list('q=ab&q=cd')).status).toBe(400)
    expect((await list('q=')).status).toBe(200)
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/strands?q=test`)
    expect(res.status).toBe(401)
  })
})
