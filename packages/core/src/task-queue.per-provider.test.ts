import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_CONCURRENT_TASKS_PER_PROVIDER,
  TaskConcurrencyQueue,
  UNKNOWN_PROVIDER_KEY,
  normalizeProviderLimitOverrides,
  readTaskConcurrencyLimitsFromConfig,
} from './task-queue.js'
import type { TaskConcurrencyLimits } from './task-queue.js'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Per-provider task slots (plan 2026-10-01): every provider gets its own
 * budget of concurrent tasks, the global limit only remains as a host-wide
 * safety cap. Provider keys here are synthetic ids.
 */

const P1 = 'provider-one'
const P2 = 'provider-two'

function makeQueue(limits: Partial<TaskConcurrencyLimits>) {
  const box: { limits: Partial<TaskConcurrencyLimits> } = { limits }
  const queue = new TaskConcurrencyQueue<string>(() => box.limits)
  return { queue, box }
}

describe('defaults', () => {
  it('allows 5 tasks per provider and 12 globally by default', () => {
    expect(DEFAULT_MAX_CONCURRENT_TASKS_PER_PROVIDER).toBe(5)
    expect(DEFAULT_MAX_CONCURRENT_TASKS).toBe(12)
    const { queue } = makeQueue({})
    expect(queue.limit()).toBe(12)
    expect(queue.providerLimit(P1)).toBe(5)
  })
})

