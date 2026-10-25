/**
 * S1-D (REVIEW-S1-D-2, point 4): the interjection owner check on the
 * HTTP/WS level. A message of user B that targets the strand in which user A's
 * turn runs must not be offered to A's run as a steer, and A's socket must not
 * get a `message.steered` frame.
 *
 * Two layers, one test each: (1) the WS strand access check (B gets
 * `session_forbidden` before the runner is reached; red without
 * assertSessionAccess in ws-chat); (2) the runner's owner check (live turns
 * keyed by the sending user): with the access check neutralised, B's message
 * still runs as B's own turn, never as a steer into A's run (red against a
 * runner that looks up live turns of any user).
 * Fails against a handler that hands B's message to the runner/steer path for
 * A's strand (offerSteer would be called, frame sent). The positive control
 * proves the steer path is live for A in the same setup.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database, ResponseChunk } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { ChatEventBus } from './chat-event-bus.js'

let db: Database
let server: http.Server
let port: number
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let wss: { clients: Set<WebSocket>; close: () => void }
let releaseA: (() => void) | null = null
const offerSteer = vi.fn(() => ({ accepted: true as const, settled: Promise.resolve(true) }))
const sent: Array<{ userId: string; text: string }> = []

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-steer-owner-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'bob', 'x', 'user')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = {
    sendMessage: vi.fn(async function* (userId: string, text: string): AsyncGenerator<ResponseChunk> {
      sent.push({ userId: String(userId), text })
      if (String(userId) === '1') {
        // A's turn stays "in its tool batch" until the test releases it.
        yield { type: 'tool_call_start', toolName: 'shell', toolCallId: 'c1' } as unknown as ResponseChunk
        await new Promise<void>((resolve) => { releaseA = resolve })
      }
      yield { type: 'text', text: 'ok' }
      yield { type: 'done' }
    }),
    abort: vi.fn(),
    offerSteer,
    getSessionManager: () => sessionManager,
    getPendingMessageCount: () => 0,
  } as unknown as AgentCore

  server = http.createServer(createApp({ db, getAgentCore: () => agentCore }))
  const chat = setupWebSocketChat(server, db, () => agentCore, undefined, new ChatEventBus())
  wss = chat.wss as unknown as { clients: Set<WebSocket>; close: () => void }
  await new Promise<void>((resolve) => server.listen(0, resolve))
  port = (server.address() as { port: number }).port
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

async function connect(userId: number, username: string, role: 'admin' | 'user'): Promise<{ ws: WebSocket; frames: Array<{ type?: string }> }> {
  const token = generateAccessToken({ userId, username, role })
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=${token}`)
  const frames: Array<{ type?: string }> = []
  ws.on('message', (data) => { frames.push(JSON.parse(data.toString()) as { type?: string }) })
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  return { ws, frames }
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 10))
  expect(cond()).toBe(true)
}

describe('ws-chat interjection owner check (REVIEW-S1-D-2, point 4)', () => {
  it("a message of user B into the strand of user A's running turn is not offered as a steer", async () => {
    const strand = sessionManager.createThread('1', 'main', 'Alices Strang').id
    const a = await connect(1, 'alice', 'admin')
    const b = await connect(2, 'bob', 'user')

    a.ws.send(JSON.stringify({ type: 'message', content: 'Start A', sessionId: strand }))
    await until(() => releaseA !== null)

    b.ws.send(JSON.stringify({ type: 'message', content: 'Zwischenruf von B', sessionId: strand, clientMessageId: 'b-1' }))
    // B's message is processed (an answer of any kind reaches B's socket) ...
    await until(() => b.frames.some(f => ['done', 'error', 'message_ack', 'message.queued', 'queued', 'turn_queued'].includes(String(f.type))))
    await new Promise(r => setTimeout(r, 100))

    // ... refused at the WS level: the explicit strand belongs to A.
    const bError = b.frames.find(f => f.type === 'error') as { code?: string } | undefined
    expect(bError?.code).toBe('session_forbidden')
    // ... and never as an interjection into A's run.
    expect(offerSteer).not.toHaveBeenCalled()
    expect(a.frames.filter(f => f.type === 'message.steered')).toEqual([])
    expect(b.frames.filter(f => f.type === 'message.steered')).toEqual([])
    // A's run never saw B's text.
    expect(sent.filter(s => s.userId === '1').map(s => s.text)).toEqual(['Start A'])

    // Positive control: A's own follow-up in the same strand IS offered, so
    // the negative above is not vacuous.
    a.ws.send(JSON.stringify({ type: 'message', content: 'Zwischenruf von A', sessionId: strand, clientMessageId: 'a-2' }))
    await until(() => a.frames.some(f => f.type === 'message.steered'))
    expect(offerSteer).toHaveBeenCalledTimes(1)
    expect(b.frames.filter(f => f.type === 'message.steered')).toEqual([])

    releaseA!()
    await until(() => a.frames.some(f => f.type === 'done'))
    a.ws.close()
    b.ws.close()
  })
  it('layer 2: even with the strand access check passed, the runner keeps B out of A\'s run (no offerSteer, no message.steered to A)', async () => {
    // Isolates the runner owner check (live turns keyed by the sending user):
    // the WS access check is neutralised for this test only, so B's message
    // for A's strand reaches TurnRunner.submitUserMessage. Fails against a
    // runner that looks up live turns of ANY user for the strand.
    offerSteer.mockClear()
    releaseA = null
    sent.length = 0
    const strand = sessionManager.createThread('1', 'main', 'Alices zweiter Strang').id
    const access = vi.spyOn(sessionManager, 'assertSessionAccess').mockImplementation(() => undefined as never)
    const a = await connect(1, 'alice', 'admin')
    const b = await connect(2, 'bob', 'user')
    try {
      a.ws.send(JSON.stringify({ type: 'message', content: 'Start A2', sessionId: strand }))
      await until(() => releaseA !== null)

      b.ws.send(JSON.stringify({ type: 'message', content: 'Zwischenruf von B2', sessionId: strand, clientMessageId: 'b-2' }))
      // Wait for either outcome: B's own turn ran, or B's text was steered.
      await until(() => sent.some(s => s.userId === '2') || offerSteer.mock.calls.length > 0
        || [...a.frames, ...b.frames].some(f => f.type === 'message.steered'))
      await new Promise(r => setTimeout(r, 100))
      expect(offerSteer).not.toHaveBeenCalled()
      expect(a.frames.filter(f => f.type === 'message.steered')).toEqual([])
      // B's message passed the (neutralised) access check and ran as B's own turn.
      expect(sent.filter(s => s.userId === '2').map(s => s.text).join()).toContain('Zwischenruf von B2')
      await until(() => b.frames.some(f => f.type === 'done'))
      expect(b.frames.find(f => f.type === 'error')).toBeUndefined()

      expect(a.frames.filter(f => f.type === 'message.steered')).toEqual([])
      expect(b.frames.filter(f => f.type === 'message.steered')).toEqual([])
      expect(sent.filter(s => s.userId === '1').map(s => s.text)).toEqual(['Start A2'])
    } finally {
      access.mockRestore()
      // Cast: TS narrows releaseA to null after the reset above and cannot see
      // the assignment inside the mocked runner closure.
      ;(releaseA as (() => void) | null)?.()
      await until(() => a.frames.some(f => f.type === 'done'))
      a.ws.close()
      b.ws.close()
    }
  })
})
