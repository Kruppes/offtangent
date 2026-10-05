/**
 * Eco mode switch (plan 2026-10-04-eco-implementation):
 * `PATCH /api/strands/:id/eco` and the additive `eco` block of
 * `GET /api/strands/:id/context`. Real SessionManager, real database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager, isStrandEcoEnabled } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

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
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-strand-eco-'))
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
  db.exec('DELETE FROM tool_calls; DELETE FROM chat_messages; DELETE FROM sessions;')
})

async function api(method: string, url: string, body?: unknown, authToken = token) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { Authorization: `Bearer ${authToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

describe('strand eco mode', () => {
  it('defaults to off, persists on, and rolls back by switching off', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Eco strand')
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)

    const ctx0 = await api('GET', `/api/strands/${strand.id}/context`)
    expect(ctx0.status).toBe(200)
    expect(ctx0.body.eco).toMatchObject({ enabled: false, last: null })

    const on = await api('PATCH', `/api/strands/${strand.id}/eco`, { enabled: true })
    expect(on.status).toBe(200)
    expect(on.body).toMatchObject({ strandId: strand.id, eco: { enabled: true } })
    expect(isStrandEcoEnabled(db, strand.id)).toBe(true)
    expect((await api('GET', `/api/strands/${strand.id}/context`)).body.eco).toMatchObject({ enabled: true })

    const off = await api('PATCH', `/api/strands/${strand.id}/eco`, { enabled: false })
    expect(off.status).toBe(200)
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)
  })

  it('rejects anything but a strict boolean body', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Strict')
    for (const body of [{ enabled: 'true' }, { enabled: 1 }, {}, { enabled: true, extra: 1 }, [true]]) {
      const res = await api('PATCH', `/api/strands/${strand.id}/eco`, body)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('invalid_eco')
    }
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)
  })

  it('answers 404 for a foreign or unknown strand and changes nothing', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Mine')
    const foreign = await api('PATCH', `/api/strands/${strand.id}/eco`, { enabled: true }, otherToken)
    expect(foreign.status).toBe(404)
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)
    expect((await api('PATCH', '/api/strands/does-not-exist/eco', { enabled: true })).status).toBe(404)
  })

  it('requires authentication', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Auth')
    const res = await fetch(`${baseUrl}/api/strands/${strand.id}/eco`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(401)
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)
  })

  it('reports frozen tool results (real Eco) as estimates, never refusals', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Metric')
    await api('PATCH', `/api/strands/${strand.id}/eco`, { enabled: true })
    const ctx0 = await api('GET', `/api/strands/${strand.id}/context`)
    expect(ctx0.body.eco).toMatchObject({ enabled: true, last: null })
    // Two results frozen at creation: originals 3000 + 6000 chars, projections 900 + 1200.
    const meta = (o: number, p: number) => JSON.stringify({ toolName: 'shell', toolResult: { content: [{ type: 'text', text: 'x' }], details: { eco: { rowId: 1, originalChars: o, projectedChars: p } } } })
    const ins = db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, eco_original) VALUES (?, 1, 'tool', 'Tool: shell', ?, ?)")
    ins.run(strand.id, meta(3000, 900), '{"content":[]}')
    ins.run(strand.id, meta(6000, 1200), '{"content":[]}')
    const ctx = await api('GET', `/api/strands/${strand.id}/context`)
    expect(ctx.body.eco).toMatchObject({
      enabled: true,
      last: { estimatedTokensBefore: 3000, estimatedTokensAfter: 700, compactedResults: 2, droppedMessages: 0, degraded: false, refused: false, refusalReason: null },
    })
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool_name = 'eco_context'").get()).toEqual({ n: 0 })
  })
})
