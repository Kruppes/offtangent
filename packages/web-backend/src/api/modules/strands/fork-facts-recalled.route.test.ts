/**
 * W5b routes of a strand, pinned against a real SessionManager and an
 * in-memory database:
 *   POST /api/strands/:id/fork      "fork at this message"
 *   GET  /api/strands/:id/facts     slim fact list of the context panel
 *   GET  /api/strands/:id/context   additive `recalled[]`
 * Every fixture is synthetic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { getStrandForkLineage, initDatabase, logToolCall, SessionManager } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createStrandsRouters, FORK_PER_MINUTE } from './route.js'
import { parseForkBody } from './schema.js'
import { defaultForkTitle } from './service.js'
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
const events: Array<Record<string, unknown>> = []

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strand-w5b-'))
  process.env.DATA_DIR = tempDataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'first', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'second', 'x', 'user')
  // A third user only for the rate limit, so its window never touches the others.
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(3, 'third', 'x', 'user')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  const app = express()
  app.use(express.json())
  const routers = createStrandsRouters({
    db,
    getAgentCore: () => agentCore,
    getNowSetMode: () => 'manual',
    chatEventBus: { broadcast: (event: Record<string, unknown>) => { events.push(event) } } as never,
  })
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
  db.exec('DELETE FROM strand_links; DELETE FROM memories; DELETE FROM tool_calls; DELETE FROM chat_messages; DELETE FROM sessions;')
  events.length = 0
})

function strand(title: string, userId = '1'): string {
  return sessionManager.createThread(userId, 'main', title).id
}

function message(sessionId: string, content: string, role = 'user', userId = 1): number {
  return Number(db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, userId, role, content, 'main').lastInsertRowid)
}

async function call(method: string, url: string, body?: unknown, bearer: string | null = token) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  const res = await fetch(`${baseUrl}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, Json> }
}

describe('POST /api/strands/:id/fork', () => {
  it('forks at the chosen message: lineage, seed, notice and the pinned answer', async () => {
    const parent = strand('Synthetic garden plan')
    const first = message(parent, 'Which seeds should go into the north bed?\nSecond line.')
    message(parent, 'Probably beans and peas.', 'assistant')
    message(parent, 'And the south bed?')

    const res = await call('POST', `/api/strands/${parent}/fork`, { messageId: first })
    expect(res.status).toBe(201)
    const fork = res.body.fork
    expect(Object.keys(res.body).sort()).toEqual(['fork', 'strand'])
    expect(Object.keys(fork).sort()).toEqual([
      'depth', 'forkedAt', 'forkedFromMessageId', 'noticeMessageId', 'parentStrandId',
      'parentTitle', 'seedMessageId', 'strandId', 'title',
    ])
    expect(fork).toMatchObject({
      title: 'Which seeds should go into the north bed?',
      parentStrandId: parent,
      parentTitle: 'Synthetic garden plan',
      forkedFromMessageId: first,
      depth: 1,
    })
    expect(res.body.strand).toMatchObject({
      id: fork.strandId, title: fork.title, parentStrandId: parent,
      parentStrandTitle: 'Synthetic garden plan', forkedFromMessageId: first, childStrands: [],
    })

    // Same mechanism as fork_strand: the lineage columns, at the CHOSEN message.
    expect(getStrandForkLineage(db, fork.strandId)).toEqual({
      parentStrandId: parent, forkedAt: fork.forkedAt, forkedFromMessageId: first,
    })
    const seed = db.prepare('SELECT role, content FROM chat_messages WHERE session_id = ?').all(fork.strandId) as Array<{ role: string; content: string }>
    expect(seed).toHaveLength(1)
    expect(seed[0]!.content).toContain('Which seeds should go into the north bed?')
    expect(seed[0]!.content).toContain(`[msg:${first}]`)
    expect(seed[0]!.content).not.toContain('Probably beans and peas.')
    // The parent shows "forked into" and its detail lists the child.
    const parentDetail = await call('GET', `/api/strands/${parent}`)
    expect(parentDetail.body.strand.childStrandIds).toEqual([fork.strandId])
    expect(parentDetail.body.strand.childStrands).toEqual([
      { id: fork.strandId, title: fork.title, forkedAt: fork.forkedAt, forkedFromMessageId: first },
    ])
    expect(parentDetail.body.strand.forkedFromMessageId).toBeNull()
    // The live event the agent tool sends, without a started run.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'strand_forked', userId: 1, sessionId: parent, fork: { strandId: fork.strandId, runStarted: false } })
  })

  it('takes a given title (trimmed) and rejects one that is too long', async () => {
    const parent = strand('Synthetic parent')
    const id = message(parent, 'A synthetic question.', 'assistant')
    const ok = await call('POST', `/api/strands/${parent}/fork`, { messageId: id, title: '  Side path  ' })
    expect(ok.status).toBe(201)
    expect(ok.body.fork.title).toBe('Side path')
    const long = await call('POST', `/api/strands/${parent}/fork`, { messageId: id, title: 'x'.repeat(81) })
    expect(long).toEqual({ status: 400, body: { error: 'title must be at most 80 characters', code: 'invalid_title' } })
  })

  it('answers 401 without a token', async () => {
    const parent = strand('Synthetic parent')
    const id = message(parent, 'Hello')
    expect((await call('POST', `/api/strands/${parent}/fork`, { messageId: id }, null)).status).toBe(401)
  })

  it('answers 404 for a foreign strand and for a message of another strand', async () => {
    const mine = strand('Mine')
    const foreign = strand('Foreign', '2')
    const foreignMsg = message(foreign, 'Not yours', 'user', 2)
    const mineMsg = message(mine, 'Mine')
    const asOther = await call('POST', `/api/strands/${mine}/fork`, { messageId: mineMsg }, otherToken)
    expect(asOther).toEqual({ status: 404, body: { error: 'Strand not found', code: 'strand_not_found' } })
    const crossed = await call('POST', `/api/strands/${mine}/fork`, { messageId: foreignMsg })
    expect(crossed).toEqual({ status: 404, body: { error: 'Message not found in this strand', code: 'message_not_found' } })
    const unknown = await call('POST', '/api/strands/does-not-exist/fork', { messageId: mineMsg })
    expect(unknown.status).toBe(404)
    // Nothing was created by any of them.
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(2)
  })

  it('validates the body and refuses tool or system rows', async () => {
    const parent = strand('Synthetic parent')
    const toolRow = message(parent, 'tool output', 'tool')
    for (const body of [{}, { messageId: '1' }, { messageId: 0 }, { messageId: -4 }, { messageId: 1.5 }, { messageId: 1, title: 7 }, []]) {
      const res = await call('POST', `/api/strands/${parent}/fork`, body)
      expect(res.status).toBe(400)
    }
    expect((await call('POST', `/api/strands/${parent}/fork`, { messageId: toolRow })).status).toBe(404)
    expect((await call('POST', `/api/strands/${parent}/fork`, { messageId: 'x' })).body).toEqual({
      error: 'messageId must be a positive integer', code: 'invalid_message_id',
    })
  })

  it('refuses an archived strand with 409', async () => {
    const parent = strand('Archived parent')
    const id = message(parent, 'Hello there')
    db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(parent)
    const res = await call('POST', `/api/strands/${parent}/fork`, { messageId: id })
    expect(res).toEqual({ status: 409, body: { error: 'An archived strand cannot be forked', code: 'strand_archived' } })
  })

  it('rate limits forks per user', async () => {
    const third = generateAccessToken({ userId: 3, username: 'third', role: 'user' })
    const parent = strand('Rate parent', '3')
    const id = message(parent, 'Hello', 'user', 3)
    const statuses: number[] = []
    for (let i = 0; i <= FORK_PER_MINUTE; i++) statuses.push((await call('POST', `/api/strands/${parent}/fork`, { messageId: id }, third)).status)
    expect(statuses.slice(0, FORK_PER_MINUTE).every(s => s === 201)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })
})

describe('fork helpers', () => {
  it('derives the title from the first non-empty line', () => {
    expect(defaultForkTitle('\n\n## Heading line\nmore')).toBe('Heading line')
    expect(defaultForkTitle('y'.repeat(100))).toHaveLength(60)
    expect(defaultForkTitle('   ')).toBe('Fork')
  })
  it('parses the body strictly', () => {
    expect(parseForkBody({ messageId: 3, title: '   ' })).toEqual({ ok: true, value: { messageId: 3 } })
    expect(parseForkBody(null).ok).toBe(false)
  })
})

describe('GET /api/strands/:id/facts', () => {
  function fact(strandId: string, content: string, userId = '1', status = 'active'): number {
    return Number(db.prepare(
      "INSERT INTO memories (content, source, user_id, session_id, status, timestamp) VALUES (?, 'chat', ?, ?, ?, '2026-01-02 03:04:05')",
    ).run(content, userId, strandId, status).lastInsertRowid)
  }

  it('lists the facts of the strand in the pinned shape', async () => {
    const s = strand('Facts strand')
    const a = fact(s, 'Synthetic fact one')
    const b = fact(s, 'Synthetic fact two', '1', 'superseded')
    fact(strand('Other'), 'Fact of another strand')
    const res = await call('GET', `/api/strands/${s}/facts`)
    expect(res).toEqual({
      status: 200,
      body: {
        strandId: s,
        facts: [
          { id: a, text: 'Synthetic fact one', createdAt: '2026-01-02T03:04:05.000Z', status: 'active' },
          { id: b, text: 'Synthetic fact two', createdAt: '2026-01-02T03:04:05.000Z', status: 'superseded' },
        ],
        total: 2,
        truncated: false,
        summaries: 0,
        toolCalls: 0,
      },
    })
  })

  it('is an empty list for a strand without facts', async () => {
    const s = strand('Empty')
    expect((await call('GET', `/api/strands/${s}/facts`)).body).toEqual({ strandId: s, facts: [], total: 0, truncated: false, summaries: 0, toolCalls: 0 })
  })

  it('answers 401 without a token and 404 for a foreign strand', async () => {
    const s = strand('Mine')
    fact(s, 'Private synthetic fact')
    expect((await call('GET', `/api/strands/${s}/facts`, undefined, null)).status).toBe(401)
    expect(await call('GET', `/api/strands/${s}/facts`, undefined, otherToken)).toEqual({
      status: 404, body: { error: 'Strand not found', code: 'strand_not_found' },
    })
  })

  it('leaves delete-preview untouched', async () => {
    const s = strand('Preview')
    fact(s, 'Synthetic preview fact')
    const res = await call('GET', `/api/strands/${s}/delete-preview`)
    expect(res.status).toBe(200)
    expect(res.body.facts).toEqual([{ id: expect.any(Number), text: 'Synthetic preview fact' }])
  })
})

describe('GET /api/strands/:id/context recalled[]', () => {
  it('lists recalled messages additively next to the existing fields', async () => {
    const s = strand('Context strand')
    const old = message(s, 'An older synthetic message about the shed')
    logToolCall(db, {
      sessionId: s, toolName: 'recall_message', input: JSON.stringify({ message_id: old }),
      output: JSON.stringify({ content: [{ type: 'text', text: '…' }], details: { messageId: old } }), durationMs: 1,
    })
    const res = await call('GET', `/api/strands/${s}/context`)
    expect(res.status).toBe(200)
    for (const key of ['strandId', 'measurement', 'budget', 'transcript', 'lastCompaction', 'model', 'generatedAt']) {
      expect(res.body).toHaveProperty(key)
    }
    expect(res.body.recalled).toHaveLength(1)
    expect(Object.keys(res.body.recalled[0]).sort()).toEqual(['excerpt', 'messageId', 'recalledAt', 'role', 'source', 'strandId'])
    expect(res.body.recalled[0]).toMatchObject({ messageId: old, strandId: s, role: 'user', excerpt: 'An older synthetic message about the shed', source: 'recall' })
  })

  it('is an empty list without recalls and 404 for a foreign strand', async () => {
    const s = strand('Quiet strand')
    expect((await call('GET', `/api/strands/${s}/context`)).body.recalled).toEqual([])
    expect((await call('GET', `/api/strands/${s}/context`, undefined, otherToken)).status).toBe(404)
    expect((await call('GET', `/api/strands/${s}/context`, undefined, null)).status).toBe(401)
  })
})
