import { describe, it, expect, vi, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import { TurnRunner } from './turn-runner.js'
import type { TurnAgentLike, TurnEvent } from './turn-runner.js'
import type { AbortScope, ResponseChunk, TurnStreamChunk } from './agent-runtime-types.js'
import type { Database } from './database.js'

/**
 * Regression suite for the 2026-09-15 incident: the stall watchdog of a turn
 * that was merely WAITING in the process-wide message queue aborted the agent
 * process-wide and killed the turn of a different user/session:
 *
 *   16:10:23.145 [turn-runner] Provider stalled 90002ms (user=2, session=ea21cee2). Aborting stream.
 *   16:10:23.150 [turn-runner] Turn failed (user=1, session=df39bbbc, cause=non_retryable, attempts=0): This operation was aborted
 */

const SESSION_A = 'session-a'
const SESSION_B = 'session-b'
const USER_A = 11
const USER_B = 22

function freshDb(): Database {
  const db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_A, 'alice', 'x')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_B, 'bob', 'x')
  return db
}

function chunks(events: TurnEvent[]): ResponseChunk[] {
  return events.filter(e => e.type === 'chunk').map(e => (e as { chunk: ResponseChunk }).chunk)
}

function chunkTypes(events: TurnEvent[]): string[] {
  return chunks(events).map(c => c.type)
}

interface FakeStream {
  queue: ResponseChunk[]
  waiters: Array<() => void>
  done: boolean
  aborted: boolean
  started: boolean
}

/**
 * Fake agent that models the two production properties that matter here:
 * turns are serialized process-wide by one queue lock (MessageQueue), and
 * `abort()` is routed by the AgentCore/AgentRuntime session scope — a scoped
 * abort only reaches the runtime that currently runs exactly that session.
 */
function serialQueueAgent(options: { serialize?: boolean } = {}) {
  const serialize = options.serialize !== false
  const abortCalls: Array<AbortScope | undefined> = []
  const streams = new Map<string, FakeStream>()
  /** Session whose run currently owns the runtime (AgentRuntime.currentSessionId). */
  const active = new Set<string>()
  let lock: Promise<void> = Promise.resolve()

  const streamFor = (sessionId: string): FakeStream => {
    let stream = streams.get(sessionId)
    if (!stream) {
      stream = { queue: [], waiters: [], done: false, aborted: false, started: false }
      streams.set(sessionId, stream)
    }
    return stream
  }

  const wake = (stream: FakeStream): void => {
    while (stream.waiters.length) stream.waiters.shift()!()
  }

  const push = (sessionId: string, chunk: ResponseChunk): void => {
    const stream = streamFor(sessionId)
    stream.queue.push(chunk)
    wake(stream)
  }

  const finish = (sessionId: string): void => {
    const stream = streamFor(sessionId)
    stream.done = true
    wake(stream)
  }

  const sendMessage = async function* (
    _userId: string,
    _text: string,
    _source?: string,
    _attachments?: unknown,
    _agentId?: string,
    sessionId?: string,
  ): AsyncGenerator<TurnStreamChunk> {
    const key = sessionId ?? 'default'
    const stream = streamFor(key)

    yield { type: 'queue_waiting' }
    let release = (): void => {}
    if (serialize) {
      const previous = lock
      lock = new Promise<void>((resolve) => { release = resolve })
      await previous
    }
    active.add(key)
    stream.started = true
    yield { type: 'queue_started' }

    try {
      for (;;) {
        while (stream.queue.length > 0) yield stream.queue.shift()!
        if (stream.aborted) throw new Error('This operation was aborted')
        if (stream.done) return
        await new Promise<void>((resolve) => { stream.waiters.push(resolve) })
      }
    } finally {
      active.delete(key)
      release()
    }
  }

  const agent: TurnAgentLike = {
    sendMessage,
    abort: (scope?: AbortScope) => {
      abortCalls.push(scope)
      for (const sessionId of active) {
        // Unscoped abort = legacy behaviour: every live run dies.
        if (scope?.sessionId !== undefined && scope.sessionId !== sessionId) continue
        const stream = streamFor(sessionId)
        stream.aborted = true
        wake(stream)
      }
    },
  }

  return { agent, push, finish, abortCalls, streamFor }
}

