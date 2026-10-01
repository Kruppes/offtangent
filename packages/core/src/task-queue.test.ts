import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_CONCURRENT_TASKS_PER_PROVIDER,
  TaskConcurrencyQueue,
  UNKNOWN_PROVIDER_KEY,
  normalizeMaxConcurrentTasks,
  queueAppliesToTrigger,
} from './task-queue.js'

describe('queueAppliesToTrigger', () => {
  it('queues user and agent triggers', () => {
    expect(queueAppliesToTrigger('user')).toBe(true)
    expect(queueAppliesToTrigger('agent')).toBe(true)
  })

  it('lets cronjob, heartbeat and consolidation bypass the queue', () => {
    expect(queueAppliesToTrigger('cronjob')).toBe(false)
    expect(queueAppliesToTrigger('heartbeat')).toBe(false)
    expect(queueAppliesToTrigger('consolidation')).toBe(false)
  })

  it('treats an unknown trigger type as bypassing', () => {
    expect(queueAppliesToTrigger('something-new')).toBe(false)
  })
})

describe('normalizeMaxConcurrentTasks', () => {
  it('keeps non-negative integers', () => {
    expect(normalizeMaxConcurrentTasks(0)).toBe(0)
    expect(normalizeMaxConcurrentTasks(1)).toBe(1)
    expect(normalizeMaxConcurrentTasks(12)).toBe(12)
  })

  it('floors fractions and clamps negatives to 0 (= unlimited)', () => {
    expect(normalizeMaxConcurrentTasks(2.7)).toBe(2)
    expect(normalizeMaxConcurrentTasks(-5)).toBe(0)
  })

  it('rejects non-numbers so the caller can fall back to the default', () => {
    expect(normalizeMaxConcurrentTasks('3')).toBeUndefined()
    expect(normalizeMaxConcurrentTasks(null)).toBeUndefined()
    expect(normalizeMaxConcurrentTasks(undefined)).toBeUndefined()
    expect(normalizeMaxConcurrentTasks(Number.NaN)).toBeUndefined()
    expect(normalizeMaxConcurrentTasks(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

describe('TaskConcurrencyQueue', () => {
  // These tests pin the global cap (`tasks.maxConcurrent`) on its own: the
  // per-provider limit is switched off (0) and every task lands in the same
  // `unknown` provider bucket. Per-provider behaviour lives in
  // task-queue.per-provider.test.ts.
  function makeQueue(limit: number) {
    const box = { limit }
    const queue = new TaskConcurrencyQueue<string>(() => ({ global: box.limit, perProvider: 0 }))
    return { queue, box }
  }

  /** Shape of a waiting admission under the global cap (additive fields since the per-provider limit). */
  function waitingOnGlobal(position: number, running: number) {
    return {
      admitted: false, position, running,
      reason: 'global', providerKey: UNKNOWN_PROVIDER_KEY, providerRunning: running, providerLimit: 0,
    }
  }

  it('admits up to the limit and queues the rest in FIFO order', () => {
    const { queue } = makeQueue(2)

    expect(queue.admit('a', 'payload-a')).toEqual({ admitted: true, running: 1 })
    expect(queue.admit('b', 'payload-b')).toEqual({ admitted: true, running: 2 })
    expect(queue.admit('c', 'payload-c')).toEqual(waitingOnGlobal(1, 2))
    expect(queue.admit('d', 'payload-d')).toEqual(waitingOnGlobal(2, 2))

    expect(queue.activeCount()).toBe(2)
    expect(queue.queuedIds()).toEqual(['c', 'd'])
    expect(queue.position('d')).toBe(2)
  })

  it('hands out a freed slot to the oldest waiting task', () => {
    const { queue } = makeQueue(1)
    queue.admit('a', 'payload-a')
    queue.admit('b', 'payload-b')
    queue.admit('c', 'payload-c')

    expect(queue.takeNext()).toBeNull() // no slot yet

    expect(queue.release('a')).toBe(true)
    const next = queue.takeNext()
    expect(next?.taskId).toBe('b')
    expect(next?.payload).toBe('payload-b')
    expect(queue.isActive('b')).toBe(true)
    expect(queue.queuedIds()).toEqual(['c'])

    // The slot is taken again — c has to wait.
    expect(queue.takeNext()).toBeNull()
  })

  it('never starts more than the limit even with many releases', () => {
    const { queue } = makeQueue(3)
    for (const id of ['a', 'b', 'c', 'd', 'e']) queue.admit(id, id)
    expect(queue.activeIds().sort()).toEqual(['a', 'b', 'c'])
    expect(queue.queuedIds()).toEqual(['d', 'e'])

    queue.release('a')
    expect(queue.takeNext()?.taskId).toBe('d')
    expect(queue.activeCount()).toBe(3)
    expect(queue.takeNext()).toBeNull()
  })

  it('treats limit 0 as unlimited', () => {
    const { queue } = makeQueue(0)
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect(queue.admit(id, id).admitted).toBe(true)
    }
    expect(queue.queuedCount()).toBe(0)
    expect(queue.hasFreeSlot()).toBe(true)
  })

  it('re-reads the limit on every decision', () => {
    const { queue, box } = makeQueue(1)
    queue.admit('a', 'a')
    expect(queue.admit('b', 'b').admitted).toBe(false)

    // Raising the limit lets the waiting task in without any other change.
    box.limit = 2
    expect(queue.takeNext()?.taskId).toBe('b')

    // Lowering it below the active count stops the queue from draining.
    queue.admit('c', 'c')
    box.limit = 1
    expect(queue.hasFreeSlot()).toBe(false)
    expect(queue.takeNext()).toBeNull()
  })

  it('falls back to the default when the limit source returns garbage', () => {
    const queue = new TaskConcurrencyQueue<string>(() => ({ global: Number.NaN, perProvider: Number.NaN }))
    expect(queue.limit()).toBe(DEFAULT_MAX_CONCURRENT_TASKS)
    expect(queue.providerLimit('any')).toBe(DEFAULT_MAX_CONCURRENT_TASKS_PER_PROVIDER)
  })

  it('occupy takes a slot without waiting (bypass) and still counts', () => {
    const { queue } = makeQueue(1)
    queue.admit('a', 'a')
    queue.occupy('bypass-1')
    queue.occupy('bypass-2')

    expect(queue.activeCount()).toBe(3)
    expect(queue.hasFreeSlot()).toBe(false)
    // Occupy is idempotent.
    queue.occupy('bypass-1')
    expect(queue.activeCount()).toBe(3)
  })

  it('cancel removes a waiting task so it is never started', () => {
    const { queue } = makeQueue(1)
    queue.admit('a', 'a')
    queue.admit('b', 'b')
    queue.admit('c', 'c')

    expect(queue.cancel('b')?.taskId).toBe('b')
    expect(queue.cancel('b')).toBeNull()
    expect(queue.queuedIds()).toEqual(['c'])

    queue.release('a')
    expect(queue.takeNext()?.taskId).toBe('c')
  })

  it('release reports whether a slot was actually held', () => {
    const { queue } = makeQueue(2)
    queue.admit('a', 'a')
    expect(queue.release('a')).toBe(true)
    expect(queue.release('a')).toBe(false)
    expect(queue.release('never-seen')).toBe(false)
  })

  it('does not duplicate an entry when admit is called twice', () => {
    const { queue } = makeQueue(1)
    queue.admit('a', 'a')
    expect(queue.admit('a', 'a')).toEqual({ admitted: true, running: 1 })

    queue.admit('b', 'b')
    expect(queue.admit('b', 'b')).toEqual(waitingOnGlobal(1, 1))
    expect(queue.queuedIds()).toEqual(['b'])
  })

  it('clear drops slots and the waiting list', () => {
    const { queue } = makeQueue(1)
    queue.admit('a', 'a')
    queue.admit('b', 'b')
    queue.clear()
    expect(queue.snapshot()).toEqual({
      limit: 1, perProviderLimit: 0, running: 0, queued: 0, queuedIds: [], providers: {},
    })
  })

  it('snapshot reports limit, running and queued for logging', () => {
    const { queue } = makeQueue(2)
    queue.admit('a', 'a')
    queue.admit('b', 'b')
    queue.admit('c', 'c')
    expect(queue.snapshot()).toEqual({
      limit: 2, perProviderLimit: 0, running: 2, queued: 1, queuedIds: ['c'],
      providers: { [UNKNOWN_PROVIDER_KEY]: { running: 2, queued: 1, limit: 0 } },
    })
  })
})
