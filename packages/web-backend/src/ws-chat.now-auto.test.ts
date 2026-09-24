/**
 * `/ws/chat` with an automatic now set: a user message can change the computed
 * ranking, so the handler compares it before and after the write and only then
 * broadcasts `now_set_changed { strandIds }`.
 *
 * Fails against a handler that never looks at the now set (no frame at all) as
 * well as against one that broadcasts on every message.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database, NowSetMode, ResponseChunk } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { ChatEventBus } from './chat-event-bus.js'
import type { ChatEvent } from './chat-event-bus.js'

let db: Database
let server: http.Server
let port: number
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let mode: NowSetMode = 'auto'
let events: ChatEvent[] = []
let wss: { clients: Set<WebSocket>; close: () => void }

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-now-auto-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = {
    sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
      yield { type: 'text', text: 'ok' }
      yield { type: 'done' }
    }),
    abort: vi.fn(),
    getSessionManager: () => sessionManager,
    getPendingMessageCount: () => 0,
  } as unknown as AgentCore
  const bus = new ChatEventBus()
  bus.subscribe(e => events.push(e))

  server = http.createServer(createApp({ db, getAgentCore: () => agentCore }))
  const chat = setupWebSocketChat(
    server,
    db,
    () => agentCore,
    undefined,
    bus,
    undefined,
    undefined,
    undefined,
    { getNowSetMax: () => 3, getNowSetMode: () => mode },
  )
  wss = chat.wss as unknown as { clients: Set<WebSocket>; close: () => void }
  await new Promise<void>((resolve) => server.listen(0, resolve))
  port = (server.address() as { port: number }).port
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
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

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM now_set; DELETE FROM sessions;')
  events = []
  mode = 'auto'
})

/** Send one chat frame and wait until the turn it started is done. */
async function sendMessage(sessionId: string, content: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=${token}`)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  const done = new Promise<void>((resolve) => {
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as { type?: string }
      if (parsed.type === 'done' || parsed.type === 'error') resolve()
    })
  })
  ws.send(JSON.stringify({ type: 'message', content, sessionId }))
  await done
  await new Promise<void>((resolve) => {
    ws.on('close', () => resolve())
    ws.close()
  })
}

function nowSetChanges(): string[][] {
  return events.filter(e => e.type === 'now_set_changed').map(e => (e as { strandIds: string[] }).strandIds)
}

describe('ws-chat and the automatic now set', () => {
  it('broadcasts the computed list when a user message changes it, and stays silent otherwise', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Dach').id
    await sendMessage(strand, 'erste Nachricht')
    expect(nowSetChanges()).toEqual([[strand]])

    // Second message in the same strand on the same day: no change, no frame.
    events = []
    await sendMessage(strand, 'zweite Nachricht')
    expect(nowSetChanges()).toEqual([])

    // A message in another strand adds it to the computed list. Both strands
    // score the same here (one day, same second — `chat_messages.timestamp`
    // has second granularity), so the id breaks the tie; what matters is that
    // the changed list is announced exactly once.
    const second = sessionManager.createThread('1', 'main', 'Garten').id
    events = []
    await sendMessage(second, 'dritte Nachricht')
    const changes = nowSetChanges()
    expect(changes).toHaveLength(1)
    expect([...changes[0]!].sort()).toEqual([strand, second].sort())

    // Nothing of this touched the curated table.
    expect(db.prepare('SELECT count(*) c FROM now_set').get()).toEqual({ c: 0 })
  })

  it('does not broadcast in manual mode', async () => {
    mode = 'manual'
    const strand = sessionManager.createThread('1', 'main', 'Dach').id
    await sendMessage(strand, 'eine Nachricht')
    expect(nowSetChanges()).toEqual([])
  })
})