describe('TaskConcurrencyQueue — per-provider slots', () => {
  it('runs 5 tasks of each of two providers at the same time', () => {
    const { queue } = makeQueue({ global: 12, perProvider: 5 })
    for (let i = 0; i < 5; i++) {
      expect(queue.admit(`p1-${i}`, 'x', P1).admitted).toBe(true)
      expect(queue.admit(`p2-${i}`, 'x', P2).admitted).toBe(true)
    }
    expect(queue.activeCount()).toBe(10)
    expect(queue.activeCountFor(P1)).toBe(5)
    expect(queue.activeCountFor(P2)).toBe(5)
    expect(queue.queuedCount()).toBe(0)
  })

  it('queues the 6th task of a provider while a later task of another provider starts at once', () => {
    const { queue } = makeQueue({ global: 12, perProvider: 5 })
    for (let i = 0; i < 5; i++) queue.admit(`p1-${i}`, 'x', P1)

    const sixth = queue.admit('p1-5', 'x', P1)
    expect(sixth).toMatchObject({ admitted: false, position: 1, reason: 'provider', providerKey: P1 })

    // Arrives later, but its provider has room: no head-of-line blocking.
    expect(queue.admit('p2-0', 'x', P2).admitted).toBe(true)
    expect(queue.isActive('p2-0')).toBe(true)
    expect(queue.queuedIds()).toEqual(['p1-5'])
  })

  it('dequeues past a blocked head: the oldest admissible waiter starts', () => {
    const { queue } = makeQueue({ global: 3, perProvider: 2 })
    queue.admit('a1', 'x', P1)
    queue.admit('a2', 'x', P1)
    queue.admit('b1', 'x', P2)
    // Global limit reached: both of these wait.
    expect(queue.admit('a3', 'x', P1)).toMatchObject({ admitted: false, reason: 'provider' })
    expect(queue.admit('b2', 'x', P2)).toMatchObject({ admitted: false, reason: 'global' })
    expect(queue.queuedIds()).toEqual(['a3', 'b2'])

    // A P2 slot frees up. a3 is older but P1 is still full, so b2 starts.
    queue.release('b1')
    expect(queue.takeNext()?.taskId).toBe('b2')
    expect(queue.queuedIds()).toEqual(['a3'])
    expect(queue.takeNext()).toBeNull()
  })

  it('is strictly FIFO within one provider', () => {
    const { queue } = makeQueue({ global: 0, perProvider: 1 })
    queue.admit('a1', 'x', P1)
    queue.admit('a2', 'x', P1)
    queue.admit('a3', 'x', P1)
    queue.admit('a4', 'x', P1)
    expect(queue.queuedIds()).toEqual(['a2', 'a3', 'a4'])

    queue.release('a1')
    expect(queue.takeNext()?.taskId).toBe('a2')
    queue.release('a2')
    expect(queue.takeNext()?.taskId).toBe('a3')
    queue.release('a3')
    expect(queue.takeNext()?.taskId).toBe('a4')
  })

  it('a newcomer never overtakes an older waiter of the same provider', () => {
    const { queue, box } = makeQueue({ global: 0, perProvider: 1 })
    queue.admit('a1', 'x', P1)
    queue.admit('a2', 'x', P1)
    // The limit is raised live, but nobody pumped the queue yet.
    box.limits = { global: 0, perProvider: 2 }
    expect(queue.admit('a3', 'x', P1).admitted).toBe(false)
    expect(queue.queuedIds()).toEqual(['a2', 'a3'])
    expect(queue.takeNext()?.taskId).toBe('a2')
  })

  it('hands a freed slot to the right waiter (same provider, oldest first)', () => {
    const { queue } = makeQueue({ global: 0, perProvider: 1 })
    queue.admit('a1', 'x', P1)
    queue.admit('b1', 'x', P2)
    queue.admit('b2', 'x', P2)
    queue.admit('a2', 'x', P1)
    queue.admit('a3', 'x', P1)
    expect(queue.queuedIds()).toEqual(['b2', 'a2', 'a3'])

    // A P1 slot frees: b2 is the oldest waiter, but only a2 can use the slot.
    queue.release('a1')
    const next = queue.takeNext()
    expect(next?.taskId).toBe('a2')
    expect(next?.providerKey).toBe(P1)
    expect(queue.takeNext()).toBeNull()
    expect(queue.queuedIds()).toEqual(['b2', 'a3'])
  })

  it('applies a per-provider override', () => {
    const { queue } = makeQueue({ global: 0, perProvider: 5, byProvider: { [P1]: 2, [P2]: 0 } })
    expect(queue.providerLimit(P1)).toBe(2)
    expect(queue.providerLimit(P2)).toBe(0)
    expect(queue.providerLimit('another')).toBe(5)

    queue.admit('a1', 'x', P1)
    queue.admit('a2', 'x', P1)
    expect(queue.admit('a3', 'x', P1)).toMatchObject({ admitted: false, reason: 'provider' })
    // 0 = unlimited for that provider.
    for (let i = 0; i < 8; i++) expect(queue.admit(`b${i}`, 'x', P2).admitted).toBe(true)
  })

  it('the global limit applies across providers', () => {
    const { queue } = makeQueue({ global: 4, perProvider: 5 })
    queue.admit('a1', 'x', P1)
    queue.admit('a2', 'x', P1)
    queue.admit('b1', 'x', P2)
    queue.admit('c1', 'x', 'provider-three')
    const admission = queue.admit('b2', 'x', P2)
    expect(admission).toMatchObject({ admitted: false, reason: 'global' })
    expect(queue.waitReason('b2')).toBe('global')

    queue.release('a1')
    expect(queue.takeNext()?.taskId).toBe('b2')
  })

  it('treats 0 as unlimited for the per-provider and the global limit', () => {
    const { queue } = makeQueue({ global: 0, perProvider: 0 })
    for (let i = 0; i < 30; i++) expect(queue.admit(`t${i}`, 'x', P1).admitted).toBe(true)
    expect(queue.queuedCount()).toBe(0)
  })

  it('bypassing tasks occupy a slot of their provider and of the global budget', () => {
    const { queue } = makeQueue({ global: 3, perProvider: 2 })
    queue.occupy('cron-1', P1)
    queue.occupy('cron-2', P1)
    expect(queue.activeCountFor(P1)).toBe(2)
    expect(queue.admit('a1', 'x', P1)).toMatchObject({ admitted: false, reason: 'provider' })

    queue.occupy('beat-1', P2)
    expect(queue.admit('b1', 'x', P2)).toMatchObject({ admitted: false, reason: 'global' })
    // Occupy may exceed the limits by design (bypass never waits).
    queue.occupy('cron-3', P1)
    expect(queue.activeCountFor(P1)).toBe(3)
  })

  it('re-reads the limits on every decision', () => {
    const { queue, box } = makeQueue({ global: 0, perProvider: 1 })
    queue.admit('a1', 'x', P1)
    expect(queue.admit('a2', 'x', P1).admitted).toBe(false)

    box.limits = { global: 0, perProvider: 1, byProvider: { [P1]: 2 } }
    expect(queue.takeNext()?.taskId).toBe('a2')

    box.limits = { global: 1, perProvider: 5 }
    expect(queue.admit('b1', 'x', P2)).toMatchObject({ admitted: false, reason: 'global' })
  })

  it('files a task without a provider under the unknown key instead of crashing', () => {
    const { queue } = makeQueue({ global: 0, perProvider: 1 })
    expect(queue.admit('x1', 'x').admitted).toBe(true)
    expect(queue.admit('x2', 'x', '')).toMatchObject({ admitted: false, providerKey: UNKNOWN_PROVIDER_KEY })
    expect(queue.activeCountFor(UNKNOWN_PROVIDER_KEY)).toBe(1)
  })

  it('cancel and release keep the per-provider counts right', () => {
    const { queue } = makeQueue({ global: 0, perProvider: 1 })
    queue.admit('a1', 'x', P1)
    queue.admit('a2', 'x', P1)
    expect(queue.cancel('a2')?.taskId).toBe('a2')
    expect(queue.release('a1')).toBe(true)
    expect(queue.activeCountFor(P1)).toBe(0)
    expect(queue.takeNext()).toBeNull()
    expect(queue.admit('a3', 'x', P1).admitted).toBe(true)
  })

  it('snapshot reports the occupancy per provider', () => {
    const { queue } = makeQueue({ global: 10, perProvider: 1, byProvider: { [P2]: 3 } })
    queue.admit('a1', 'x', P1)
    queue.admit('a2', 'x', P1)
    queue.admit('b1', 'x', P2)
    const snapshot = queue.snapshot()
    expect(snapshot).toMatchObject({ limit: 10, perProviderLimit: 1, running: 2, queued: 1, queuedIds: ['a2'] })
    expect(snapshot.providers).toEqual({
      [P1]: { running: 1, queued: 1, limit: 1 },
      [P2]: { running: 1, queued: 0, limit: 3 },
    })
  })
})

