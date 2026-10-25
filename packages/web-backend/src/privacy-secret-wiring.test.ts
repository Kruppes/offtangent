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
  ingestInteractionMessage,
} from '@axiom/core'
import type { AgentCore, Database, ResolvedRouterModel } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { createCapturesService } from './api/modules/captures/service.js'
import { createInteractionsService } from './api/modules/interactions/service.js'
import { registerInteractionBroadcast } from './interaction-broadcast.js'

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
      // S1-D: ws-chat submits through submitUserMessage; with no live run
      // it starts a turn, exactly like the real runner.
      submitUserMessage(input: { text: string }) {
        return { mode: 'started' as const, turn: this.startTurn(input) }
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

  // The payload of a card is assistant text that never passed the boundary.
  // Every way it leaves the server (list endpoint, websocket frames) carries
  // it sealed, recursively over every string (question, option labels; the
  // contract keeps no free description field).
  function insertSecretCard(): { messageId: number; content: string } {
    db.prepare(
      `INSERT INTO sessions (id, user_id, session_user, type, agent_id, title, started_at, last_activity, archived)
       VALUES ('strand-p', 1, '1', 'interactive', 'main', 'Deploy', datetime('now'), datetime('now'), 0)`,
    ).run()
    const content = [
      'Was nehmen wir?',
      '',
      '```offtangent',
      JSON.stringify({
        block: 'choice',
        id: 'b1',
        question: `Token ${STRONG_CANARY} behalten?`,
        options: [
          { id: 'old', label: `den alten (${STRONG_CANARY})` },
          { id: 'new', label: 'einen neuen erzeugen' },
        ],
      }),
      '```',
    ].join('\n')
    const messageId = Number(db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id)
       VALUES ('strand-p', 1, 'assistant', ?, NULL, 'main')`,
    ).run(content).lastInsertRowid)
    return { messageId, content }
  }

  it('seals the payload in the list endpoint (GET /api/strands/:id/interactions)', () => {
    const { messageId, content } = insertSecretCard()
    ingestInteractionMessage(db, { messageId, strandId: 'strand-p', userId: 1, agent: 'main', content })
    const service = createInteractionsService({ db, getTurnRunner: () => null })
    const listed = service.listForStrand(1, 'strand-p', 'open')
    expect(listed).toHaveLength(1)
    const json = JSON.stringify(listed)
    expect(json).not.toContain(STRONG_CANARY)
    const payload = listed[0]!.payload as unknown as { question: string; options: Array<{ id: string; label: string }> }
    expect(handles(payload.question)).toHaveLength(1)
    expect(handles(payload.options[0]!.label)).toHaveLength(1)
    expect(payload.options.map(o => o.id)).toEqual(['old', 'new'])
    expect(payload.options[1]!.label).toBe('einen neuen erzeugen')
  })

  it('seals the payload in every interaction websocket frame (interaction-broadcast.ts)', () => {
    const frames: Array<Record<string, unknown>> = []
    const off = registerInteractionBroadcast({ chatEventBus: { broadcast: (event: Record<string, unknown>) => { frames.push(event) } } as never })
    try {
      const { messageId, content } = insertSecretCard()
      const [row] = ingestInteractionMessage(db, { messageId, strandId: 'strand-p', userId: 1, agent: 'main', content })
      const service = createInteractionsService({ db, getTurnRunner: () => ({ startTurn: () => ({}) } as never) })
      service.answerById(1, row!.id, { value: 'old', clientRequestId: 'cr-canary', surface: 'web' })
    } finally {
      off()
    }
    expect(frames.map(f => f.type)).toEqual(expect.arrayContaining(['interaction.open', 'interaction.updated']))
    for (const frame of frames) {
      expect(JSON.stringify(frame)).not.toContain(STRONG_CANARY)
      const payload = (frame.interaction as { payload: { options: Array<{ label: string }> } }).payload
      expect(handles(payload.options[0]!.label)).toHaveLength(1)
    }
  })
})

describe('V3 interaction boundary per path (review 1, finding 2: draft, answer, attention)', () => {
  const card = [
    'Pick one.',
    '```offtangent',
    JSON.stringify({ block: 'choice', id: 'q1', question: `Rotate ${STRONG_CANARY}?`, options: [{ id: 'a', label: 'yes' }, { id: 'b', label: 'no' }] }),
    '```',
  ].join('\n')

  function seed(sessionId = 'strand-v3') {
    db.prepare(`INSERT OR IGNORE INTO sessions (id, user_id, agent_id, title, type) VALUES (?, 1, 'main', 'S', 'interactive')`).run(sessionId)
    const messageId = Number(db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, 1, 'assistant', ?, NULL, 'main')`,
    ).run(sessionId, card).lastInsertRowid)
    const [row] = ingestInteractionMessage(db, { messageId, strandId: sessionId, userId: 1, agent: 'main', content: card })
    return { messageId, row: row! }
  }

  it('PUT draft response, GET list with draft and the draft WS frame are sealed', () => {
    const frames: Array<Record<string, unknown>> = []
    const off = registerInteractionBroadcast({ chatEventBus: { broadcast: (event: Record<string, unknown>) => { frames.push(event) } } as never })
    const { row } = seed()
    const service = createInteractionsService({ db, getTurnRunner: () => null })
    let saved: unknown
    try {
      saved = service.saveDraft(1, row.id, { answers: { q1: `typed ${STRONG_CANARY}` } })
    } finally { off() }
    expect(JSON.stringify(saved)).not.toContain(STRONG_CANARY)
    expect(handles(JSON.stringify((saved as { draft: unknown }).draft))).toHaveLength(1)
    const listed = service.listForStrand(1, 'strand-v3', 'open')
    expect(JSON.stringify(listed[0]!.draft)).not.toContain(STRONG_CANARY)
    expect(handles(JSON.stringify(listed[0]!.draft))).toHaveLength(1)
    const draftFrame = frames.find(f => f.type === 'interaction.draft')
    expect(draftFrame).toBeDefined()
    expect(JSON.stringify(draftFrame)).not.toContain(STRONG_CANARY)
  })

  it('GET list with a backfilled raw answer label and the 409 body are sealed (sealed on read)', () => {
    const { row } = seed()
    // A backfilled answer keeps the raw label in the table (raw source).
    db.prepare(`UPDATE interactions SET status = 'answered', close_source = 'backfill', closed_at = '2026-10-24T00:00:00.000Z', answer = ? WHERE id = ?`)
      .run(JSON.stringify({ value: 'a', label: `old ${STRONG_CANARY}`, answeredAt: '2026-10-20T00:00:00.000Z', clientRequestId: 'cm-old', resumed: true }), row.id)
    expect((db.prepare('SELECT answer FROM interactions WHERE id = ?').get(row.id) as { answer: string }).answer).toContain(STRONG_CANARY)
    const service = createInteractionsService({ db, getTurnRunner: () => null })
    const listed = service.listForStrand(1, 'strand-v3')
    expect(JSON.stringify(listed)).not.toContain(STRONG_CANARY)
    expect(handles(listed[0]!.answer!.label)).toHaveLength(1)
    let body: Record<string, unknown> | undefined
    try {
      service.answerById(1, row.id, { value: 'b', clientRequestId: 'cr-new', surface: 'web' })
    } catch (err) {
      body = { status: (err as { status: number }).status, ...((err as { details?: Record<string, unknown> }).details ?? {}) }
      expect(JSON.stringify(err)).not.toContain(STRONG_CANARY)
    }
    expect(body).toBeDefined()
    expect(JSON.stringify(body)).not.toContain(STRONG_CANARY)
    expect(handles(String(body!.label))).toHaveLength(1)
  })

  /** Review 2, finding A: a backfilled raw answer, replayed with its own key and value. */
  function importRawAnswer(rowId: string, resumed: boolean) {
    db.prepare(`UPDATE interactions SET status = 'answered', close_source = 'backfill', closed_at = '2026-10-24T00:00:00.000Z', answer = ? WHERE id = ?`)
      .run(JSON.stringify({ value: 'a', label: `old ${STRONG_CANARY}`, answeredAt: '2026-10-20T00:00:00.000Z', clientRequestId: 'cm-old', resumed }), rowId)
  }

  it('idempotent replay of an imported raw answer: top-level value/label and interaction.answer are sealed (both doors)', () => {
    const { messageId, row } = seed()
    importRawAnswer(row.id, true)
    const service = createInteractionsService({ db, getTurnRunner: () => null })
    const byId = service.answerById(1, row.id, { value: 'a', clientRequestId: 'cm-old', surface: 'web' })
    const legacy = service.answer(1, { messageId, blockId: 'q1', value: 'a', clientMessageId: 'cm-old' } as never, 'web')
    for (const result of [byId, legacy]) {
      expect(result.idempotent).toBe(true)
      expect(JSON.stringify(result)).not.toContain(STRONG_CANARY)
      expect(String(result.label)).not.toContain(STRONG_CANARY)
      expect(handles(String(result.label))).toHaveLength(1)
      expect(result.interaction?.answer).toBeDefined()
      expect(JSON.stringify(result.interaction?.answer)).not.toContain(STRONG_CANARY)
    }
  })

  it('idempotent replay of an imported raw answer that still owes its turn: startTurn gets the sealed label', () => {
    const { row } = seed()
    importRawAnswer(row.id, false)
    // The user row of the original answer exists, the turn never started.
    db.prepare(`INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, client_message_id) VALUES ('strand-v3', 1, 'user', 'old', NULL, 'main', 'cm-old')`).run()
    const turns: Array<Record<string, unknown>> = []
    const runner = { startTurn: (args: Record<string, unknown>) => { turns.push(args) } }
    const service = createInteractionsService({ db, getTurnRunner: () => runner as never })
    const result = service.answerById(1, row.id, { value: 'a', clientRequestId: 'cm-old', surface: 'web' })
    expect(turns).toHaveLength(1)
    expect(JSON.stringify(turns[0])).not.toContain(STRONG_CANARY)
    expect(handles(String(turns[0]!.text))).toHaveLength(1)
    expect(result.resumed).toBe(true)
    expect(JSON.stringify(result)).not.toContain(STRONG_CANARY)
    const metadata = (db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(row.messageId) as { metadata: string | null }).metadata
    expect(String(metadata)).not.toContain(STRONG_CANARY)
  })

  it('GET /api/strands: attention.prompt is sealed', async () => {
    const sessionManager = new SessionManager({ db, memoryDir: path.join(tmpDir, 'memory'), timeoutMinutes: 0 })
    const session = sessionManager.getOrCreateSession('1', 'web', 'main')
    seed(session.id)
    const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
    const srv = http.createServer(createApp({ db, getAgentCore: () => agentCore } as Parameters<typeof createApp>[0]))
    await new Promise<void>(resolve => srv.listen(0, resolve))
    try {
      const port = (srv.address() as { port: number }).port
      const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
      const res = await fetch(`http://127.0.0.1:${port}/api/strands`, { headers: { Authorization: `Bearer ${token}` } })
      const text = await res.text()
      expect(res.status).toBe(200)
      const strands = (JSON.parse(text) as { strands?: Array<{ id: string; attention: { prompt: string } | null }> }).strands
        ?? (JSON.parse(text) as Array<{ id: string; attention: { prompt: string } | null }>)
      const mine = strands.find(s => s.id === session.id)
      expect(mine?.attention?.prompt).toBeTruthy()
      // Scope of this check is attention.prompt (the lastMessage preview is
      // the stored chat row and not part of the interaction boundary).
      expect(JSON.stringify(mine!.attention)).not.toContain(STRONG_CANARY)
      expect(handles(mine!.attention!.prompt)).toHaveLength(1)
    } finally {
      await new Promise<void>(resolve => srv.close(() => resolve()))
    }
  })
})
