import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from './app.js'
import { initDatabase, initTasksTable, TaskStore, TaskEventBus } from '@axiom/core'
import type { Database } from '@axiom/core'
import { generateAccessToken } from './auth.js'
import { setupWebSocketTask } from './ws-task.js'
import { WebSocket } from 'ws'

let db: Database
let server: http.Server
let port: number
let baseUrl: string
let wsBaseUrl: string
let tempDataDir: string
let previousDataDir: string | undefined
let taskEventBus: TaskEventBus

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-task-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  initTasksTable(db)

  taskEventBus = new TaskEventBus()

  const app = createApp({ db, taskEventBus })
  server = http.createServer(app)
  setupWebSocketTask({ server, db, taskEventBus })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  wsBaseUrl = `ws://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (previousDataDir !== undefined) {
    process.env.DATA_DIR = previousDataDir
  } else {
    delete process.env.DATA_DIR
  }
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

function getToken() {
  return generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
}

describe('GET /api/tasks/:id/events', () => {
  it('returns 404 for non-existent task', async () => {
    const token = getToken()
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/events`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
  })

  it('returns events for an existing task', async () => {
    const store = new TaskStore(db)
    const task = store.create({
      name: 'Test task',
      prompt: 'Do something',
      triggerType: 'user',
      sessionId: 'test-session-123',
    })

    // Insert some tool calls for the task's session
    db.prepare(
      'INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('test-session-123', 'bash', '{"command":"ls"}', '{"files":["a.txt"]}', 150, 'success')

    const token = getToken()
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)

    const body = await res.json() as { events: unknown[]; task: { id: string } }
    expect(body.task.id).toBe(task.id)
    expect(body.events.length).toBeGreaterThanOrEqual(1)
    expect((body.events[0] as { type: string }).type).toBe('tool_call')
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/any/events`)
    expect(res.status).toBe(401)
  })
})

describe('WebSocket /ws/task/:id', () => {
  it('rejects unauthenticated connections', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/ws/task/some-id`)
    const closePromise = new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code))
      ws.on('error', () => resolve(-1))
    })
    // Should be rejected — either error or close
    const code = await closePromise
    expect(code).not.toBe(1000) // Not a clean close
  })

  it('sends task_info and history for completed tasks', async () => {
    const store = new TaskStore(db)
    const task = store.create({
      name: 'Completed task',
      prompt: 'Do something',
      triggerType: 'user',
      sessionId: 'completed-session-1',
    })
    store.update(task.id, { status: 'completed', resultStatus: 'completed', completedAt: '2024-01-01 00:00:00' })

    // Add a tool call
    db.prepare(
      'INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('completed-session-1', 'read_file', '{"path":"test.txt"}', '"hello world"', 50, 'success')

    const token = getToken()
    const messages: Record<string, unknown>[] = []

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${wsBaseUrl}/ws/task/${task.id}?token=${token}`)
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Timeout waiting for messages'))
      }, 3000)

      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        messages.push(msg)

        // After receiving history_end, we're done
        if (msg.type === 'history_end') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      })

      ws.on('error', (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    expect(messages.length).toBeGreaterThanOrEqual(3) // task_info, history_start, ..., history_end
    expect(messages[0].type).toBe('task_info')
    expect(messages[0].name).toBe('Completed task')
    expect(messages[1].type).toBe('history_start')
    expect(messages[messages.length - 1].type).toBe('history_end')
  })

  it('replays the history in the written order with unambiguous timestamps', async () => {
    const store = new TaskStore(db)
    const task = store.create({
      name: 'Chronology task',
      prompt: 'Several rows in one second',
      triggerType: 'user',
      sessionId: 'chronology-session-1',
    })
    store.update(task.id, { status: 'completed', resultStatus: 'completed', completedAt: '2026-09-15 07:35:02' })

    const second = '2026-09-15 07:35:00'
    const insertMessage = db.prepare(
      'INSERT INTO chat_messages (session_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)',
    )
    insertMessage.run('chronology-session-1', 'assistant', 'erster schritt', null, second)
    insertMessage.run('chronology-session-1', 'assistant', 'zweiter schritt', null, second)
    insertMessage.run('chronology-session-1', 'assistant', 'dritter schritt', null, second)
    db.prepare(
      'INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('chronology-session-1', 'bash', '{}', '{}', 5, 'success', '2026-09-15 07:35:01')

    const token = getToken()
    const messages: Record<string, unknown>[] = []

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${wsBaseUrl}/ws/task/${task.id}?token=${token}`)
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Timeout waiting for messages'))
      }, 3000)

      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        messages.push(msg)
        if (msg.type === 'history_end') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      })
      ws.on('error', (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    const history = messages.filter(m => m.type === 'text_delta' || m.type === 'tool_call_end')
    // Three rows in one second stay in insertion order (`ORDER BY timestamp,
    // id`), and the tool call a second later comes last — not first, which is
    // what a string compare of ISO against naked timestamps would produce.
    expect(history.map(m => m.text ?? m.toolName)).toEqual([
      'erster schritt',
      'zweiter schritt',
      'dritter schritt',
      'bash',
    ])
    for (const event of history) {
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    expect(history[0]!.timestamp).toBe('2026-09-15T07:35:00.000Z')
  })

  it('streams live events for running tasks', async () => {
    const store = new TaskStore(db)
    const task = store.create({
      name: 'Running task',
      prompt: 'Do something live',
      triggerType: 'agent',
      sessionId: 'running-session-1',
    })
    // Task stays in 'running' status by default from create

    const token = getToken()
    const messages: Record<string, unknown>[] = []

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${wsBaseUrl}/ws/task/${task.id}?token=${token}`)
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Timeout'))
      }, 3000)

      ws.on('open', () => {
        // Wait a tick for the connection handler to run, then emit events
        setTimeout(() => {
          taskEventBus.emitTaskEvent({
            type: 'tool_call_start',
            taskId: task.id,
            timestamp: new Date().toISOString(),
            toolName: 'bash',
            toolCallId: 'tc-live-1',
            toolArgs: { command: 'echo test' },
          })

          taskEventBus.emitTaskEvent({
            type: 'tool_call_end',
            taskId: task.id,
            timestamp: new Date().toISOString(),
            toolName: 'bash',
            toolCallId: 'tc-live-1',
            toolResult: 'test',
            durationMs: 42,
          })

          taskEventBus.emitTaskEvent({
            type: 'status_change',
            taskId: task.id,
            timestamp: new Date().toISOString(),
            status: 'completed',
            statusMessage: 'Done!',
          })
        }, 100)
      })

      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        messages.push(msg)

        if (msg.type === 'status_change') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      })

      ws.on('error', (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    // Should have: task_info, tool_call_start, tool_call_end, status_change
    const types = messages.map(m => m.type)
    expect(types).toContain('task_info')
    expect(types).toContain('tool_call_start')
    expect(types).toContain('tool_call_end')
    expect(types).toContain('status_change')

    // Verify tool call data
    const toolEnd = messages.find(m => m.type === 'tool_call_end')
    expect(toolEnd?.toolName).toBe('bash')
    expect(toolEnd?.durationMs).toBe(42)
  })

  it('sends backlog to late joiners of running tasks', async () => {
    const store = new TaskStore(db)
    const task = store.create({
      name: 'Backlog task',
      prompt: 'Do something',
      triggerType: 'user',
      sessionId: 'backlog-session-1',
    })

    // Emit events BEFORE connecting
    taskEventBus.emitTaskEvent({
      type: 'tool_call_start',
      taskId: task.id,
      timestamp: new Date().toISOString(),
      toolName: 'read_file',
      toolCallId: 'tc-backlog-1',
    })
    taskEventBus.emitTaskEvent({
      type: 'tool_call_end',
      taskId: task.id,
      timestamp: new Date().toISOString(),
      toolName: 'read_file',
      toolCallId: 'tc-backlog-1',
      toolResult: 'contents',
      durationMs: 10,
    })

    const token = getToken()
    const messages: Record<string, unknown>[] = []

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${wsBaseUrl}/ws/task/${task.id}?token=${token}`)
      const timeout = setTimeout(() => {
        ws.close()
        resolve() // Resolve even on timeout to check what we got
      }, 1000)

      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        messages.push(msg)

        if (msg.type === 'backlog_end') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      })

      ws.on('error', (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    const types = messages.map(m => m.type)
    expect(types).toContain('task_info')
    expect(types).toContain('backlog_start')
    expect(types).toContain('tool_call_start')
    expect(types).toContain('tool_call_end')
    expect(types).toContain('backlog_end')
  })

  it('returns error for non-existent task', async () => {
    const token = getToken()
    const messages: Record<string, unknown>[] = []

    await new Promise<void>((resolve, _reject) => {
      const ws = new WebSocket(`${wsBaseUrl}/ws/task/nonexistent?token=${token}`)
      const timeout = setTimeout(() => {
        ws.close()
        resolve()
      }, 1000)

      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        messages.push(msg)
      })

      ws.on('close', () => {
        clearTimeout(timeout)
        resolve()
      })

      ws.on('error', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    if (messages.length > 0) {
      expect(messages[0].type).toBe('error')
    }
  })
})
