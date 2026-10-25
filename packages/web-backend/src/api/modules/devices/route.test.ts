/**
 * /api/status and /api/devices against a real database and a real express
 * app: device token scopes and revocation, user-JWT access, LAN gate, ETag /
 * 304, the status payload (waiting, questions, running, unread, note,
 * privacy), answering through the shared interactions service, and the
 * migration of clock tokens issued before the generalisation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { ingestInteractionMessage, initDatabase, readInteractionAnswers } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createSharedInteractionsService } from '../interactions/route.js'
import { createClockDeviceRouter } from '../clock-device/route.js'
import { ClockDeviceRegistry } from '../clock-device/registry.js'
import { generateAccessToken } from '../../../auth.js'
import { createDevicesRouter, createStatusRouter } from './route.js'
import { DeviceRegistry, hashDeviceToken, parseStoredScopes } from './registry.js'
import { STATUS_NOTE_FILE_MAX, StatusNoteSource, parseStatusNote } from './note.js'
import { deviceClientMessageId, isDeviceAnswerableBlock } from './answer.js'
import { parseDeviceAllowedCidrs, resolveDeviceAllowedCidrs } from './gate.js'

let db: Database
let server: http.Server
let baseUrl: string
let userJwt: string
let otherJwt: string
let dashToken: string
let dashId: string
let turns: Array<{ sessionId: string; text: string }> = []
let tmpDir: string
let noteDir: string

function fence(payload: Record<string, unknown>): string {
  return ['```offtangent', JSON.stringify(payload), '```'].join('\n')
}

const CHOICE = {
  block: 'choice',
  id: 'b1',
  question: 'Welche Variante soll ich für den Bericht über das Wochenende nehmen?',
  options: [
    { id: 'kurz', label: 'Kurzfassung' },
    { id: 'lang', label: 'Lange Fassung mit allen Details' },
  ],
}

function insertSession(id: string, userId = 1, agentId = 'main', title = 'Strand'): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES (?, ?, ?, ?, 'interactive')`,
  ).run(id, userId, agentId, title)
}

function insertBlockMessage(input: { sessionId?: string; userId?: number; payload?: Record<string, unknown>; agentId?: string } = {}): number {
  const content = `Kurze Frage.\n\n${fence(input.payload ?? CHOICE)}`
  const result = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
     VALUES (?, ?, 'assistant', ?, ?, ?)`,
  ).run(input.sessionId ?? 'strand-1', input.userId ?? 1, content, input.agentId ?? 'main', new Date().toISOString().replace('T', ' ').slice(0, 19))
  const messageId = Number(result.lastInsertRowid)
  ingestInteractionMessage(db, {
    messageId,
    strandId: input.sessionId ?? 'strand-1',
    userId: input.userId ?? 1,
    agent: input.agentId ?? 'main',
    content,
  })
  return messageId
}

function insertRunningTask(id: string, name: string, sessionId: string, agentId = 'main'): void {
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, session_id, agent_id, started_at)
     VALUES (?, ?, 'p', 'running', 'user', ?, ?, ?, datetime('now', '-5 minutes'))`,
  ).run(id, name, sessionId, `task-session-${id}`, agentId)
  db.prepare(
    `INSERT INTO sessions (id, user_id, agent_id, title, type, parent_session_id) VALUES (?, ?, ?, 'Task', 'task', ?)`,
  ).run(`task-session-${id}`, null, agentId, sessionId)
}

async function call(
  method: string,
  urlPath: string,
  opts: { token?: string | null; body?: unknown; headers?: Record<string, string>; base?: string } = {},
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) }
  const token = opts.token === undefined ? dashToken : opts.token
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${opts.base ?? baseUrl}${urlPath}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {}, headers: res.headers }
}

function noteFile(userId = 1): string {
  return path.join(noteDir, `note-${userId}.json`)
}

function writeNote(content: unknown, userId = 1): void {
  fs.writeFileSync(noteFile(userId), typeof content === 'string' ? content : JSON.stringify(content))
}

function makeApp(allowedCidrs?: string): express.Express {
  const service = createSharedInteractionsService({
    db,
    getTurnRunner: () => ({ startTurn: (input) => { turns.push({ sessionId: input.sessionId, text: input.text }); return {} } }),
  })
  const app = express()
  app.use(express.json())
  app.use('/api/device/clock', createClockDeviceRouter({ db, getInteractions: () => service, allowedCidrs: allowedCidrs ?? '127.0.0.1/32' }))
  app.use('/api/status', createStatusRouter({ db, getInteractions: () => service, allowedCidrs, noteDir }))
  app.use('/api/devices', createDevicesRouter({ db }))
  return app
}

async function listen(app: express.Express): Promise<{ server: http.Server; base: string }> {
  const s = http.createServer(app)
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
  return { server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-api-'))
  noteDir = path.join(tmpDir, 'status')
  fs.mkdirSync(noteDir)
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
  // Loopback allowed explicitly; the default gate is tested on its own server.
  const started = await listen(makeApp('127.0.0.1/32'))
  server = started.server
  baseUrl = started.base
  userJwt = generateAccessToken({ userId: 1, username: 'alice', role: 'admin' })
  otherJwt = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.prepare('DELETE FROM chat_messages').run()
  // Attention reads the interactions table, not chat_messages.
  db.prepare('DELETE FROM interactions').run()
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM clock_devices').run()
  for (const entry of fs.readdirSync(noteDir)) fs.rmSync(path.join(noteDir, entry), { force: true })
  insertSession('strand-1', 1, 'main', 'Bericht Wochenende')
  turns = []
  const created = new DeviceRegistry(db).create(1, {
    name: 'Offtangent-PI',
    kind: 'dashboard',
    scopes: ['status:read', 'interactions:answer'],
  })
  dashToken = created.token
  dashId = created.device.id
})

describe('device tokens on /api/status', () => {
  it('rejects a missing or unknown token with 401', async () => {
    expect((await call('GET', '/api/status', { token: null })).status).toBe(401)
    expect((await call('GET', '/api/status', { token: 'otd_doesnotexist' })).status).toBe(401)
    expect((await call('GET', '/api/status', { token: 'garbage' })).status).toBe(401)
  })

  it('stores only the hash and uses the otd_ prefix', () => {
    const row = db.prepare('SELECT token_hash, kind FROM clock_devices WHERE id = ?').get(dashId) as { token_hash: string; kind: string }
    expect(row.token_hash).toBe(hashDeviceToken(dashToken))
    expect(row.token_hash).not.toContain(dashToken)
    expect(row.kind).toBe('dashboard')
    expect(dashToken.startsWith('otd_')).toBe(true)
  })

  it('is a 401 the moment the token is revoked', async () => {
    expect((await call('GET', '/api/status')).status).toBe(200)
    expect((await call('DELETE', `/api/devices/${dashId}`, { token: userJwt })).status).toBe(200)
    const after = await call('GET', '/api/status')
    expect(after.status).toBe(401)
    expect(after.json.code).toBe('unauthorized')
    expect((await call('POST', '/api/status/answer', { body: {} })).status).toBe(401)
  })

  it('enforces scopes: no status:read => 403 on GET, no interactions:answer => 403 on answer', async () => {
    db.prepare("UPDATE clock_devices SET scopes = 'interactions:answer' WHERE id = ?").run(dashId)
    const read = await call('GET', '/api/status')
    expect(read.status).toBe(403)
    expect(read.json.code).toBe('forbidden_scope')
    db.prepare("UPDATE clock_devices SET scopes = 'status:read' WHERE id = ?").run(dashId)
    const messageId = insertBlockMessage()
    const answer = await call('POST', '/api/status/answer', { body: { message_id: messageId, block_id: 'b1', value: 'kurz', client_id: 'c1' } })
    expect(answer.status).toBe(403)
    expect(answer.json.code).toBe('forbidden_scope')
    expect(turns).toHaveLength(0)
  })

  it('fails closed on unknown stored scope names', async () => {
    db.prepare("UPDATE clock_devices SET scopes = 'admin:all status:write' WHERE id = ?").run(dashId)
    expect((await call('GET', '/api/status')).status).toBe(403)
    expect(parseStoredScopes('clock:state  bogus interactions:answer')).toEqual(['status:read', 'interactions:answer'])
  })

  it('records last_seen_at', async () => {
    await call('GET', '/api/status')
    const row = db.prepare('SELECT last_seen_at FROM clock_devices WHERE id = ?').get(dashId) as { last_seen_at: string | null }
    expect(row.last_seen_at).not.toBeNull()
  })

  it('keeps a dashboard token out of the clock routes and vice versa only by scope', async () => {
    // A dashboard is not a clock: the clock endpoints stay clock-only.
    expect((await call('GET', '/api/device/clock/state')).status).toBe(401)
    // A clock token is a device token with status:read, so it may poll /api/status.
    const clock = new ClockDeviceRegistry(db).create(1, { name: 'TC002' })
    expect((await call('GET', '/api/status', { token: clock.token })).status).toBe(200)
  })
})

describe('LAN gate on /api/status', () => {
  it('refuses device tokens through a proxy or tunnel with 403 not_lan', async () => {
    for (const header of ['x-forwarded-for', 'cf-ray', 'via', 'forwarded']) {
      const res = await call('GET', '/api/status', { headers: { [header]: '1.2.3.4' } })
      expect(res.status, header).toBe(403)
      expect(res.json.code).toBe('not_lan')
      const answer = await call('POST', '/api/status/answer', { headers: { [header]: '1.2.3.4' }, body: {} })
      expect(answer.status, header).toBe(403)
    }
  })

  it('refuses loopback device tokens under the default allowlist, but a user JWT passes', async () => {
    const prev = { d: process.env.DEVICE_ALLOWED_CIDRS, c: process.env.CLOCK_ALLOWED_CIDRS }
    delete process.env.DEVICE_ALLOWED_CIDRS
    delete process.env.CLOCK_ALLOWED_CIDRS
    const strict = await listen(makeApp(undefined))
    try {
      const device = await call('GET', '/api/status', { base: strict.base })
      expect(device.status).toBe(403)
      expect(device.json.code).toBe('not_lan')
      // The app's own credential works wherever the app reaches the backend,
      // proxy headers included (the tunnel).
      const viaTunnel = await call('GET', '/api/status', { base: strict.base, token: userJwt, headers: { 'cf-ray': 'x' } })
      expect(viaTunnel.status).toBe(200)
      expect(viaTunnel.json.privacy).toBe(false)
    } finally {
      await new Promise<void>(resolve => strict.server.close(() => resolve()))
      if (prev.d !== undefined) process.env.DEVICE_ALLOWED_CIDRS = prev.d
      if (prev.c !== undefined) process.env.CLOCK_ALLOWED_CIDRS = prev.c
    }
  })

  it('fails closed on a set but empty or entirely invalid allowlist; only an unset variable means the defaults', async () => {
    expect(parseDeviceAllowedCidrs(undefined).cidrs.length).toBeGreaterThan(0)
    for (const raw of ['', '   ', 'banana', '192.168.1.0/33, ,10.0.0.0/8/1']) {
      const list = parseDeviceAllowedCidrs(raw)
      expect(list.cidrs, JSON.stringify(raw)).toEqual([])
      expect(list.allows('192.168.1.237'), JSON.stringify(raw)).toBe(false)
    }
    expect(resolveDeviceAllowedCidrs({})).toEqual({ value: undefined, source: 'default' })
    expect(resolveDeviceAllowedCidrs({ DEVICE_ALLOWED_CIDRS: '' })).toEqual({ value: '', source: 'DEVICE_ALLOWED_CIDRS' })
    expect(resolveDeviceAllowedCidrs({ CLOCK_ALLOWED_CIDRS: '' })).toEqual({ value: '', source: 'CLOCK_ALLOWED_CIDRS' })
    expect(resolveDeviceAllowedCidrs({ DEVICE_ALLOWED_CIDRS: '', CLOCK_ALLOWED_CIDRS: '127.0.0.1/32' }).value).toBe('')
    // End to end: loopback would pass with 127.0.0.1/32; empty and junk refuse it.
    const prev = { d: process.env.DEVICE_ALLOWED_CIDRS, c: process.env.CLOCK_ALLOWED_CIDRS }
    try {
      for (const env of [{ d: '' }, { c: '' }, { d: 'banana' }, { c: ' , ' }] as Array<{ d?: string; c?: string }>) {
        delete process.env.DEVICE_ALLOWED_CIDRS
        delete process.env.CLOCK_ALLOWED_CIDRS
        if (env.d !== undefined) process.env.DEVICE_ALLOWED_CIDRS = env.d
        if (env.c !== undefined) process.env.CLOCK_ALLOWED_CIDRS = env.c
        const strict = await listen(makeApp(undefined))
        try {
          const res = await call('GET', '/api/status', { base: strict.base })
          expect(res.status, JSON.stringify(env)).toBe(403)
          expect(res.json.code).toBe('not_lan')
        } finally {
          await new Promise<void>(resolve => strict.server.close(() => resolve()))
        }
      }
      // An explicit empty option is fail closed too.
      const explicit = await listen(makeApp(''))
      try {
        expect((await call('GET', '/api/status', { base: explicit.base })).status).toBe(403)
      } finally {
        await new Promise<void>(resolve => explicit.server.close(() => resolve()))
      }
    } finally {
      if (prev.d === undefined) delete process.env.DEVICE_ALLOWED_CIDRS; else process.env.DEVICE_ALLOWED_CIDRS = prev.d
      if (prev.c === undefined) delete process.env.CLOCK_ALLOWED_CIDRS; else process.env.CLOCK_ALLOWED_CIDRS = prev.c
    }
  })

  it('honours the old CLOCK_ALLOWED_CIDRS name as an alias', async () => {
    const prev = { d: process.env.DEVICE_ALLOWED_CIDRS, c: process.env.CLOCK_ALLOWED_CIDRS }
    delete process.env.DEVICE_ALLOWED_CIDRS
    process.env.CLOCK_ALLOWED_CIDRS = '127.0.0.1/32'
    const aliased = await listen(makeApp(undefined))
    try {
      expect((await call('GET', '/api/status', { base: aliased.base })).status).toBe(200)
      // The new name wins when both are set.
      process.env.DEVICE_ALLOWED_CIDRS = '10.0.0.0/8'
      const both = await listen(makeApp(undefined))
      try {
        expect((await call('GET', '/api/status', { base: both.base })).status).toBe(403)
      } finally {
        await new Promise<void>(resolve => both.server.close(() => resolve()))
      }
    } finally {
      await new Promise<void>(resolve => aliased.server.close(() => resolve()))
      if (prev.d === undefined) delete process.env.DEVICE_ALLOWED_CIDRS; else process.env.DEVICE_ALLOWED_CIDRS = prev.d
      if (prev.c === undefined) delete process.env.CLOCK_ALLOWED_CIDRS; else process.env.CLOCK_ALLOWED_CIDRS = prev.c
    }
  })

  it('rejects an invalid user JWT with 401', async () => {
    // A JWT-shaped string with a bogus signature (assembled so secret scanners do not flag it).
    const forged = ['eyJhbGciOiJIUzI1NiJ9', 'e30', 'bad'].join('.')
    expect((await call('GET', '/api/status', { token: forged })).status).toBe(401)
  })
})

describe('status payload', () => {
  it('is empty and versioned for a quiet user, with rev, generated_at and an ETag', async () => {
    const res = await call('GET', '/api/status')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      v: 2, privacy: false, note: '', note_expires_at: null,
      waiting: [], questions: [], running: [], unread: 0, unread_all: 0,
    })
    expect(String(res.json.rev)).toMatch(/^[0-9a-f]{16}$/)
    expect(Number.isFinite(Date.parse(String(res.json.generated_at)))).toBe(true)
    expect(res.headers.get('etag')).toBe(`"${String(res.json.rev)}"`)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('answers 304 without a body while nothing changed, 200 once something did', async () => {
    const first = await call('GET', '/api/status')
    const etag = first.headers.get('etag')!
    const same = await call('GET', '/api/status', { headers: { 'If-None-Match': etag } })
    expect(same.status).toBe(304)
    expect(same.json).toEqual({})
    // A bare rev (no quotes) is accepted too.
    expect((await call('GET', '/api/status', { headers: { 'If-None-Match': String(first.json.rev) } })).status).toBe(304)
    insertBlockMessage()
    const changed = await call('GET', '/api/status', { headers: { 'If-None-Match': etag } })
    expect(changed.status).toBe(200)
    expect(changed.json.rev).not.toBe(first.json.rev)
  })

  it('lists a waiting strand and its answerable question with options', async () => {
    const messageId = insertBlockMessage()
    const { json } = await call('GET', '/api/status')
    const waiting = json.waiting as Array<Record<string, unknown>>
    const questions = json.questions as Array<Record<string, unknown>>
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ strand_id: 'strand-1', title: 'Bericht Wochenende', persona: 'main', kind: 'interaction' })
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({
      id: `m${messageId}:b1`,
      message_id: messageId,
      block_id: 'b1',
      strand_id: 'strand-1',
      kind: 'choice',
      text: CHOICE.question,
      options: [{ id: 'kurz', label: 'Kurzfassung' }, { id: 'lang', label: 'Lange Fassung mit allen Details' }],
    })
    expect(waiting[0]!.question_id).toBe(questions[0]!.id)
  })

  it('maps a default confirm card to Ja/Nein', async () => {
    insertBlockMessage({ payload: { block: 'confirm', id: 'c1', question: 'Weiter?' } })
    const { json } = await call('GET', '/api/status')
    const q = (json.questions as Array<Record<string, unknown>>)[0]!
    expect(q.kind).toBe('confirm')
    expect((q.options as Array<{ label: string }>).map(o => o.label).sort()).toEqual(['Ja', 'Nein'])
  })

  it('shows destructive, danger and multi cards as waiting, but never as answerable questions', async () => {
    insertSession('s2'); insertSession('s3')
    insertBlockMessage({ payload: { block: 'confirm', id: 'd1', question: 'Alles löschen?', destructive: true } })
    insertBlockMessage({ sessionId: 's2', payload: { block: 'choice', id: 'd2', question: 'Was?', options: [{ id: 'a', label: 'A', style: 'danger' }, { id: 'b', label: 'B' }] } })
    insertBlockMessage({ sessionId: 's3', payload: { block: 'multi', id: 'd3', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } })
    const { json } = await call('GET', '/api/status')
    const waiting = json.waiting as Array<Record<string, unknown>>
    expect(waiting).toHaveLength(3)
    expect(waiting.every(w => w.question_id === null)).toBe(true)
    expect(json.questions).toEqual([])
    expect(JSON.stringify(json)).not.toContain('Alles löschen')
  })

  it('lists running tasks of the user with persona, name and start', async () => {
    insertRunningTask('t1', 'Dashboard bauen', 'strand-1', 'builder')
    insertSession('foreign', 2)
    insertRunningTask('t2', 'Fremder Task', 'foreign')
    const { json } = await call('GET', '/api/status')
    const running = json.running as Array<Record<string, unknown>>
    expect(running).toHaveLength(1)
    expect(running[0]).toMatchObject({ id: 't1', name: 'Dashboard bauen', persona: 'builder' })
    expect(Number.isFinite(Date.parse(String(running[0]!.started_at)))).toBe(true)
  })

  it('filters running tasks by owner before any limit: >200 older foreign tasks do not hide the own ones', async () => {
    insertSession('foreign', 2, 'main', 'Fremd')
    const insertForeign = db.transaction(() => {
      for (let i = 0; i < 250; i++) {
        db.prepare(
          `INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, session_id, agent_id, started_at)
           VALUES (?, ?, 'p', 'running', 'user', 'foreign', ?, 'main', datetime('now', '-2 hours'))`,
        ).run(`f${i}`, `Fremd ${i}`, `task-session-f${i}`)
        db.prepare(
          `INSERT INTO sessions (id, user_id, agent_id, title, type, parent_session_id) VALUES (?, NULL, 'main', 'Task', 'task', 'foreign')`,
        ).run(`task-session-f${i}`)
      }
    })
    insertForeign()
    for (let i = 0; i < 12; i++) insertRunningTask(`own${String(i).padStart(2, '0')}`, `Eigen ${i}`, 'strand-1')
    const { json } = await call('GET', '/api/status')
    const running = json.running as Array<{ id: string; name: string }>
    expect(running).toHaveLength(10)
    expect(running.every(task => task.id.startsWith('own'))).toBe(true)
    expect(JSON.stringify(json)).not.toContain('Fremd')
    const theirs = await call('GET', '/api/status', { token: otherJwt })
    expect((theirs.json.running as Array<{ id: string }>).every(task => task.id.startsWith('f'))).toBe(true)
    expect((theirs.json.running as unknown[]).length).toBe(10)
  })

  it('never shows strands or questions of another user', async () => {
    insertSession('foreign', 2, 'main', 'Geheim')
    insertBlockMessage({ sessionId: 'foreign', userId: 2 })
    const mine = await call('GET', '/api/status')
    expect(mine.json.waiting).toEqual([])
    expect(JSON.stringify(mine.json)).not.toContain('Geheim')
    const theirs = await call('GET', '/api/status', { token: otherJwt })
    expect((theirs.json.waiting as unknown[]).length).toBe(1)
  })

  it('counts unread strands, recent ones separately', async () => {
    insertSession('s-new', 1, 'main', 'Neu')
    insertSession('s-old', 1, 'main', 'Alt')
    db.prepare(`INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
                VALUES ('s-new', 1, 'assistant', 'hallo', 'main', datetime('now', '-1 hour'))`).run()
    db.prepare(`INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
                VALUES ('s-old', 1, 'assistant', 'hallo', 'main', datetime('now', '-30 days'))`).run()
    const { json } = await call('GET', '/api/status')
    expect(json.unread).toBe(1)
    expect(json.unread_all).toBe(2)
  })

  it('strips every text and hides ids in privacy mode, and the opaque ids answer', async () => {
    db.prepare('UPDATE clock_devices SET privacy = 1 WHERE id = ?').run(dashId)
    insertRunningTask('t1', 'Geheimer Task', 'strand-1')
    writeNote({ text: 'Privater Hinweis' })
    const messageId = insertBlockMessage()
    const { json } = await call('GET', '/api/status')
    const text = JSON.stringify(json)
    for (const secret of ['Bericht Wochenende', 'Welche Variante', 'Kurzfassung', 'Geheimer Task', 'Privater Hinweis', '"kurz"', '"b1"']) {
      expect(text, secret).not.toContain(secret)
    }
    const q = (json.questions as Array<{ block_id: string; options: Array<{ id: string }> }>)[0]!
    expect(q.block_id).toBe('~1')
    expect(q.options.map(o => o.id)).toEqual(['~1', '~2'])
    const answer = await call('POST', '/api/status/answer', { body: { message_id: messageId, block_id: '~1', value: '~2', client_id: 'p1' } })
    expect(answer.status).toBe(200)
    const meta = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(messageId) as { metadata: string }
    expect(readInteractionAnswers(meta.metadata).b1?.value).toBe('lang')
  })
})

describe('note from Main', () => {
  it('shows a note from the file, cut to one line, and drops it once expired', async () => {
    writeNote({ text: 'Deploy  läuft,\nbitte **nichts** mergen', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    const shown = await call('GET', '/api/status')
    expect(shown.json.note).toBe('Deploy läuft, bitte nichts mergen')
    expect(shown.json.note_expires_at).not.toBeNull()
    writeNote({ text: 'Alt', expires_at: '2020-01-01T00:00:00Z' })
    expect((await call('GET', '/api/status')).json.note).toBe('')
    fs.rmSync(noteFile())
    expect((await call('GET', '/api/status')).json.note).toBe('')
  })

  it('keeps notes per user: only the owner and the owner\'s device tokens see a note', async () => {
    writeNote({ text: 'Nur für Alice' }, 1)
    writeNote({ text: 'Nur für Other' }, 2)
    const otherDevice = new DeviceRegistry(db).create(2, { name: 'Other-PI', kind: 'dashboard', scopes: ['status:read'] })
    expect((await call('GET', '/api/status', { token: userJwt })).json.note).toBe('Nur für Alice')
    expect((await call('GET', '/api/status')).json.note).toBe('Nur für Alice')
    expect((await call('GET', '/api/status', { token: otherJwt })).json.note).toBe('Nur für Other')
    expect((await call('GET', '/api/status', { token: otherDevice.token })).json.note).toBe('Nur für Other')
    fs.rmSync(noteFile(2))
    const other = await call('GET', '/api/status', { token: otherDevice.token })
    expect(other.json.note).toBe('')
    expect(JSON.stringify(other.json)).not.toContain('Alice')
    expect(JSON.stringify((await call('GET', '/api/status', { token: otherJwt })).json)).not.toContain('Nur für')
  })

  it('never serves the former shared note.json, not even as a fallback', async () => {
    fs.writeFileSync(path.join(noteDir, 'note.json'), JSON.stringify({ text: 'Geteilte Notiz' }))
    for (const token of [userJwt, otherJwt, dashToken]) {
      const res = await call('GET', '/api/status', { token })
      expect(res.json.note).toBe('')
      expect(JSON.stringify(res.json)).not.toContain('Geteilte Notiz')
    }
  })

  it('sees a change with the same mtime and size (content hash) and bumps rev', async () => {
    writeNote({ text: 'Alpha' })
    const pinned = new Date('2026-10-25T10:00:00Z')
    fs.utimesSync(noteFile(), pinned, pinned)
    const first = await call('GET', '/api/status')
    expect(first.json.note).toBe('Alpha')
    writeNote({ text: 'Omega' })
    fs.utimesSync(noteFile(), pinned, pinned)
    const second = await call('GET', '/api/status')
    expect(second.json.note).toBe('Omega')
    expect(second.json.rev).not.toBe(first.json.rev)
  })

  it('ignores a note file larger than 8 KB and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeNote({ text: 'Riesig', pad: 'x'.repeat(STATUS_NOTE_FILE_MAX) })
      for (let i = 0; i < 3; i++) {
        const res = await call('GET', '/api/status')
        expect(res.status).toBe(200)
        expect(res.json.note).toBe('')
      }
      expect(warn.mock.calls.filter(args => String(args[0]).includes('larger than'))).toHaveLength(1)
      // Back under the cap: shown again.
      writeNote({ text: 'Klein' })
      expect((await call('GET', '/api/status')).json.note).toBe('Klein')
    } finally {
      warn.mockRestore()
    }
  })

  it('ignores an unreadable note instead of failing the status', async () => {
    writeNote('{ not json')
    const res = await call('GET', '/api/status')
    expect(res.status).toBe(200)
    expect(res.json.note).toBe('')
  })

  it('validates the file shape', () => {
    expect(parseStatusNote('{"text":"  "}')).toBeNull()
    expect(() => parseStatusNote('[]')).toThrow()
    expect(() => parseStatusNote('{"text":1}')).toThrow()
    expect(() => parseStatusNote('{"text":"x","expires_at":"bald"}')).toThrow()
    expect(parseStatusNote(JSON.stringify({ text: 'x'.repeat(500) }))!.text.length).toBe(160)
    // A missing file is simply no note.
    const source = new StatusNoteSource(path.join(tmpDir, 'missing'))
    expect(source.read(1)).toBeNull()
    expect(() => source.read(0)).toThrow()
  })
})

describe('POST /api/status/answer', () => {
  it('answers through the shared service, once, idempotent per client_id', async () => {
    const messageId = insertBlockMessage()
    const body = { message_id: messageId, block_id: 'b1', value: 'lang', client_id: 'k1' }
    const first = await call('POST', '/api/status/answer', { body })
    expect(first.status).toBe(200)
    expect(first.json).toEqual({ applied: true, idempotent: false })
    expect(turns).toHaveLength(1)
    expect(turns[0]!.sessionId).toBe('strand-1')
    const retry = await call('POST', '/api/status/answer', { body })
    expect(retry.status).toBe(200)
    expect(retry.json.idempotent).toBe(true)
    expect(turns).toHaveLength(1)
    const meta = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(messageId) as { metadata: string }
    expect(readInteractionAnswers(meta.metadata).b1?.value).toBe('lang')
    expect((await call('GET', '/api/status')).json.questions).toEqual([])
    // Another client id after the answer is a conflict, not a second answer.
    const late = await call('POST', '/api/status/answer', { body: { ...body, client_id: 'k2' } })
    expect(late.status).toBe(409)
  })

  it('hashes the full idempotency key: two client ids with the same 64-char prefix are two different answers', async () => {
    const prefix = 'c'.repeat(63)
    const a = deviceClientMessageId('device', dashId, `${prefix}A`)
    const b = deviceClientMessageId('device', dashId, `${prefix}B`)
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(deviceClientMessageId('device', dashId, `${prefix}A`)).toBe(a)
    expect(deviceClientMessageId('clock', dashId, `${prefix}A`)).not.toBe(a)
    // End to end: the first answer applies, the second (other client id, same
    // prefix) is a conflict and not an idempotent replay of the first.
    const messageId = insertBlockMessage()
    const body = { message_id: messageId, block_id: 'b1', value: 'lang', client_id: `${prefix}A` }
    expect((await call('POST', '/api/status/answer', { body })).json).toEqual({ applied: true, idempotent: false })
    const second = await call('POST', '/api/status/answer', { body: { ...body, value: 'kurz', client_id: `${prefix}B` } })
    expect(second.status).toBe(409)
    expect(second.json.idempotent).not.toBe(true)
    const replay = await call('POST', '/api/status/answer', { body })
    expect(replay.json.idempotent).toBe(true)
    expect(turns).toHaveLength(1)
  })

  it('refuses destructive, danger and multi cards with 403 not_allowed', async () => {
    insertSession('s2'); insertSession('s3')
    const destructive = insertBlockMessage({ payload: { block: 'confirm', id: 'd1', question: 'Alles löschen?', destructive: true } })
    const danger = insertBlockMessage({ sessionId: 's2', payload: { block: 'choice', id: 'd2', question: 'Was?', options: [{ id: 'a', label: 'A', style: 'danger' }, { id: 'b', label: 'B' }] } })
    const multi = insertBlockMessage({ sessionId: 's3', payload: { block: 'multi', id: 'd3', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } })
    for (const [messageId, blockId, value] of [[destructive, 'd1', 'yes'], [danger, 'd2', 'b'], [multi, 'd3', 'a']] as const) {
      const res = await call('POST', '/api/status/answer', { body: { message_id: messageId, block_id: blockId, value, client_id: `x-${blockId}` } })
      expect(res.status, blockId).toBe(403)
      expect(res.json.code).toBe('not_allowed')
    }
    expect(turns).toHaveLength(0)
  })

  it('refuses foreign messages, unknown blocks and malformed bodies', async () => {
    insertSession('foreign', 2)
    const foreign = insertBlockMessage({ sessionId: 'foreign', userId: 2 })
    expect((await call('POST', '/api/status/answer', { body: { message_id: foreign, block_id: 'b1', value: 'kurz', client_id: 'f' } })).status).toBe(404)
    const own = insertBlockMessage()
    expect((await call('POST', '/api/status/answer', { body: { message_id: own, block_id: 'nope', value: 'kurz', client_id: 'f' } })).status).toBe(404)
    expect((await call('POST', '/api/status/answer', { body: { message_id: own, block_id: 'b1', value: 'kurz' } })).status).toBe(400)
    expect((await call('POST', '/api/status/answer', { body: { message_id: own, block_id: 'b1', value: 'erfunden', client_id: 'u' } })).status).toBe(400)
  })

  it('does not take a user JWT (answers from the app go through /api/interactions)', async () => {
    const messageId = insertBlockMessage()
    const res = await call('POST', '/api/status/answer', { token: userJwt, body: { message_id: messageId, block_id: 'b1', value: 'kurz', client_id: 'j' } })
    expect(res.status).toBe(401)
  })

  it('keeps the shared answer rule identical to the clock rule', () => {
    expect(isDeviceAnswerableBlock({ kind: 'choice', id: 'x', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } as never)).toBe(true)
    expect(isDeviceAnswerableBlock({ kind: 'confirm', id: 'x', question: 'q', destructive: true, options: [{ id: 'yes', label: 'Ja' }, { id: 'no', label: 'Nein' }] } as never)).toBe(false)
  })
})

describe('/api/devices (owner)', () => {
  it('creates a dashboard token once, lists every kind without secrets', async () => {
    new ClockDeviceRegistry(db).create(1, { name: 'TC002' })
    const created = await call('POST', '/api/devices', { token: userJwt, body: { name: 'Offtangent-PI 2' } })
    expect(created.status).toBe(201)
    expect(String(created.json.token)).toMatch(/^otd_/)
    expect(created.json.device).toMatchObject({ kind: 'dashboard', scopes: ['status:read', 'interactions:answer'], privacy: false })
    const list = await call('GET', '/api/devices', { token: userJwt })
    const text = JSON.stringify(list.json)
    expect(text).not.toContain(String(created.json.token))
    expect(text).not.toContain(dashToken)
    expect(text).not.toContain('token_hash')
    const kinds = (list.json.devices as Array<{ kind: string; scopes: string[] }>).map(d => d.kind).sort()
    expect(kinds).toEqual(['clock', 'dashboard', 'dashboard'])
    // Clocks show their canonical scopes here.
    const clock = (list.json.devices as Array<{ kind: string; scopes: string[] }>).find(d => d.kind === 'clock')!
    expect(clock.scopes).toEqual(['status:read', 'interactions:answer'])
  })

  it('validates kind, name, scopes and privacy', async () => {
    expect((await call('POST', '/api/devices', { token: userJwt, body: { kind: 'toaster' } })).status).toBe(400)
    expect((await call('POST', '/api/devices', { token: userJwt, body: { name: 'x'.repeat(41) } })).status).toBe(400)
    expect((await call('POST', '/api/devices', { token: userJwt, body: { scopes: ['admin'] } })).status).toBe(400)
    expect((await call('POST', '/api/devices', { token: userJwt, body: { scopes: [] } })).status).toBe(400)
    expect((await call('POST', '/api/devices', { token: userJwt, body: { privacy: 'ja' } })).status).toBe(400)
    const generic = await call('POST', '/api/devices', { token: userJwt, body: { kind: 'generic', name: 'Knopf' } })
    expect(generic.json.device).toMatchObject({ kind: 'generic', scopes: ['status:read'] })
  })

  it('changes scopes and privacy, refuses foreign and device callers', async () => {
    const patched = await call('PATCH', `/api/devices/${dashId}`, { token: userJwt, body: { scopes: ['status:read'], privacy: true } })
    expect(patched.status).toBe(200)
    expect(patched.json.device).toMatchObject({ scopes: ['status:read'], privacy: true })
    expect((await call('PATCH', `/api/devices/${dashId}`, { token: userJwt, body: {} })).status).toBe(400)
    expect((await call('PATCH', `/api/devices/${dashId}`, { token: otherJwt, body: { privacy: false } })).status).toBe(404)
    expect((await call('DELETE', `/api/devices/${dashId}`, { token: otherJwt })).status).toBe(404)
    // A device token is not an owner credential.
    expect((await call('GET', '/api/devices')).status).toBe(401)
    expect((await call('DELETE', `/api/devices/${dashId}`)).status).toBe(401)
    expect((await call('GET', '/api/status')).json.privacy).toBe(true)
  })
})

describe('migration of clock tokens issued before the generalisation', () => {
  it('adds the kind column to an old clock_devices table and keeps old tokens working everywhere', async () => {
    const file = path.join(tmpDir, `legacy-${Date.now()}.db`)
    const token = 'otc_legacy-token-from-the-first-clock-build'
    // The table exactly as the first clock build created it (no `kind`).
    const BetterSqlite = (await import('better-sqlite3')).default
    const raw = new BetterSqlite(file)
    raw.exec(`
      CREATE TABLE clock_devices (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'clock:state clock:answer',
        privacy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT, revoked_at TEXT
      );
    `)
    raw.prepare('INSERT INTO clock_devices (id, user_id, name, token_hash) VALUES (?, 1, ?, ?)').run('clk_legacy', 'TC002', hashDeviceToken(token))
    raw.close()

    const migrated = initDatabase(file)
    try {
      const row = migrated.prepare('SELECT kind, scopes, token_hash FROM clock_devices WHERE id = ?').get('clk_legacy') as { kind: string; scopes: string; token_hash: string }
      // Additive: kind defaults to clock, scopes and hash stay as stored.
      expect(row).toEqual({ kind: 'clock', scopes: 'clock:state clock:answer', token_hash: hashDeviceToken(token) })
      const device = new DeviceRegistry(migrated).verify(token)
      expect(device).toMatchObject({ id: 'clk_legacy', kind: 'clock', scopes: ['status:read', 'interactions:answer'] })
      // The clock wrapper still reports the clock scope names.
      expect(new ClockDeviceRegistry(migrated).verify(token)!.scopes).toEqual(['clock:state', 'clock:answer'])
      // Running the migration twice is a no-op.
      migrated.close()
      const again = initDatabase(file)
      expect((again.prepare('SELECT COUNT(*) AS n FROM clock_devices').get() as { n: number }).n).toBe(1)
      again.close()
    } finally {
      try { migrated.close() } catch { /* already closed */ }
      fs.rmSync(file, { force: true })
      for (const suffix of ['-wal', '-shm']) fs.rmSync(file + suffix, { force: true })
    }
  })

  it('serves a legacy-scoped clock on /api/status and /api/status/answer', async () => {
    const clock = new ClockDeviceRegistry(db).create(1, { name: 'TC002' })
    const stored = db.prepare('SELECT scopes FROM clock_devices WHERE id = ?').get(clock.device.id) as { scopes: string }
    expect(stored.scopes).toBe('clock:state clock:answer')
    const messageId = insertBlockMessage()
    expect((await call('GET', '/api/status', { token: clock.token })).status).toBe(200)
    const res = await call('POST', '/api/status/answer', { token: clock.token, body: { message_id: messageId, block_id: 'b1', value: 'kurz', client_id: 'l1' } })
    expect(res.status).toBe(200)
  })
})
