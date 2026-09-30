/**
 * The `attention` field, the `attention=1` / `unread=1` filters and
 * `GET /api/strands/attention-summary` (plan 2026-09-26), wired the way
 * production is: real app, real SessionManager, real database.
 *
 * The test that matters most is "answered through POST /api/interactions ->
 * attention null": it is the one that would catch the badge and the endpoint
 * drifting apart, because it answers through the real endpoint instead of
 * writing the metadata by hand.
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

interface Attention {
  kind: 'interaction' | 'task_question'
  since: string
  prompt: string
  messageId: number | null
  taskId: string | null
}
interface StrandView { id: string; unread: boolean; attention: Attention | null }

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
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-strand-attention-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'bob', 'x', 'user')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  server = http.createServer(createApp({
    db,
    getAgentCore: () => agentCore,
    // The interactions endpoint files the answer and would resume the turn;
    // a stub keeps the test free of an LLM without changing the answer path.
    getTurnRunner: () => ({ startTurn: () => ({}) }),
  } as Parameters<typeof createApp>[0]))
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'alice', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'bob', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM tasks; DELETE FROM sessions;')
})

async function api(method: string, url: string, authToken = token, body?: unknown) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

async function listStrands(query = '', authToken = token): Promise<StrandView[]> {
  const res = await api('GET', `/api/strands${query}`, authToken)
  expect(res.status).toBe(200)
  return res.body.strands as StrandView[]
}

/**
 * Fixtures date themselves relative to the real clock: `attention` drops a
 * question older than `ATTENTION_MAX_AGE_MS` (48 h), so a hard-coded calendar
 * date would quietly turn every fixture stale two days later.
 */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
}

/** The `since` value the API reports for a row inserted with {@link minutesAgo}. */
function isoOf(sqlTimestamp: string): string {
  return `${sqlTimestamp.replace(' ', 'T')}.000Z`
}

function fence(payload: Record<string, unknown>): string {
  return ['```offtangent', JSON.stringify(payload), '```'].join('\n')
}

function choicePayload(id = 'b1', question = 'Hand this to Bob?'): Record<string, unknown> {
  return {
    block: 'choice',
    id,
    question,
    options: [{ id: 'yes', label: 'Hand over to Bob' }, { id: 'stay', label: 'Keep it here' }],
  }
}

