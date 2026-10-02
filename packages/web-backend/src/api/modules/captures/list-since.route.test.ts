/**
 * `GET /api/captures?since=` (W6b, additive): the week view counts exactly.
 * `since` narrows both the page and `total` to captures created at or after
 * the instant; without it nothing changes. Invalid values answer 400
 * `invalid_since` and are never spliced into SQL. All content is synthetic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager, countCaptures } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import { parseListCapturesQuery } from './schema.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-since-'))
  process.env.DATA_DIR = tempDataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'first', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'second', 'x', 'user')
  const sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  const app = express()
  app.use(express.json())
  const captures = createCapturesRouters({
    db,
    getAgentCore: () => agentCore,
    chatEventBus: new ChatEventBus(),
    getTurnRunner: () => ({ startTurn: () => ({}) }),
    routerChain: () => [],
    routerComplete: async () => '{}',
  })
  app.use('/api/captures', captures.captures)
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
  db.exec('DELETE FROM router_decisions; DELETE FROM captures;')
})

let seq = 0
function capture(createdAt: string, status = 'filed', userId = '1'): void {
  seq += 1
  db.prepare("INSERT INTO captures (id, user_id, text, kind, source, status, created_at) VALUES (?, ?, 'synthetic note', 'text', 'web', ?, ?)")
    .run(`cap-${seq}`, userId, status, createdAt)
}

async function list(query: string) {
  const res = await fetch(`${baseUrl}/api/captures?${query}`, { headers: { Authorization: `Bearer ${token}` } })
  return { status: res.status, body: await res.json() as { captures?: Array<{ id: string; createdAt: string }>; total?: number; code?: string; error?: string } }
}

describe('GET /api/captures since', () => {
  it('narrows page and total to the instant; 450 synthetic rows page exactly', async () => {
    // 450 this week (more than two 200 pages), 30 before, 5 dismissed, 7 of another user.
    for (let i = 0; i < 450; i++) capture(`2026-01-0${5 + (i % 4)} ${String(8 + (i % 10)).padStart(2, '0')}:00:00`)
    for (let i = 0; i < 30; i++) capture('2026-01-04 22:59:59')
    for (let i = 0; i < 5; i++) capture('2026-01-06 10:00:00', 'dismissed')
    for (let i = 0; i < 7; i++) capture('2026-01-06 10:00:00', 'filed', '2')

    const since = '2026-01-05T00:00:00%2B01:00' // = 2026-01-04 23:00:00 UTC
    const first = await list(`status=all&limit=200&offset=0&since=${since}`)
    expect(first.status).toBe(200)
    expect(first.body.total).toBe(450)
    const seen = new Set<string>()
    for (let offset = 0; offset < 450; offset += 200) {
      const page = await list(`status=all&limit=200&offset=${offset}&since=${since}`)
      for (const c of page.body.captures!) {
        seen.add(c.id)
        expect(Date.parse(c.createdAt)).toBeGreaterThanOrEqual(Date.parse('2026-01-04T23:00:00Z'))
      }
    }
    expect(seen.size).toBe(450)
    // The boundary is inclusive and exact to the second.
    expect((await list('status=all&since=2026-01-04T22:59:59Z')).body.total).toBe(480)
    expect((await list('status=all&since=2026-01-04T23:00:00.000Z')).body.total).toBe(450)
    // Without `since` the answer is the old one.
    expect((await list('status=all&limit=10')).body.total).toBe(480)
    expect((await list('status=dismissed&since=2026-01-05T00:00:00Z')).body.total).toBe(5)
  })

  it('rejects anything that is not a zoned ISO instant with 400 invalid_since', async () => {
    capture('2026-01-06 10:00:00')
    const bad = ['yesterday', '2026-01-05', '2026-01-05T00:00:00', '2026-13-45T99:00:00Z', "2026-01-05T00:00:00Z' OR 1=1 --", '1767571200', `${'2026-01-05T00:00:00Z'.padEnd(41, '0')}`]
    for (const value of bad) {
      expect(await list(`status=all&since=${encodeURIComponent(value)}`), value).toEqual({
        status: 400, body: { error: 'since must be an ISO 8601 instant with a time zone', code: 'invalid_since' },
      })
    }
    expect((await list('status=all&since=a&since=b')).body.code).toBe('invalid_since')
    expect((await list('status=all&since=')).status).toBe(200)
    expect(parseListCapturesQuery({ since: '2026-01-05T00:00:00+01:00' })).toEqual({ ok: true, value: { status: 'all', limit: 50, offset: 0, since: '2026-01-04T23:00:00.000Z' } })
    expect(parseListCapturesQuery({})).toEqual({ ok: true, value: { status: 'all', limit: 50, offset: 0 } })
  })

  it('core: an unparsable since throws instead of matching everything', () => {
    expect(() => countCaptures(db, '1', { since: 'nope' })).toThrow(RangeError)
  })
})
