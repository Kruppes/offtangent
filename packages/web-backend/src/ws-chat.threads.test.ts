/**
 * Offtangent Stufe 1 over /ws/chat: `{type:'message', ..., sessionId}` picks
 * the thread explicitly.
 *
 * Each test fails against the pre-threads handler, which always resolved the
 * ONE session of (user, persona) via getOrCreateSession, knew no session error
 * codes and never told a client that its turn has to wait.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase, saveProviders, SessionNotFoundError, SessionAgentMismatchError, SessionForbiddenError } from '@axiom/core'
import type { AgentCore, ResponseChunk, Database } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'

let previousDataDir: string | undefined
let tempDataDir: string

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-threads-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })
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
  activateCalls: Array<[string, string, string | undefined]>
  getOrCreateCalls: Array<[string, string, string | undefined]>
  close: () => Promise<void>
}

/**
 * @param activate  behaviour of SessionManager.activateSession (throw to
 *                  simulate a guard failure).
 * @param pending   what AgentCore reports as the global queue depth.
 */
async function harness(options: {
  activate?: (userId: string, sessionId: string, agentId?: string) => { id: string }
  pending?: number
  /** Per-persona queue state (plan 2026-09-19); omitted = legacy core. */
  queue?: { position: number; blockedBy: { agentId: string; sessionId: string | null } | null }
} = {}): Promise<Harness> {
  const db = initDatabase(':memory:')
  const activateCalls: Array<[string, string, string | undefined]> = []
  const getOrCreateCalls: Array<[string, string, string | undefined]> = []
  const sessionManager = {
    getOrCreateSession: vi.fn((userId: string, source: string, agentId?: string) => {
      getOrCreateCalls.push([userId, source, agentId])
      return { id: `sess-${agentId ?? 'main'}`, userId, source, startedAt: 0, lastActivity: 0, messageCount: 0, summaryWritten: false, restored: false }
    }),
    // The WS layer must only CHECK access (assertSessionAccess); activation
    // is the turn's job. `activateSession` is left undefined on purpose so a
    // regression back to activating here fails loudly.
    assertSessionAccess: vi.fn((userId: string, sessionId: string, agentId?: string) => {
      activateCalls.push([userId, sessionId, agentId])
      const handler = options.activate ?? ((_u: string, id: string) => ({ id }))
      return handler(userId, sessionId, agentId)
    }),
    getSession: vi.fn(() => undefined),
  }
  const sendMessage = vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
    yield { type: 'text', text: 'ok' }
    yield { type: 'done' }
  })
  const agentCore = {
    sendMessage,
    abort: vi.fn(),
    getSessionManager: () => sessionManager,
    getPendingMessageCount: () => options.pending ?? 0,
    // Only present when the test asks for it, so the legacy fallback
    // (getPendingMessageCount only) keeps being covered by the tests above.
    ...(options.queue ? { describeQueue: () => options.queue } : {}),
  } as unknown as AgentCore

  const app = createApp({ db })
  const server = http.createServer(app)
  const { wss } = setupWebSocketChat(server, db, agentCore)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port
  const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

  return {
    db, port, token, sendMessage, activateCalls, getOrCreateCalls,
    close: async () => {
      await new Promise<void>((r) => setTimeout(r, 20))
      for (const c of wss.clients) c.terminate()
      wss.close()
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
    },
  }
}