function insertBlockMessage(
  sessionId: string,
  payload: Record<string, unknown> = choicePayload(),
  options: { userId?: number; timestamp?: string } = {},
): number {
  const result = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
     VALUES (?, ?, 'assistant', ?, 'main', ?)`,
  ).run(
    sessionId,
    options.userId ?? 1,
    `That is a decision for you.\n\n${fence(payload)}`,
    options.timestamp ?? minutesAgo(60),
  )
  return Number(result.lastInsertRowid)
}

/** A task as the runner leaves it: own session, parent = the strand. */
function insertPausedTask(taskId: string, strandId: string, options: { startedAt?: string; summary?: string } = {}): void {
  const taskSession = `task-session-${taskId}`
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, agent_id, title, parent_session_id)
     VALUES (?, 1, '1', 'web', 'task', 'main', 'Task session', ?)`,
  ).run(taskSession, strandId)
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, status, trigger_type, result_status, result_summary, session_id, started_at)
     VALUES (?, ?, 'work', 'paused', 'user', 'question', ?, ?, ?)`,
  ).run(
    taskId,
    `Task ${taskId}`,
    options.summary ?? 'Should I book the early train?',
    taskSession,
    options.startedAt ?? minutesAgo(120),
  )
}

describe('attention on the strand reads', () => {
  it('carries the open question on the list and on the detail read', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Decision pending')
    const quiet = sessionManager.createThread('1', 'main', 'Nothing open')
    const cardAt = minutesAgo(45)
    const messageId = insertBlockMessage(strand.id, choicePayload(), { timestamp: cardAt })

    const strands = await listStrands()
    const view = strands.find(s => s.id === strand.id)!
    expect(view.attention).toEqual({
      kind: 'interaction',
      since: isoOf(cardAt),
      prompt: 'Hand this to Bob?',
      messageId,
      taskId: null,
    })
    expect(strands.find(s => s.id === quiet.id)!.attention).toBeNull()

    const detail = await api('GET', `/api/strands/${strand.id}`)
    expect(detail.status).toBe(200)
    expect((detail.body.strand as StrandView).attention).toMatchObject({ kind: 'interaction', messageId })
  })

  it('clears the attention after the card is answered through POST /api/interactions', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Decision pending')
    const messageId = insertBlockMessage(strand.id)
    expect((await listStrands()).find(s => s.id === strand.id)!.attention).not.toBeNull()

    const answer = await api('POST', '/api/interactions', token, {
      messageId,
      blockId: 'b1',
      value: 'yes',
      clientMessageId: 'cmid-attention-1',
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ applied: true })

    expect((await listStrands()).find(s => s.id === strand.id)!.attention).toBeNull()

    // And the endpoint agrees in the other direction: a second answer is a 409,
    // i.e. the card really is closed for both.
    const second = await api('POST', '/api/interactions', token, {
      messageId,
      blockId: 'b1',
      value: 'stay',
      clientMessageId: 'cmid-attention-2',
    })
    expect(second.status).toBe(409)
  })

  it('reports a paused task with a question and drops it once the task runs again', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Delegated')
    const startedAt = minutesAgo(150)
    insertPausedTask('task-1', strand.id, { startedAt })

    expect((await listStrands()).find(s => s.id === strand.id)!.attention).toEqual({
      kind: 'task_question',
      since: isoOf(startedAt),
      prompt: 'Should I book the early train?',
      messageId: null,
      taskId: 'task-1',
    })

    // `POST /api/tasks/:id/reply` resumes the task: status back to running.
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = 'task-1'").run()
    expect((await listStrands()).find(s => s.id === strand.id)!.attention).toBeNull()
  })

  it('lets the oldest source win when a card and a task are both open', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Two open things')
    const startedAt = minutesAgo(300)
    insertPausedTask('task-2', strand.id, { startedAt })
    insertBlockMessage(strand.id, choicePayload(), { timestamp: minutesAgo(30) })

    expect((await listStrands()).find(s => s.id === strand.id)!.attention).toMatchObject({
      kind: 'task_question',
      taskId: 'task-2',
      since: isoOf(startedAt),
    })
  })

  it('renders a long question as one truncated line', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Long question')
    insertBlockMessage(strand.id, choicePayload('b1', `Should we\n\n  ${'y'.repeat(300)}`))

    const attention = (await listStrands()).find(s => s.id === strand.id)!.attention!
    expect(attention.prompt.length).toBe(120)
    expect(attention.prompt).not.toContain('\n')
    expect(attention.prompt.endsWith('…')).toBe(true)
  })

  it('never leaks a foreign strand', async () => {
    const foreign = sessionManager.createThread('2', 'main', "Bob's strand")
    insertBlockMessage(foreign.id, choicePayload(), { userId: 2 })

    expect((await listStrands()).some(s => s.id === foreign.id)).toBe(false)
    expect((await api('GET', `/api/strands/${foreign.id}`)).status).toBe(404)
    expect((await api('GET', '/api/strands/attention-summary')).body).toMatchObject({
      awaiting: 0,
      firstAwaitingStrandId: null,
    })
    // Bob sees his own.
    expect((await api('GET', '/api/strands/attention-summary', otherToken)).body).toMatchObject({ awaiting: 1 })
  })
})

describe('staleness reaches the reads, the filter and the summary alike', () => {
  it('drops a superseded or aged card everywhere and reports the newest open card', async () => {
    // 1. superseded by a later user turn.
    const answeredInProse = sessionManager.createThread('1', 'main', 'Answered in prose')
    insertBlockMessage(answeredInProse.id, choicePayload('b-prose'), { timestamp: minutesAgo(90) })
    db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
       VALUES (?, 1, 'user', 'keep it here, I will do it', 'main', ?)`,
    ).run(answeredInProse.id, minutesAgo(80))

    // 2. past the 48 h age limit.
    const aged = sessionManager.createThread('1', 'main', 'Old question')
    insertBlockMessage(aged.id, choicePayload('b-aged'), { timestamp: minutesAgo(49 * 60) })

    // 3. two open cards: the newest one represents the strand.
    const twoCards = sessionManager.createThread('1', 'main', 'Two open cards')
    insertBlockMessage(twoCards.id, choicePayload('b-old', 'Older question?'), { timestamp: minutesAgo(70) })
    const newestAt = minutesAgo(20)
    const newestId = insertBlockMessage(twoCards.id, choicePayload('b-new', 'Newer question?'), {
      timestamp: newestAt,
    })

    const strands = await listStrands()
    expect(strands.find(s => s.id === answeredInProse.id)!.attention).toBeNull()
    expect(strands.find(s => s.id === aged.id)!.attention).toBeNull()
    expect(strands.find(s => s.id === twoCards.id)!.attention).toMatchObject({
      messageId: newestId,
      prompt: 'Newer question?',
      since: isoOf(newestAt),
    })

    // The filter and the summary derive from the same function, so they agree.
    expect((await listStrands('?attention=1')).map(s => s.id)).toEqual([twoCards.id])
    expect((await api('GET', '/api/strands/attention-summary')).body).toMatchObject({
      awaiting: 1,
      firstAwaitingStrandId: twoCards.id,
    })
  })

  it('still accepts the answer for a card that lost its badge — POST /api/interactions is unchanged', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Old but answerable')
    const messageId = insertBlockMessage(strand.id, choicePayload('b-old-answerable'), {
      timestamp: minutesAgo(10 * 24 * 60),
    })
    expect((await listStrands()).find(s => s.id === strand.id)!.attention).toBeNull()

    const answer = await api('POST', '/api/interactions', token, {
      messageId,
      blockId: 'b-old-answerable',
      value: 'yes',
      clientMessageId: 'cmid-stale-but-answerable',
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ applied: true })
  })
})

