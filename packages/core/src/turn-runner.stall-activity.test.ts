/**
 * Regression tests for plan 2026-10-09-provider-silence: the stall watchdog
 * must only count *provider* silence. Two confirmed misclassifications:
 *  1. A running tool (shell, ask_agent, ...) has no provider request in
 *     flight, yet its runtime was counted as provider silence (warn at 30 s,
 *     "Provider stopped responding" abort + retry at 90 s).
 *  2. Provider output that produces no text/thinking chunk (tool-call
 *     argument streaming, thinking/text block boundaries) was invisible to
 *     the watchdog, so a model streaming a long tool call looked silent.
 * All fixtures are synthetic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import { TurnRunner } from './turn-runner.js'
import type { TurnAgentLike, TurnEvent } from './turn-runner.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { emitProviderPhase } from './provider-phase.js'
import { PROVIDER_STALL_KIND } from './provider-stall.js'
import type { Database } from './database.js'

const SESSION_ID = 'session-stall-activity'
const USER_ID = 7

function freshDb(): Database {
  const db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
  return db
}

function controllableAgent() {
  const queue: ResponseChunk[] = []
  const waiters: Array<() => void> = []
  let done = false
  const wake = () => { while (waiters.length) waiters.shift()!() }
  const agent: TurnAgentLike = {
    sendMessage: async function* () {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!
        if (done) return
        await new Promise<void>((resolve) => { waiters.push(resolve) })
      }
    },
    abort: vi.fn(() => { done = true; wake() }),
  }
  return {
    agent,
    push: (chunk: ResponseChunk) => { queue.push(chunk); wake() },
    finish: () => { done = true; wake() },
  }
}

function stallChunks(events: TurnEvent[]): ResponseChunk[] {
  return events
    .filter(e => e.type === 'chunk')
    .map(e => (e as { chunk: ResponseChunk }).chunk)
    .filter(c => c.type === 'stall_warning' || c.type === 'stall_resolved')
}

function stallRowCount(db: Database): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM chat_messages WHERE json_extract(metadata, '$.kind') = ?",
  ).get(PROVIDER_STALL_KIND) as { n: number }
  return row.n
}

function start(db: Database, agent: TurnAgentLike) {
  const runner = new TurnRunner({
    db,
    getAgent: () => agent,
    stallWarnMs: 30_000,
    stallAbortMs: 90_000,
    watchdogIntervalMs: 1_000,
    retryPolicy: { enabled: false },
  })
  const events: TurnEvent[] = []
  runner.subscribe(USER_ID, (e) => { events.push(e) })
  runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'synthetic' })
  return { runner, events }
}

describe('stall watchdog: provider silence vs. other activity', () => {
  afterEach(() => { vi.useRealTimers() })

  it('does not warn or abort while a tool is executing', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    const { agent, push, finish } = controllableAgent()
    const { runner, events } = start(db, agent)
    await vi.advanceTimersByTimeAsync(0)

    push({ type: 'tool_call_start', toolName: 'shell', toolCallId: 't1', toolArgs: { command: 'sleep 120' } })
    await vi.advanceTimersByTimeAsync(120_000)

    expect(stallChunks(events)).toEqual([])
    expect(stallRowCount(db)).toBe(0)
    expect(agent.abort).not.toHaveBeenCalled()

    push({ type: 'tool_call_end', toolName: 'shell', toolCallId: 't1', toolResult: 'ok', toolIsError: false })
    push({ type: 'text', text: 'done' })
    finish()
    await vi.advanceTimersByTimeAsync(1)
    expect(runner.hasActiveTurn(USER_ID)).toBe(false)
  })

  it('counts provider silence again after the tool finished (real stalls still abort)', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    const { agent, push } = controllableAgent()
    const { events } = start(db, agent)
    await vi.advanceTimersByTimeAsync(0)

    push({ type: 'tool_call_start', toolName: 'shell', toolCallId: 't1', toolArgs: {} })
    await vi.advanceTimersByTimeAsync(60_000)
    push({ type: 'tool_call_end', toolName: 'shell', toolCallId: 't1', toolResult: 'ok', toolIsError: false })
    await vi.advanceTimersByTimeAsync(1)
    expect(stallChunks(events)).toEqual([])

    // The follow-up provider request never answers: this is a real stall.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(stallChunks(events).map(c => c.type)).toEqual(['stall_warning'])
    await vi.advanceTimersByTimeAsync(60_000)
    const resolved = stallChunks(events)[1]
    expect(resolved?.stall?.outcome).toBe('aborted')
    expect(agent.abort).toHaveBeenCalled()
  })

  it('keeps the watchdog paused until every parallel tool has finished', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    const { agent, push, finish } = controllableAgent()
    const { events } = start(db, agent)
    await vi.advanceTimersByTimeAsync(0)

    push({ type: 'tool_call_start', toolName: 'shell', toolCallId: 'a', toolArgs: {} })
    push({ type: 'tool_call_start', toolName: 'web_fetch', toolCallId: 'b', toolArgs: {} })
    await vi.advanceTimersByTimeAsync(10_000)
    push({ type: 'tool_call_end', toolName: 'web_fetch', toolCallId: 'b', toolResult: 'ok', toolIsError: false })
    await vi.advanceTimersByTimeAsync(100_000)
    expect(stallChunks(events)).toEqual([])
    expect(agent.abort).not.toHaveBeenCalled()

    push({ type: 'tool_call_end', toolName: 'shell', toolCallId: 'a', toolResult: 'ok', toolIsError: false })
    finish()
    await vi.advanceTimersByTimeAsync(1)
  })

  it('treats provider stream activity without text (tool-call argument streaming) as activity', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    const { agent, finish } = controllableAgent()
    const { events } = start(db, agent)
    await vi.advanceTimersByTimeAsync(0)

    // 100 s of a model streaming a long tool call: an activity signal every 10 s.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
      emitProviderPhase(SESSION_ID, { phase: 'stream_activity' })
    }

    expect(stallChunks(events)).toEqual([])
    expect(stallRowCount(db)).toBe(0)
    expect(agent.abort).not.toHaveBeenCalled()
    finish()
    await vi.advanceTimersByTimeAsync(1)
  })

  it('a stream_activity for another session does not keep this turn alive', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    const { agent } = controllableAgent()
    const { events } = start(db, agent)
    await vi.advanceTimersByTimeAsync(0)

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
      emitProviderPhase('other-session', { phase: 'stream_activity' })
    }
    expect(stallChunks(events).map(c => c.type)).toEqual(['stall_warning'])
  })
})

describe('createStreamActivityNotifier', () => {
  it('emits stream_activity for its own session, throttled', async () => {
    const { createStreamActivityNotifier, subscribeProviderPhase } = await import('./provider-phase.js')
    let t = 0
    const seen: string[] = []
    const off = subscribeProviderPhase('notifier-session', e => seen.push(e.phase))
    const notify = createStreamActivityNotifier('notifier-session', () => t)
    notify(); notify()
    t = 999; notify()
    t = 1000; notify()
    off()
    expect(seen).toEqual(['stream_activity', 'stream_activity'])
  })
})
