/** The periodic fallback that re-delivers unacknowledged injections (W4). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  enqueueTaskInjection,
  getTaskInjection,
  markTaskInjectionAttempt,
  markTaskInjectionDelivered,
  type TaskInjectionRow,
} from './task-injection-queue.js'
import { TaskInjectionSweeper } from './task-injection-sweeper.js'

let db: Database
let delivered: TaskInjectionRow[]
const silent = { log: () => {}, warn: () => {}, error: () => {} }

beforeEach(() => {
  db = initDatabase(':memory:')
  delivered = []
})

afterEach(() => {
  db.close()
  vi.useRealTimers()
})

function enqueue(over: Partial<Parameters<typeof enqueueTaskInjection>[1]> = {}) {
  return enqueueTaskInjection(db, {
    taskId: 'task-1',
    userId: 1,
    agentId: 'bob',
    sessionId: 'strand-1',
    payload: '<task_injection>done</task_injection>',
    ...over,
  })
}

function sweeper(over: Partial<ConstructorParameters<typeof TaskInjectionSweeper>[0]> = {}) {
  return new TaskInjectionSweeper({
    db,
    deliver: row => { delivered.push(row) },
    retryAfterMs: 300_000,
    maxAttempts: 3,
    maxAgeMs: 24 * 3600_000,
    batchLimit: 5,
    logger: silent,
    ...over,
  })
}

describe('TaskInjectionSweeper', () => {
  it('re-delivers a pending injection and counts the attempt', async () => {
    const queued = enqueue()
    const result = await sweeper().sweepOnce()
    expect(result).toEqual({ redelivered: 1, expired: 0, skipped: false })
    expect(delivered.map(r => r.id)).toEqual([queued.id])
    expect(getTaskInjection(db, queued.id)!.attempts).toBe(1)
  })

  it('leaves an acknowledged injection alone', async () => {
    const queued = enqueue()
    markTaskInjectionDelivered(db, queued.id)
    expect(await sweeper().sweepOnce()).toEqual({ redelivered: 0, expired: 0, skipped: false })
    expect(delivered).toEqual([])
  })

  it('does not re-deliver an injection that is still in flight', async () => {
    const queued = enqueue()
    markTaskInjectionAttempt(db, queued.id)
    expect((await sweeper().sweepOnce()).redelivered).toBe(0)
    // ... but does once the retry window passed.
    expect((await sweeper({ retryAfterMs: 0 }).sweepOnce()).redelivered).toBe(1)
  })

  it('abandons a row after the attempt cap and stops touching it', async () => {
    const queued = enqueue()
    db.prepare('UPDATE task_injections SET attempts = 3 WHERE id = ?').run(queued.id)
    const result = await sweeper({ retryAfterMs: 0 }).sweepOnce()
    expect(result).toEqual({ redelivered: 0, expired: 1, skipped: false })
    expect(getTaskInjection(db, queued.id)!.status).toBe('abandoned')
    expect((await sweeper({ retryAfterMs: 0 }).sweepOnce()).expired).toBe(0)
  })

  it('abandons a result older than the age cap', async () => {
    const queued = enqueue()
    db.prepare("UPDATE task_injections SET created_at = datetime('now', '-3 days') WHERE id = ?").run(queued.id)
    expect((await sweeper({ retryAfterMs: 0 }).sweepOnce()).expired).toBe(1)
    expect(getTaskInjection(db, queued.id)!.lastError).toContain('expired')
  })

  it('skips the sweep entirely while there is nothing to inject into', async () => {
    enqueue()
    const result = await sweeper({ isDeliverable: () => false }).sweepOnce()
    expect(result.skipped).toBe(true)
    expect(delivered).toEqual([])
  })

  it('keeps a row pending when delivery throws, and records why', async () => {
    const queued = enqueue()
    const s = sweeper({ deliver: () => { throw new Error('no agent core') } })
    expect((await s.sweepOnce()).redelivered).toBe(0)
    const stored = getTaskInjection(db, queued.id)!
    expect(stored.status).toBe('pending')
    expect(stored.attempts).toBe(1)
    expect(stored.lastError).toContain('no agent core')
  })

  it('honours the batch limit per sweep', async () => {
    enqueue({ taskId: 'a' })
    enqueue({ taskId: 'b' })
    enqueue({ taskId: 'c' })
    expect((await sweeper({ batchLimit: 2 }).sweepOnce()).redelivered).toBe(2)
    expect(delivered).toHaveLength(2)
  })

  it('does not run two sweeps on top of each other', async () => {
    enqueue()
    const gate: { release: () => void } = { release: () => {} }
    const s = sweeper({ deliver: () => new Promise<void>(resolve => { gate.release = resolve }) })
    const first = s.sweepOnce()
    const second = await s.sweepOnce()
    expect(second.skipped).toBe(true)
    gate.release()
    await first
  })

  it('runs on its interval and stops on stop()', async () => {
    vi.useFakeTimers()
    enqueue()
    const s = sweeper({ intervalMs: 1000, retryAfterMs: 0 })
    s.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(delivered).toHaveLength(1)
    s.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(delivered).toHaveLength(1)
  })

  it('does not start a timer when the interval is 0 (disabled)', async () => {
    vi.useFakeTimers()
    enqueue()
    const s = sweeper({ intervalMs: 0 })
    s.start()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(delivered).toEqual([])
    s.stop()
  })
})
