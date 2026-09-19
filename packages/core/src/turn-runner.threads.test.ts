/**
 * Offtangent Stufe 1: the runner carries the explicitly chosen thread into the
 * agent call.
 *
 * `StartTurnInput.sessionId` is where the turn's rows are persisted;
 * `explicitSessionId` is the thread the USER picked. Only the latter may reach
 * `sendMessage`/`retryTurn` — passing the persistence id would switch every
 * existing caller (Telegram, companion app) onto the explicit path and silently
 * disable topic-shift detection for them.
 */
import { describe, it, expect, vi } from 'vitest'
import { initDatabase } from './database.js'
import { TurnRunner } from './turn-runner.js'
import type { TurnAgentLike, TurnEvent } from './turn-runner.js'
import type { Database } from './database.js'

const SESSION_ID = 'session-threads'
const USER_ID = 11

function freshDb(): Database {
  const db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
  return db
}

/** Records the 6th positional argument (sessionId) of both agent entry points. */
function recordingAgent() {
  const seen: { sendMessage: (string | undefined)[]; retryTurn: (string | undefined)[] } = {
    sendMessage: [], retryTurn: [],
  }
  const agent: TurnAgentLike = {
    sendMessage: async function* (_u: string, _t: string, _s?: string, _a?: unknown, _agentId?: string, sessionId?: string) {
      seen.sendMessage.push(sessionId)
      yield { type: 'text' as const, text: 'ok' }
      yield { type: 'done' as const }
    },
    retryTurn: async function* (_u: string, _t: string, _s?: string, _a?: unknown, _agentId?: string, sessionId?: string) {
      seen.retryTurn.push(sessionId)
      yield { type: 'text' as const, text: 'ok' }
      yield { type: 'done' as const }
    },
    abort: vi.fn(),
  }
  return { agent, seen }
}

async function waitForEnd(events: TurnEvent[], timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!events.some(e => e.type === 'turn_end')) {
    if (Date.now() > deadline) throw new Error('turn did not end')
    await new Promise<void>((r) => setTimeout(r, 5))
  }
}

describe('TurnRunner explicit thread', () => {
  it('passes explicitSessionId to agent.sendMessage', async () => {
    const db = freshDb()
    const { agent, seen } = recordingAgent()
    const runner = new TurnRunner({ db, getAgent: () => agent })
    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, (e) => { events.push(e) })

    runner.startTurn({
      userId: USER_ID,
      sessionId: SESSION_ID,
      text: 'hi',
      agentId: 'bob',
      explicitSessionId: 'thread-42',
    })
    await waitForEnd(events)

    expect(seen.sendMessage).toEqual(['thread-42'])
  })

  it('passes explicitSessionId to agent.retryTurn', async () => {
    const db = freshDb()
    const { agent, seen } = recordingAgent()
    const runner = new TurnRunner({ db, getAgent: () => agent })
    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, (e) => { events.push(e) })

    runner.retryTurn({
      userId: USER_ID,
      sessionId: SESSION_ID,
      text: 'hi',
      agentId: 'bob',
      explicitSessionId: 'thread-42',
    })
    await waitForEnd(events)

    expect(seen.retryTurn).toEqual(['thread-42'])
  })

  it('sends undefined when the caller picked no thread (legacy channels)', async () => {
    const db = freshDb()
    const { agent, seen } = recordingAgent()
    const runner = new TurnRunner({ db, getAgent: () => agent })
    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, (e) => { events.push(e) })

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitForEnd(events)

    // NOT the persistence session id: that would make every Telegram turn
    // explicit and kill topic-shift detection.
    expect(seen.sendMessage).toEqual([undefined])
  })
})
