/**
 * `/api/now` with `offtangent.nowSetMode = 'auto'`: the set is COMPUTED from
 * the user's activity, carries `mode`, and refuses writes with 409
 * `now_set_auto`. Manual mode keeps the curated table behaviour.
 *
 * Fails against the pre-auto route, which always read the `now_set` table,
 * never reported a mode and happily wrote whatever was PUT.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager, setNowSet } from '@axiom/core'
import type { AgentCore, Database, NowSetMode, Thread } from '@axiom/core'
import { createStrandsRouters } from './route.js'
import { generateAccessToken } from '../../../auth.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import type { ChatEvent } from '../../../chat-event-bus.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let mode: NowSetMode = 'auto'
const events: ChatEvent[] = []

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-now-auto-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  const bus = new ChatEventBus()
  bus.subscribe(e => events.push(e))

  const app = express()
  app.use(express.json())
  const routers = createStrandsRouters({
    db,
    getAgentCore: () => agentCore,
    chatEventBus: bus,
    getNowSetMax: () => 3,
    getNowSetMode: () => mode,
  })
  app.use('/api/strands', routers.strands)
  app.use('/api/now', routers.now)

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM now_set; DELETE FROM chat_messages; DELETE FROM strand_tags; DELETE FROM sessions;')
  events.length = 0
  mode = 'auto'
})

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

/** `daysAgo` in the UTC format `chat_messages.timestamp` uses. */
function userMessage(strandId: string, daysAgo: number): void {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
  db.prepare(
    "INSERT INTO chat_messages (session_id, user_id, role, content, timestamp, agent_id) VALUES (?, 1, 'user', 'x', ?, 'main')",
  ).run(strandId, at)
}

describe('GET/PUT /api/now in auto mode', () => {
  it('computes the set from activity, reports mode and ranks pinned first', async () => {
    const quiet = sessionManager.createThread('1', 'main', 'Quiet').id
    const busy = sessionManager.createThread('1', 'main', 'Busy').id
    const pinned = sessionManager.createThread('1', 'main', 'Pinned').id
    for (const day of [0, 1, 2, 3]) userMessage(busy, day)
    userMessage(quiet, 6)
    userMessage(pinned, 9)
    db.prepare('UPDATE sessions SET pinned = 1 WHERE id = ?').run(pinned)

    const res = await api('GET', '/api/now')
    expect(res.status).toBe(200)
    expect(res.body.mode).toBe('auto')
    expect(res.body.max).toBe(3)
    const strands = res.body.strands as (Thread & { nowRank: number; tags: unknown[]; links: unknown })[]
    expect(strands.map(s => s.id)).toEqual([pinned, busy, quiet])
    // nowRank is the position in the COMPUTED list, not a `now_set` rank.
    expect(strands.map(s => s.nowRank)).toEqual([1, 2, 3])
    // Hydrated exactly like the manual set: tags and links are attached.
    expect(Array.isArray(strands[0]!.tags)).toBe(true)
    expect(strands[0]!.links).toBeDefined()
    // Nothing was written to the table.
    expect(db.prepare('SELECT count(*) c FROM now_set').get()).toEqual({ c: 0 })
  })

  it('cuts at max and leaves a user without activity with an empty set', async () => {
    const ids = [1, 2, 3, 4, 5].map(i => sessionManager.createThread('1', 'main', `S${i}`).id)
    ids.forEach((id, index) => userMessage(id, index))
    const res = await api('GET', '/api/now')
    expect((res.body.strands as Thread[]).map(s => s.id)).toEqual(ids.slice(0, 3))

    db.exec('DELETE FROM chat_messages')
    expect((await api('GET', '/api/now')).body.strands).toEqual([])
  })

  it('refuses PUT with 409 now_set_auto and writes nothing', async () => {
    const strand = sessionManager.createThread('1', 'main', 'S').id
    const res = await api('PUT', '/api/now', { strandIds: [strand] })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('now_set_auto')
    expect(res.body.code).toBe('now_set_auto')
    expect(res.body.message).toBe(
      'The now set is filled automatically; switch offtangent.nowSetMode to manual to edit it',
    )
    expect(db.prepare('SELECT count(*) c FROM now_set').get()).toEqual({ c: 0 })
  })

  it('drops an archived strand from the computed list and broadcasts the new one', async () => {
    const keep = sessionManager.createThread('1', 'main', 'Keep').id
    const gone = sessionManager.createThread('1', 'main', 'Gone').id
    userMessage(keep, 1)
    userMessage(gone, 0)
    expect(((await api('GET', '/api/now')).body.strands as Thread[]).map(s => s.id)).toEqual([gone, keep])

    const patched = await fetch(`${baseUrl}/api/strands/${gone}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    })
    expect(patched.status).toBe(200)
    const broadcast = events.filter(e => e.type === 'now_set_changed').at(-1) as { strandIds: string[] } | undefined
    expect(broadcast?.strandIds).toEqual([keep])
    expect(((await api('GET', '/api/now')).body.strands as Thread[]).map(s => s.id)).toEqual([keep])
  })

  it('manual mode is unchanged and reports mode: manual', async () => {
    mode = 'manual'
    const a = sessionManager.createThread('1', 'main', 'A').id
    const b = sessionManager.createThread('1', 'main', 'B').id
    // Activity that would rank B first if the mode leaked.
    userMessage(b, 0)
    setNowSet(db, '1', [a], 3)

    const res = await api('GET', '/api/now')
    expect(res.body.mode).toBe('manual')
    expect((res.body.strands as Thread[]).map(s => s.id)).toEqual([a])

    const put = await api('PUT', '/api/now', { strandIds: [b, a] })
    expect(put.status).toBe(200)
    expect(put.body.mode).toBe('manual')
    expect((put.body.strands as Thread[]).map(s => s.id)).toEqual([b, a])
    expect(db.prepare('SELECT strand_id FROM now_set ORDER BY rank').all())
      .toEqual([{ strand_id: b }, { strand_id: a }])
  })
})