function collect(events: TurnEvent[]) {
  return (event: TurnEvent) => { events.push(event) }
}

describe('turn abort scope (incident 2026-09-15)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('A: a turn waiting for the queue lock never trips the stall watchdog and never kills the running turn', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    const { agent, push, finish, abortCalls } = serialQueueAgent()
    const runner = new TurnRunner({
      db,
      getAgent: () => agent,
      stallWarnMs: 30_000,
      stallAbortMs: 90_000,
      watchdogIntervalMs: 1_000,
      retryPolicy: { enabled: false },
    })

    const eventsA: TurnEvent[] = []
    const eventsB: TurnEvent[] = []
    runner.subscribe(USER_A, collect(eventsA))
    runner.subscribe(USER_B, collect(eventsB))

    runner.startTurn({ userId: USER_A, sessionId: SESSION_A, explicitSessionId: SESSION_A, text: 'long job' })
    await vi.advanceTimersByTimeAsync(10)
    runner.startTurn({ userId: USER_B, sessionId: SESSION_B, explicitSessionId: SESSION_B, text: 'second' })
    await vi.advanceTimersByTimeAsync(10)

    // Turn A streams continuously for 200s — far beyond the 90s abort
    // threshold that turn B would hit while it only waits in the queue.
    for (let i = 0; i < 10; i++) {
      push(SESSION_A, { type: 'text', text: `part-${i} ` })
      await vi.advanceTimersByTimeAsync(20_000)
    }

    // Turn B waited >200s in the queue: no stall notice, no abort, no error.
    expect(chunkTypes(eventsB)).toEqual([])
    expect(abortCalls).toEqual([])

    // Turn A finished undisturbed.
    push(SESSION_A, { type: 'done' })
    finish(SESSION_A)
    await vi.advanceTimersByTimeAsync(100)
    expect(chunks(eventsA).filter(c => c.type === 'error')).toEqual([])
    expect(runner.hasActiveTurn(USER_A)).toBe(false)

    // …and turn B runs normally once it gets the lock.
    push(SESSION_B, { type: 'text', text: 'my turn' })
    push(SESSION_B, { type: 'done' })
    finish(SESSION_B)
    await vi.advanceTimersByTimeAsync(100)
    expect(chunkTypes(eventsB)).toEqual(['text', 'done'])
    expect(runner.hasActiveTurn(USER_B)).toBe(false)
  })

  it('B1: the stall watchdog aborts only its own session/persona', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    const { agent, abortCalls } = serialQueueAgent()
    const runner = new TurnRunner({
      db,
      getAgent: () => agent,
      stallWarnMs: 30_000,
      stallAbortMs: 90_000,
      watchdogIntervalMs: 1_000,
      retryPolicy: { enabled: false },
    })

    const events: TurnEvent[] = []
    runner.subscribe(USER_A, collect(events))
    runner.startTurn({ userId: USER_A, sessionId: SESSION_A, explicitSessionId: SESSION_A, text: 'hi' })

    await vi.advanceTimersByTimeAsync(95_000)

    expect(abortCalls).toEqual([{ sessionId: SESSION_A, agentId: 'main' }])
  })

  it('B2: a stalled session does not kill the run of another session', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    // Overlapping runs: the queue lock of a long turn can be force-released by
    // the queue watchdog while its run keeps going, so two runs can be live.
    const { agent, push, finish, streamFor } = serialQueueAgent({ serialize: false })
    const runner = new TurnRunner({
      db,
      getAgent: () => agent,
      stallWarnMs: 30_000,
      stallAbortMs: 90_000,
      watchdogIntervalMs: 1_000,
      retryPolicy: { enabled: false },
    })

    const eventsA: TurnEvent[] = []
    const eventsB: TurnEvent[] = []
    runner.subscribe(USER_A, collect(eventsA))
    runner.subscribe(USER_B, collect(eventsB))

    // A stalls right after it started streaming; B keeps working.
    runner.startTurn({ userId: USER_A, sessionId: SESSION_A, explicitSessionId: SESSION_A, text: 'stalls' })
    runner.startTurn({ userId: USER_B, sessionId: SESSION_B, explicitSessionId: SESSION_B, text: 'works' })
    await vi.advanceTimersByTimeAsync(10)

    for (let i = 0; i < 5; i++) {
      push(SESSION_B, { type: 'text', text: `b-${i} ` })
      await vi.advanceTimersByTimeAsync(20_000)
    }

    // A's watchdog has fired by now (100s idle).
    expect(chunkTypes(eventsA)).toContain('stall_resolved')
    expect(streamFor(SESSION_A).aborted).toBe(true)
    // B is untouched: still live, no abort, no error.
    expect(streamFor(SESSION_B).aborted).toBe(false)
    expect(chunks(eventsB).filter(c => c.type === 'error')).toEqual([])
    expect(runner.hasActiveTurn(USER_B)).toBe(true)

    push(SESSION_B, { type: 'done' })
    finish(SESSION_B)
    await vi.advanceTimersByTimeAsync(100)
    expect(runner.hasActiveTurn(USER_B)).toBe(false)
  })

  it('C: a turn that goes silent AFTER it acquired the queue lock is still aborted', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    const { agent, push, abortCalls } = serialQueueAgent()
    const runner = new TurnRunner({
      db,
      getAgent: () => agent,
      stallWarnMs: 30_000,
      stallAbortMs: 90_000,
      watchdogIntervalMs: 1_000,
      retryPolicy: { enabled: false },
    })

    const events: TurnEvent[] = []
    runner.subscribe(USER_A, collect(events))
    runner.startTurn({ userId: USER_A, sessionId: SESSION_A, explicitSessionId: SESSION_A, text: 'hi' })
    await vi.advanceTimersByTimeAsync(10)

    // The run started and produced output, then the provider went silent.
    push(SESSION_A, { type: 'text', text: 'thinking…' })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(chunkTypes(events)).toContain('stall_warning')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(chunkTypes(events)).toEqual(['text', 'stall_warning', 'stall_resolved', 'error', 'done'])
    const error = chunks(events).find(c => c.type === 'error')
    expect(error?.error).toContain('Provider stopped responding')
    expect(abortCalls).toEqual([{ sessionId: SESSION_A, agentId: 'main' }])
  })

  it('F1: an abort this turn did not request is retryable, a user /stop is not', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    const { agent, push, abortCalls } = serialQueueAgent({ serialize: false })
    const runner = new TurnRunner({
      db,
      getAgent: () => agent,
      stallWarnMs: 30_000,
      stallAbortMs: 90_000,
      watchdogIntervalMs: 1_000,
      retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 1_000 },
    })

    const events: TurnEvent[] = []
    runner.subscribe(USER_A, collect(events))
    runner.startTurn({ userId: USER_A, sessionId: SESSION_A, explicitSessionId: SESSION_A, text: 'hi' })
    await vi.advanceTimersByTimeAsync(10)

    // Foreign kill: the stream dies with an AbortError although neither the
    // turn's own abortController nor its attemptController was triggered.
    push(SESSION_A, { type: 'error', error: 'This operation was aborted' })
    await vi.advanceTimersByTimeAsync(10)

    expect(chunkTypes(events)).toContain('retry_scheduled')
    expect(abortCalls).toEqual([])

    // The user's /stop, by contrast, ends the turn without any retry.
    const events2: TurnEvent[] = []
    runner.subscribe(USER_B, collect(events2))
    runner.startTurn({ userId: USER_B, sessionId: SESSION_B, explicitSessionId: SESSION_B, text: 'hi' })
    await vi.advanceTimersByTimeAsync(10)
    runner.abortTurn(USER_B)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(chunkTypes(events2)).not.toContain('retry_scheduled')
    expect(chunks(events2).filter(c => c.type === 'error')).toEqual([])
    // /stop is scoped to the aborted turn's session, not to the whole process.
    expect(abortCalls).toEqual([{ sessionId: SESSION_B, agentId: 'main' }])
  })
})
