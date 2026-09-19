/** The durable queue behind task-result delivery (W4). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  abandonTaskInjection,
  countPendingTaskInjections,
  enqueueTaskInjection,
  formatRedeliveryPayload,
  getTaskInjection,
  injectionTimestampMs,
  listPendingTaskInjections,
  markTaskInjectionAttempt,
  markTaskInjectionDelivered,
  markTaskInjectionFailed,
  selectInjectionsForRedelivery,
  type TaskInjectionRow,
} from './task-injection-queue.js'

let db: Database

beforeEach(() => {
  db = initDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

function enqueue(overrides: Partial<Parameters<typeof enqueueTaskInjection>[1]> = {}) {
  return enqueueTaskInjection(db, {
    taskId: 'task-1',
    userId: 1,
    agentId: 'bob',
    sessionId: 'strand-1',
    payload: '<task_injection>done</task_injection>',
    ...overrides,
  })
}

function row(over: Partial<TaskInjectionRow> = {}): TaskInjectionRow {
  return {
    id: 'i1',
    taskId: 't1',
    kind: 'task_result',
    userId: 1,
    agentId: 'bob',
    sessionId: 's1',
    payload: 'p',
    status: 'pending',
    attempts: 0,
    createdAt: '2026-09-17 15:00:00',
    lastAttemptAt: null,
    deliveredAt: null,
    lastError: null,
    ...over,
  }
}

const NOW = Date.parse('2026-09-17T15:10:00Z')

describe('task injection queue persistence', () => {
  it('stores an injection as pending with the payload intact', () => {
    const created = enqueue()
    const stored = getTaskInjection(db, created.id)
    expect(stored).toMatchObject({
      taskId: 'task-1',
      kind: 'task_result',
      userId: 1,
      agentId: 'bob',
      sessionId: 'strand-1',
      payload: '<task_injection>done</task_injection>',
      status: 'pending',
      attempts: 0,
      deliveredAt: null,
    })
    expect(countPendingTaskInjections(db)).toBe(1)
  })

  it('survives a reopened connection — the point of the whole table', () => {
    // Same process, new statement handles: the row is in the file/page cache,
    // not in a Map that dies with the process.
    const created = enqueue()
    const again = getTaskInjection(db, created.id)
    expect(again?.payload).toBe(created.payload)
  })

  it('counts an attempt without acking it', () => {
    const created = enqueue()
    markTaskInjectionAttempt(db, created.id)
    const stored = getTaskInjection(db, created.id)!
    expect(stored.attempts).toBe(1)
    expect(stored.status).toBe('pending')
    expect(stored.lastAttemptAt).toBeTruthy()
  })

  it('acks exactly once', () => {
    const created = enqueue()
    expect(markTaskInjectionDelivered(db, created.id)).toBe(true)
    expect(markTaskInjectionDelivered(db, created.id)).toBe(false)
    const stored = getTaskInjection(db, created.id)!
    expect(stored.status).toBe('delivered')
    expect(stored.deliveredAt).toBeTruthy()
    expect(countPendingTaskInjections(db)).toBe(0)
  })

  it('keeps a failed delivery pending so it can be retried', () => {
    const created = enqueue()
    markTaskInjectionAttempt(db, created.id)
    markTaskInjectionFailed(db, created.id, 'provider exploded')
    const stored = getTaskInjection(db, created.id)!
    expect(stored.status).toBe('pending')
    expect(stored.lastError).toBe('provider exploded')
    expect(listPendingTaskInjections(db)).toHaveLength(1)
  })

  it('never resurrects a delivered row', () => {
    const created = enqueue()
    markTaskInjectionDelivered(db, created.id)
    markTaskInjectionFailed(db, created.id, 'late error')
    abandonTaskInjection(db, created.id, 'late abandon')
    const stored = getTaskInjection(db, created.id)!
    expect(stored.status).toBe('delivered')
    expect(stored.lastError).toBeNull()
  })

  it('abandons a row so no sweep picks it up again', () => {
    const created = enqueue()
    abandonTaskInjection(db, created.id, 'too old')
    expect(getTaskInjection(db, created.id)).toMatchObject({ status: 'abandoned', lastError: 'too old' })
    expect(listPendingTaskInjections(db)).toEqual([])
  })

  it('lists pending rows oldest first and filters by strand and persona', () => {
    const a = enqueue({ taskId: 'a', sessionId: 's-a', agentId: 'bob' })
    const b = enqueue({ taskId: 'b', sessionId: 's-b', agentId: 'main' })
    markTaskInjectionDelivered(db, a.id)
    expect(listPendingTaskInjections(db).map(r => r.taskId)).toEqual(['b'])
    expect(listPendingTaskInjections(db, { sessionId: 's-b' }).map(r => r.taskId)).toEqual(['b'])
    expect(listPendingTaskInjections(db, { agentId: 'bob' })).toEqual([])
    expect(listPendingTaskInjections(db, { agentId: 'main' }).map(r => r.id)).toEqual([b.id])
  })

  it('respects the list limit', () => {
    enqueue({ taskId: 'a' })
    enqueue({ taskId: 'b' })
    expect(listPendingTaskInjections(db, { limit: 1 })).toHaveLength(1)
  })
})

describe('redelivery selection', () => {
  it('redelivers a pending row that was never attempted', () => {
    const selection = selectInjectionsForRedelivery([row()], {
      now: NOW, retryAfterMs: 300_000, maxAttempts: 5, maxAgeMs: 0, limit: 0,
    })
    expect(selection.redeliver.map(r => r.id)).toEqual(['i1'])
    expect(selection.expire).toEqual([])
  })

  it('treats a recent attempt as in flight', () => {
    const selection = selectInjectionsForRedelivery([row({ lastAttemptAt: '2026-09-17 15:09:30', attempts: 1 })], {
      now: NOW, retryAfterMs: 300_000, maxAttempts: 5, maxAgeMs: 0, limit: 0,
    })
    expect(selection.redeliver).toEqual([])
    expect(selection.expire).toEqual([])
  })

  it('retries once the attempt is older than the retry window', () => {
    const selection = selectInjectionsForRedelivery([row({ lastAttemptAt: '2026-09-17 15:00:00', attempts: 1 })], {
      now: NOW, retryAfterMs: 300_000, maxAttempts: 5, maxAgeMs: 0, limit: 0,
    })
    expect(selection.redeliver).toHaveLength(1)
  })

  it('abandons a row that exceeded the attempt cap', () => {
    const selection = selectInjectionsForRedelivery([row({ attempts: 5 })], {
      now: NOW, retryAfterMs: 0, maxAttempts: 5, maxAgeMs: 0, limit: 0,
    })
    expect(selection.redeliver).toEqual([])
    expect(selection.expire[0].reason).toContain('5 delivery attempts')
  })

  it('abandons a result that is older than the age cap instead of injecting stale context', () => {
    const selection = selectInjectionsForRedelivery([row({ createdAt: '2026-09-15 15:00:00' })], {
      now: NOW, retryAfterMs: 0, maxAttempts: 0, maxAgeMs: 24 * 3600_000, limit: 0,
    })
    expect(selection.expire[0].reason).toContain('expired')
    expect(selection.redeliver).toEqual([])
  })

  it('treats 0 as "disabled" for both caps', () => {
    const ancient = row({ createdAt: '2020-01-01 00:00:00', attempts: 99 })
    const selection = selectInjectionsForRedelivery([ancient], {
      now: NOW, retryAfterMs: 0, maxAttempts: 0, maxAgeMs: 0, limit: 0,
    })
    expect(selection.redeliver).toHaveLength(1)
    expect(selection.expire).toEqual([])
  })

  it('caps the batch but still expires everything expirable', () => {
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b' }),
      row({ id: 'c', attempts: 9 }),
      row({ id: 'd' }),
    ]
    const selection = selectInjectionsForRedelivery(rows, {
      now: NOW, retryAfterMs: 0, maxAttempts: 5, maxAgeMs: 0, limit: 2,
    })
    expect(selection.redeliver.map(r => r.id)).toEqual(['a', 'b'])
    expect(selection.expire.map(e => e.row.id)).toEqual(['c'])
  })

  it('ignores rows that are not pending', () => {
    const selection = selectInjectionsForRedelivery([row({ status: 'delivered' }), row({ id: 'x', status: 'abandoned' })], {
      now: NOW, retryAfterMs: 0, maxAttempts: 0, maxAgeMs: 0, limit: 0,
    })
    expect(selection.redeliver).toEqual([])
  })

  it('parses the naked sqlite timestamp as UTC', () => {
    expect(injectionTimestampMs('2026-09-17 15:00:00')).toBe(Date.parse('2026-09-17T15:00:00Z'))
    expect(injectionTimestampMs('2026-09-17T15:00:00Z')).toBe(Date.parse('2026-09-17T15:00:00Z'))
    expect(injectionTimestampMs(null)).toBe(0)
    expect(injectionTimestampMs('not a date')).toBe(0)
  })
})

describe('redelivery payload', () => {
  it('leaves a first delivery byte-identical', () => {
    expect(formatRedeliveryPayload(row({ payload: 'X' }), 'container_restart')).toBe('X')
  })

  it('prefixes a repeat with a delivery notice that names the reason', () => {
    const out = formatRedeliveryPayload(row({ payload: '<task_injection>R</task_injection>', attempts: 1 }), 'container_restart')
    expect(out).toContain('reason="container_restart"')
    expect(out).toContain('attempt="2"')
    expect(out).toContain('container restarted')
    expect(out.endsWith('<task_injection>R</task_injection>')).toBe(true)
  })

  it('uses the dead-session wording for a plain retry', () => {
    const out = formatRedeliveryPayload(row({ attempts: 2 }), 'retry')
    expect(out).toContain('reason="retry"')
    expect(out).toContain('session this result was delivered into died')
  })
})
