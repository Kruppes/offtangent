/**
 * V3 of the privacy plan (2026-09-26): one integration test per user entry
 * path, each with a canary.
 *
 * The canaries are assembled at runtime from harmless parts so no file in this
 * repository contains a token-shaped literal:
 * - a strong canary (`ghp_` + 36 chars) that the structural rules must catch
 *   on every path, in both tiers,
 * - a context canary ("mein Passwort ist …") that only the `user` tier sees.
 *
 * What every test asserts:
 * 1. the canary value appears ZERO times in `chat_messages.content`,
 *    `captures.text`, `router_decisions.part_text` and in the text handed to
 *    the runtime (the turn runner / the router model),
 * 2. a `{{secret:<slug>}}` handle appears instead,
 * 3. the value is still resolvable from the encrypted store, so nothing was
 *    lost.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import {
  initDatabase,
  SessionManager,
  resolveSecret,
  listSecrets,
  invalidateSecretHandleCache,
  invalidateKnownValues,
  SECRET_HANDLE_RE,
  STAGE1_SYSTEM_PROMPT,
} from '@axiom/core'
import type { AgentCore, Database, ResolvedRouterModel } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { createCapturesService } from './api/modules/captures/service.js'
import { createInteractionsService } from './api/modules/interactions/service.js'

/** `ghp_` plus 36 alphanumerics — matched by the `github-token` rule. */
const STRONG_CANARY = ['ghp', '_', 'C4n4ry', 'Fake', 'Token', '0000', 'abcdefghij', 'klmnopqr'].join('')
const CONTEXT_CANARY = 'Zw1ebel-Kanari3!'
const CONTEXT_SENTENCE = `mein Passwort ist ${CONTEXT_CANARY}`

let tmpDir: string
let previousDataDir: string | undefined
let previousKey: string | undefined
let db: Database

function handles(text: string): string[] {
  return [...text.matchAll(new RegExp(SECRET_HANDLE_RE.source, 'g'))].map(match => match[1]!)
}

/** Every text column a user message can end up in. */
function storedTexts(): string[] {
  const rows: string[] = []
  for (const row of db.prepare('SELECT content FROM chat_messages').all() as Array<{ content: string }>) {
    rows.push(row.content)
  }
  for (const row of db.prepare('SELECT text FROM captures').all() as Array<{ text: string }>) {
    rows.push(row.text)
  }
  for (const row of db.prepare('SELECT part_text, rationale FROM router_decisions').all() as Array<{ part_text: string | null; rationale: string | null }>) {
    if (row.part_text) rows.push(row.part_text)
    if (row.rationale) rows.push(row.rationale)
  }
  for (const row of db.prepare('SELECT input, output FROM tool_calls').all() as Array<{ input: string | null; output: string | null }>) {
    if (row.input) rows.push(row.input)
    if (row.output) rows.push(row.output)
  }
  return rows
}

function expectNoCanaryStored(): void {
  for (const text of storedTexts()) {
    expect(text).not.toContain(STRONG_CANARY)
    expect(text).not.toContain(CONTEXT_CANARY)
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-wiring-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previousDataDir = process.env.DATA_DIR
  previousKey = process.env.ENCRYPTION_KEY
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-privacy-wiring-tests'
  invalidateSecretHandleCache()
  invalidateKnownValues()
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
})

