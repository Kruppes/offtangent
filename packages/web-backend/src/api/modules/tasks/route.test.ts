import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Database, Task } from '@axiom/core'
import { initDatabase, initTasksTable, TaskStore } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tasks-route-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  initTasksTable(db)

  server = http.createServer(createApp({ db }))
  await new Promise<void>((resolve) => server.listen(0, resolve))

  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))

  if (previousDataDir === undefined) {
    delete process.env.DATA_DIR
  } else {
    process.env.DATA_DIR = previousDataDir
  }

  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.prepare('DELETE FROM tool_calls').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
})

function authHeaders() {
  return { Authorization: `Bearer ${token}` }
}

function createTask(input?: Partial<{
  name: string
  prompt: string
  triggerType: Task['triggerType']
  triggerSourceId: string
  sessionId: string
  provider: string
  model: string
  isDefaultModel: boolean
}>) {
  const store = new TaskStore(db)
  return store.create({
    name: input?.name ?? 'Task',
    prompt: input?.prompt ?? 'Do something',
    triggerType: input?.triggerType ?? 'user',
    triggerSourceId: input?.triggerSourceId,
    sessionId: input?.sessionId,
    provider: input?.provider,
    model: input?.model,
    isDefaultModel: input?.isDefaultModel,
  })
}

