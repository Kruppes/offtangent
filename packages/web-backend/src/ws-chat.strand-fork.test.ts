/**
 * `/ws/chat` forwards the `strand_forked` frame to EVERY socket of the owning
 * user — a fork is the one strand creation no client triggered, so without
 * this frame the list only learns about it on the next poll — and to nobody
 * else.
 *
 * Fails against a handler that drops the event as well as against one that
 * broadcasts it to every connection regardless of the user.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { ChatEventBus } from './chat-event-bus.js'

let db: Database
let server: http.Server
let port: number
let token: string
let otherToken: string
let bus: ChatEventBus
let tempDataDir: string
let previousDataDir: string | undefined
let wss: { clients: Set<WebSocket>; close: () => void }

const FORK = {
  strandId: 'strand-child',
  title: 'Privacy: Gmail-Scopes',
  parentStrandId: 'strand-parent',
  forkedAt: '2026-09-26T10:00:00.000Z',
  agentId: 'main',
  projectId: null,
  runStarted: false,
}

async function connect(auth: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=${auth}`)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  return ws
}

/** Collect every frame of one socket for `ms`. */
function collect(ws: WebSocket, ms: number): Promise<Array<Record<string, unknown>>> {
  const frames: Array<Record<string, unknown>> = []
  ws.on('message', data => frames.push(JSON.parse(data.toString()) as Record<string, unknown>))
  return new Promise(resolve => setTimeout(() => resolve(frames), ms))
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-ws-fork-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
  const sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = {
    sendMessage: vi.fn(),
    abort: vi.fn(),
    getSessionManager: () => sessionManager,
    getPendingMessageCount: () => 0,
  } as unknown as AgentCore

  bus = new ChatEventBus()
  server = http.createServer(createApp({ db, getAgentCore: () => agentCore, chatEventBus: bus }))
  const chat = setupWebSocketChat(server, db, () => agentCore, undefined, bus)
  wss = chat.wss as unknown as { clients: Set<WebSocket>; close: () => void }
  await new Promise<void>((resolve) => server.listen(0, resolve))
  port = (server.address() as { port: number }).port
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  for (const client of wss.clients) client.terminate()
  wss.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

describe('/ws/chat strand_forked frame', () => {
  it('reaches every socket of the user and no socket of another user', async () => {
    const first = await connect(token)
    const second = await connect(token)
    const foreign = await connect(otherToken)

    const collected = Promise.all([collect(first, 250), collect(second, 250), collect(foreign, 250)])
    bus.broadcast({
      type: 'strand_forked',
      userId: 1,
      source: 'web',
      sessionId: 'strand-parent',
      agentId: 'main',
      fork: FORK,
    })
    const [a, b, c] = await collected

    for (const frames of [a, b]) {
      const forked = frames.filter(frame => frame.type === 'strand_forked')
      expect(forked).toHaveLength(1)
      expect(forked[0]).toEqual({
        type: 'strand_forked', sessionId: 'strand-parent', agentId: 'main', fork: FORK,
      })
    }
    expect(c.filter(frame => frame.type === 'strand_forked')).toHaveLength(0)

    first.close()
    second.close()
    foreign.close()
  })
})
