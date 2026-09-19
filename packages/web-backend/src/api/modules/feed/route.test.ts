/**
 * /api/feed (SPEC 6.4) against a real database, a real captures service and a
 * stubbed router model. The feed is per user, so every read path is also
 * checked against a second user's token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, insertFeedItem, SessionManager } from '@axiom/core'
import type { AgentCore, Capture, Database, Decision, FeedItem, ResolvedRouterModel } from '@axiom/core'
import { createFeedRouter } from './route.js'
import { ASK_CONTEXT_BODY_MAX, buildAskCaptureText } from './service.js'
import { createCapturesRouters } from '../captures/route.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let nextAnswers: string[] = []
let turns: Array<{ sessionId: string; text: string }> = []

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-feed-routes-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  const app = express()
  app.use(express.json())
  const captures = createCapturesRouters({
    db,
    getAgentCore: () => agentCore,
    chatEventBus: new ChatEventBus(),
    getTurnRunner: () => ({
      startTurn: (input) => { turns.push({ sessionId: input.sessionId, text: input.text }); return {} },
    }),
    routerChain: () => chain,
    routerComplete: async () => {
      const next = nextAnswers.shift()
      if (next === undefined) throw new Error('router stub has no answer')
      return next
    },
  })
  app.use('/api/captures', captures.captures)
  app.use('/api/feed', createFeedRouter({ db, getCaptureCreator: () => captures.service }))

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res())))
  db.close()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
})

beforeEach(() => {
  db.exec('DELETE FROM feed_items; DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM captures; DELETE FROM router_decisions; DELETE FROM now_set;')
  nextAnswers = []
  turns = []
})

async function api(
  method: string,
  url: string,
  body?: unknown,
  bearer = token,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

function seed(userId: string, over: Partial<Parameters<typeof insertFeedItem>[1]> = {}): FeedItem {
  return insertFeedItem(db, {
    userId,
    kind: 'cron_report',
    title: 'Morning report',
    body: 'Two new mails, nothing urgent',
    taskId: 'task-1',
    agentId: 'main',
    ...over,
  })
}

function itemsOf(body: Record<string, unknown>): FeedItem[] {
  return body.items as FeedItem[]
}

describe('GET /api/feed', () => {
  it('requires authentication', async () => {
    expect((await fetch(`${baseUrl}/api/feed`)).status).toBe(401)
  })

  it('returns the newest items first in the documented shape', async () => {
    seed('1', { title: 'older' })
    seed('1', { title: 'newer', kind: 'task_result', strandId: 's-1' })
    const res = await api('GET', '/api/feed')
    expect(res.status).toBe(200)
    const items = itemsOf(res.body)
    expect(items.map(i => i.title)).toEqual(['newer', 'older'])
    expect(Object.keys(items[0]).sort()).toEqual(
      ['agentId', 'body', 'createdAt', 'id', 'kind', 'readAt', 'strandId', 'taskId', 'title'],
    )
    expect(items[0]).toMatchObject({ kind: 'task_result', strandId: 's-1', taskId: 'task-1', readAt: null })
  })

  it('never shows another user their feed', async () => {
    seed('1', { title: 'mine' })
    seed('2', { title: 'theirs' })
    expect(itemsOf((await api('GET', '/api/feed')).body).map(i => i.title)).toEqual(['mine'])
    expect(itemsOf((await api('GET', '/api/feed', undefined, otherToken)).body).map(i => i.title)).toEqual(['theirs'])
  })

  it('pages forward over since_id in batches', async () => {
    const a = seed('1', { title: 'one' })
    const b = seed('1', { title: 'two' })
    const c = seed('1', { title: 'three' })

    const page1 = itemsOf((await api('GET', `/api/feed?since_id=${a.id}&limit=1`)).body)
    expect(page1.map(i => i.title)).toEqual(['two'])
    const page2 = itemsOf((await api('GET', `/api/feed?since_id=${page1[0].id}&limit=1`)).body)
    expect(page2.map(i => i.title)).toEqual(['three'])
    expect(itemsOf((await api('GET', `/api/feed?since_id=${c.id}`)).body)).toEqual([])
    expect(itemsOf((await api('GET', `/api/feed?since_id=${a.id}`)).body).map(i => i.id)).toEqual([b.id, c.id])
  })

  it('refuses a cursor from another user instead of leaking the gap', async () => {
    const foreign = seed('2')
    const res = await api('GET', `/api/feed?since_id=${foreign.id}`)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_since_id')
  })

  it('filters by kind and by unread_only', async () => {
    seed('1', { kind: 'cron_report', title: 'cron' })
    const task = seed('1', { kind: 'task_result', title: 'task' })
    expect(itemsOf((await api('GET', '/api/feed?kind=cron_report')).body).map(i => i.title)).toEqual(['cron'])
    expect((await api('GET', '/api/feed?kind=nonsense')).body.code).toBe('invalid_kind')

    await api('POST', `/api/feed/${task.id}/read`)
    expect(itemsOf((await api('GET', '/api/feed?unread_only=1')).body).map(i => i.title)).toEqual(['cron'])
  })

  it('rejects a broken limit', async () => {
    expect((await api('GET', '/api/feed?limit=-2')).body.code).toBe('invalid_limit')
  })
})

describe('read state', () => {
  it('is idempotent and keeps the unread count honest', async () => {
    const a = seed('1')
    const b = seed('1')
    expect((await api('GET', '/api/feed/unread-count')).body).toEqual({ count: 2 })

    expect((await api('POST', `/api/feed/${a.id}/read`)).status).toBe(204)
    expect((await api('POST', `/api/feed/${a.id}/read`)).status).toBe(204)
    expect((await api('GET', '/api/feed/unread-count')).body).toEqual({ count: 1 })

    expect((await api('POST', '/api/feed/read-all')).status).toBe(204)
    expect((await api('GET', '/api/feed/unread-count')).body).toEqual({ count: 0 })
    expect((await api('POST', '/api/feed/read-all')).status).toBe(204)
    expect(itemsOf((await api('GET', '/api/feed')).body).every(i => i.readAt !== null)).toBe(true)
    expect(b.readAt).toBeNull()
  })

  it('cannot read, or read away, a foreign item', async () => {
    const mine = seed('1')
    expect((await api('POST', `/api/feed/${mine.id}/read`, undefined, otherToken)).status).toBe(404)
    seed('2')
    await api('POST', '/api/feed/read-all', undefined, otherToken)
    expect((await api('GET', '/api/feed/unread-count')).body).toEqual({ count: 1 })
    expect((await api('POST', '/api/feed/missing-id/read')).status).toBe(404)
  })
})

describe('POST /api/feed/:id/ask', () => {
  it('creates a capture that carries the feed item as context and routes it', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Mailbox')
    const item = seed('1', { title: 'Morning report', body: 'Two new mails, nothing urgent' })
    nextAnswers.push(JSON.stringify({
      action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.9, tags: [], rationale: 'mail',
    }))

    const res = await api('POST', `/api/feed/${item.id}/ask`, { text: 'which mails exactly?' })
    expect(res.status).toBe(201)
    const capture = res.body.capture as Capture
    const decision = res.body.decision as Decision
    expect(capture.text).toContain('which mails exactly?')
    expect(capture.text).toContain('Morning report')
    expect(capture.text).toContain('Two new mails, nothing urgent')
    expect(capture.text).toContain('cron_report')
    expect(capture.source).toBe('feed')
    expect(capture.status).toBe('filed')
    expect(capture.strandId).toBe(strand.id)
    expect(decision.action).toBe('append')
    expect(turns).toEqual([{ sessionId: strand.id, text: capture.text }])

    // The row really landed in the strand, and asking counts as reading.
    const rows = db.prepare('SELECT content, capture_id FROM chat_messages WHERE session_id = ?')
      .all(strand.id) as Array<{ content: string; capture_id: string | null }>
    expect(rows.length).toBe(1)
    expect(rows[0].capture_id).toBe(capture.id)
    expect((await api('GET', '/api/feed/unread-count')).body).toEqual({ count: 0 })
  })

  it('works without a text and keeps the item as the question', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Mailbox')
    const item = seed('1', { title: 'Nightly build failed', body: null })
    nextAnswers.push(JSON.stringify({
      action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.9, tags: [], rationale: 'build',
    }))
    const res = await api('POST', `/api/feed/${item.id}/ask`, {})
    expect(res.status).toBe(201)
    expect((res.body.capture as Capture).text).toContain('Nightly build failed')
  })

  it('refuses a foreign item, an unknown item and a broken text', async () => {
    const mine = seed('1')
    expect((await api('POST', `/api/feed/${mine.id}/ask`, {}, otherToken)).status).toBe(404)
    expect((await api('POST', '/api/feed/nope/ask', {})).status).toBe(404)
    expect((await api('POST', `/api/feed/${mine.id}/ask`, { text: 42 })).body.code).toBe('invalid_text')
    expect(nextAnswers.length).toBe(0)
  })
})

describe('buildAskCaptureText', () => {
  const item = {
    id: 'x', kind: 'cron_report' as const, title: 'Morning report', body: 'Two new mails',
    agentId: 'main', taskId: 't', strandId: null, createdAt: '2026-09-14T06:00:00Z', readAt: null,
  }

  it('puts the question first and the item below it as quoted context', () => {
    expect(buildAskCaptureText(item, 'which mails?')).toBe(
      'which mails?\n\n---\nFeed item (cron_report): Morning report\nTwo new mails',
    )
  })

  it('falls back to the title as the question and drops an empty body', () => {
    expect(buildAskCaptureText({ ...item, body: null }, null)).toBe(
      'About this feed item: Morning report\n\n---\nFeed item (cron_report): Morning report',
    )
  })

  it('shortens a long body so a huge report cannot blow up the capture', () => {
    const text = buildAskCaptureText({ ...item, body: 'x'.repeat(5000) }, 'why?')
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(ASK_CONTEXT_BODY_MAX + 200)
  })
})