describe('GET /api/strands filters', () => {
  it('filters by attention and by unread, and combines both', async () => {
    const awaiting = sessionManager.createThread('1', 'main', 'Awaiting + unread')
    const awaitingRead = sessionManager.createThread('1', 'main', 'Awaiting, already read')
    const unreadOnly = sessionManager.createThread('1', 'main', 'Only unread')
    const quiet = sessionManager.createThread('1', 'main', 'Quiet')

    insertBlockMessage(awaiting.id)
    insertBlockMessage(awaitingRead.id)
    db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
       VALUES (?, 1, 'assistant', 'here you go', 'main', ?)`,
    ).run(unreadOnly.id, minutesAgo(60))
    db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
       VALUES (?, 1, 'user', 'note to self', 'main', ?)`,
    ).run(quiet.id, minutesAgo(60))
    expect((await api('POST', `/api/strands/${awaitingRead.id}/read`)).status).toBe(204)

    const byAttention = (await listStrands('?attention=1')).map(s => s.id).sort()
    expect(byAttention).toEqual([awaiting.id, awaitingRead.id].sort())

    const byUnread = (await listStrands('?unread=1')).map(s => s.id).sort()
    expect(byUnread).toEqual([awaiting.id, unreadOnly.id].sort())

    const both = (await listStrands('?attention=1&unread=1')).map(s => s.id)
    expect(both).toEqual([awaiting.id])

    expect((await listStrands()).length).toBe(4)
  })

  it('paginates the filtered list correctly', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const strand = sessionManager.createThread('1', 'main', `Awaiting ${i}`)
      insertBlockMessage(strand.id)
      ids.push(strand.id)
      // A strand without a question between every awaiting one: a page that
      // was filtered after the fact would be short here.
      const noise = sessionManager.createThread('1', 'main', `Noise ${i}`)
      db.prepare(
        `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
         VALUES (?, 1, 'assistant', 'nothing to decide', 'main', ?)`,
      ).run(noise.id, minutesAgo(60))
    }

    const first = await listStrands('?attention=1&limit=2&offset=0')
    const second = await listStrands('?attention=1&limit=2&offset=2')
    const third = await listStrands('?attention=1&limit=2&offset=4')
    expect(first.length).toBe(2)
    expect(second.length).toBe(2)
    expect(third.length).toBe(1)

    const seen = [...first, ...second, ...third].map(s => s.id)
    expect(new Set(seen).size).toBe(5)
    expect(seen.sort()).toEqual([...ids].sort())
    expect(seen.every(id => ids.includes(id))).toBe(true)
  })

  it('rejects a filter value that is not a boolean instead of silently listing everything', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Quiet')
    expect(strand.id).toBeTruthy()

    const res = await api('GET', '/api/strands?attention=maybe')
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'invalid_attention' })

    const unreadRes = await api('GET', '/api/strands?unread=perhaps')
    expect(unreadRes.status).toBe(400)
    expect(unreadRes.body).toMatchObject({ code: 'invalid_unread' })

    // `0` is a valid value and means "no filter".
    expect((await listStrands('?attention=0')).length).toBe(1)
  })

  it('excludes archived strands from the attention filter by default', async () => {
    const archived = sessionManager.createThread('1', 'main', 'Archived with a question')
    insertBlockMessage(archived.id)
    sessionManager.updateThread('1', archived.id, { archived: true })

    expect((await listStrands('?attention=1')).length).toBe(0)
    expect((await listStrands('?attention=1&include_archived=1')).map(s => s.id)).toEqual([archived.id])
  })
})

