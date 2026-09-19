/**
 * Regression tests for MULTI-PERSONA attribution through the shared TurnRunner
 * (added during the upstream 0.27.0 merge).
 *
 * Why these exist / what failure class they catch:
 *   Upstream 0.27.0 introduced the TurnRunner. Its stock implementation
 *   persisted `chat_messages` WITHOUT an `agent_id` column and called
 *   `agent.sendMessage(userId, text, source, attachments)` WITHOUT the persona
 *   agentId. On this fork every turn MUST be attributed to a persona
 *   (agent_id), and Telegram runs per-persona bots. Without the plumbing added
 *   in the merge, ALL Telegram/persona turns would silently write agent_id
 *   'main' (the column default) and route to the main runtime.
 *
 *   Each assertion below fails against a non-persona-aware runner:
 *   - the persisted rows would carry 'main' instead of the persona id;
 *   - the agent would receive `undefined`/no agentId argument.
 */
import { describe, it, expect, vi } from 'vitest'
import { initDatabase } from './database.js'
import { TurnRunner } from './turn-runner.js'
import type { TurnAgentLike, TurnEvent } from './turn-runner.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import type { Database } from './database.js'

const SESSION_ID = 'session-persona'
const USER_ID = 7

function freshDb(): Database {
  const db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
  return db
}

interface Row { role: string; content: string; agent_id: string; metadata: string | null }
function rows(db: Database): Row[] {
  return db.prepare(
    'SELECT role, content, agent_id, metadata FROM chat_messages WHERE session_id = ? ORDER BY id',
  ).all(SESSION_ID) as Row[]
}

/** Records the agentId argument the agent was called with. */
function recordingAgent(chunks: ResponseChunk[]) {
  const seen: { sendMessage: (string | undefined)[]; retryTurn: (string | undefined)[] } = {
    sendMessage: [], retryTurn: [],
  }
  const agent: TurnAgentLike = {
    sendMessage: async function* (_u: string, _t: string, _s?: string, _a?: unknown, agentId?: string) {
      seen.sendMessage.push(agentId)
      for (const c of chunks) yield c
    },
    retryTurn: async function* (_u: string, _t: string, _s?: string, _a?: unknown, agentId?: string) {
      seen.retryTurn.push(agentId)
      for (const c of chunks) yield c
    },
    abort: vi.fn(),
  }
  return { agent, seen }
}

function collect(events: TurnEvent[]) {
  return (event: TurnEvent) => { events.push(event) }
}

async function waitForEnd(events: TurnEvent[], timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!events.some(e => e.type === 'turn_end')) {
    if (Date.now() > deadline) throw new Error('turn did not end')
    await new Promise<void>((r) => setTimeout(r, 5))
  }
}

