/**
 * /api/device/clock against a real database and a real express app: token
 * scope and revocation, LAN-only gate, the reduced state (lengths, privacy,
 * eligibility filter, ownership) and answering through the shared
 * interactions service.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { initDatabase, readInteractionAnswers } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createSharedInteractionsService } from '../interactions/route.js'
import { CLOCK_DEFAULT_ALLOWED_CIDRS, FORWARDING_HEADERS, createClockDeviceRouter, isLanAddress, parseClockAllowedCidrs, parseClockAnswerBody } from './route.js'
import { ClockDeviceRegistry } from './registry.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let userJwt: string
let otherJwt: string
let clockToken: string
let clockId: string
let turns: Array<{ sessionId: string; text: string }> = []

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
    { id: 'none', label: 'Gar keine' },
  ],
}

function insertSession(id: string, userId = 1, agentId = 'main'): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES (?, ?, ?, 'Strand', 'interactive')`,
  ).run(id, userId, agentId)
}

function insertBlockMessage(input: { sessionId?: string; userId?: number; payload?: Record<string, unknown>; agentId?: string; at?: string } = {}): number {
  const result = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
     VALUES (?, ?, 'assistant', ?, ?, ?)`,
  ).run(
    input.sessionId ?? 'strand-1',
    input.userId ?? 1,
    `Kurze Frage.\n\n${fence(input.payload ?? CHOICE)}`,
    input.agentId ?? 'main',
    input.at ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
  )
  return Number(result.lastInsertRowid)
}

function insertTask(input: { id: string; name: string; status: string; sessionId: string; agentId?: string; resultStatus?: string | null; completedAgoSec?: number }): void {
  const completedAt = input.completedAgoSec === undefined
    ? null
    : new Date(Date.now() - input.completedAgoSec * 1000).toISOString().replace('T', ' ').slice(0, 19)
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, session_id, agent_id, result_status, completed_at)
     VALUES (?, ?, 'p', ?, 'user', ?, ?, ?, ?, ?)`,
  ).run(input.id, input.name, input.status, input.sessionId, `task-session-${input.id}`, input.agentId ?? 'main', input.resultStatus ?? null, completedAt)
  db.prepare(
    `INSERT INTO sessions (id, user_id, agent_id, title, type, parent_session_id) VALUES (?, ?, ?, 'Task', 'task', ?)`,
  ).run(`task-session-${input.id}`, null, input.agentId ?? 'main', input.sessionId)
}

async function call(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) }
  const token = opts.token === undefined ? clockToken : opts.token
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${baseUrl}/api/device/clock${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> }
}

beforeAll(async () => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
  const service = createSharedInteractionsService({
    db,
    getTurnRunner: () => ({ startTurn: (input) => { turns.push({ sessionId: input.sessionId, text: input.text }); return {} } }),
  })
  const app = express()
  app.use(express.json())
  // Loopback is NOT allowed by default (a same-host tunnel connects from
  // there); the test server allows it explicitly, like CLOCK_ALLOWED_CIDRS
  // would. The default gate is tested on its own server below.
  app.use('/api/device/clock', createClockDeviceRouter({ db, getInteractions: () => service, allowedCidrs: '127.0.0.1/32' }))
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  userJwt = generateAccessToken({ userId: 1, username: 'alice', role: 'admin' })
  otherJwt = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
})

beforeEach(() => {
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM clock_devices').run()
  insertSession('strand-1')
  turns = []
  const created = new ClockDeviceRegistry(db).create(1, { name: 'TC002' })
  clockToken = created.token
  clockId = created.device.id
})

describe('clock token', () => {
  it('rejects a missing, foreign-format or unknown token with 401', async () => {
    expect((await call('GET', '/state', { token: null })).status).toBe(401)
    expect((await call('GET', '/state', { token: userJwt })).status).toBe(401)
    expect((await call('GET', '/state', { token: 'otc_doesnotexist' })).status).toBe(401)
  })

  it('stores only the hash, never the token', () => {
    const row = db.prepare('SELECT token_hash FROM clock_devices WHERE id = ?').get(clockId) as { token_hash: string }
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.token_hash).not.toContain(clockToken)
    expect(clockToken.startsWith('otc_')).toBe(true)
  })

  it('stops working the moment it is revoked', async () => {
    expect((await call('GET', '/state')).status).toBe(200)
    const revoke = await call('DELETE', `/devices/${clockId}`, { token: userJwt })
    expect(revoke.status).toBe(200)
    expect((await call('GET', '/state')).status).toBe(401)
    // Revoking twice is a 404, not a silent success.
    expect((await call('DELETE', `/devices/${clockId}`, { token: userJwt })).status).toBe(404)
  })

  it('cannot be used for the owner routes, and a user cannot revoke a foreign clock', async () => {
    expect((await call('GET', '/devices')).status).toBe(401)
    expect((await call('DELETE', `/devices/${clockId}`, { token: otherJwt })).status).toBe(404)
    expect((await call('GET', '/state')).status).toBe(200)
  })

  it('enforces scopes: a state-only token may not answer', async () => {
    db.prepare("UPDATE clock_devices SET scopes = 'clock:state' WHERE id = ?").run(clockId)
    const messageId = insertBlockMessage()
    const res = await call('POST', '/answer', { body: { message_id: messageId, block_id: 'b1', value: 'kurz', client_id: 'c1' } })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('forbidden_scope')
  })

  it('dies with its user: deleting the user removes the device rows', async () => {
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(3, 'gone', 'x', 'user')
    const created = new ClockDeviceRegistry(db).create(3, { name: 'Alt' })
    expect((await call('GET', '/state', { token: created.token })).status).toBe(200)
    db.prepare('DELETE FROM users WHERE id = ?').run(3)
    expect(db.prepare('SELECT COUNT(*) AS n FROM clock_devices WHERE user_id = 3').get()).toEqual({ n: 0 })
    expect((await call('GET', '/state', { token: created.token })).status).toBe(401)
    // The other user's clock is untouched.
    expect((await call('GET', '/state')).status).toBe(200)
  })

  it('shows the token once at creation and lists devices without it', async () => {
    const created = await call('POST', '/devices', { token: userJwt, body: { name: 'Küche', privacy: true } })
    expect(created.status).toBe(201)
    expect(String(created.json.token)).toMatch(/^otc_/)
    const list = await call('GET', '/devices', { token: userJwt })
    const text = JSON.stringify(list.json)
    expect(text).not.toContain(String(created.json.token))
    expect(text).not.toContain('token_hash')
    expect((list.json.devices as unknown[]).length).toBe(2)
  })
})

describe('LAN gate', () => {
  it('classifies addresses', () => {
    for (const ok of ['192.168.1.202', '10.0.0.5', '172.16.1.1', '172.31.255.1', '::ffff:192.168.1.4', 'fd12:3456::1', 'fe80::1']) {
      expect(isLanAddress(ok), ok).toBe(true)
    }
    // Loopback is not LAN: a tunnel on the same host connects from there.
    for (const bad of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2a01:4f8::1', '::ffff:1.1.1.1', '', undefined]) {
      expect(isLanAddress(bad), String(bad)).toBe(false)
    }
  })

  it('refuses requests that came through a proxy or tunnel', async () => {
    for (const header of ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip']) {
      const res = await call('GET', '/state', { headers: { [header]: '192.168.1.202' } })
      expect(res.status, header).toBe(403)
      expect(res.json.code).toBe('not_lan')
    }
  })

  it('refuses the headers a tunnel sets even with the visitor IP headers stripped', async () => {
    // Allowed peer (127.0.0.1 on the test server), but Cloudflare/Caddy marks.
    for (const header of ['cf-ray', 'cdn-loop', 'via', 'x-forwarded-proto', 'x-forwarded-host', 'cf-visitor', 'cf-ipcountry', 'x-forwarded-server', 'true-client-ip']) {
      expect(FORWARDING_HEADERS, header).toContain(header)
      const res = await call('GET', '/state', { headers: { [header]: 'x' } })
      expect(res.status, header).toBe(403)
      expect(res.json.code, header).toBe('not_lan')
    }
  })

  it('refuses loopback without any header under the default allowlist', async () => {
    // The bypass from the review: a same-host tunnel that sends no forwarding
    // header at all. Without CLOCK_ALLOWED_CIDRS listing loopback, 403.
    const saved = process.env.CLOCK_ALLOWED_CIDRS
    delete process.env.CLOCK_ALLOWED_CIDRS
    const app = express()
    app.use(express.json())
    app.use('/api/device/clock', createClockDeviceRouter({ db, getInteractions: () => { throw new Error('unused') } }))
    const plain = http.createServer(app)
    try {
      await new Promise<void>(resolve => plain.listen(0, '127.0.0.1', resolve))
      const port = (plain.address() as { port: number }).port
      const res = await fetch(`http://127.0.0.1:${port}/api/device/clock/state`, { headers: { Authorization: `Bearer ${clockToken}` } })
      expect(res.status).toBe(403)
      expect((await res.json() as { code: string }).code).toBe('not_lan')
    } finally {
      await new Promise<void>(resolve => plain.close(() => resolve()))
      if (saved === undefined) delete process.env.CLOCK_ALLOWED_CIDRS
      else process.env.CLOCK_ALLOWED_CIDRS = saved
    }
  })

  it('parses CLOCK_ALLOWED_CIDRS, defaults to private ranges without loopback and Docker, fails closed', () => {
    const defaults = parseClockAllowedCidrs(undefined)
    expect(defaults.cidrs.join(',')).toBe(CLOCK_DEFAULT_ALLOWED_CIDRS)
    for (const ok of ['192.168.1.202', '::ffff:192.168.1.202', '10.0.0.7', 'fd00::5', 'fe80::1']) {
      expect(defaults.allows(ok), ok).toBe(true)
    }
    for (const bad of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.20.0.1', '172.17.0.1', '8.8.8.8', '2a01:4f8::1', '', undefined, 'not-an-ip']) {
      expect(defaults.allows(bad), String(bad)).toBe(false)
    }

    const clockOnly = parseClockAllowedCidrs(' 192.168.1.202/32 , 172.20.0.1 ')
    expect(clockOnly.cidrs).toEqual(['192.168.1.202/32', '172.20.0.1/32'])
    expect(clockOnly.allows('192.168.1.202')).toBe(true)
    expect(clockOnly.allows('::ffff:192.168.1.202')).toBe(true)
    expect(clockOnly.allows('172.20.0.1')).toBe(true)
    expect(clockOnly.allows('192.168.1.133')).toBe(false)
    expect(clockOnly.allows('127.0.0.1')).toBe(false)

    const broken = parseClockAllowedCidrs('192.168.1.0/33,banana,10.0.0.0/8/1')
    expect(broken.invalid).toEqual(['192.168.1.0/33', 'banana', '10.0.0.0/8/1'])
    expect(broken.cidrs).toEqual([])
    expect(broken.allows('192.168.1.202')).toBe(false)
  })
})

describe('GET /state', () => {
  it('is empty and stable for a quiet user', async () => {
    const a = await call('GET', '/state')
    const b = await call('GET', '/state')
    expect(a.status).toBe(200)
    expect(a.json.question).toBeNull()
    expect(a.json.events).toEqual([])
    expect(a.json.status).toEqual({ running: [], questions_waiting: 0, thinking: false })
    expect(a.json.rev).toBe(b.json.rev)
  })

  it('counts running tasks per persona and reports finished ones as events with short titles', async () => {
    insertTask({ id: 't1', name: 'Recherche A', status: 'running', sessionId: 'strand-1', agentId: 'builder' })
    insertTask({ id: 't2', name: 'Recherche B', status: 'running', sessionId: 'strand-1', agentId: 'builder' })
    insertTask({ id: 't3', name: 'Anderes', status: 'running', sessionId: 'strand-1', agentId: 'scout' })
    insertTask({ id: 't4', name: 'Bericht über die Speicher-Migration mit allen Schritten', status: 'completed', sessionId: 'strand-1', agentId: 'builder', resultStatus: 'completed', completedAgoSec: 30 })
    insertTask({ id: 't5', name: 'Kaputt', status: 'failed', sessionId: 'strand-1', agentId: 'main', completedAgoSec: 20 })
    insertTask({ id: 't6', name: 'Heartbeat still', status: 'completed', sessionId: 'strand-1', resultStatus: 'silent', completedAgoSec: 10 })
    insertTask({ id: 't7', name: 'Lange her', status: 'completed', sessionId: 'strand-1', resultStatus: 'completed', completedAgoSec: 3600 })
    const { json } = await call('GET', '/state')
    expect((json.status as { running: unknown }).running).toEqual([{ persona: 'builder', count: 2 }, { persona: 'scout', count: 1 }])
    const events = json.events as Array<Record<string, string>>
    expect(events.map(e => e.type)).toEqual(['task_done', 'task_failed'])
    expect(events[0]!.persona).toBe('builder')
    expect(events[0]!.title.length).toBeLessThanOrEqual(24)
    expect(events[0]!.title.endsWith('..')).toBe(true)
    expect(events[1]!.sound).toBe('alert')
    expect(events.every(e => /^t[0-9a-f]{12}$/.test(e.id))).toBe(true)
  })

  it('never shows tasks or questions of another user', async () => {
    insertSession('foreign', 2)
    insertTask({ id: 'f1', name: 'Fremd', status: 'running', sessionId: 'foreign' })
    insertTask({ id: 'f2', name: 'Fremd fertig', status: 'completed', sessionId: 'foreign', completedAgoSec: 5 })
    insertBlockMessage({ sessionId: 'foreign', userId: 2 })
    const { json } = await call('GET', '/state')
    expect(json.question).toBeNull()
    expect(json.events).toEqual([])
    expect((json.status as { running: unknown[] }).running).toEqual([])
  })

  it('offers an open choice with clipped question, labels and short labels', async () => {
    const messageId = insertBlockMessage({ agentId: 'builder' })
    const { json } = await call('GET', '/state')
    const q = json.question as Record<string, unknown>
    expect(q.message_id).toBe(messageId)
    expect(q.block_id).toBe('b1')
    expect(q.kind).toBe('choice')
    expect(q.persona).toBe('builder')
    expect(String(q.text).length).toBeLessThanOrEqual(40)
    const options = q.options as Array<{ id: string; label: string; short: string }>
    expect(options.map(o => o.id)).toEqual(['kurz', 'lang', 'none'])
    for (const o of options) {
      expect(o.label.length).toBeLessThanOrEqual(20)
      expect(o.short.length).toBeLessThanOrEqual(9)
    }
    expect(options[1]!.short).toBe('Lange')
    expect((json.status as { questions_waiting: number }).questions_waiting).toBe(1)
    expect((json.events as Array<{ type: string }>).map(e => e.type)).toEqual(['question'])
  })

  it('maps a default confirm card to Ja/Nein', async () => {
    insertBlockMessage({ payload: { block: 'confirm', id: 'c1', question: 'Mail an Anna senden?' } })
    const q = (await call('GET', '/state')).json.question as Record<string, unknown>
    expect(q.kind).toBe('confirm')
    expect(q.options).toEqual([
      { id: 'yes', label: 'Ja', short: 'Ja' },
      { id: 'no', label: 'Nein', short: 'Nein' },
    ])
  })

  it('never offers destructive, danger, multi or draft cards', async () => {
    insertSession('s2'); insertSession('s3'); insertSession('s4')
    insertBlockMessage({ payload: { block: 'confirm', id: 'd1', question: 'Alles löschen?', destructive: true } })
    insertBlockMessage({ sessionId: 's2', payload: { block: 'choice', id: 'd2', question: 'Was?', options: [{ id: 'a', label: 'A', style: 'danger' }, { id: 'b', label: 'B' }] } })
    insertBlockMessage({ sessionId: 's3', payload: { block: 'multi', id: 'd3', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } })
    insertBlockMessage({ sessionId: 's4', payload: { block: 'confirm', id: 'd4', question: 'Senden?', options: [{ id: 'go', label: 'Los' }, { id: 'stop', label: 'Stopp' }] } })
    const { json } = await call('GET', '/state')
    // Only the custom-option confirm is eligible, and it goes out as a choice.
    const q = json.question as Record<string, unknown>
    expect(q.block_id).toBe('d4')
    expect(q.kind).toBe('choice')
    expect((json.status as { questions_waiting: number }).questions_waiting).toBe(1)
  })

  it('strips every text in privacy mode but keeps the short labels', async () => {
    insertTask({ id: 't1', name: 'Geheimes Projekt', status: 'completed', sessionId: 'strand-1', completedAgoSec: 5 })
    insertBlockMessage()
    const patch = await call('PATCH', `/devices/${clockId}`, { token: userJwt, body: { privacy: true } })
    expect(patch.status).toBe(200)
    const { json } = await call('GET', '/state')
    expect(json.privacy).toBe(true)
    const text = JSON.stringify(json)
    expect(text).not.toContain('Geheimes')
    expect(text).not.toContain('Wochenende')
    expect(text).not.toContain('Lange Fassung')
    const q = json.question as { text: string; options: Array<{ label: string; short: string }> }
    expect(q.text).toBe('')
    expect(q.options.map(o => o.short)).toEqual(['Kurzfassu', 'Lange', 'Gar keine'])
  })

  it('hides the model-chosen ids in privacy mode and maps the opaque ids back', async () => {
    const messageId = insertBlockMessage({ payload: { ...CHOICE, id: 'kunde_acme_frage', options: [
      { id: 'delete_customer_acme', label: 'Löschen' },
      { id: 'keep_customer_acme', label: 'Behalten' },
    ] } })
    await call('PATCH', `/devices/${clockId}`, { token: userJwt, body: { privacy: true } })
    const { json } = await call('GET', '/state')
    const q = json.question as { id: string; block_id: string; options: Array<{ id: string }> }
    expect(JSON.stringify(json)).not.toContain('acme')
    expect(q.block_id).toBe('~1')
    expect(q.id).toBe(`m${messageId}:~1`)
    expect(q.options.map(o => o.id)).toEqual(['~1', '~2'])
    const res = await call('POST', '/answer', { body: { message_id: messageId, block_id: q.block_id, value: q.options[1]!.id, client_id: 'p1' } })
    expect(res.status).toBe(200)
    expect(turns).toHaveLength(1)
    const meta = (db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(messageId) as { metadata: string }).metadata
    expect(meta).toContain('keep_customer_acme')
    expect(meta).not.toContain('~2')
  })

  it('keeps the real ids outside privacy mode', async () => {
    insertBlockMessage()
    const { json } = await call('GET', '/state')
    const q = json.question as { block_id: string; options: Array<{ id: string }> }
    expect(q.block_id).toBe('b1')
    expect(q.options.map(o => o.id)).toEqual(['kurz', 'lang', 'none'])
  })

  it('folds text to the clock font', async () => {
    insertTask({ id: 't1', name: 'Café “Résumé” 🚀 — fertig', status: 'completed', sessionId: 'strand-1', completedAgoSec: 5 })
    const events = (await call('GET', '/state')).json.events as Array<{ title: string }>
    expect(events[0]!.title).toBe('Cafe "Resume" - fertig')
  })

  it('changes rev when something visible changes', async () => {
    const before = (await call('GET', '/state')).json.rev
    insertBlockMessage()
    const after = (await call('GET', '/state')).json.rev
    expect(after).not.toBe(before)
    expect(typeof after).toBe('number')
    expect(after as number).toBeLessThanOrEqual(0x7fffffff)
  })
})

describe('POST /answer', () => {
  it('answers through the shared service and starts the turn once', async () => {
    const messageId = insertBlockMessage()
    const body = { message_id: messageId, block_id: 'b1', value: 'lang', client_id: 'k1' }
    const first = await call('POST', '/answer', { body })
    expect(first.status).toBe(200)
    expect(first.json.applied).toBe(true)
    expect(first.json.idempotent).toBe(false)
    // No label echo: the clock does not need it and it may be private.
    expect(first.json).not.toHaveProperty('label')
    expect(JSON.stringify(first.json)).not.toContain('Lange Fassung')
    expect(turns).toHaveLength(1)
    expect(turns[0]!.sessionId).toBe('strand-1')
    // A retry with the same client id is idempotent, no second turn.
    const retry = await call('POST', '/answer', { body })
    expect(retry.status).toBe(200)
    expect(retry.json.idempotent).toBe(true)
    expect(turns).toHaveLength(1)
    const meta = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(messageId) as { metadata: string }
    expect(readInteractionAnswers(meta.metadata).b1?.value).toBe('lang')
    // The question is gone from the state afterwards.
    expect((await call('GET', '/state')).json.question).toBeNull()
  })

  it('answers 409 without the stored label when the phone was faster', async () => {
    const messageId = insertBlockMessage()
    await call('POST', '/answer', { body: { message_id: messageId, block_id: 'b1', value: 'kurz', client_id: 'phone' } })
    const res = await call('POST', '/answer', { body: { message_id: messageId, block_id: 'b1', value: 'lang', client_id: 'clock' } })
    expect(res.status).toBe(409)
    expect(res.json.code).toBe('already_answered')
    expect(JSON.stringify(res.json)).not.toContain('Kurzfassung')
  })

  it('refuses destructive cards even when called directly', async () => {
    const messageId = insertBlockMessage({ payload: { block: 'confirm', id: 'd1', question: 'Alles löschen?', destructive: true } })
    const res = await call('POST', '/answer', { body: { message_id: messageId, block_id: 'd1', value: 'yes', client_id: 'x' } })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('not_allowed')
    expect(turns).toHaveLength(0)
  })

  it('refuses multi cards and foreign messages', async () => {
    const multi = insertBlockMessage({ payload: { block: 'multi', id: 'm1', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } })
    expect((await call('POST', '/answer', { body: { message_id: multi, block_id: 'm1', value: 'a', client_id: 'x' } })).status).toBe(403)
    insertSession('foreign', 2)
    const foreign = insertBlockMessage({ sessionId: 'foreign', userId: 2 })
    const res = await call('POST', '/answer', { body: { message_id: foreign, block_id: 'b1', value: 'kurz', client_id: 'x' } })
    expect(res.status).toBe(404)
    expect(turns).toHaveLength(0)
  })

  it('rejects unknown options and malformed bodies', async () => {
    const messageId = insertBlockMessage()
    const unknown = await call('POST', '/answer', { body: { message_id: messageId, block_id: 'b1', value: 'nope', client_id: 'x' } })
    expect(unknown.status).toBe(400)
    expect((await call('POST', '/answer', { body: { message_id: messageId, block_id: 'b1' } })).status).toBe(400)
    expect((await call('POST', '/answer', { body: { message_id: messageId, block_id: 'zz', value: 'kurz', client_id: 'x' } })).status).toBe(404)
  })
})

describe('parseClockAnswerBody', () => {
  it('accepts a numeric string id (Berry json encodes what it got) and caps id lengths', () => {
    expect(parseClockAnswerBody({ message_id: '12', block_id: 'b', value: 'v', client_id: 'c' })?.messageId).toBe(12)
    expect(parseClockAnswerBody({ message_id: 0, block_id: 'b', value: 'v', client_id: 'c' })).toBeNull()
    expect(parseClockAnswerBody({ message_id: 1, block_id: 'x'.repeat(65), value: 'v', client_id: 'c' })).toBeNull()
    expect(parseClockAnswerBody([])).toBeNull()
  })
})

describe('short labels', () => {
  it('never lets two options look the same on the panel', async () => {
    insertBlockMessage({ payload: { block: 'choice', id: 'u1', question: 'Welche?', options: [
      { id: 'a', label: 'Lange Fassung' },
      { id: 'b', label: 'Lange Version' },
      { id: 'c', label: 'Kurz' },
    ] } })
    const q = (await call('GET', '/state')).json.question as { options: Array<{ short: string }> }
    const shorts = q.options.map(o => o.short)
    expect(new Set(shorts).size).toBe(3)
    expect(shorts).toEqual(['Lange Fas', 'Lange Ver', 'Kurz'])
    expect(shorts.every(s => s.length <= 9)).toBe(true)
  })
})
