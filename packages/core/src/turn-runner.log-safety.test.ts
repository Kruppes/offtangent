/**
 * Review K0-K2-4 #2/#3: a provider error can echo the prompt (a clock
 * dictation). On its way through the TurnRunner the raw text may reach
 * neither a console level (message or stack), nor the error chunk the client
 * renders, nor the persisted `turn_error` row, nor a retry notice. The user
 * still sees an error: a fixed sentence plus the error class.
 *
 * The real AgentRuntime producer is used for the chunk (processEvent on a
 * failed assistant `message_end`), so the test covers the whole hand-over
 * runtime → runner → client/database.
 */
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TurnRunner } from './turn-runner.js'
import type { TurnAgentLike, TurnEvent } from './turn-runner.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { PiAgentRuntimeForTests } from './agent-runtime.js'
import { publicProviderError } from './log-safe-error.js'

const MARKER = 'PRIVATE_CLOCK_DICTATION_MARKER_007'
const SESSION_ID = 'clock-session'
const USER_ID = 1

let seen: unknown[] = []
let spies: Array<ReturnType<typeof vi.spyOn>> = []

beforeEach(() => {
  seen = []
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { seen.push(...args) }))
})
afterEach(() => { for (const spy of spies) spy.mockRestore() })

function logged(): string {
  return seen.map(arg => (typeof arg === 'string' ? arg : inspect(arg, { depth: 5 }))).join('\n')
}

