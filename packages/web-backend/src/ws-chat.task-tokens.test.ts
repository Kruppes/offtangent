/**
 * The last hop: a `task_started` / `task_progress` / `task_finished` event on
 * the bus is relayed to the WebSocket client WITH its usage numbers.
 *
 * This is a separate hop from `broadcastTaskActivity` (which fills the bus
 * event) — `ws-chat.ts` copies field by field, so a field that exists on the
 * bus event but is not listed there never reaches the App. That is exactly
 * how the tokens were lost before.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase, TaskStore } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { ChatEventBus } from './chat-event-bus.js'
import { broadcastTaskActivity } from './task-activity.js'

let previousDataDir: string | undefined
let tempDataDir: string

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-task-tokens-'))
  process.env.DATA_DIR = tempDataDir
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

function connect(port: number, token: string): Promise<{
  ws: WebSocket
  nextOfType: (type: string) => Promise<Record<string, unknown>>
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/chat?token=${token}`)
    const queue: Record<string, unknown>[] = []
    let waiter: ((msg: Record<string, unknown>) => void) | null = null
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>
      if (waiter) {
        const w = waiter
        waiter = null
        w(parsed)
      } else {
        queue.push(parsed)
      }
    })
    const next = (): Promise<Record<string, unknown>> => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!)
      return new Promise((res) => { waiter = res })
    }
    const nextOfType = async (type: string): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 2000
      for (;;) {
        if (Date.now() > deadline) throw new Error(`no ${type} frame within 2s`)
        const msg = await Promise.race([
          next(),
          new Promise<Record<string, unknown>>((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), 2000)),
        ])
        if (msg.type === type) return msg
      }
    }
    ws.on('open', () => resolve({ ws, nextOfType }))
    ws.on('error', reject)
  })
}

async function harness(): Promise<{
  db: Database
  port: number
  token: string
  bus: ChatEventBus
  close: () => Promise<void>
}> {
  const db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('admin', 'x', 'admin')
  const agentCore = {
    sendMessage: vi.fn(),
    abort: vi.fn(),
    getSessionManager: () => ({ getOrCreateSession: vi.fn(), assertSessionAccess: vi.fn(), getSession: vi.fn() }),
    getPendingMessageCount: () => 0,
  } as unknown as AgentCore
  const bus = new ChatEventBus()
  const app = createApp({ db })
  const server = http.createServer(app)
  const { wss } = setupWebSocketChat(server, db, agentCore, undefined, bus)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port
  const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  return {
    db, port, token, bus,
    close: async () => {
      for (const c of wss.clients) c.terminate()
      wss.close()
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
      db.close()
    },
  }
}

describe('ws-chat strand activity frames', () => {
  it('relays the live token and cost stand to the client', async () => {
    const h = await harness()
    try {
      h.db.prepare(
        `INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES ('strand-ws', 'web', 'interactive', NULL, '1')`,
      ).run()
      h.db.prepare(
        `INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES ('task-ws', 'system', 'task', 'strand-ws', '1')`,
      ).run()
      const store = new TaskStore(h.db)
      const task = store.create({ name: 'Counting', prompt: 'p', triggerType: 'agent', sessionId: 'task-ws', agentId: 'main' })
      store.update(task.id, {
        promptTokens: 78,
        completionTokens: 8221,
        cacheRead: 1308532,
        cacheWrite: 55092,
        estimatedCost: 1.204506,
        toolCallCount: 38,
      })

      const client = await connect(h.port, h.token)
      // 'system: Authenticated' — sent synchronously on connect, and the
      // client is registered for bus events at that point.
      await client.nextOfType('system')

      expect(broadcastTaskActivity(
        { db: h.db, chatEventBus: h.bus, resolveUserId: () => 1 },
        'progress',
        store.getById(task.id)!,
      )).toBe(true)

      const frame = await client.nextOfType('task_progress')
      expect(frame.sessionId).toBe('strand-ws')
      expect(frame.taskId).toBe(task.id)
      expect(frame.taskPromptTokens).toBe(78)
      expect(frame.taskCompletionTokens).toBe(8221)
      expect(frame.taskCacheRead).toBe(1308532)
      expect(frame.taskCacheWrite).toBe(55092)
      expect(frame.taskEstimatedCost).toBeCloseTo(1.204506, 6)
      expect(frame.taskToolCallCount).toBe(38)
      client.ws.close()
    } finally {
      await h.close()
    }
  })
})
