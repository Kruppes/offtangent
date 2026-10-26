/**
 * On-demand detail endpoints for status devices (Pi dashboard v2):
 * GET /api/status/task/:id, /strand/:id, /tokens against a real database and
 * express app. Covers ownership (404 for foreign ids), scopes, the LAN gate,
 * privacy blanking, "unknown is null", subtasks and the Berlin day split.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createSharedInteractionsService } from '../interactions/route.js'
import { generateAccessToken } from '../../../auth.js'
import { createStatusRouter } from './route.js'
import { DeviceRegistry } from './registry.js'
import { berlinDayOf, buildTokensReport } from './details.js'

let db: Database
let server: http.Server
let baseUrl: string
let tmpDir: string
let readToken: string
let answerOnlyToken: string
let privacyToken: string
let otherToken: string
let userJwt: string

function makeApp(allowedCidrs?: string): express.Express {
  const service = createSharedInteractionsService({ db, getTurnRunner: () => ({ startTurn: () => ({}) }) })
  const app = express()
  app.use(express.json())
  app.use('/api/status', createStatusRouter({ db, getInteractions: () => service, allowedCidrs, noteDir: tmpDir }))
  return app
}

async function listen(app: express.Express): Promise<{ server: http.Server; base: string }> {
  const s = http.createServer(app)
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
  return { server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` }
}

async function get(urlPath: string, token: string | null, base = baseUrl): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${base}${urlPath}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : {} }
}

function strand(id: string, userId: number, title = 'Strand'): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, agent_id, title, type, prompt_tokens, completion_tokens, cache_read, cache_write)
     VALUES (?, ?, 'main', ?, 'interactive', 100, 20, 3000, 50)`,
  ).run(id, userId, title)
}

function task(id: string, input: { parent: string; status?: string; started?: boolean; name?: string; budget?: number | null; result?: string | null; tokens?: [number, number, number, number] }): void {
  const [p, c, cr, cw] = input.tokens ?? [10, 5, 1000, 0]
  const fromStrand = input.parent.startsWith('s-')
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, session_id, agent_id, model,
                        max_duration_minutes, prompt_tokens, completion_tokens, cache_read, cache_write, tool_call_count,
                        result_summary, started_at)
     VALUES (?, ?, 'secret prompt text', ?, 'agent', ?, ?, 'bob', 'claude-x', ?, ?, ?, ?, ?, 7, ?, ${input.started === false ? 'NULL' : "datetime('now', '-30 minutes')"})`,
  ).run(id, input.name ?? `Task ${id}`, input.status ?? 'running', fromStrand ? null : input.parent, `ts-${id}`, input.budget === undefined ? 60 : input.budget,
    p, c, cr, cw, input.result ?? null)
  // Like production: a top-level task's session hangs under the strand
  // (parent_session_id); a subtask names its parent TASK in trigger_source_id.
  db.prepare(`INSERT INTO sessions (id, user_id, agent_id, title, type, parent_session_id) VALUES (?, NULL, 'bob', 'T', 'task', ?)`)
    .run(`ts-${id}`, fromStrand ? input.parent : null)
}

function usage(sessionId: string, timestamp: string, p: number, c: number, cr: number, cw: number): void {
  db.prepare(
    `INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, cache_read, cache_write, session_id)
     VALUES (?, 'anthropic', 'm', ?, ?, ?, ?, ?)`,
  ).run(timestamp, p, c, cr, cw, sessionId)
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-detail-'))
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (2, ?, ?, ?)').run('other', 'x', 'user')
  const started = await listen(makeApp('127.0.0.1/32'))
  server = started.server
  baseUrl = started.base
  userJwt = generateAccessToken({ userId: 1, username: 'alice', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const table of ['token_usage', 'tasks', 'session_summaries', 'sessions', 'clock_devices']) db.prepare(`DELETE FROM ${table}`).run()
  const registry = new DeviceRegistry(db)
  readToken = registry.create(1, { name: 'Pi', kind: 'dashboard', scopes: ['status:read', 'interactions:answer'] }).token
  answerOnlyToken = registry.create(1, { name: 'A', kind: 'dashboard', scopes: ['interactions:answer'] }).token
  privacyToken = registry.create(1, { name: 'P', kind: 'dashboard', scopes: ['status:read'], privacy: true }).token
  otherToken = registry.create(2, { name: 'O', kind: 'dashboard', scopes: ['status:read'] }).token
  strand('s-own', 1, 'Pi Dashboard')
  strand('s-foreign', 2, 'Fremd')
})

describe('GET /api/status/task/:id', () => {
  it('returns runtime, budget, tokens, subtasks and never a progress value', async () => {
    task('t-root', { parent: 's-own', tokens: [100, 50, 9000, 10] })
    task('t-sub1', { parent: 't-root', status: 'completed', tokens: [1, 2, 3, 4] })
    task('t-sub2', { parent: 't-root', tokens: [10, 20, 30, 40] })
    task('t-subsub', { parent: 't-sub2', tokens: [1, 1, 1, 1] })
    const { status, json } = await get('/api/status/task/t-root', readToken)
    expect(status).toBe(200)
    expect(json.kind).toBe('task')
    expect(json.name).toBe('Task t-root')
    expect(json.progress).toBeNull()
    expect(json.progress_basis).toBe('none')
    expect(json.runtime_s).toBeGreaterThanOrEqual(30 * 60 - 5)
    expect(json.budget_minutes).toBe(60)
    expect(json.budget_used).toBeCloseTo(0.5, 1)
    expect(json.tokens).toEqual({ input: 100, output: 50, cache_read: 9000, cache_write: 10, total: 9160 })
    expect(json.tokens_with_subtasks.total).toBe(9160 + 10 + 100 + 4)
    expect(json.subtasks_total).toBe(2)
    expect(json.subtasks_running).toBe(1)
    expect(json.subtasks.map((s: any) => s.id)).toEqual(['t-sub1', 't-sub2'])
    expect(json.summary).toBeNull()
    expect(JSON.stringify(json)).not.toContain('secret prompt text')
  })

  it('unknown stays null: no start, no budget', async () => {
    task('t-queued', { parent: 's-own', started: false, budget: null })
    const { json } = await get('/api/status/task/t-queued', readToken)
    expect(json.runtime_s).toBeNull()
    expect(json.budget_minutes).toBeNull()
    expect(json.budget_used).toBeNull()
    expect(json.tokens).toBeNull()
    expect(json.tool_calls).toBeNull()
  })

  it('a finished task carries its result summary', async () => {
    task('t-done', { parent: 's-own', status: 'completed', result: 'Alles **fertig**' })
    const { json } = await get('/api/status/task/t-done', readToken)
    expect(json.summary).toBe('Alles fertig')
    expect(json.summary_source).toBe('result')
  })

  it('404 for a foreign task and for an unknown id, same body', async () => {
    task('t-foreign', { parent: 's-foreign' })
    const foreign = await get('/api/status/task/t-foreign', readToken)
    const unknown = await get('/api/status/task/t-nothere', readToken)
    expect(foreign.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(foreign.json).toEqual(unknown.json)
    // The owner sees it.
    expect((await get('/api/status/task/t-foreign', otherToken)).status).toBe(200)
  })

  it('rejects malformed ids', async () => {
    expect((await get('/api/status/task/a%20b', readToken)).status).toBe(404)
    expect((await get(`/api/status/task/${'x'.repeat(100)}`, readToken)).status).toBe(404)
  })

  it('privacy mode blanks texts and model', async () => {
    task('t-p', { parent: 's-own', status: 'completed', result: 'Geheim' })
    task('t-p-sub', { parent: 't-p' })
    const { json } = await get('/api/status/task/t-p', privacyToken)
    expect(json.privacy).toBe(true)
    expect(json.name).toBe('')
    expect(json.model).toBeNull()
    expect(json.summary).toBeNull()
    expect(json.subtasks[0].name).toBe('')
    expect(JSON.stringify(json)).not.toContain('Geheim')
  })
})

describe('GET /api/status/strand/:id', () => {
  it('returns the newest summary, tokens and running tasks', async () => {
    db.prepare(`INSERT INTO session_summaries (session_id, version, schema_json) VALUES ('s-own', 1, ?)`).run(JSON.stringify({ goal: 'Alt' }))
    db.prepare(`INSERT INTO session_summaries (session_id, version, schema_json) VALUES ('s-own', 2, ?)`).run(JSON.stringify({ goal: 'Dashboard bauen', open: ['Review', 7, 'Deploy'], next: ['Screens'] }))
    task('t-run', { parent: 's-own' })
    const { status, json } = await get('/api/status/strand/s-own', readToken)
    expect(status).toBe(200)
    expect(json.goal).toBe('Dashboard bauen')
    expect(json.open).toEqual(['Review', 'Deploy'])
    expect(json.next).toEqual(['Screens'])
    expect(json.tokens.total).toBe(3170)
    expect(json.running_tasks.map((t: any) => t.id)).toEqual(['t-run'])
  })

  it('no summary yet is null, broken summary is null', async () => {
    expect((await get('/api/status/strand/s-own', readToken)).json.goal).toBeNull()
    db.prepare(`INSERT INTO session_summaries (session_id, version, schema_json) VALUES ('s-own', 1, '{broken')`).run()
    const { status, json } = await get('/api/status/strand/s-own', readToken)
    expect(status).toBe(200)
    expect(json.goal).toBeNull()
  })

  it('404 for a foreign strand', async () => {
    expect((await get('/api/status/strand/s-foreign', readToken)).status).toBe(404)
  })

  it('owner from session_user (SessionManager rows), fail closed on conflicting owners', async () => {
    db.prepare(`INSERT INTO sessions (id, user_id, session_user, title, type) VALUES ('s-su', NULL, '1', 'SU', 'interactive')`).run()
    db.prepare(`INSERT INTO sessions (id, user_id, session_user, title, type) VALUES ('s-conflict', 1, '2', 'C', 'interactive')`).run()
    expect((await get('/api/status/strand/s-su', readToken)).status).toBe(200)
    expect((await get('/api/status/strand/s-conflict', readToken)).status).toBe(404)
    expect((await get('/api/status/strand/s-conflict', otherToken)).status).toBe(404)
  })

  it('privacy mode hides title and summary', async () => {
    db.prepare(`INSERT INTO session_summaries (session_id, version, schema_json) VALUES ('s-own', 1, ?)`).run(JSON.stringify({ goal: 'Geheim' }))
    const { json } = await get('/api/status/strand/s-own', privacyToken)
    expect(json.title).toBe('')
    expect(json.goal).toBeNull()
    expect(JSON.stringify(json)).not.toContain('Geheim')
  })
})

describe('GET /api/status/tokens', () => {
  it('sums own strands and own tasks per Berlin day, excludes foreign and system sessions', async () => {
    task('t-own', { parent: 's-own' })
    task('t-other', { parent: 's-foreign' })
    db.prepare(`INSERT INTO sessions (id, user_id, type) VALUES ('hb', NULL, 'heartbeat')`).run()
    const now = Date.now()
    const ts = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
    usage('s-own', ts(now - 60_000), 10, 1, 100, 5)
    usage('ts-t-own', ts(now - 60_000), 20, 2, 200, 0)
    usage('s-foreign', ts(now - 60_000), 999, 999, 999, 999)
    usage('ts-t-other', ts(now - 60_000), 777, 777, 777, 777)
    usage('hb', ts(now - 60_000), 555, 555, 555, 555)
    usage('s-own', ts(now - 10 * 86_400_000), 4444, 4444, 4444, 4444)
    const { status, json } = await get('/api/status/tokens', readToken)
    expect(status).toBe(200)
    expect(json.timezone).toBe('Europe/Berlin')
    expect(json.counting).toContain('cache_read')
    expect(json.days).toHaveLength(7)
    const today = json.days[6]
    expect(today.day).toBe(berlinDayOf(now))
    expect(today).toMatchObject({ input: 30, output: 3, cache_read: 300, cache_write: 5, total: 338 })
    expect(json.total.total).toBe(338)
    // The foreign user sees only its own.
    const other = await get('/api/status/tokens', otherToken)
    expect(other.json.total.total).toBe(999 * 4 + 777 * 4)
  })

  it('splits days at Berlin midnight, not UTC midnight (CEST and CET)', () => {
    task('t-own', { parent: 's-own' })
    // 2026-07-01 22:30 UTC is 2026-07-02 00:30 in Berlin (CEST, UTC+2).
    usage('s-own', '2026-07-01 22:30:00', 1, 0, 0, 0)
    // 2026-07-01 21:30 UTC is 2026-07-01 23:30 in Berlin.
    usage('s-own', '2026-07-01 21:30:00', 10, 0, 0, 0)
    // Winter: 2026-01-10 23:30 UTC is 2026-01-11 00:30 (CET, UTC+1).
    usage('s-own', '2026-01-10 23:30:00', 100, 0, 0, 0)
    const summer = buildTokensReport(db, { userId: 1, now: Date.parse('2026-07-03T10:00:00Z') })
    const byDay = Object.fromEntries(summer.days.map(d => [d.day, d.input]))
    expect(byDay['2026-07-02']).toBe(1)
    expect(byDay['2026-07-01']).toBe(10)
    expect(summer.days.map(d => d.day)).toEqual(['2026-06-27', '2026-06-28', '2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03'])
    const winter = buildTokensReport(db, { userId: 1, now: Date.parse('2026-01-12T10:00:00Z') })
    expect(Object.fromEntries(winter.days.map(d => [d.day, d.input]))['2026-01-11']).toBe(100)
  })

  it('seven distinct days across the DST switch', () => {
    const report = buildTokensReport(db, { userId: 1, now: Date.parse('2026-10-26T00:30:00Z') })
    expect(report.days.map(d => d.day)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'])
    const spring = buildTokensReport(db, { userId: 1, now: Date.parse('2026-03-29T22:30:00Z') })
    expect(new Set(spring.days.map(d => d.day)).size).toBe(7)
    expect(spring.days[6].day).toBe('2026-03-30')
  })
})

describe('auth on the detail endpoints', () => {
  it('needs status:read; answer-only tokens and no token are refused', async () => {
    for (const p of ['/api/status/tokens', '/api/status/strand/s-own']) {
      expect((await get(p, null)).status).toBe(401)
      expect((await get(p, answerOnlyToken)).status).toBe(403)
      expect((await get(p, 'otd_unknown')).status).toBe(401)
    }
  })

  it('accepts a user JWT', async () => {
    expect((await get('/api/status/strand/s-own', userJwt)).status).toBe(200)
  })

  it('device tokens only from the LAN allowlist', async () => {
    const strict = await listen(makeApp('10.0.0.0/8'))
    try {
      expect((await get('/api/status/tokens', readToken, strict.base)).status).toBe(403)
    } finally {
      await new Promise<void>(resolve => strict.server.close(() => resolve()))
    }
  })
})