describe('tasks route module', () => {
  it('lists tasks with pagination and filters', async () => {
    const store = new TaskStore(db)
    const runningTask = createTask({ name: 'Running task', triggerType: 'user' })
    const completedTask = createTask({ name: 'Completed task', triggerType: 'agent' })

    store.update(completedTask.id, {
      status: 'completed',
      resultStatus: 'completed',
      completedAt: '2026-03-27 12:00:00',
    })

    const res = await fetch(`${baseUrl}/api/tasks?page=1&limit=1&status=completed`, {
      headers: authHeaders(),
    })

    const body = await res.json() as {
      tasks: Task[]
      pagination: { page: number; limit: number; total: number; totalPages: number }
    }

    expect(res.status).toBe(200)
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]?.id).toBe(completedTask.id)
    expect(body.pagination).toEqual({
      page: 1,
      limit: 1,
      total: 1,
      totalPages: 1,
    })
    expect(body.tasks[0]?.id).not.toBe(runningTask.id)
  })

  it('returns provider filter options from historical task rows in the selected date range', async () => {
    const defaultTask = createTask({
      name: 'Default task',
      provider: 'ChatGPT Plus',
      model: 'gpt-5.4-mini',
      isDefaultModel: true,
    })
    const explicitTask = createTask({
      name: 'Explicit task',
      provider: 'OpenAI GPT-5.4',
      model: 'gpt-5.4',
      isDefaultModel: false,
    })
    const explicitDefaultProviderTask = createTask({
      name: 'Explicit default provider task',
      provider: 'ChatGPT Plus',
      model: 'gpt-5.4-mini',
      isDefaultModel: false,
    })
    const outsideRangeTask = createTask({
      name: 'Outside task',
      provider: 'Old Provider',
      model: 'old-model',
      isDefaultModel: false,
    })

    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-04-14 23:00:00', defaultTask.id)
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-04-09 23:00:00', explicitTask.id)
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-04-14 23:30:00', explicitDefaultProviderTask.id)
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-03-31 23:00:00', outsideRangeTask.id)

    const res = await fetch(`${baseUrl}/api/tasks?created_from=2026-04-01&created_to=2026-04-28`, {
      headers: authHeaders(),
    })

    const body = await res.json() as {
      providerOptions: Array<{ provider: string | null; model: string | null; isDefaultModel: boolean | null }>
    }

    expect(res.status).toBe(200)
    expect(body.providerOptions.filter(option =>
      option.provider === 'ChatGPT Plus' && option.model === 'gpt-5.4-mini',
    )).toEqual([{
      provider: 'ChatGPT Plus',
      model: 'gpt-5.4-mini',
      isDefaultModel: true,
    }])
    expect(body.providerOptions).toContainEqual({
      provider: 'OpenAI GPT-5.4',
      model: 'gpt-5.4',
      isDefaultModel: false,
    })
    expect(body.providerOptions).not.toContainEqual({
      provider: 'Old Provider',
      model: 'old-model',
      isDefaultModel: false,
    })
  })

  it('returns 400 for invalid filters', async () => {
    const res = await fetch(`${baseUrl}/api/tasks?status=not-a-valid-status`, {
      headers: authHeaders(),
    })

    const body = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toContain('Invalid status filter')
  })

  it('returns 400 when the created date range is inverted', async () => {
    const res = await fetch(`${baseUrl}/api/tasks?created_from=2026-04-28&created_to=2026-04-01`, {
      headers: authHeaders(),
    })

    const body = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toContain('created_to must be greater than or equal to created_from')
  })

  it('returns 400 when a created date is not a real calendar date', async () => {
    const res = await fetch(`${baseUrl}/api/tasks?created_from=2026-04-31`, {
      headers: authHeaders(),
    })

    const body = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toContain('Invalid created_from filter')
  })

  it('returns task details and 404 for missing task', async () => {
    const task = createTask({ name: 'Detail task' })

    const getRes = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      headers: authHeaders(),
    })

    const getBody = await getRes.json() as { task: Task }

    expect(getRes.status).toBe(200)
    expect(getBody.task.id).toBe(task.id)
    expect(getBody.task.name).toBe('Detail task')

    const missingRes = await fetch(`${baseUrl}/api/tasks/missing-task-id`, {
      headers: authHeaders(),
    })

    expect(missingRes.status).toBe(404)
  })

  it('returns merged task events in chronological order', async () => {
    const task = createTask({ name: 'Events task', sessionId: 'task-events-session' })

    db.prepare(
      'INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'task-events-session',
      'bash',
      '{"command":"ls"}',
      '{"stdout":"file.txt"}',
      20,
      'success',
      '2026-03-27 10:00:00',
    )

    db.prepare(
      'INSERT INTO chat_messages (session_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'task-events-session',
      'system',
      'System note',
      null,
      '2026-03-27 10:00:01',
    )

    db.prepare(
      'INSERT INTO chat_messages (session_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'task-events-session',
      'assistant',
      'Assistant response',
      JSON.stringify({ thinking: 'step by step' }),
      '2026-03-27 10:00:02',
    )

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
      headers: authHeaders(),
    })

    const body = await res.json() as {
      task: { id: string; name: string; status: string }
      events: Array<{ type: string; timestamp: string; role?: string; toolName?: string }>
    }

    expect(res.status).toBe(200)
    expect(body.task.id).toBe(task.id)
    expect(body.events).toHaveLength(3)
    expect(body.events.map(event => event.type)).toEqual(['tool_call', 'message', 'message'])
    expect(body.events[0]?.toolName).toBe('bash')
    expect(body.events[1]?.role).toBe('system')
    expect(body.events[2]?.role).toBe('assistant')
    // Unambiguous on the wire: ISO-8601 with an explicit UTC marker, for both
    // event sources. The stored value is `2026-03-27 10:00:00` (UTC, naked).
    for (const event of body.events) {
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    expect(body.events[0]?.timestamp).toBe('2026-03-27T10:00:00.000Z')
  })

  it('interleaves tool calls and messages that share one second by their real order', async () => {
    const task = createTask({ name: 'Same second task', sessionId: 'task-events-tie' })
    const second = '2026-03-27 10:00:00'

    const insertTool = db.prepare(
      'INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const insertMessage = db.prepare(
      'INSERT INTO chat_messages (session_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)',
    )

    insertMessage.run('task-events-tie', 'assistant', 'first', null, second)
    insertMessage.run('task-events-tie', 'assistant', 'second', null, second)
    insertTool.run('task-events-tie', 'bash', '{}', '{}', 1, 'success', second)
    insertMessage.run('task-events-tie', 'assistant', 'third', null, second)

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, { headers: authHeaders() })
    const body = await res.json() as { events: Array<{ type: string; content?: string }> }

    expect(res.status).toBe(200)
    // Same instant everywhere: the sort is stable, so the messages keep the
    // `ORDER BY timestamp, id` order they came back in. Before the fix a
    // string compare of ISO against naked timestamps pushed every message
    // behind every tool call.
    expect(body.events.filter(e => e.type === 'message').map(e => e.content))
      .toEqual(['first', 'second', 'third'])
    expect(body.events).toHaveLength(4)
  })

  it('keeps two tool calls of the same second in the order they ran', async () => {
    const task = createTask({ name: 'Tool tie task', sessionId: 'task-events-tools' })
    const insertTool = db.prepare(
      'INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insertTool.run('task-events-tools', 'read_file', '{}', '{}', 1, 'success', '2026-03-27 10:00:00')
    insertTool.run('task-events-tools', 'shell', '{}', '{}', 1, 'success', '2026-03-27 10:00:00')
    insertTool.run('task-events-tools', 'write_file', '{}', '{}', 1, 'success', '2026-03-27 10:00:00')

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, { headers: authHeaders() })
    const body = await res.json() as { events: Array<{ toolName?: string }> }

    expect(body.events.map(e => e.toolName)).toEqual(['read_file', 'shell', 'write_file'])
  })

  it('does not let a normalized message jump behind an older tool call', async () => {
    const task = createTask({ name: 'Mixed format task', sessionId: 'task-events-mixed' })

    db.prepare(
      'INSERT INTO chat_messages (session_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run('task-events-mixed', 'assistant', 'early answer', null, '2026-03-27 10:00:00')
    db.prepare(
      'INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('task-events-mixed', 'bash', '{}', '{}', 1, 'success', '2026-03-27 10:00:05')

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, { headers: authHeaders() })
    const body = await res.json() as { events: Array<{ type: string }> }

    expect(body.events.map(e => e.type)).toEqual(['message', 'tool_call'])
  })

  /**
   * Incremental timeline reads. The app polls this endpoint every 15 s and
   * used to get the whole run back every time, tool payloads included.
   * `since` is a pair of row ids (`t<toolCallId>-m<messageId>`) because the
   * two source tables are append-only with AUTOINCREMENT ids, while their
   * `timestamp` has second resolution and ties across tables.
   */
  describe('events ?since=', () => {
    function insertTool(sessionId: string, name: string, timestamp: string) {
      db.prepare(
        'INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(sessionId, name, '{}', '{}', 1, 'success', timestamp)
    }

    function insertMessage(sessionId: string, content: string, timestamp: string, role = 'assistant') {
      db.prepare(
        'INSERT INTO chat_messages (session_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)',
      ).run(sessionId, role, content, null, timestamp)
    }

    async function readEvents(taskId: string, since?: string) {
      const url = since === undefined
        ? `${baseUrl}/api/tasks/${taskId}/events`
        : `${baseUrl}/api/tasks/${taskId}/events?since=${encodeURIComponent(since)}`
      const res = await fetch(url, { headers: authHeaders() })
      const body = await res.json() as {
        events: Array<{ type: string; content?: string; toolName?: string }>
        nextSince?: string
        task?: { id: string }
        error?: string
      }
      return { res, body }
    }

    it('returns the full timeline and a cursor when since is omitted', async () => {
      const task = createTask({ name: 'Since task', sessionId: 'since-full' })
      insertTool('since-full', 'bash', '2026-03-27 10:00:00')
      insertMessage('since-full', 'one', '2026-03-27 10:00:01')

      const { res, body } = await readEvents(task.id)
      expect(res.status).toBe(200)
      expect(body.events).toHaveLength(2)
      expect(body.nextSince).toMatch(/^t\d+-m\d+$/)
      expect(body.task?.id).toBe(task.id)
    })

    it('returns only the events written after the cursor', async () => {
      const task = createTask({ name: 'Since task', sessionId: 'since-delta' })
      insertTool('since-delta', 'bash', '2026-03-27 10:00:00')
      insertMessage('since-delta', 'first', '2026-03-27 10:00:01')

      const first = await readEvents(task.id)
      const cursor = first.body.nextSince as string

      insertTool('since-delta', 'read_file', '2026-03-27 10:00:02')
      insertMessage('since-delta', 'second', '2026-03-27 10:00:03')

      const { res, body } = await readEvents(task.id, cursor)
      expect(res.status).toBe(200)
      expect(body.events).toHaveLength(2)
      expect(body.events[0]?.toolName).toBe('read_file')
      expect(body.events[1]?.content).toBe('second')
      // The old events are gone from the payload, not just from the view.
      expect(JSON.stringify(body.events)).not.toContain('first')
      expect(body.nextSince).not.toBe(cursor)
      // The task block is still there — a poll also refreshes status/usage.
      expect(body.task?.id).toBe(task.id)
    })

    it('returns an empty list for the cursor of the last event', async () => {
      const task = createTask({ name: 'Since task', sessionId: 'since-end' })
      insertTool('since-end', 'bash', '2026-03-27 10:00:00')
      insertMessage('since-end', 'last', '2026-03-27 10:00:01')

      const first = await readEvents(task.id)
      const cursor = first.body.nextSince as string

      const { res, body } = await readEvents(task.id, cursor)
      expect(res.status).toBe(200)
      expect(body.events).toEqual([])
      // A poll that finds nothing must not push the cursor back.
      expect(body.nextSince).toBe(cursor)
    })

    it('walks the timeline event by event without loss or repetition', async () => {
      const task = createTask({ name: 'Since task', sessionId: 'since-walk' })
      insertMessage('since-walk', 'm1', '2026-03-27 10:00:00')
      insertTool('since-walk', 't1', '2026-03-27 10:00:00')
      insertMessage('since-walk', 'm2', '2026-03-27 10:00:01')
      insertTool('since-walk', 't2', '2026-03-27 10:00:02')

      const full = await readEvents(task.id)
      const expected = full.body.events.map(e => e.toolName ?? e.content)
      expect(expected).toHaveLength(4)

      // Same session, read incrementally from zero: every event exactly once,
      // and the concatenation is the full timeline.
      const seen: Array<string | undefined> = []
      let cursor = 't0-m0'
      for (let i = 0; i < 10; i++) {
        const step = await readEvents(task.id, cursor)
        expect(step.res.status).toBe(200)
        seen.push(...step.body.events.map(e => e.toolName ?? e.content))
        if (step.body.nextSince === cursor) break
        cursor = step.body.nextSince as string
      }
      expect(seen).toEqual(expected)
    })

    it('ignores rows of other sessions when advancing the cursor', async () => {
      const task = createTask({ name: 'Since task', sessionId: 'since-mine' })
      insertMessage('since-mine', 'mine', '2026-03-27 10:00:00')
      const first = await readEvents(task.id)
      const cursor = first.body.nextSince as string

      // Another task writes a lot in between: the cursor of this task must
      // not jump over its own next event.
      insertMessage('since-other', 'not mine', '2026-03-27 10:00:01')
      insertTool('since-other', 'bash', '2026-03-27 10:00:01')
      insertMessage('since-mine', 'mine too', '2026-03-27 10:00:02')

      const { body } = await readEvents(task.id, cursor)
      expect(body.events.map(e => e.content)).toEqual(['mine too'])
    })

    it('skips user and tool rows but still advances past them', async () => {
      const task = createTask({ name: 'Since task', sessionId: 'since-roles' })
      insertMessage('since-roles', 'assistant one', '2026-03-27 10:00:00')
      const first = await readEvents(task.id)
      const cursor = first.body.nextSince as string

      insertMessage('since-roles', 'user text', '2026-03-27 10:00:01', 'user')
      insertMessage('since-roles', 'tool text', '2026-03-27 10:00:01', 'tool')

      const second = await readEvents(task.id, cursor)
      expect(second.body.events).toEqual([])
      expect(second.body.nextSince).not.toBe(cursor)

      insertMessage('since-roles', 'assistant two', '2026-03-27 10:00:02')
      const third = await readEvents(task.id, second.body.nextSince as string)
      expect(third.body.events.map(e => e.content)).toEqual(['assistant two'])
    })

    it('answers 400 for an invalid cursor instead of falling back to everything', async () => {
      const task = createTask({ name: 'Since task', sessionId: 'since-bad' })
      insertMessage('since-bad', 'secret payload', '2026-03-27 10:00:00')

      for (const bad of ['yesterday', '2026-03-27T10:00:00Z', '42', 't1', 'm1', 't1-m', 't-1-m2', 't1_m2', '', 'tNaN-m1']) {
        const { res, body } = await readEvents(task.id, bad)
        expect(res.status, `since=${bad}`).toBe(400)
        expect(body.error).toContain('Invalid since cursor')
        expect(JSON.stringify(body)).not.toContain('secret payload')
      }
    })

    it('answers 400 when since is repeated', async () => {
      const task = createTask({ name: 'Since task', sessionId: 'since-dup' })
      const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events?since=t0-m0&since=t1-m1`, {
        headers: authHeaders(),
      })
      expect(res.status).toBe(400)
    })

    it('rejects a bad cursor uniformly, for any id', async () => {
      // The validation runs before the lookup, so the 400 says nothing about
      // whether the id exists — with a valid cursor the same id is a 404.
      const res = await fetch(`${baseUrl}/api/tasks/does-not-exist/events?since=garbage`, {
        headers: authHeaders(),
      })
      expect(res.status).toBe(400)
      const other = await fetch(`${baseUrl}/api/tasks/does-not-exist/events?since=t0-m0`, {
        headers: authHeaders(),
      })
      expect(other.status).toBe(404)
    })

    it('returns an empty timeline and a zero cursor for a legacy task without a session', async () => {
      const task = createTask({ name: 'Legacy task' })
      const { res, body } = await readEvents(task.id)
      expect(res.status).toBe(200)
      expect(body.events).toEqual([])
      expect(body.nextSince).toBe('t0-m0')
    })
  })

  it('falls back to raw string when task message metadata contains malformed JSON', async () => {
    const task = createTask({ name: 'Corrupted metadata task', sessionId: 'task-events-corrupt' })

    db.prepare(
      'INSERT INTO chat_messages (session_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'task-events-corrupt',
      'assistant',
      'Assistant response',
      '{"thinking":',
      '2026-03-27 10:00:02',
    )

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
      headers: authHeaders(),
    })

    const body = await res.json() as {
      task: { id: string }
      events: Array<{ type: string; role?: string; metadata?: unknown }>
    }

    // A single malformed metadata row must not crash the endpoint; instead the
    // service falls back to the raw string so the rest of the timeline loads.
    expect(res.status).toBe(200)
    expect(body.events).toHaveLength(1)
    expect(body.events[0]?.type).toBe('message')
    expect(body.events[0]?.role).toBe('assistant')
    expect(body.events[0]?.metadata).toBe('{"thinking":')
  })

  it('kills running tasks and prevents killing non-running tasks', async () => {
    const store = new TaskStore(db)
    const runningTask = createTask({ name: 'Kill me' })

    const killRes = await fetch(`${baseUrl}/api/tasks/${runningTask.id}/kill`, {
      method: 'POST',
      headers: authHeaders(),
    })

    const killBody = await killRes.json() as { task: Task }

    expect(killRes.status).toBe(200)
    expect(killBody.task.status).toBe('failed')
    expect(killBody.task.resultSummary).toBe('Killed by user from web UI')
    expect(killBody.task.completedAt).toBeTruthy()

    const completedTask = createTask({ name: 'Already done' })
    store.update(completedTask.id, {
      status: 'completed',
      resultStatus: 'completed',
      completedAt: '2026-03-27 10:00:00',
    })

    const blockedKillRes = await fetch(`${baseUrl}/api/tasks/${completedTask.id}/kill`, {
      method: 'POST',
      headers: authHeaders(),
    })

    const blockedKillBody = await blockedKillRes.json() as { error: string }

    expect(blockedKillRes.status).toBe(400)
    expect(blockedKillBody.error).toBe("Cannot kill task with status 'completed'. Only running tasks can be killed.")
  })

  describe('restart endpoint', () => {
    it('returns 404 when the original task does not exist', async () => {
      const res = await fetch(`${baseUrl}/api/tasks/nope/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(404)
    })

    it('returns 409 when the original task is still running', async () => {
      const task = createTask({ name: 'Still running' })

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const body = await res.json() as { error: string }
      expect(res.status).toBe(409)
      expect(body.error).toContain("status 'running'")
      expect(body.error).toContain('Kill the task first')
    })

    it('returns 409 when the original task is paused', async () => {
      const store = new TaskStore(db)
      const task = createTask({ name: 'Paused task' })
      store.update(task.id, { status: 'paused', resultStatus: 'question' })

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(409)
    })

    it('returns 400 when the body has invalid fields', async () => {
      const store = new TaskStore(db)
      const task = createTask({ name: 'Failed task' })
      store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        completedAt: '2026-03-27 10:00:00',
      })

      const badName = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      })
      expect(badName.status).toBe(400)

      const badDuration = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDurationMinutes: -5 }),
      })
      expect(badDuration.status).toBe(400)

      const badDurationZero = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDurationMinutes: 0 }),
      })
      expect(badDurationZero.status).toBe(400)
    })

    it('returns 503 when the task runtime is not available', async () => {
      // `createApp({ db })` in this test file does not inject a TaskRuntime,
      // so every valid restart attempt should land on 503. This also
      // exercises the guard path before the runner is touched.
      const store = new TaskStore(db)
      const task = createTask({ name: 'Completed task' })
      store.update(task.id, {
        status: 'completed',
        resultStatus: 'completed',
        completedAt: '2026-03-27 10:00:00',
      })

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const body = await res.json() as { error: string }
      expect(res.status).toBe(503)
      expect(body.error).toContain('runtime is not available')
    })
  })
  /**
   * Ownership (SPEC: no existence oracle). A task has no `user_id`; it is
   * attributed through its session lineage — the same walk that decides who
   * receives its result. A foreign task answers 404, exactly like a task id
   * that does not exist, so an attacker cannot enumerate ids.
   */
  describe('ownership', () => {
    const userToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
    const otherUserToken = generateAccessToken({ userId: 3, username: 'third', role: 'user' })

    function userHeaders(t = userToken) {
      return { Authorization: `Bearer ${t}` }
    }

    /** A task whose session lineage ends at an interactive session of `userId`. */
    function ownedTask(userId: number, suffix: string): Task {
      const strandId = `strand-own-${suffix}`
      const taskSessionId = `tsess-own-${suffix}`
      db.prepare(
        `INSERT OR REPLACE INTO sessions (id, source, type, parent_session_id, session_user)
         VALUES (?, 'web', 'interactive', NULL, ?)`,
      ).run(strandId, String(userId))
      db.prepare(
        `INSERT OR REPLACE INTO sessions (id, source, type, parent_session_id, session_user)
         VALUES (?, 'system', 'task', ?, ?)`,
      ).run(taskSessionId, strandId, String(userId))
      return createTask({ name: `Owned by ${userId}`, sessionId: taskSessionId })
    }

    it('serves a task to the user its lineage belongs to', async () => {
      const task = ownedTask(2, 'a')
      const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers: userHeaders() })
      expect(res.status).toBe(200)
      const body = await res.json() as { task: { id: string } }
      expect(body.task.id).toBe(task.id)
    })

    it('answers 404 (not 403) for another user\'s task', async () => {
      const task = ownedTask(2, 'b')
      const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers: userHeaders(otherUserToken) })
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Task not found')
    })

    it('hides another user\'s task timeline and kill button', async () => {
      const task = ownedTask(2, 'c')
      db.prepare(
        `INSERT INTO chat_messages (session_id, role, content, metadata, timestamp)
         VALUES (?, 'assistant', 'secret', NULL, '2026-03-27 10:00:00')`,
      ).run('tsess-own-c')

      const events = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, { headers: userHeaders(otherUserToken) })
      expect(events.status).toBe(404)
      expect(await events.text()).not.toContain('secret')

      const kill = await fetch(`${baseUrl}/api/tasks/${task.id}/kill`, { method: 'POST', headers: userHeaders(otherUserToken) })
      expect(kill.status).toBe(404)

      const restart = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...userHeaders(otherUserToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(restart.status).toBe(404)
    })

    it('keeps the timeline readable for the owner', async () => {
      const task = ownedTask(2, 'd')
      db.prepare(
        `INSERT INTO chat_messages (session_id, role, content, metadata, timestamp)
         VALUES (?, 'assistant', 'mine', NULL, '2026-03-27 10:00:00')`,
      ).run('tsess-own-d')
      const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, { headers: userHeaders() })
      expect(res.status).toBe(200)
      const body = await res.json() as { events: Array<{ content?: string }>; task: { promptTokens: number } }
      expect(body.events.some(e => e.content === 'mine')).toBe(true)
      // The detail view gets the usage numbers without a second request.
      expect(body.task.promptTokens).toBe(0)
    })

    it('hides a system task (cronjob/heartbeat: no human owner) from a normal user, but not from an admin', async () => {
      const task = createTask({ name: 'Nightly', triggerType: 'cronjob', sessionId: 'tsess-cron-none' })
      db.prepare(
        `INSERT OR REPLACE INTO sessions (id, source, type, parent_session_id, session_user)
         VALUES ('tsess-cron-none', 'system', 'task', NULL, NULL)`,
      ).run()

      const asUser = await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers: userHeaders() })
      expect(asUser.status).toBe(404)

      const asAdmin = await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers: authHeaders() })
      expect(asAdmin.status).toBe(200)
    })

    it('hides a task that has no session at all from a normal user', async () => {
      const task = createTask({ name: 'Sessionless' })
      const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers: userHeaders() })
      expect(res.status).toBe(404)
    })

    /**
     * A task that a task delegated. Its own session is an orphan (the
     * background task tools pass `parentSessionId = null` on purpose), so
     * the only link back to the human is `tasks.trigger_source_id`.
     * Reproduces the live measurement: parent 200, child 404.
     */
    function subTaskOf(parent: Task, suffix: string): Task {
      const childSessionId = `tsess-child-${suffix}`
      db.prepare(
        `INSERT OR REPLACE INTO sessions (id, source, type, parent_session_id, session_user, user_id)
         VALUES (?, 'system', 'task', NULL, NULL, NULL)`,
      ).run(childSessionId)
      return createTask({
        name: `Sub-task of ${parent.id}`,
        triggerType: 'agent',
        triggerSourceId: parent.id,
        sessionId: childSessionId,
      })
    }

    it('serves a sub-task of the user\'s own task to that user', async () => {
      const parent = ownedTask(2, 'sub-a')
      const child = subTaskOf(parent, 'sub-a')

      const parentRes = await fetch(`${baseUrl}/api/tasks/${parent.id}`, { headers: userHeaders() })
      expect(parentRes.status).toBe(200)

      const childRes = await fetch(`${baseUrl}/api/tasks/${child.id}`, { headers: userHeaders() })
      expect(childRes.status).toBe(200)
      const body = await childRes.json() as { task: { id: string } }
      expect(body.task.id).toBe(child.id)
    })

    it('serves the timeline of a sub-task of the user\'s own task', async () => {
      const parent = ownedTask(2, 'sub-b')
      const child = subTaskOf(parent, 'sub-b')
      db.prepare(
        `INSERT INTO chat_messages (session_id, role, content, metadata, timestamp)
         VALUES ('tsess-child-sub-b', 'assistant', 'child work', NULL, '2026-03-27 10:00:00')`,
      ).run()

      const res = await fetch(`${baseUrl}/api/tasks/${child.id}/events`, { headers: userHeaders() })
      expect(res.status).toBe(200)
      const body = await res.json() as { events: Array<{ content?: string }> }
      expect(body.events.some(e => e.content === 'child work')).toBe(true)
    })

    it('serves a grandchild task through two parent hops', async () => {
      const root = ownedTask(2, 'sub-c')
      const child = subTaskOf(root, 'sub-c')
      const grandchild = createTask({
        name: 'Grandchild',
        triggerType: 'agent',
        triggerSourceId: child.id,
        sessionId: 'tsess-grandchild-sub-c',
      })
      db.prepare(
        `INSERT OR REPLACE INTO sessions (id, source, type, parent_session_id, session_user, user_id)
         VALUES ('tsess-grandchild-sub-c', 'system', 'task', NULL, NULL, NULL)`,
      ).run()

      const res = await fetch(`${baseUrl}/api/tasks/${grandchild.id}`, { headers: userHeaders() })
      expect(res.status).toBe(200)
    })

    /**
     * The security gate of this change: climbing the task-parent edge must
     * not hand a FOREIGN sub-task to anybody. Same three surfaces as the
     * foreign-parent case above.
     */
    it('answers 404 for a sub-task of another user\'s task', async () => {
      const parent = ownedTask(2, 'sub-d')
      const child = subTaskOf(parent, 'sub-d')
      db.prepare(
        `INSERT INTO chat_messages (session_id, role, content, metadata, timestamp)
         VALUES ('tsess-child-sub-d', 'assistant', 'secret child', NULL, '2026-03-27 10:00:00')`,
      ).run()

      const detail = await fetch(`${baseUrl}/api/tasks/${child.id}`, { headers: userHeaders(otherUserToken) })
      expect(detail.status).toBe(404)
      expect(await detail.json() as { error: string }).toEqual({ error: 'Task not found' })

      const events = await fetch(`${baseUrl}/api/tasks/${child.id}/events`, { headers: userHeaders(otherUserToken) })
      expect(events.status).toBe(404)
      expect(await events.text()).not.toContain('secret child')

      const kill = await fetch(`${baseUrl}/api/tasks/${child.id}/kill`, { method: 'POST', headers: userHeaders(otherUserToken) })
      expect(kill.status).toBe(404)

      const restart = await fetch(`${baseUrl}/api/tasks/${child.id}/restart`, {
        method: 'POST',
        headers: { ...userHeaders(otherUserToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(restart.status).toBe(404)
    })

    it('answers 404 for a sub-task of a system task (no human origin) but serves it to an admin', async () => {
      const cron = createTask({ name: 'Nightly', triggerType: 'cronjob', sessionId: 'tsess-cron-sub' })
      db.prepare(
        `INSERT OR REPLACE INTO sessions (id, source, type, parent_session_id, session_user)
         VALUES ('tsess-cron-sub', 'system', 'task', NULL, NULL)`,
      ).run()
      const child = subTaskOf(cron, 'sub-e')

      const asUser = await fetch(`${baseUrl}/api/tasks/${child.id}`, { headers: userHeaders() })
      expect(asUser.status).toBe(404)

      const asAdmin = await fetch(`${baseUrl}/api/tasks/${child.id}`, { headers: authHeaders() })
      expect(asAdmin.status).toBe(200)
    })

    it('does not inherit an owner through a cyclic parent chain', async () => {
      const a = createTask({ name: 'Cycle A', triggerType: 'agent', triggerSourceId: 'cycle-b-id' })
      db.prepare('UPDATE tasks SET id = ? WHERE id = ?').run('cycle-a-id', a.id)
      createTask({ name: 'Cycle B', triggerType: 'agent', triggerSourceId: 'cycle-a-id' })
      db.prepare('UPDATE tasks SET id = ? WHERE name = ?').run('cycle-b-id', 'Cycle B')

      const res = await fetch(`${baseUrl}/api/tasks/cycle-a-id`, { headers: userHeaders() })
      expect(res.status).toBe(404)
    })

    it('still answers 404 for an id that does not exist (same shape as a foreign task)', async () => {
      const res = await fetch(`${baseUrl}/api/tasks/does-not-exist`, { headers: userHeaders() })
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Task not found')
    })
  })
})