describe('ws-chat explicit threads', () => {
  it.each([
    [{ modelProviderId: 'choice' }, 'invalid_model_pin'],
    [{ modelId: 'chosen' }, 'invalid_model_pin'],
    [{ modelProviderId: '', modelId: 'chosen' }, 'invalid_model_pin'],
    [{ modelProviderId: null, modelId: null }, 'invalid_model_pin'],
    [{ modelProviderId: 'unknown', modelId: 'chosen' }, 'model_unavailable'],
    [{ modelProviderId: 'choice', modelId: 'disabled' }, 'model_unavailable'],
    [{ modelProviderId: 'choice', modelId: 'failed' }, 'model_unavailable'],
    [{ modelProviderId: 'broken', modelId: 'chosen' }, 'model_unavailable'],
  ])('refuses unavailable/invalid turn selection %j before any side effect', async (selection, code) => {
    saveProviders({ providers: [
      { id: 'choice', name: 'Choice', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['chosen', 'failed'], modelStatuses: { chosen: 'connected', failed: 'error' } },
      { id: 'broken', name: 'Broken', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['chosen'], status: 'error' },
    ] })
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'hello', sessionId: 'thread-1', ...selection }))
      expect(await c.nextOfType('error')).toMatchObject({ code })
      expect(h.sendMessage).not.toHaveBeenCalled()
      expect(h.activateCalls).toEqual([])
      expect(h.db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()).toEqual({ c: 0 })
      c.ws.close()
    } finally { await h.close() }
  })

  it('threads a valid one-shot selection through the real runner, without changing a strand pin', async () => {
    saveProviders({ providers: [
      { id: 'choice', name: 'Choice', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['chosen'], modelStatuses: { chosen: 'connected' } },
    ] })
    const h = await harness()
    try {
      h.db.prepare("INSERT INTO sessions (id, user_id, source, agent_id, model_provider_id, model_id) VALUES ('thread-1', '1', 'web', 'main', 'original', 'pinned')").run()
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'hello', sessionId: 'thread-1', modelProviderId: ' choice ', modelId: ' chosen ' }))
      await c.nextOfType('done')
      expect(h.sendMessage.mock.calls[0][6]).toEqual({ providerId: 'choice', modelId: 'chosen' })
      expect(h.db.prepare("SELECT model_provider_id, model_id FROM sessions WHERE id = 'thread-1'").get()).toEqual({ model_provider_id: 'original', model_id: 'pinned' })
      c.ws.send(JSON.stringify({ type: 'message', content: 'inherit again', sessionId: 'thread-1' }))
      await c.nextOfType('done')
      expect(h.sendMessage.mock.calls[1][6]).toBeUndefined()
      c.ws.close()
    } finally { await h.close() }
  })

  it('activates the named thread, persists there and hands it to the agent', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next() // Authenticated
      c.ws.send(JSON.stringify({ type: 'message', content: 'hello', agentId: 'bob', sessionId: 'thread-1' }))

      // Every turn frame names the thread (and persona) so a client with
      // several open threads of one persona can route it.
      const text = await c.nextOfType('text')
      expect(text.sessionId).toBe('thread-1')
      expect(text.agentId).toBe('bob')
      const done = await c.nextOfType('done')
      expect(done.sessionId).toBe('thread-1')
      expect(h.activateCalls).toEqual([['1', 'thread-1', 'bob']])
      expect(h.getOrCreateCalls).toEqual([])
      // 6th positional arg of AgentCore.sendMessage is the explicit session.
      expect(h.sendMessage.mock.calls[0][5]).toBe('thread-1')

      await new Promise<void>((r) => setTimeout(r, 30))
      const rows = h.db.prepare('SELECT role, session_id FROM chat_messages ORDER BY id').all() as Array<{ role: string; session_id: string }>
      expect(rows.map(r => r.session_id)).toEqual(['thread-1', 'thread-1'])
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('keeps the legacy path when no sessionId is sent', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'hello' }))

      await c.nextOfType('done')
      expect(h.getOrCreateCalls).toEqual([['1', 'web', 'main']])
      expect(h.activateCalls).toEqual([])
      expect(h.sendMessage.mock.calls[0][5]).toBeUndefined()
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it.each([
    ['session_not_found', () => { throw new SessionNotFoundError('nope') }],
    ['session_agent_mismatch', () => { throw new SessionAgentMismatchError('other persona') }],
    ['session_forbidden', () => { throw new SessionForbiddenError('not yours') }],
  ])('maps %s to an error frame without persisting or starting a turn', async (code, activate) => {
    const h = await harness({ activate: activate as () => { id: string } })
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'hello', agentId: 'bob', sessionId: 'thread-x' }))

      const err = await c.nextOfType('error')
      expect(err.code).toBe(code)
      await c.quietFor(50)
      expect(h.sendMessage).not.toHaveBeenCalled()
      expect(h.db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()).toEqual({ c: 0 })
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('refuses a malformed sessionId before any side effect', async () => {
    const h = await harness()
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'hello', sessionId: 'not a session' }))

      const err = await c.nextOfType('error')
      expect(err.error).toBe('Invalid sessionId')
      await c.quietFor(50)
      expect(h.activateCalls).toEqual([])
      expect(h.sendMessage).not.toHaveBeenCalled()
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('announces a queued turn when the global queue is busy', async () => {
    const h = await harness({ pending: 2 })
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'hello', agentId: 'bob', sessionId: 'thread-1' }))

      const queued = await c.nextOfType('queued')
      expect(queued.sessionId).toBe('thread-1')
      expect(queued.position).toBe(3)
      expect(queued.agentId).toBe('bob')
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('names the blocking strand in queued and turn_queued', async () => {
    // A real strand of the user so the title resolves; the blocker lives in
    // the database, not in core (core only knows ids).
    const h = await harness({
      queue: { position: 2, blockedBy: { agentId: 'bob', sessionId: 'blocker-strand' } },
    })
    try {
      h.db.prepare(
        "INSERT INTO sessions (id, user_id, session_user, agent_id, title, source, started_at, last_activity) VALUES (?, 1, '1', 'bob', 'Hotfix Deploy', 'web', 0, 0)",
      ).run('blocker-strand')
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'hello', agentId: 'bob', sessionId: 'thread-1' }))

      const expected = {
        sessionId: 'thread-1',
        agentId: 'bob',
        position: 2,
        blockedBy: { agentId: 'bob', sessionId: 'blocker-strand', title: 'Hotfix Deploy' },
      }
      const queued = await c.nextOfType('queued')
      expect(queued).toMatchObject(expected)
      // The new frame carries the same payload under the event-bus name.
      const turnQueued = await c.nextOfType('turn_queued')
      expect(turnQueued).toMatchObject(expected)
      c.ws.close()
    } finally {
      await h.close()
    }
  })

  it('stays silent about the queue when nothing is waiting', async () => {
    const h = await harness({ pending: 0 })
    try {
      const c = await connect(h.port, h.token)
      await c.next()
      c.ws.send(JSON.stringify({ type: 'message', content: 'hello' }))

      const frames: string[] = []
      for (let i = 0; i < 2; i++) frames.push(String((await c.next()).type))
      expect(frames).not.toContain('queued')
      c.ws.close()
    } finally {
      await h.close()
    }
  })
})