describe('TurnRunner persona attribution', () => {
  it('persists assistant + tool rows with the persona agent_id from startTurn', async () => {
    const db = freshDb()
    const { agent } = recordingAgent([
      { type: 'tool_call_start', toolName: 'search', toolCallId: 't1', toolArgs: {} },
      { type: 'tool_call_end', toolName: 'search', toolCallId: 't1', toolResult: { ok: true } },
      { type: 'text', text: 'done' },
      { type: 'done' },
    ])
    const runner = new TurnRunner({ db, getAgent: () => agent })

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi', agentId: 'bob' })
    await waitForEnd(events)

    const persisted = rows(db)
    expect(persisted.length).toBeGreaterThan(0)
    // Every persisted row for this turn must carry the persona id, NOT 'main'.
    for (const r of persisted) {
      expect(r.agent_id, `row role=${r.role} content=${r.content}`).toBe('bob')
    }
    // Sanity: at least the assistant answer and the tool row exist.
    expect(persisted.some(r => r.role === 'assistant' && r.content === 'done')).toBe(true)
    expect(persisted.some(r => r.role === 'tool')).toBe(true)
  })

  it('passes the persona agentId to agent.sendMessage', async () => {
    const db = freshDb()
    const { agent, seen } = recordingAgent([{ type: 'text', text: 'ok' }, { type: 'done' }])
    const runner = new TurnRunner({ db, getAgent: () => agent })

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi', agentId: 'warren' })
    await waitForEnd(events)

    expect(seen.sendMessage).toEqual(['warren'])
  })

  it("defaults to 'main' when no agentId is supplied (web single-persona path)", async () => {
    const db = freshDb()
    const { agent, seen } = recordingAgent([{ type: 'text', text: 'ok' }, { type: 'done' }])
    const runner = new TurnRunner({ db, getAgent: () => agent })

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitForEnd(events)

    expect(seen.sendMessage).toEqual(['main'])
    for (const r of rows(db)) expect(r.agent_id).toBe('main')
  })

  it('persists the terminal error row with the persona agent_id', async () => {
    const db = freshDb()
    // A non-retryable provider error ends the turn with a persisted 'system' row.
    const { agent } = recordingAgent([
      { type: 'error', error: 'invalid x-api-key' },
    ])
    const runner = new TurnRunner({ db, getAgent: () => agent })

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi', agentId: 'gekko' })
    await waitForEnd(events)

    const errorRows = rows(db).filter(r => r.role === 'system')
    expect(errorRows.length).toBeGreaterThan(0)
    for (const r of errorRows) expect(r.agent_id).toBe('gekko')
  })

  it('runs a manual retry (retryTurn) under the same persona', async () => {
    const db = freshDb()
    const { agent, seen } = recordingAgent([{ type: 'text', text: 'recovered' }, { type: 'done' }])
    const runner = new TurnRunner({ db, getAgent: () => agent })

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.retryTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi', agentId: 'bob' })
    await waitForEnd(events)

    // retryTurn sets continueFromTranscript → agent.retryTurn is used, with the persona.
    expect(seen.retryTurn).toEqual(['bob'])
    for (const r of rows(db)) expect(r.agent_id).toBe('bob')
  })

  // Axiom-Companion M1: the runner keys turns per USER, so a client subscribed
  // to one user sees the turns of every persona on the same stream. Without
  // `agentId` on each event it could not tell whose answer it is rendering.
  it('stamps every emitted (and replayed) event with the turn persona', async () => {
    const db = freshDb()
    const { agent } = recordingAgent([
      { type: 'text', text: 'hi' },
      { type: 'tool_call_start', toolName: 'search', toolCallId: 't1', toolArgs: {} },
      { type: 'tool_call_end', toolName: 'search', toolCallId: 't1', toolResult: 1 },
      { type: 'done' },
    ])
    const runner = new TurnRunner({ db, getAgent: () => agent, completedTurnRetentionMs: 5_000 })
    const live: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(live))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'q', agentId: 'warren' })
    await waitForEnd(live)

    expect(live.length).toBeGreaterThanOrEqual(4)
    for (const e of live) expect(e.agentId).toBe('warren')

    // A late subscriber gets the buffered replay with the same attribution.
    const replayed: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(replayed))
    expect(replayed.length).toBe(live.length)
    for (const e of replayed) {
      expect(e.replay).toBe(true)
      expect(e.agentId).toBe('warren')
    }
  })

  it('runs turns of different personas for the same user side by side, each keeping its own attribution', async () => {
    const db = freshDb()
    let releaseFirst!: () => void
    const gate = new Promise<void>((r) => { releaseFirst = r })
    const order: string[] = []
    const agent: TurnAgentLike = {
      sendMessage: async function* (_u: string, _t: string, _s?: string, _a?: unknown, agentId?: string) {
        order.push(`start:${agentId}`)
        if (agentId === 'bob') await gate
        yield { type: 'text', text: `from ${agentId}` }
        yield { type: 'done' }
        order.push(`end:${agentId}`)
      },
      abort: vi.fn(),
    }
    const runner = new TurnRunner({ db, getAgent: () => agent })
    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'a', agentId: 'bob' })
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'b', agentId: 'warren' })
    await new Promise<void>((r) => setTimeout(r, 20))
    // Queues are per user AND persona since 2026-09-19 (Fix 2a): warren does
    // NOT wait for the blocked bob turn — it starts and finishes meanwhile.
    expect(order).toEqual(['start:bob', 'start:warren', 'end:warren'])
    releaseFirst()
    const deadline = Date.now() + 2000
    while (events.filter(e => e.type === 'turn_end').length < 2) {
      if (Date.now() > deadline) throw new Error('turns did not both end')
      await new Promise<void>((r) => setTimeout(r, 5))
    }
    expect(order).toEqual(['start:bob', 'start:warren', 'end:warren', 'end:bob'])

    const texts = events.filter(e => e.type === 'chunk' && e.chunk.type === 'text')
    expect(texts.map(e => e.agentId)).toEqual(['warren', 'bob'])
    const persisted = rows(db).filter(r => r.role === 'assistant')
    expect(persisted.map(r => r.agent_id)).toEqual(['warren', 'bob'])
  })
})
