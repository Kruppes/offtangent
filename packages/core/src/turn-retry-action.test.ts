import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { buildTurnErrorMetadata } from './turn-error.js'
import {
  TURN_RETRY_RESOLUTIONS,
  createTurnRetryService,
  newTurnRetryActionId,
} from './turn-retry-action.js'
import type { TurnRetryRunnerLike } from './turn-retry-action.js'
import { clearTurnRetryNotifiers, registerTurnRetryNotifier } from './turn-retry-notifier.js'
import type { TurnRetryResolution } from './turn-retry-notifier.js'

const USER_ID = 3
const SESSION_ID = 'session-retry-action'

let db: Database

function seedSession(id = SESSION_ID, endedAt: string | null = null): void {
  db.prepare(
    'INSERT INTO sessions (id, user_id, source, type, ended_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, USER_ID, 'web', 'interactive', endedAt)
}

function insertMessage(
  role: 'user' | 'assistant' | 'tool' | 'system',
  content: string,
  metadata?: string,
  sessionId = SESSION_ID,
): number {
  const result = db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, USER_ID, role, content, metadata ?? null)
  return Number(result.lastInsertRowid)
}

/** Seeds the transcript of a failed turn: user message + persisted error row. */
function seedFailedTurn(): number {
  insertMessage('user', 'What is the weather?')
  return insertMessage('system', '\u274C Provider error: 401 invalid api key', JSON.stringify(
    buildTurnErrorMetadata({
      cause: 'non_retryable',
      error: '401 invalid api key',
      attempts: 0,
      retryable: false,
      occurredAt: new Date().toISOString(),
      retryActionId: newTurnRetryActionId(),
    }),
  ))
}

function fakeRunner(overrides: Partial<TurnRetryRunnerLike> = {}) {
  const retryTurn = vi.fn(() => ({
    turnId: 'turn-1',
    agentUserId: String(USER_ID),
    userId: USER_ID as number | null,
    sessionId: SESSION_ID,
    agentId: 'main',
    startedAt: Date.now(),
  }))
  const runner: TurnRetryRunnerLike = {
    hasActiveTurn: () => false,
    retryTurn,
    ...overrides,
  }
  return { runner, retryTurn }
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
})

