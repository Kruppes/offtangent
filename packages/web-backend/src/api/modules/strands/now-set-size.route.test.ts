/**
 * The now-set size end to end: `PUT /api/settings` writes
 * `offtangent.nowSetMax`, and `/api/now` follows it without any injected test
 * double — the same path the app wires in production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database, Thread } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-now-set-size-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  server = http.createServer(createApp({ db, getAgentCore: () => agentCore }))
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
  db.exec('DELETE FROM now_set; DELETE FROM sessions;')
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

describe('now set size setting end to end', () => {
  it('raises the limit, keeps an oversized set after lowering it, and never clamps silently', async () => {
    const ids = [1, 2, 3, 4, 5, 6].map(i => sessionManager.createThread('1', 'main', `S${i}`).id)

    expect((await api('GET', '/api/now')).body.max).toBe(4)
    expect((await api('PUT', '/api/now', { strandIds: ids.slice(0, 5) })).status).toBe(400)

    expect((await api('PUT', '/api/settings', { offtangent: { nowSetMax: 6 } })).status).toBe(200)

    const six = await api('PUT', '/api/now', { strandIds: ids })
    expect(six.status).toBe(200)
    expect(six.body.max).toBe(6)
    expect((six.body.strands as Thread[]).map(s => s.id)).toEqual(ids)

    // Lowering the size leaves the six strands in place.
    expect((await api('PUT', '/api/settings', { offtangent: { nowSetMax: 2 } })).status).toBe(200)
    const lowered = await api('GET', '/api/now')
    expect(lowered.body.max).toBe(2)
    expect((lowered.body.strands as Thread[]).map(s => s.id)).toEqual(ids)

    const refused = await api('PUT', '/api/now', { strandIds: ids.slice(0, 3) })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe('The now set holds at most 2 strands')
    expect(((await api('GET', '/api/now')).body.strands as Thread[]).length).toBe(6)

    // An out-of-range size is rejected, the stored one survives.
    const invalid = await api('PUT', '/api/settings', { offtangent: { nowSetMax: 99 } })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toBe('offtangent.nowSetMax must be an integer 1-12')
    expect((await api('GET', '/api/now')).body.max).toBe(2)
  })
})
