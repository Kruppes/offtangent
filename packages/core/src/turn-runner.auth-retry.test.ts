/**
 * Incident 2026-09-24: a single
 * `401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`
 * from Anthropic (OAuth provider) ended a turn as `non_retryable`, although the
 * same stored credential answered normally one second earlier and one minute
 * later. An OAuth provider gets exactly one credential recovery plus retry; a
 * second authentication error is terminal, and a static API key never retries.
 */
import { describe, it, expect, vi } from 'vitest'
import { initDatabase } from './database.js'
import { TurnRunner } from './turn-runner.js'
import type { TurnAgentLike, TurnEvent, TurnRunnerOptions } from './turn-runner.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { parseTurnErrorMetadata } from './turn-error.js'
import type { Database } from './database.js'

const SESSION_ID = 'session-auth-retry'
const USER_ID = 11

const ANTHROPIC_401 = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},'
  + '"request_id":"req_011CfNDHfRqpcndEJGPQM3i6"}'

function freshDb(): Database {
  const db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
  return db
}

/** Plays one script per attempt; the last script repeats. */
function sequenceAgent(scripts: ResponseChunk[][]) {
  const calls: string[] = []
  const agent: TurnAgentLike = {
    sendMessage: async function* (): AsyncGenerator<ResponseChunk> {
      const script = scripts[Math.min(calls.length, scripts.length - 1)]!
      calls.push('sendMessage')
      for (const chunk of script) yield chunk
    },
    retryTurn: async function* (): AsyncGenerator<ResponseChunk> {
      const script = scripts[Math.min(calls.length, scripts.length - 1)]!
      calls.push('retryTurn')
      for (const chunk of script) yield chunk
    },
    abort: vi.fn(),
  }
  return { agent, calls }
}

function rows(db: Database) {
  return db.prepare(
    'SELECT role, content, metadata FROM chat_messages WHERE session_id = ? ORDER BY id',
  ).all(SESSION_ID) as Array<{ role: string; content: string; metadata: string | null }>
}

function errorMetadata(db: Database) {
  return rows(db).map(r => parseTurnErrorMetadata(r.metadata)).filter(m => m !== null)
}

function chunks(events: TurnEvent[], type: string): ResponseChunk[] {
  return events
    .filter(e => e.type === 'chunk')
    .map(e => (e as { chunk: ResponseChunk }).chunk)
    .filter(c => c.type === type)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

describe('TurnRunner credential recovery on authentication errors', () => {
  it('refreshes the OAuth credentials once and completes the retried turn', async () => {
    const db = freshDb()
    const { agent, calls } = sequenceAgent([
      [{ type: 'error', error: ANTHROPIC_401 }],
      [{ type: 'text', text: 'recovered answer' }, { type: 'done' }],
    ])
    const recoverAuth = vi.fn<NonNullable<TurnRunnerOptions['recoverAuth']>>(async () => true)
    const runner = new TurnRunner({
      db,
      getAgent: () => agent,
      recoverAuth,
      resolveStartModel: () => ({ providerId: 'anthropic', modelId: 'claude-fable-5-1', source: 'global' }),
    })

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, event => { events.push(event) })
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(recoverAuth).toHaveBeenCalledTimes(1)
    expect(recoverAuth.mock.calls[0]![0]).toMatchObject({
      agentId: 'main',
      sessionId: SESSION_ID,
      providerId: 'anthropic',
      error: ANTHROPIC_401,
    })
    // Second attempt continues the transcript instead of resending the message.
    expect(calls).toEqual(['sendMessage', 'retryTurn'])
    expect(errorMetadata(db)).toEqual([])
    expect(rows(db).some(r => r.role === 'assistant' && r.content.includes('recovered answer'))).toBe(true)
    const retries = chunks(events, 'retry_scheduled')
    expect(retries).toHaveLength(1)
    expect(retries[0]!.text).toContain('credentials')
    expect((retries[0]! as { retry?: { delayMs: number } }).retry?.delayMs).toBe(0)
    expect(chunks(events, 'error')).toEqual([])
  })

  it('ends the turn as non_retryable when the second call is rejected too', async () => {
    const db = freshDb()
    const { agent, calls } = sequenceAgent([[{ type: 'error', error: ANTHROPIC_401 }]])
    const recoverAuth = vi.fn(async () => true)
    const runner = new TurnRunner({
      db,
      getAgent: () => agent,
      recoverAuth,
      resolveStartModel: () => ({ providerId: 'anthropic', modelId: 'claude-fable-5-1' }),
    })

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, event => { events.push(event) })
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(recoverAuth).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['sendMessage', 'retryTurn'])
    const persisted = errorMetadata(db)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ cause: 'non_retryable', retryable: false, attempts: 1, error: ANTHROPIC_401 })
  })

  it('keeps failing fast when the provider has no recoverable credentials (static API key)', async () => {
    const db = freshDb()
    const { agent, calls } = sequenceAgent([[{ type: 'error', error: ANTHROPIC_401 }]])
    const recoverAuth = vi.fn(async () => false)
    const runner = new TurnRunner({ db, getAgent: () => agent, recoverAuth })

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(recoverAuth).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['sendMessage'])
    expect(errorMetadata(db)[0]).toMatchObject({ cause: 'non_retryable', attempts: 0, retryable: false })
  })

  it('does not treat a rate limit as an authentication failure', async () => {
    const db = freshDb()
    const { agent } = sequenceAgent([[{ type: 'error', error: '429 too many requests' }]])
    const recoverAuth = vi.fn(async () => true)
    const runner = new TurnRunner({
      db,
      getAgent: () => agent,
      recoverAuth,
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    })

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(recoverAuth).not.toHaveBeenCalled()
  })
})

describe('TurnRunner running-turn model', () => {
  it('reports the model frozen at turn start while the turn runs, and nothing afterwards', async () => {
    const db = freshDb()
    let resolved = { providerId: 'anthropic', modelId: 'claude-fable-5-1', source: 'global' }
    const release: Array<() => void> = []
    const agent: TurnAgentLike = {
      sendMessage: async function* (): AsyncGenerator<ResponseChunk> {
        await new Promise<void>(resolve => release.push(resolve))
        yield { type: 'text', text: 'done' }
      },
      abort: vi.fn(),
    }
    const runner = new TurnRunner({ db, getAgent: () => agent, resolveStartModel: () => ({ ...resolved }) })

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => release.length === 1)

    // The global selection changes mid-turn; the running turn keeps its model.
    resolved = { providerId: 'openai-codex', modelId: 'gpt-6-astra', source: 'global' }
    expect(runner.getRunningTurnModel(USER_ID, SESSION_ID)).toEqual({
      providerId: 'anthropic', modelId: 'claude-fable-5-1', source: 'global',
    })
    expect(runner.getRunningTurnModel(USER_ID, 'other-strand')).toBeNull()

    release[0]!()
    await waitFor(() => !runner.hasActiveTurn(USER_ID))
    expect(runner.getRunningTurnModel(USER_ID, SESSION_ID)).toBeNull()
  })
})