describe('GET /api/strands/attention-summary', () => {
  it('counts beyond the 100 per page cap and ignores archived and foreign strands', async () => {
    // 120 strands with an open card: more than one page of the list endpoint.
    const awaitingIds: string[] = []
    for (let i = 0; i < 120; i++) {
      const strand = sessionManager.createThread('1', 'main', `Awaiting ${i}`)
      insertBlockMessage(strand.id, choicePayload(`b-${i}`, `Question ${i}?`), {
        timestamp: minutesAgo(120 + i),
      })
      awaitingIds.push(strand.id)
    }
    // The oldest question of all, in a strand created last.
    const oldest = sessionManager.createThread('1', 'main', 'Oldest question')
    insertBlockMessage(oldest.id, choicePayload('b-oldest', 'Oldest?'), { timestamp: minutesAgo(600) })

    // Archived with a question: not counted.
    const archived = sessionManager.createThread('1', 'main', 'Archived')
    insertBlockMessage(archived.id, choicePayload('b-arch', 'Archived question?'))
    sessionManager.updateThread('1', archived.id, { archived: true })

    // Foreign: not counted.
    const foreign = sessionManager.createThread('2', 'main', "Bob's")
    insertBlockMessage(foreign.id, choicePayload('b-bob', 'Bob question?'), { userId: 2 })

    // One extra strand that is only unread.
    const unread = sessionManager.createThread('1', 'main', 'Only unread')
    db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
       VALUES (?, 1, 'assistant', 'answer', 'main', ?)`,
    ).run(unread.id, minutesAgo(60))

    // The list caps a page at 100 even when asked for more — which is exactly
    // why the summary endpoint exists.
    const page = await listStrands('?limit=500')
    expect(page.length).toBe(100)

    const res = await api('GET', '/api/strands/attention-summary')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      awaiting: 121,
      // Every strand with a block message is unread too (assistant message,
      // never read) — 121 of those plus the unread-only one.
      unread: 122,
      firstAwaitingStrandId: oldest.id,
    })
  })

  it('answers zero for a user without strands and is not swallowed by /:id', async () => {
    const res = await api('GET', '/api/strands/attention-summary')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ awaiting: 0, unread: 0, firstAwaitingStrandId: null })
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/strands/attention-summary`)
    expect(res.status).toBe(401)
  })
})
