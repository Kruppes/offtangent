/**
 * Axiom-Companion M1: multi-persona + idempotent sends over /ws/chat.
 *
 * Each test fails against the pre-M1 handler, which hardcoded agent_id 'main'
 * (rows + session + turn), knew no `clientMessageId` and no `message_ack`.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase } from '@axiom/core'
import type { AgentCore, ResponseChunk, Database } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { ChatEventBus } from './chat-event-bus.js'

let previousDataDir: string | undefined
let tempDataDir: string

beforeAll(() => {
  // Persona whitelist = directories under $DATA_DIR/agents (+ 'main').
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-persona-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'warren'), { recursive: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

interface Client {
  ws: WebSocket
  next: () => Promise<Record<string, unknown>>
  nextOfType: (type: string) => Promise<Record<string, unknown>>
  quietFor: (ms: number) => Promise<void>
}

function connect(port: number, token: string): Promise<Client> {
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
    const quietFor = async (ms: number): Promise<void> => {
      if (queue.length > 0) throw new Error(`expected silence, queued: ${JSON.stringify(queue[0])}`)
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, ms)
        waiter = (msg) => { clearTimeout(t); waiter = null; rej(new Error(`expected silence, got ${JSON.stringify(msg)}`)) }
      })
    }
    ws.on('open', () => resolve({ ws, next, nextOfType, quietFor }))
    ws.on('error', reject)
  })
}

interface Harness {
  db: Database
  port: number
  token: string
  sendMessage: ReturnType<typeof vi.fn>
  sessionCalls: Array<[string, string, string | undefined]>
  resetCalls: Array<[string, string, string | undefined]>
  bus: ChatEventBus
  close: () => Promise<void>
}

async function harness(reply = 'ok'): Promise<Harness> {
  const db = initDatabase(':memory:')
  const sessionCalls: Array<[string, string, string | undefined]> = []
  const resetCalls: Array<[string, string, string | undefined]> = []
  const sessionManager = {
    getOrCreateSession: vi.fn((userId: string, source: string, agentId?: string) => {
      sessionCalls.push([userId, source, agentId])
      return { id: `sess-${agentId ?? 'main'}`, userId, source, startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false }
    }),
    getSession: vi.fn((userId: string, agentId?: string) => ({ id: `sess-${agentId ?? 'main'}`, userId, source: 'web', startedAt: 0, lastActivity: 0, messageCount: 0, summaryWritten: false, restored: false })),
  }
  const sendMessage = vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
    yield { type: 'text', text: reply }
    yield { type: 'done' }
  })
  const agentCore = {
    sendMessage,
    abort: vi.fn(),
    resetSessionAsync: vi.fn((userId: string, source: string, agentId?: string) => {
      resetCalls.push([userId, source, agentId])
      return { id: `new-${agentId ?? 'main'}` }
    }),
    getSessionManager: () => sessionManager,
  } as unknown as AgentCore

  const app = createApp({ db })
  const server = http.createServer(app)
  const bus = new ChatEventBus()
  const { wss } = setupWebSocketChat(server, db, agentCore, undefined, bus)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port
  const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

  return {
    db, port, token, sendMessage, sessionCalls, resetCalls, bus,
    close: async () => {
      await new Promise<void>((r) => setTimeout(r, 20))
      for (const c of wss.clients) c.terminate()
      wss.close()
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
    },
  }
}

function userRows(db: Database) {
  return db.prepare(
    "SELECT id, session_id, agent_id, client_message_id, content, timestamp FROM chat_messages WHERE role = 'user' ORDER BY id",
  ).all() as Array<{ id: number; session_id: string; agent_id: string; client_message_id: string | null; content: string; timestamp: string }>
}

describe('ws-chat multi-persona', () => {
  it('routes a message with agentId to that persona: session, agent call, persisted rows, streamed frames', async () => {
    const h = await harness('bob says hi')
    try {
      const c = await connect(h.port, h.token)
      await c.next() // Authenticated
      c.ws.send(JSON.stringify({ type: 'message', content: 'hello bob', agentId: 'bob' }))

      const text = await c.nextOfType('text')
      expect(text.text).toBe('bob says hi')
      expect(text.agentId).toBe('bob')
      const done = await c.nextOfType('done')
      expect(done.agentId).toBe('bob')

      expect(h.sessionCalls).toEqual([['1', 'web', 'bob']])
      // 5th positional arg of AgentCore.sendMessage is the persona.
      expect(h.sendMessage.mock.calls[0][4]).toBe('bob')

      await new Promise<void>((r) => setTimeout(r, 30))
      const rows = h.db.prepare("SELECT role, agent_id, session_id FROM chat_messages ORDER BY id").all() as Array<{ role: string; agent_id: string; session_id: string }>
      expect(rows.map(r => r.role)).toEqual(['user', 'assistant'])
      for (const r of rows) {
        expect(r.agent_id).toBe('bob')
        expect(r.session_id).toBe('sess-bob')
      }
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('keeps sessions apart when one socket alternates between personas', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'to bob', agentId: 'bob', clientMessageId: 'k-bob' }))
      const ackBob = await c.nextOfType('message_ack')
      expect(ackBob.sessionId).toBe('sess-bob')
      await c.nextOfType('done')

      c.ws.send(JSON.stringify({ type: 'message', content: 'to warren', agentId: 'warren', clientMessageId: 'k-warren' }))
      const ackWarren = await c.nextOfType('message_ack')
      expect(ackWarren.sessionId).toBe('sess-warren')
      const text = await c.nextOfType('text')
      expect(text.agentId).toBe('warren')
      await c.nextOfType('done')

      const rows = userRows(h.db)
      expect(rows.map(r => [r.agent_id, r.session_id])).toEqual([['bob', 'sess-bob'], ['warren', 'sess-warren']])
      expect(h.sendMessage.mock.calls.map(call => call[4])).toEqual(['bob', 'warren'])
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it("keeps the legacy web UI on 'main' when no agentId is sent", async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'plain' }))
      const text = await c.nextOfType('text')
      expect(text.agentId).toBe('main')
      await c.nextOfType('done')
      expect(h.sessionCalls).toEqual([['1', 'web', 'main']])
      expect(h.sendMessage.mock.calls[0][4]).toBe('main')
      expect(userRows(h.db)[0].agent_id).toBe('main')
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('refuses an unknown agentId without persisting or starting a turn', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'x', agentId: 'gekko' }))
      const err = await c.next()
      expect(err.type).toBe('error')
      expect(err.error).toBe('Unknown agentId')
      await c.quietFor(50)
      expect(h.sendMessage).not.toHaveBeenCalled()
      expect(userRows(h.db)).toHaveLength(0)
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('ends only the addressed persona session on /new', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'command', content: '/new', agentId: 'warren' }))
      const end = await c.nextOfType('session_end')
      expect(end.agentId).toBe('warren')
      expect(end.sessionId).toBe('new-warren')
      expect(end.endedSessionId).toBe('sess-warren')
      expect(h.resetCalls).toEqual([['1', 'web', 'warren']])
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('forwards the persona of Telegram-originated user messages to web clients', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      h.bus.broadcast({ type: 'user_message', userId: 1, source: 'telegram', sessionId: 's', text: 'via tg', agentId: 'warren' })
      const ext = await c.nextOfType('external_user_message')
      expect(ext.text).toBe('via tg')
      expect(ext.agentId).toBe('warren')
      c.ws.close()
    } finally {
      await h.close()
    }
  })
})

describe('ws-chat idempotent sends (clientMessageId + message_ack)', () => {
  it('acks a keyed message with its row id and persists the key', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'first', agentId: 'bob', clientMessageId: 'cm-1' }))
      const ack = await c.nextOfType('message_ack')
      expect(ack.clientMessageId).toBe('cm-1')
      expect(ack.agentId).toBe('bob')
      expect(ack.sessionId).toBe('sess-bob')
      expect(ack.duplicate).toBe(false)
      const rows = userRows(h.db)
      expect(rows).toHaveLength(1)
      expect(ack.messageId).toBe(rows[0].id)
      expect(rows[0].client_message_id).toBe('cm-1')
      // The ack carries the server's own time for that row, unambiguous
      // (ISO-8601 UTC). A client that rendered the bubble optimistically with
      // its local clock replaces it with this and stays comparable to history.
      expect(ack.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(ack.timestamp).toBe(new Date(`${String(rows[0].timestamp).replace(' ', 'T')}Z`).toISOString())
      await c.nextOfType('done')
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('a retry with the same key persists nothing, starts no second turn and is acked as duplicate', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      const frame = JSON.stringify({ type: 'message', content: 'retry me', agentId: 'bob', clientMessageId: 'cm-2' })
      c.ws.send(frame)
      const first = await c.nextOfType('message_ack')
      await c.nextOfType('done')

      c.ws.send(frame)
      const second = await c.nextOfType('message_ack')
      expect(second.duplicate).toBe(true)
      expect(second.messageId).toBe(first.messageId)
      // A retry answers with the same instant as the original ack.
      expect(second.timestamp).toBe(first.timestamp)
      await c.quietFor(60) // no text/done from a second turn
      expect(h.sendMessage).toHaveBeenCalledTimes(1)
      expect(userRows(h.db)).toHaveLength(1)
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('does not start a second turn when the upload-path frame (skipSave) is retried', async () => {
    const h = await harness()
    try {
      // Row pre-created by POST /api/chat/message (simulated).
      h.db.prepare(
        "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, client_message_id) VALUES ('sess-bob', 1, 'user', 'with file', 'bob', 'cm-3')",
      ).run()
      const c = await connect(h.port, h.token)
      await c.next()
      const frame = JSON.stringify({ type: 'message', content: 'with file', agentId: 'bob', clientMessageId: 'cm-3', skipSave: true, attachments: [] })
      c.ws.send(frame)
      const ack = await c.nextOfType('message_ack')
      expect(ack.duplicate).toBe(false)
      expect(ack.messageId).toBe(userRows(h.db)[0].id)
      await c.nextOfType('done')

      c.ws.send(frame)
      const again = await c.nextOfType('message_ack')
      expect(again.duplicate).toBe(true)
      await c.quietFor(60)
      expect(h.sendMessage).toHaveBeenCalledTimes(1)
      expect(userRows(h.db)).toHaveLength(1)
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('runs the turn for a key whose row survived a restart (no turn seen by this process)', async () => {
    const h = await harness()
    try {
      // Row from a previous process lifetime, turn never completed.
      h.db.prepare(
        "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, client_message_id) VALUES ('sess-bob', 1, 'user', 'lost', 'bob', 'cm-4')",
      ).run()
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'lost', agentId: 'bob', clientMessageId: 'cm-4' }))
      const ack = await c.nextOfType('message_ack')
      expect(ack.duplicate).toBe(true) // row existed
      await c.nextOfType('done') // but the turn ran
      expect(h.sendMessage).toHaveBeenCalledTimes(1)
      expect(userRows(h.db)).toHaveLength(1)
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('refuses skipSave with a key that has no stored row (client claim is wrong)', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'ghost', agentId: 'bob', clientMessageId: 'cm-ghost', skipSave: true }))
      const err = await c.next()
      expect(err.type).toBe('error')
      expect(String(err.error)).toMatch(/skipSave/)
      await c.quietFor(50)
      expect(h.sendMessage).not.toHaveBeenCalled()
      expect(userRows(h.db)).toHaveLength(0)
      // The key was not consumed: a proper (non-skipSave) send still works.
      c.ws.send(JSON.stringify({ type: 'message', content: 'ghost', agentId: 'bob', clientMessageId: 'cm-ghost' }))
      const ack = await c.nextOfType('message_ack')
      expect(ack.duplicate).toBe(false)
      await c.nextOfType('done')
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('refuses to reuse a key for another persona (save path and skipSave path)', async () => {
    const h = await harness()
    try {
      // Row from an earlier attempt that targeted bob.
      h.db.prepare(
        "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, client_message_id) VALUES ('sess-bob', 1, 'user', 'x', 'bob', 'k-mismatch')",
      ).run()
      const c = await connect(h.port, h.token)
      await c.next()

      c.ws.send(JSON.stringify({ type: 'message', content: 'x', agentId: 'warren', clientMessageId: 'k-mismatch' }))
      const err1 = await c.next()
      expect(err1.type).toBe('error')
      expect(String(err1.error)).toMatch(/another persona/)

      c.ws.send(JSON.stringify({ type: 'message', content: 'x', agentId: 'warren', clientMessageId: 'k-mismatch', skipSave: true }))
      const err2 = await c.next()
      expect(err2.type).toBe('error')
      expect(String(err2.error)).toMatch(/another persona/)

      await c.quietFor(50)
      expect(h.sendMessage).not.toHaveBeenCalled()
      expect(userRows(h.db)).toHaveLength(1)

      // The rightful persona can still retry it.
      c.ws.send(JSON.stringify({ type: 'message', content: 'x', agentId: 'bob', clientMessageId: 'k-mismatch' }))
      const ack = await c.nextOfType('message_ack')
      expect(ack.duplicate).toBe(true)
      await c.nextOfType('done')
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('rejects a malformed clientMessageId up front', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'x', clientMessageId: 'has space' }))
      const err = await c.next()
      expect(err.type).toBe('error')
      expect(err.error).toBe('Invalid clientMessageId')
      await c.quietFor(50)
      expect(h.sendMessage).not.toHaveBeenCalled()
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('never sends message_ack to clients that do not use keys (web UI unchanged)', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'legacy' }))
      const first = await c.next()
      expect(first.type).toBe('text')
      await c.nextOfType('done')
      c.ws.close()
    } finally {
      await h.close()
    }
  })
})
