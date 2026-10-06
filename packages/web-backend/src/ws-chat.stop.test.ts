/**
 * Strand-local `/stop` vs. global `/kill` over /ws/chat.
 *
 * The visible stop button of a strand sends `/stop` with that strand's
 * sessionId. It must end only the turns of that strand: before this fix the
 * handler called the user-wide abort, so stopping strand A also killed a turn
 * the same user had running in strand B. `/kill` stays the explicit global
 * emergency stop. All ids and texts are synthetic.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase, SessionForbiddenError, SessionNotFoundError } from '@axiom/core'
import type { AgentCore, Database, ResponseChunk } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'

const STRAND_A = 'strand-a-0001'
const STRAND_B = 'strand-b-0002'
const FOREIGN = 'strand-foreign-0003'

let previousDataDir: string | undefined
let tempDataDir: string

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-stop-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'coder'), { recursive: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

type Frame = Record<string, unknown>

interface Client {
  ws: WebSocket
  frames: Frame[]
  waitFor: (predicate: (frame: Frame) => boolean, label: string) => Promise<Frame>
}

function connect(port: number, token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/chat?token=${token}`)
    const frames: Frame[] = []
    ws.on('message', (data) => { frames.push(JSON.parse(data.toString()) as Frame) })
    const waitFor = async (predicate: (frame: Frame) => boolean, label: string): Promise<Frame> => {
      const deadline = Date.now() + 2000
      for (;;) {
        const hit = frames.find(predicate)
        if (hit) return hit
        if (Date.now() > deadline) throw new Error(`no ${label} frame within 2s, got ${JSON.stringify(frames)}`)
        await new Promise<void>((r) => setTimeout(r, 5))
      }
    }
    ws.on('open', () => resolve({ ws, frames, waitFor }))
    ws.on('error', reject)
  })
}

interface Harness {
  db: Database
  port: number
  token: string
  abort: ReturnType<typeof vi.fn>
  assertSessionAccess: ReturnType<typeof vi.fn>
  release: (sessionId: string) => void
  close: () => Promise<void>
}

/**
 * @param activeSessions  what SessionManager.getSession reports as the ACTIVE
 *                        session per persona (legacy frames without sessionId).
 */
async function harness(activeSessions: Record<string, string> = {}): Promise<Harness> {
  const db = initDatabase(':memory:')
  const owned: Record<string, string> = { [STRAND_A]: 'main', [STRAND_B]: 'coder' }
  const assertSessionAccess = vi.fn((userId: string, sessionId: string, agentId = 'main') => {
    if (sessionId === FOREIGN) throw new SessionForbiddenError(`Session ${sessionId} belongs to another user`)
    if (userId !== '1' || owned[sessionId] !== agentId) throw new SessionNotFoundError(`Session ${sessionId} is not an interactive session`)
    return { id: sessionId }
  })
  const sessionManager = {
    getOrCreateSession: vi.fn((userId: string, source: string, agentId = 'main') => ({
      id: activeSessions[agentId] ?? `sess-${agentId}`, userId, source, startedAt: 0, lastActivity: 0, messageCount: 0, summaryWritten: false, restored: false,
    })),
    assertSessionAccess,
    getSession: vi.fn((_userId: string, agentId = 'main') => (activeSessions[agentId] ? { id: activeSessions[agentId] } : undefined)),
  }

  // One blocked stream per session; released by a matching scoped abort
  // (like the runtime's session check) or explicitly by the test.
  const releases = new Map<string, () => void>()
  const gates = new Map<string, Promise<void>>()
  const gate = (sessionId: string): Promise<void> => {
    let g = gates.get(sessionId)
    if (!g) {
      g = new Promise<void>((resolve) => { releases.set(sessionId, resolve) })
      gates.set(sessionId, g)
    }
    return g
  }
  const release = (sessionId: string) => { gate(sessionId); releases.get(sessionId)!() }
  const sendMessage = vi.fn(async function* (
    _userId: string, _text: string, _source?: string, _attachments?: unknown, _agentId?: string, sessionId?: string,
  ): AsyncGenerator<ResponseChunk> {
    const id = sessionId ?? 'legacy'
    yield { type: 'text', text: `working in ${id}` }
    await gate(id)
    yield { type: 'text', text: `finished ${id}` }
    yield { type: 'done' }
  })
  const abort = vi.fn((scope?: { sessionId?: string }) => {
    if (scope?.sessionId) release(scope.sessionId)
  })
  const agentCore = {
    sendMessage,
    abort,
    getSessionManager: () => sessionManager,
    getPendingMessageCount: () => 0,
  } as unknown as AgentCore

  const app = createApp({ db })
  const server = http.createServer(app)
  const { wss } = setupWebSocketChat(server, db, agentCore)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port
  const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

  return {
    db, port, token, abort, assertSessionAccess, release,
    close: async () => {
      for (const id of [STRAND_A, STRAND_B, 'legacy']) release(id)
      await new Promise<void>((r) => setTimeout(r, 20))
      for (const c of wss.clients) c.terminate()
      wss.close()
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
    },
  }
}