describe('manual turn retry', () => {
  it('re-runs the failed turn continue-style and reports it as started', () => {
    seedSession()
    const errorId = seedFailedTurn()
    const { runner, retryTurn } = fakeRunner()

    const outcome = createTurnRetryService({ db, runner }).retry(errorId)

    expect(outcome).toEqual({ ok: true, resolution: TURN_RETRY_RESOLUTIONS.started })
    expect(retryTurn).toHaveBeenCalledWith({
      userId: USER_ID,
      sessionId: SESSION_ID,
      text: 'What is the weather?',
      source: 'web',
    })
    // The retry must not re-send the user message: nothing is written here.
    const userRows = db.prepare(
      `SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ? AND role = 'user'`
    ).get(SESSION_ID) as { count: number }
    expect(userRows.count).toBe(1)
  })

  it('runs the retry on the channel the failed session belongs to', () => {
    seedSession()
    db.prepare('UPDATE sessions SET source = ? WHERE id = ?').run('telegram', SESSION_ID)
    const errorId = seedFailedTurn()
    const { runner, retryTurn } = fakeRunner()

    createTurnRetryService({ db, runner }).retry(errorId)

    expect(retryTurn).toHaveBeenCalledWith(expect.objectContaining({ source: 'telegram' }))
  })

  it('refuses the retry once a newer user message exists', () => {
    seedSession()
    const errorId = seedFailedTurn()
    insertMessage('user', 'never mind, different question')
    const { runner, retryTurn } = fakeRunner()

    const outcome = createTurnRetryService({ db, runner }).retry(errorId)

    expect(outcome).toEqual({ ok: false, resolution: TURN_RETRY_RESOLUTIONS.movedOn })
    expect(retryTurn).not.toHaveBeenCalled()
  })

  it('refuses the retry once the turn was already retried', () => {
    seedSession()
    const errorId = seedFailedTurn()
    insertMessage('assistant', 'Sunny, 21 °C.')
    const { runner, retryTurn } = fakeRunner()

    const outcome = createTurnRetryService({ db, runner }).retry(errorId)

    expect(outcome.ok).toBe(false)
    expect(outcome.resolution).toBe(TURN_RETRY_RESOLUTIONS.movedOn)
    expect(retryTurn).not.toHaveBeenCalled()
  })

  it('ignores system rows written after the failure (stall notices, task results)', () => {
    seedSession()
    const errorId = seedFailedTurn()
    insertMessage('system', '\u23F3 Provider is slow')
    const { runner, retryTurn } = fakeRunner()

    expect(createTurnRetryService({ db, runner }).retry(errorId).ok).toBe(true)
    expect(retryTurn).toHaveBeenCalledTimes(1)
  })

  it('refuses the retry when the session ended', () => {
    seedSession(SESSION_ID, '2026-01-01T10:00:00.000Z')
    const errorId = seedFailedTurn()
    const { runner, retryTurn } = fakeRunner()

    const outcome = createTurnRetryService({ db, runner }).retry(errorId)

    expect(outcome).toEqual({ ok: false, resolution: TURN_RETRY_RESOLUTIONS.sessionEnded })
    expect(retryTurn).not.toHaveBeenCalled()
  })

  it('refuses the retry while a turn is already running', () => {
    seedSession()
    const errorId = seedFailedTurn()
    const { runner, retryTurn } = fakeRunner({ hasActiveTurn: () => true })

    const outcome = createTurnRetryService({ db, runner }).retry(errorId)

    expect(outcome).toEqual({ ok: false, resolution: TURN_RETRY_RESOLUTIONS.busy })
    expect(retryTurn).not.toHaveBeenCalled()
  })

  it('refuses unknown rows and rows that are not turn errors', () => {
    seedSession()
    insertMessage('user', 'hello')
    const plainSystemRow = insertMessage('system', 'just a notice')
    const { runner, retryTurn } = fakeRunner()
    const service = createTurnRetryService({ db, runner })

    expect(service.retry(999_999)).toEqual({ ok: false, resolution: TURN_RETRY_RESOLUTIONS.unavailable })
    expect(service.retry(plainSystemRow)).toEqual({ ok: false, resolution: TURN_RETRY_RESOLUTIONS.unavailable })
    expect(service.retry(Number.NaN)).toEqual({ ok: false, resolution: TURN_RETRY_RESOLUTIONS.unavailable })
    expect(retryTurn).not.toHaveBeenCalled()
  })

  it('announces every outcome so the other channels disable their button', async () => {
    clearTurnRetryNotifiers()
    const seen: TurnRetryResolution[] = []
    const unregister = registerTurnRetryNotifier({ retryResolved: r => { seen.push(r) } })

    try {
      seedSession()
      const errorId = seedFailedTurn()
      const { runner } = fakeRunner()
      const service = createTurnRetryService({ db, runner })

      service.retry(errorId)
      // The freshness check now fails: a retry already ran for this error.
      insertMessage('assistant', 'the answer')
      service.retry(errorId)
      await Promise.resolve()

      expect(seen).toEqual([
        { errorMessageId: errorId, ok: true, resolution: TURN_RETRY_RESOLUTIONS.started },
        { errorMessageId: errorId, ok: false, resolution: TURN_RETRY_RESOLUTIONS.movedOn },
      ])
    } finally {
      unregister()
    }
  })

  it('refuses the retry when the failed turn has no user message to continue from', () => {
    seedSession()
    const errorId = insertMessage('system', '\u274C Provider error', JSON.stringify(
      buildTurnErrorMetadata({
        cause: 'agent_unavailable',
        error: 'Agent core not available',
        attempts: 0,
        retryable: true,
        occurredAt: new Date().toISOString(),
      }),
    ))
    const { runner, retryTurn } = fakeRunner()

    expect(createTurnRetryService({ db, runner }).retry(errorId).ok).toBe(false)
    expect(retryTurn).not.toHaveBeenCalled()
  })
})