function freshDb(): Database {
  const db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, started_at, last_activity, message_count, summary_written, agent_id, title, archived)
     VALUES (?, ?, '1', 'clock', 'interactive', datetime('now'), datetime('now'), 0, 0, 'main', 'hello', 0)`,
  ).run(SESSION_ID, USER_ID)
  return db
}

/** The error chunk exactly as the AgentRuntime produces it for a failed assistant message. */
function runtimeErrorChunk(db: Database, errorMessage: string): ResponseChunk {
  const self = { db, model: { id: 'fake', contextWindow: 1000 }, agentId: 'main' }
  const message = {
    role: 'assistant', provider: 'openai', model: 'fake',
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    stopReason: 'error', errorMessage, content: [],
  }
  const chunks = (PiAgentRuntimeForTests.prototype as unknown as {
    processEvent: (this: unknown, event: unknown, sessionId: string) => ResponseChunk[]
  }).processEvent.call(self, { type: 'message_end', message }, SESSION_ID)
  const chunk = chunks.find(c => c.type === 'error')
  if (!chunk) throw new Error('runtime produced no error chunk')
  return chunk
}

function everythingPersisted(db: Database): string {
  const chat = db.prepare('SELECT content, metadata FROM chat_messages').all()
  const usage = db.prepare('SELECT error FROM token_usage').all()
  return JSON.stringify({ chat, usage })
}

async function settle(runner: TurnRunner): Promise<void> {
  const deadline = Date.now() + 2000
  while (runner.hasActiveTurn(USER_ID)) {
    if (Date.now() > deadline) throw new Error('turn did not finish')
    await new Promise(res => setTimeout(res, 5))
  }
}

function chunks(events: TurnEvent[]): ResponseChunk[] {
  return events.filter(e => e.type === 'chunk').map(e => (e as { chunk: ResponseChunk }).chunk)
}

describe('turn runner provider-error safety (review K0-K2-4 #2/#3)', () => {
  it('assistant message_end error: no marker in log, token_usage, chunk or error row; the app still gets an error', async () => {
    const db = freshDb()
    const chunk = runtimeErrorChunk(db, `401 invalid_api_key, request was: ${MARKER}`)
    const agent: TurnAgentLike = { sendMessage: async function* () { yield chunk }, abort: vi.fn() }
    const runner = new TurnRunner({ db, getAgent: () => agent })
    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, e => { events.push(e) })
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: `diktat ${MARKER}`, source: 'clock' } as never)
    await settle(runner)

    const error = chunks(events).find(c => c.type === 'error')
    expect(error).toBeDefined()
    expect(error!.error).toBe(publicProviderError('401 invalid_api_key'))
    expect(error!.error).toBe('The model provider reported an error (auth).')
    expect(error!.errorInfo?.messageId).toBeTypeOf('number')
    expect(JSON.stringify(events)).not.toContain(MARKER)
    expect(everythingPersisted(db)).not.toContain(MARKER)
    expect(everythingPersisted(db)).toContain('The model provider reported an error (auth).')
    expect(logged()).not.toContain(MARKER)
    expect(logged()).toContain('cause=non_retryable, attempts=0): auth')
  })

  it('provider 4xx: the turn_error row and the log carry a structural diagnostic, never the echoed text', async () => {
    const db = freshDb()
    const raw = `400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0: a system message that holds tool blocks cannot be the first message ${MARKER}"}}`
    const chunk = runtimeErrorChunk(db, raw)
    expect(chunk.diagnostic).toMatchObject({ status: 400, type: 'invalid_request_error', path: 'messages.0' })
    const agent: TurnAgentLike = { sendMessage: async function* () { yield chunk }, abort: vi.fn() }
    const runner = new TurnRunner({ db, getAgent: () => agent })
    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, e => { events.push(e) })
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: `diktat ${MARKER}`, source: 'clock' } as never)
    await settle(runner)

    const row = db.prepare("SELECT metadata FROM chat_messages WHERE metadata LIKE '%turn_error%'").get() as { metadata: string }
    const meta = JSON.parse(row.metadata) as { diagnostic?: { status?: number; type?: string; path?: string; phrases?: string[] } }
    expect(meta.diagnostic).toMatchObject({ status: 400, type: 'invalid_request_error', path: 'messages.0' })
    expect(meta.diagnostic!.phrases).toContain('system message')
    expect(JSON.stringify(events)).not.toContain(MARKER)
    expect(everythingPersisted(db)).not.toContain(MARKER)
    expect(logged()).not.toContain(MARKER)
    expect(logged()).toContain('type=invalid_request_error path=messages.0')
  })

  it('H1: an identifier-shaped echo in the provider path or error.type reaches neither the turn_error row nor the log', async () => {
    const WORD = 'PRIVATE_CLOCK_ACCESS_TOKEN'
    const TYPE_WORD = 'private_clock_access_token'
    const db = freshDb()
    const raw = `400 {"type":"error","error":{"type":"${TYPE_WORD}","message":"invalid argument messages.${WORD}: unexpected value"}}`
    const chunk = runtimeErrorChunk(db, raw)
    const agent: TurnAgentLike = { sendMessage: async function* () { yield chunk }, abort: vi.fn() }
    const runner = new TurnRunner({ db, getAgent: () => agent })
    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, e => { events.push(e) })
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'diktat', source: 'clock' } as never)
    await settle(runner)

    const row = db.prepare("SELECT metadata FROM chat_messages WHERE metadata LIKE '%turn_error%'").get() as { metadata: string }
    const meta = JSON.parse(row.metadata) as { diagnostic?: { status?: number; type?: string; path?: string } }
    expect(meta.diagnostic).toMatchObject({ status: 400, type: 'other', path: 'messages.<cut>' })
    for (const text of [row.metadata, everythingPersisted(db), JSON.stringify(events), logged()]) {
      expect(text.toLowerCase()).not.toContain(TYPE_WORD)
    }
    expect(logged()).toContain('type=other path=messages.<cut>')
  })

  it('retryable error: retry notice, retry log and the final error carry the class only', async () => {
    vi.useFakeTimers()
    try {
      const db = freshDb()
      const chunk = runtimeErrorChunk(db, `502 Bad Gateway, upstream body: ${MARKER}`)
      const agent: TurnAgentLike = {
        sendMessage: async function* () { yield chunk },
        retryTurn: async function* () { yield chunk },
        abort: vi.fn(),
      }
      const runner = new TurnRunner({ db, getAgent: () => agent, retryPolicy: { maxRetries: 1, baseDelayMs: 1_000 } } as never)
      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, e => { events.push(e) })
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5_000)
      vi.useRealTimers()
      await settle(runner)

      expect(chunks(events).some(c => c.type === 'retry_scheduled')).toBe(true)
      expect(chunks(events).find(c => c.type === 'error')?.errorInfo?.cause).toBe('retry_exhausted')
      expect(JSON.stringify(events)).not.toContain(MARKER)
      expect(everythingPersisted(db)).not.toContain(MARKER)
      expect(logged()).not.toContain(MARKER)
      expect(logged()).toContain('Retryable provider error')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a thrown agent error reaches neither log nor client', async () => {
    const db = freshDb()
    const agent: TurnAgentLike = {
      sendMessage: async function* (): AsyncGenerator<ResponseChunk> { throw Object.assign(new Error(`echo ${MARKER}`), { status: 400 }) },
      abort: vi.fn(),
    }
    const runner = new TurnRunner({ db, getAgent: () => agent })
    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, e => { events.push(e) })
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await settle(runner)

    expect(chunks(events).find(c => c.type === 'error')?.error).toBe('Agent error: http_400')
    expect(JSON.stringify(events)).not.toContain(MARKER)
    expect(everythingPersisted(db)).not.toContain(MARKER)
    expect(logged()).not.toContain(MARKER)
  })

  it('a chunk from a producer without rawError is still made public', async () => {
    const db = freshDb()
    const agent: TurnAgentLike = {
      sendMessage: async function* (): AsyncGenerator<ResponseChunk> { yield { type: 'error', error: `foreign ${MARKER}` } },
      abort: vi.fn(),
    }
    const runner = new TurnRunner({ db, getAgent: () => agent })
    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, e => { events.push(e) })
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await settle(runner)
    expect(chunks(events).find(c => c.type === 'error')?.error).toBe('The model provider reported an error (error).')
    expect(JSON.stringify(events)).not.toContain(MARKER)
    expect(everythingPersisted(db)).not.toContain(MARKER)
    expect(logged()).not.toContain(MARKER)
  })
})

