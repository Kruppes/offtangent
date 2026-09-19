/**
 * Server side read state of a strand (API contract 2026-09-18, B):
 * `POST /api/strands/:id/read` plus the derived `lastActivityAt` / `unread`
 * on the list and detail reads. Wired the same way production is — real
 * SessionManager, real database, no injected doubles.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

interface StrandView { id: string; lastActivityAt: string | null; unread: boolean }

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
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-strand-read-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  server = http.createServer(createApp({ db, getAgentCore: () => agentCore }))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions;')
})

async function api(method: string, url: string, authToken = token) {
  const res = await fetch(`${baseUrl}${url}`, { method, headers: { Authorization: `Bearer ${authToken}` } })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

function insertMessage(sessionId: string, role: string, content: string, timestamp?: string): void {
  if (timestamp) {
    db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp) VALUES (?, 1, ?, ?, ?, ?)')
      .run(sessionId, role, content, 'main', timestamp)
    return
  }
  db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, ?, ?, ?)')
    .run(sessionId, role, content, 'main')
}

async function listStrands(): Promise<Map<string, StrandView>> {
  const res = await api('GET', '/api/strands')
  expect(res.status).toBe(200)
  return new Map((res.body.strands as StrandView[]).map(strand => [strand.id, strand]))
}

describe('strand read state', () => {
  it('reports unread for answered strands, read after POST /read, and never for user-only strands', async () => {
    const unreadStrand = sessionManager.createThread('1', 'main', 'Unread')
    const readStrand = sessionManager.createThread('1', 'main', 'Read')
    const userOnlyStrand = sessionManager.createThread('1', 'main', 'Only my own words')

    insertMessage(unreadStrand.id, 'user', 'what about the roof?', '2026-09-18 08:00:00')
    insertMessage(unreadStrand.id, 'assistant', 'the roof holds', '2026-09-18 08:00:05')
    insertMessage(readStrand.id, 'assistant', 'done', '2026-09-18 07:00:00')
    // Only the user has spoken here: nothing to be unread about.
    insertMessage(userOnlyStrand.id, 'user', 'note to self', '2026-09-18 09:00:00')

    const markRead = await api('POST', `/api/strands/${readStrand.id}/read`)
    expect(markRead.status).toBe(204)

    const strands = await listStrands()

    expect(strands.get(unreadStrand.id)).toMatchObject({ unread: true, lastActivityAt: '2026-09-18T08:00:05.000Z' })
    expect(strands.get(readStrand.id)).toMatchObject({ unread: false, lastActivityAt: '2026-09-18T07:00:00.000Z' })
    expect(strands.get(userOnlyStrand.id)).toMatchObject({ unread: false, lastActivityAt: null })

    // The detail read carries the same two fields.
    const detail = await api('GET', `/api/strands/${unreadStrand.id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.strand).toMatchObject({ unread: true, lastActivityAt: '2026-09-18T08:00:05.000Z' })
  })

  it('turns unread again when a new answer arrives after the read marker', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Ongoing')
    insertMessage(strand.id, 'assistant', 'first answer', '2026-09-18 08:00:00')

    expect((await api('POST', `/api/strands/${strand.id}/read`)).status).toBe(204)
    expect((await listStrands()).get(strand.id)?.unread).toBe(false)

    // A task result card lands in the strand as a system message.
    insertMessage(strand.id, 'system', 'task finished', '2099-01-01 10:00:00')

    const after = (await listStrands()).get(strand.id)
    expect(after?.unread).toBe(true)
    expect(after?.lastActivityAt).toBe('2099-01-01T10:00:00.000Z')
  })

  it('is idempotent: a second read changes nothing and still answers 204', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Twice')
    insertMessage(strand.id, 'assistant', 'answer', '2026-09-18 08:00:00')

    expect((await api('POST', `/api/strands/${strand.id}/read`)).status).toBe(204)
    const first = (db.prepare('SELECT last_read_at FROM sessions WHERE id = ?').get(strand.id) as { last_read_at: string }).last_read_at
    expect(first).not.toBeNull()

    expect((await api('POST', `/api/strands/${strand.id}/read`)).status).toBe(204)
    const second = (db.prepare('SELECT last_read_at FROM sessions WHERE id = ?').get(strand.id) as { last_read_at: string }).last_read_at
    expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime())
    expect((await listStrands()).get(strand.id)?.unread).toBe(false)
  })

  it('answers 404 for an unknown or foreign strand and leaves it untouched', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Mine')
    insertMessage(strand.id, 'assistant', 'answer', '2026-09-18 08:00:00')

    expect((await api('POST', '/api/strands/does-not-exist/read')).status).toBe(404)
    expect((await api('POST', `/api/strands/${strand.id}/read`, otherToken)).status).toBe(404)

    const stored = db.prepare('SELECT last_read_at FROM sessions WHERE id = ?').get(strand.id) as { last_read_at: string | null }
    expect(stored.last_read_at).toBeNull()
  })

  it('rejects an unauthenticated read', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Mine')
    const res = await fetch(`${baseUrl}/api/strands/${strand.id}/read`, { method: 'POST' })
    expect(res.status).toBe(401)
  })
})