afterEach(() => {
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousKey
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

describe('V3 entry path: POST /api/chat/message (routes/chat.ts)', () => {
  function server(): { srv: http.Server; sessionId: string } {
    const sessionManager = new SessionManager({ db, memoryDir: path.join(tmpDir, 'memory'), timeoutMinutes: 0 })
    const session = sessionManager.getOrCreateSession('1', 'web', 'main')
    const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
    const app = createApp({ db, agentCore })
    return { srv: http.createServer(app), sessionId: session.id }
  }

  async function post(port: number, content: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  it('seals a strong canary before the row is written and reports it additively', async () => {
    const { srv } = server()
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as { port: number }).port
    try {
      const { status, body } = await post(port, `deploy with ${STRONG_CANARY} please`)
      expect(status).toBe(201)
      const message = body.message as Record<string, unknown>
      expect(String(message.content)).not.toContain(STRONG_CANARY)
      expect(handles(String(message.content))).toHaveLength(1)
      const sealed = body.sealed as Array<{ slug: string; kind: string }>
      expect(sealed).toHaveLength(1)
      expect(sealed[0]!.kind).toBe('github-token')
      expect(resolveSecret(sealed[0]!.slug)).toBe(STRONG_CANARY)
      expectNoCanaryStored()
    } finally {
      await new Promise<void>((resolve, reject) => srv.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('seals a context password (user tier) on the same path', async () => {
    const { srv } = server()
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as { port: number }).port
    try {
      const { status, body } = await post(port, `${CONTEXT_SENTENCE}, bitte merken`)
      expect(status).toBe(201)
      const sealed = body.sealed as Array<{ slug: string; kind: string }>
      expect(sealed).toHaveLength(1)
      expect(sealed[0]!.kind).toBe('password')
      expect(resolveSecret(sealed[0]!.slug)).toBe(CONTEXT_CANARY)
      expectNoCanaryStored()
    } finally {
      await new Promise<void>((resolve, reject) => srv.close(err => (err ? reject(err) : resolve())))
    }
  })

  it('leaves a message without a secret byte-identical', async () => {
    const { srv } = server()
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as { port: number }).port
    try {
      const { body } = await post(port, 'Das Passwort ist abgelaufen, bitte neu setzen.')
      expect(String((body.message as Record<string, unknown>).content))
        .toBe('Das Passwort ist abgelaufen, bitte neu setzen.')
      expect(body.sealed).toEqual([])
      expect(listSecrets()).toEqual([])
    } finally {
      await new Promise<void>((resolve, reject) => srv.close(err => (err ? reject(err) : resolve())))
    }
  })
})

describe('V3 entry path: web socket (ws-chat.ts)', () => {
  it('seals the frame before the row is written and before the turn starts', async () => {
    const sessionManager = new SessionManager({ db, memoryDir: path.join(tmpDir, 'memory'), timeoutMinutes: 0 })
    const runtimeTexts: string[] = []
    const agentCore = {
      sendMessage: vi.fn(),
      abort: vi.fn(),
      getSessionManager: () => sessionManager,
    } as unknown as AgentCore
    const turnRunner = {
      startTurn: (input: { text: string }) => {
        runtimeTexts.push(input.text)
        return { turnId: 't1', queued: false }
      },
      hasActiveTurnInSession: () => false,
      subscribe: () => () => {},
      getActiveTurns: () => [],
    }
    const app = createApp({ db, agentCore })
    const srv = http.createServer(app)
    const { wss } = setupWebSocketChat(srv, db, agentCore, undefined, undefined, undefined, turnRunner as never)
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=${token}`)
      const frames: Array<Record<string, unknown>> = []
      ws.on('message', data => frames.push(JSON.parse(data.toString()) as Record<string, unknown>))
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
      })
      ws.send(JSON.stringify({
        type: 'message',
        content: `push it with ${STRONG_CANARY} and ${CONTEXT_SENTENCE}`,
        clientMessageId: 'canary-1',
      }))
      const deadline = Date.now() + 4000
      while ((runtimeTexts.length === 0 || !frames.some(frame => frame.type === 'message_ack')) && Date.now() < deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 20))
      }
      ws.close()

      expect(runtimeTexts).toHaveLength(1)
      expect(runtimeTexts[0]).not.toContain(STRONG_CANARY)
      expect(runtimeTexts[0]).not.toContain(CONTEXT_CANARY)
      expect(handles(runtimeTexts[0]!)).toHaveLength(2)
      expectNoCanaryStored()

      const stored = db.prepare("SELECT content FROM chat_messages WHERE role = 'user'").all() as Array<{ content: string }>
      expect(stored).toHaveLength(1)
      expect(handles(stored[0]!.content)).toHaveLength(2)

      const ack = frames.find(frame => frame.type === 'message_ack')
      expect(ack).toBeDefined()
      const sealed = ack!.sealed as Array<{ slug: string; kind: string }>
      expect(sealed.map(entry => entry.kind).sort()).toEqual(['github-token', 'password'])
      expect(sealed.map(entry => resolveSecret(entry.slug)).sort())
        .toEqual([CONTEXT_CANARY, STRONG_CANARY].sort())
    } finally {
      for (const client of wss.clients) client.terminate()
      wss.close()
      await new Promise<void>((resolve, reject) => srv.close(err => (err ? reject(err) : resolve())))
    }
  })
})

describe('V3 entry path: captures (captures/service.ts)', () => {
  const chain: ResolvedRouterModel[] = [
    { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
  ]

  function build(): {
    service: ReturnType<typeof createCapturesService>
    routerPrompts: string[]
    turns: string[]
  } {
    const sessionManager = new SessionManager({ db, memoryDir: path.join(tmpDir, 'memory'), timeoutMinutes: 0 })
    const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
    const routerPrompts: string[] = []
    const turns: string[] = []
    const service = createCapturesService({
      db,
      getAgentCore: () => agentCore,
      getNowSetMode: () => 'manual',
      getTurnRunner: () => ({ startTurn: (input: { text: string }) => { turns.push(input.text); return {} } } as never),
      routerChain: () => chain,
      routerComplete: async (_entry, userPrompt) => {
        routerPrompts.push(userPrompt)
        return JSON.stringify({
          action: 'new_strand', strandId: null, secondaryStrandId: null,
          newStrand: { title: 'Canary', personaId: 'main', tags: [], projectId: null },
          intent: 'ask', confidence: 0.95, tags: [], rationale: 'canary test', alternatives: [],
        })
      },
      splitComplete: async (system: string) => (system === STAGE1_SYSTEM_PROMPT
        ? JSON.stringify({ topics: [], uncertain: [], splitConfidence: 0.1, rationale: 'one matter' })
        : ''),
    })
    return { service, routerPrompts, turns }
  }

  it('seals the capture text before insertCapture, the router call and the turn', async () => {
    // One candidate strand, otherwise the router answers synthetically and the
    // stub is never called (no candidates means "new strand" by definition).
    db.prepare(
      `INSERT INTO sessions (id, user_id, session_user, type, agent_id, title, started_at, last_activity, archived)
       VALUES ('s-candidate', 1, '1', 'interactive', 'main', 'Deploys', datetime('now','-1 day'), datetime('now','-1 day'), 0)`,
    ).run()
    const { service, routerPrompts, turns } = build()
    const result = await service.createCapture(1, {
      text: `Bitte das Repo pushen, Token ${STRONG_CANARY}, und ${CONTEXT_SENTENCE}.`,
      clientMessageId: null, agentId: null, strandId: null,
      kind: 'text', source: 'web', attachments: [], intent: null, mode: 'work',
    })

    expect(result.capture.text).not.toContain(STRONG_CANARY)
    expect(result.capture.text).not.toContain(CONTEXT_CANARY)
    expect(handles(result.capture.text)).toHaveLength(2)
    expect((result.sealed ?? []).map(entry => entry.kind).sort()).toEqual(['github-token', 'password'])

    // The router never sees the value — this is the request that leaves the
    // process first on this path.
    expect(routerPrompts).toHaveLength(1)
    expect(routerPrompts[0]).not.toContain(STRONG_CANARY)
    expect(routerPrompts[0]).not.toContain(CONTEXT_CANARY)

    // captures.text, router_decisions.part_text, chat_messages.content
    expectNoCanaryStored()
    const decision = db.prepare('SELECT part_text FROM router_decisions').get() as { part_text: string | null }
    if (decision?.part_text) expect(decision.part_text).not.toContain(STRONG_CANARY)

    for (const text of turns) {
      expect(text).not.toContain(STRONG_CANARY)
      expect(text).not.toContain(CONTEXT_CANARY)
    }
    for (const entry of result.sealed ?? []) {
      expect(resolveSecret(entry.slug)).toBeTruthy()
    }
  })

  it('seals an explicitly targeted capture too (no router on that path)', async () => {
    const { service, turns } = build()
    db.prepare(
      `INSERT INTO sessions (id, user_id, session_user, type, agent_id, title, started_at, last_activity, archived)
       VALUES ('s-explicit', 1, '1', 'interactive', 'main', 'Deploy', datetime('now'), datetime('now'), 0)`,
    ).run()
    const result = await service.createCapture(1, {
      text: `nimm ${STRONG_CANARY}`,
      clientMessageId: null, agentId: 'main', strandId: 's-explicit',
      kind: 'text', source: 'web', attachments: [], intent: 'ask', mode: 'work',
    })
    expect(result.capture.text).not.toContain(STRONG_CANARY)
    expect(handles(result.capture.text)).toHaveLength(1)
    expectNoCanaryStored()
    for (const text of turns) expect(text).not.toContain(STRONG_CANARY)
  })
})

describe('V3 entry path: interaction answers (interactions/service.ts)', () => {
  it('seals the answered label before it becomes a user row', () => {
    const sessionManager = new SessionManager({ db, memoryDir: path.join(tmpDir, 'memory'), timeoutMinutes: 0 })
    const session = sessionManager.getOrCreateSession('1', 'web', 'main')
    const turns: string[] = []
    // A choice whose option label carries a credential. The answer is filed as
    // a `user` row and starts a turn, so it passes the boundary like typed
    // text — the option ids themselves stay untouched.
    const fence = [
      '```offtangent',
      JSON.stringify({
        block: 'choice',
        id: 'b1',
        question: 'Welchen Token nehmen?',
        options: [
          { id: 'old', label: `den alten (${STRONG_CANARY})` },
          { id: 'new', label: 'einen neuen erzeugen' },
        ],
      }),
      '```',
    ].join('\n')
    db.prepare(
      `INSERT INTO sessions (id, user_id, session_user, type, agent_id, title, started_at, last_activity, archived)
       VALUES (?, 1, '1', 'interactive', 'main', 'Deploy', datetime('now'), datetime('now'), 0)`,
    ).run(session.id === 'x' ? 'strand-i' : 'strand-i')
    const messageId = Number(db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id)
       VALUES ('strand-i', 1, 'assistant', ?, NULL, 'main')`,
    ).run(`Was nehmen wir?\n\n${fence}`).lastInsertRowid)

    const service = createInteractionsService({
      db,
      getTurnRunner: () => ({ startTurn: (input: { text: string }) => { turns.push(input.text); return {} } } as never),
    })

    const answered = service.answer(1, { messageId, blockId: 'b1', value: 'old', clientMessageId: 'cmid-canary' })
    expect(JSON.stringify(answered)).not.toContain(STRONG_CANARY)

    const userRows = db.prepare("SELECT content FROM chat_messages WHERE role = 'user'").all() as Array<{ content: string }>
    expect(userRows).toHaveLength(1)
    expect(userRows[0]!.content).not.toContain(STRONG_CANARY)
    expect(handles(userRows[0]!.content)).toHaveLength(1)
    for (const text of turns) expect(text).not.toContain(STRONG_CANARY)
    expect(resolveSecret(handles(userRows[0]!.content)[0]!)).toBe(STRONG_CANARY)
  })
})