describe('agent runtime assistant error (review K0-K2-4 #2)', () => {
  it('processEvent: log and token_usage.error carry the class, the chunk only the public text', () => {
    const db = freshDb()
    const chunk = runtimeErrorChunk(db, `provider echoed ${MARKER}`)
    expect(chunk.error).toBe('The model provider reported an error (error).')
    expect(chunk.text).toBe('Modellfehler: The model provider reported an error (error).')
    expect(chunk.rawError).toContain(MARKER) // in-process only, for the classifiers
    // ... and never enumerated: JSON, util.inspect (console.*) and spread miss it.
    expect(Object.keys(chunk)).not.toContain('rawError')
    expect(JSON.stringify(chunk)).not.toContain(MARKER)
    expect(inspect(chunk, { depth: 5 })).not.toContain(MARKER)
    expect(JSON.stringify({ ...chunk })).not.toContain(MARKER)
    const usage = db.prepare('SELECT error FROM token_usage ORDER BY id DESC LIMIT 1').get() as { error: string }
    expect(usage.error).toBe('error')
    expect(logged()).not.toContain(MARKER)
    expect(logged()).toContain('Assistant message carries error (stopReason=error, session clock-session): error')
  })

  it('a context overflow keeps its class so the user learns why', () => {
    const db = freshDb()
    const chunk = runtimeErrorChunk(db, `prompt is too long: 210000 tokens > 200000 maximum; ${MARKER}`)
    expect(chunk.error).toBe('The model provider reported an error (context_overflow).')
    expect(JSON.stringify(db.prepare('SELECT error FROM token_usage').all())).not.toContain(MARKER)
  })
})