const isText = (sessionId: string, text: string) => (f: Frame) => f.type === 'text' && f.sessionId === sessionId && f.text === text
const isDone = (sessionId: string) => (f: Frame) => f.type === 'done' && f.sessionId === sessionId
const isSystem = (text: string) => (f: Frame) => f.type === 'system' && f.text === text

/** Start a blocked turn in strand A (main) and strand B (coder) of user 1. */
async function startTwoStrands(c: Client): Promise<void> {
  c.ws.send(JSON.stringify({ type: 'message', content: 'first strand', agentId: 'main', sessionId: STRAND_A }))
  c.ws.send(JSON.stringify({ type: 'message', content: 'second strand', agentId: 'coder', sessionId: STRAND_B }))
  await c.waitFor(isText(STRAND_A, `working in ${STRAND_A}`), 'A text')
  await c.waitFor(isText(STRAND_B, `working in ${STRAND_B}`), 'B text')
}

function chatRowsMentioning(db: Database, needle: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE content LIKE ?').get(`%${needle}%`) as { c: number }).c
}

describe('ws-chat strand-local /stop', () => {
  it('stops only strand A and keeps the same user\'s turn in strand B running', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await startTwoStrands(c)

      c.ws.send(JSON.stringify({ type: 'command', content: '/stop', agentId: 'main', sessionId: STRAND_A }))
      const reply = await c.waitFor(isSystem('Stopped this strand.'), 'stop reply')
      expect(reply).toMatchObject({ sessionId: STRAND_A, agentId: 'main' })
      // Ownership is checked before anything is aborted.
      expect(h.assertSessionAccess).toHaveBeenCalledWith('1', STRAND_A, 'main')
      await c.waitFor(isDone(STRAND_A), 'A done')
      expect(h.abort).toHaveBeenCalledTimes(1)
      expect(h.abort).toHaveBeenCalledWith({ sessionId: STRAND_A, agentId: 'main' })

      // B was not touched: it finishes normally once its agent continues.
      expect(c.frames.some(isDone(STRAND_B))).toBe(false)
      h.release(STRAND_B)
      await c.waitFor(isText(STRAND_B, `finished ${STRAND_B}`), 'B finished')
      await c.waitFor(isDone(STRAND_B), 'B done')
      expect(c.frames.some(isText(STRAND_A, `finished ${STRAND_A}`))).toBe(false)

      // The stop command and its reply are not persisted as chat messages.
      await new Promise<void>((r) => setTimeout(r, 30))
      expect(chatRowsMentioning(h.db, '/stop')).toBe(0)
      expect(chatRowsMentioning(h.db, 'Stopped this strand')).toBe(0)
      c.ws.close()
    } finally { await h.close() }
  })

  it('refuses a strand of another user without aborting anything', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await startTwoStrands(c)

      c.ws.send(JSON.stringify({ type: 'command', content: '/stop', agentId: 'main', sessionId: FOREIGN }))
      const error = await c.waitFor(f => f.type === 'error', 'error')
      expect(error.code).toBe('session_forbidden')
      expect(h.abort).not.toHaveBeenCalled()

      // A persona mismatch (strand B is a coder strand) is refused as well.
      c.ws.send(JSON.stringify({ type: 'command', content: '/stop', agentId: 'main', sessionId: STRAND_B }))
      await c.waitFor(f => f.type === 'error' && f.code === 'session_not_found', 'mismatch error')
      expect(h.abort).not.toHaveBeenCalled()

      // A malformed id is refused before the session guard even runs.
      const guardCalls = h.assertSessionAccess.mock.calls.length
      c.ws.send(JSON.stringify({ type: 'command', content: '/stop', sessionId: 'not a valid id!' }))
      await c.waitFor(f => f.type === 'error' && f.error === 'Invalid sessionId', 'invalid id error')
      expect(h.assertSessionAccess.mock.calls.length).toBe(guardCalls)
      expect(h.abort).not.toHaveBeenCalled()
      expect(c.frames.some(isDone(STRAND_A)) || c.frames.some(isDone(STRAND_B))).toBe(false)
      c.ws.close()
    } finally { await h.close() }
  })

  it('a legacy /stop without sessionId only stops the persona\'s active session', async () => {
    const h = await harness({ main: STRAND_A })
    try {
      const c = await connect(h.port, h.token)
      await startTwoStrands(c)

      c.ws.send(JSON.stringify({ type: 'command', content: '/stop' }))
      await c.waitFor(isSystem('Stopped this strand.'), 'stop reply')
      await c.waitFor(isDone(STRAND_A), 'A done')
      expect(h.abort).toHaveBeenCalledTimes(1)
      expect(h.abort).toHaveBeenCalledWith({ sessionId: STRAND_A, agentId: 'main' })
      expect(c.frames.some(isDone(STRAND_B))).toBe(false)
      c.ws.close()
    } finally { await h.close() }
  })

  it('a legacy /stop with no active session stops nothing instead of falling back to the global abort', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await startTwoStrands(c)

      c.ws.send(JSON.stringify({ type: 'command', content: '/stop', agentId: 'coder' }))
      await c.waitFor(isSystem('Nothing to stop in this strand.'), 'nothing reply')
      expect(h.abort).not.toHaveBeenCalled()
      expect(c.frames.some(isDone(STRAND_A)) || c.frames.some(isDone(STRAND_B))).toBe(false)
      c.ws.close()
    } finally { await h.close() }
  })

  it('reports an idle strand without touching the running one', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      c.ws.send(JSON.stringify({ type: 'message', content: 'second strand', agentId: 'coder', sessionId: STRAND_B }))
      await c.waitFor(isText(STRAND_B, `working in ${STRAND_B}`), 'B text')

      c.ws.send(JSON.stringify({ type: 'command', content: '/stop', agentId: 'main', sessionId: STRAND_A }))
      const reply = await c.waitFor(isSystem('Nothing to stop in this strand.'), 'nothing reply')
      expect(reply).toMatchObject({ sessionId: STRAND_A, agentId: 'main' })
      expect(h.abort).not.toHaveBeenCalled()
      c.ws.close()
    } finally { await h.close() }
  })
})

describe('ws-chat global /kill', () => {
  it('stays the emergency stop and ends the turns of strand A and B', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await startTwoStrands(c)

      c.ws.send(JSON.stringify({ type: 'command', content: '/kill', agentId: 'main', sessionId: STRAND_A }))
      await c.waitFor(isSystem('All of your running turns were stopped.'), 'kill reply')
      await c.waitFor(isDone(STRAND_A), 'A done')
      await c.waitFor(isDone(STRAND_B), 'B done')
      expect(h.abort).toHaveBeenCalledWith({ sessionId: STRAND_A, agentId: 'main' })
      expect(h.abort).toHaveBeenCalledWith({ sessionId: STRAND_B, agentId: 'coder' })

      await new Promise<void>((r) => setTimeout(r, 30))
      expect(chatRowsMentioning(h.db, '/kill')).toBe(0)
      c.ws.close()
    } finally { await h.close() }
  })

  it('answers "Nothing to stop." when no turn runs', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      c.ws.send(JSON.stringify({ type: 'command', content: '/kill' }))
      await c.waitFor(isSystem('Nothing to stop.'), 'nothing reply')
      expect(h.abort).not.toHaveBeenCalled()
      c.ws.close()
    } finally { await h.close() }
  })
})