describe('normalizeProviderLimitOverrides', () => {
  it('keeps usable integers and drops garbage', () => {
    expect(normalizeProviderLimitOverrides({ a: 2, b: 0, c: 'x', d: -1, e: 2.9 })).toEqual({ a: 2, b: 0, d: 0, e: 2 })
    expect(normalizeProviderLimitOverrides(null)).toEqual({})
    expect(normalizeProviderLimitOverrides([1, 2])).toEqual({})
  })
})

describe('readTaskConcurrencyLimitsFromConfig', () => {
  function writeSettings(tasks: unknown): void {
    const dir = path.join(process.env.DATA_DIR!, 'config')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ tasks }))
  }

  it('falls back to the defaults when nothing is configured', () => {
    writeSettings({})
    expect(readTaskConcurrencyLimitsFromConfig()).toEqual({ global: 12, perProvider: 5, byProvider: {} })
  })

  it('respects explicit values and reads them live', () => {
    writeSettings({ maxConcurrent: 6, maxConcurrentPerProvider: 3, maxConcurrentByProvider: { [P1]: 1 } })
    expect(readTaskConcurrencyLimitsFromConfig()).toEqual({ global: 6, perProvider: 3, byProvider: { [P1]: 1 } })
    writeSettings({ maxConcurrent: 0, maxConcurrentPerProvider: 0 })
    expect(readTaskConcurrencyLimitsFromConfig()).toEqual({ global: 0, perProvider: 0, byProvider: {} })
  })
})
