/**
 * Who a task belongs to. This walk is authorization-relevant (the tasks API
 * denies a foreign task with 404), so the edge cases are pinned here rather
 * than only through the HTTP layer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { initTasksTable } from './task-store.js'
import {
  parseStrictUserId,
  resolveTaskOwnerUserId,
  resolveTaskOwnerUserIdForTask,
} from './task-ownership.js'

let db: Database

beforeEach(() => {
  db = initDatabase(':memory:')
  // `sessions.user_id` is a real FK into `users`.
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (4, ?, ?, ?)').run('alice', 'x', 'user')
})

afterEach(() => db.close())

function session(id: string, parent: string | null, sessionUser: string | null, userId: number | null = null): string {
  db.prepare(
    `INSERT INTO sessions (id, source, type, parent_session_id, session_user, user_id)
     VALUES (?, 'system', ?, ?, ?, ?)`,
  ).run(id, parent ? 'task' : 'interactive', parent, sessionUser, userId)
  return id
}

describe('resolveTaskOwnerUserId', () => {
  it('walks the lineage up to the interactive session that triggered the work', () => {
    session('strand', null, '7')
    session('task-a', 'strand', null)
    session('task-b', 'task-a', null)
    expect(resolveTaskOwnerUserId(db, 'task-b')).toBe(7)
  })

  it('falls back to sessions.user_id when session_user is not numeric', () => {
    session('strand-u', null, 'alice', 4)
    session('task-u', 'strand-u', null)
    expect(resolveTaskOwnerUserId(db, 'task-u')).toBe(4)
  })

  it('returns null for a system task whose root session names no user', () => {
    session('cron-root', null, null)
    expect(resolveTaskOwnerUserId(db, 'cron-root')).toBeNull()
  })

  it('returns null for a task without a session and for an unknown session', () => {
    expect(resolveTaskOwnerUserId(db, null)).toBeNull()
    expect(resolveTaskOwnerUserId(db, undefined)).toBeNull()
    expect(resolveTaskOwnerUserId(db, 'nope')).toBeNull()
  })

  it('does not hang or guess on a cyclic parent chain', () => {
    session('cycle-a', null, '1')
    session('cycle-b', 'cycle-a', null)
    // a -> b -> a: only reachable through bad/legacy data, must not spin.
    db.prepare('UPDATE sessions SET parent_session_id = ? WHERE id = ?').run('cycle-b', 'cycle-a')
    expect(resolveTaskOwnerUserId(db, 'cycle-a')).toBeNull()
  })

  it('never attributes a task to a user id parsed out of a username', () => {
    // `parseInt('3abc', 10) === 3` would hand this task to user 3.
    session('strand-bad', null, '3abc')
    session('task-bad', 'strand-bad', null)
    expect(resolveTaskOwnerUserId(db, 'task-bad')).toBeNull()
  })
})

/**
 * The task-level walk. A task delegated by a task has no session lineage of
 * its own (background task tools pass `parentSessionId = null` on purpose),
 * so ownership has to climb `tasks.trigger_source_id` as well.
 */
describe('resolveTaskOwnerUserIdForTask', () => {
  beforeEach(() => initTasksTable(db))

  function task(input: {
    id: string
    triggerType?: string
    triggerSourceId?: string | null
    sessionId?: string | null
  }) {
    const row = {
      id: input.id,
      triggerType: input.triggerType ?? 'agent',
      triggerSourceId: input.triggerSourceId ?? null,
      sessionId: input.sessionId ?? null,
    }
    db.prepare(
      `INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, session_id)
       VALUES (?, ?, 'p', 'completed', ?, ?, ?)`,
    ).run(row.id, `task ${row.id}`, row.triggerType, row.triggerSourceId, row.sessionId)
    return row
  }

  it('resolves a task that has its own session lineage (unchanged behaviour)', () => {
    session('strand-1', null, '7')
    session('tsess-1', 'strand-1', null)
    const parent = task({ id: 'parent-1', sessionId: 'tsess-1' })
    expect(resolveTaskOwnerUserIdForTask(db, parent)).toBe(7)
  })

  it('resolves a sub-task through its parent task when its own session is an orphan', () => {
    // Exactly the live shape: the child's session has no parent, no
    // session_user and no user_id; the only link is trigger_source_id.
    session('strand-2', null, '2')
    session('tsess-parent-2', 'strand-2', null)
    session('tsess-child-2', null, null)
    const parent = task({ id: 'parent-2', sessionId: 'tsess-parent-2' })
    const child = task({ id: 'child-2', triggerSourceId: parent.id, sessionId: 'tsess-child-2' })

    expect(resolveTaskOwnerUserId(db, child.sessionId)).toBeNull()
    expect(resolveTaskOwnerUserIdForTask(db, child)).toBe(2)
  })

  it('climbs more than one generation of delegated tasks', () => {
    session('strand-3', null, '5')
    session('tsess-root-3', 'strand-3', null)
    session('tsess-mid-3', null, null)
    session('tsess-leaf-3', null, null)
    const root = task({ id: 'root-3', sessionId: 'tsess-root-3' })
    const mid = task({ id: 'mid-3', triggerSourceId: root.id, sessionId: 'tsess-mid-3' })
    const leaf = task({ id: 'leaf-3', triggerSourceId: mid.id, sessionId: 'tsess-leaf-3' })
    expect(resolveTaskOwnerUserIdForTask(db, leaf)).toBe(5)
  })

  it('returns null when the chain ends in system work (no human origin)', () => {
    session('cron-root-4', null, null)
    session('tsess-child-4', null, null)
    const cron = task({ id: 'cron-4', triggerType: 'cronjob', sessionId: 'cron-root-4' })
    const child = task({ id: 'child-4', triggerSourceId: cron.id, sessionId: 'tsess-child-4' })
    expect(resolveTaskOwnerUserIdForTask(db, child)).toBeNull()
  })

  it('does not follow trigger_source_id of non-agent tasks (it is a cronjob id there)', () => {
    session('strand-5', null, '9')
    session('tsess-5', 'strand-5', null)
    const decoy = task({ id: 'decoy-5', sessionId: 'tsess-5' })
    // A cronjob whose trigger_source_id happens to equal a task id must not
    // inherit that task's owner.
    const cron = task({ id: 'cron-5', triggerType: 'cronjob', triggerSourceId: decoy.id, sessionId: null })
    expect(resolveTaskOwnerUserIdForTask(db, cron)).toBeNull()
  })

  it('treats an empty trigger_source_id as no parent', () => {
    // The live rows of agent tasks started from a strand carry ''.
    const orphan = task({ id: 'orphan-6', triggerSourceId: '', sessionId: null })
    expect(resolveTaskOwnerUserIdForTask(db, orphan)).toBeNull()
  })

  it('returns null when the parent task row is gone', () => {
    const child = task({ id: 'child-7', triggerSourceId: 'deleted-parent', sessionId: null })
    expect(resolveTaskOwnerUserIdForTask(db, child)).toBeNull()
  })

  it('does not hang on a cyclic task-parent chain', () => {
    const a = task({ id: 'cycle-a', triggerSourceId: 'cycle-b', sessionId: null })
    task({ id: 'cycle-b', triggerSourceId: 'cycle-a', sessionId: null })
    expect(resolveTaskOwnerUserIdForTask(db, a)).toBeNull()
  })

  it('gives up instead of walking an unbounded chain', () => {
    session('strand-deep', null, '1')
    session('tsess-deep-root', 'strand-deep', null)
    task({ id: 'deep-0', sessionId: 'tsess-deep-root' })
    for (let i = 1; i <= 12; i++) {
      task({ id: `deep-${i}`, triggerSourceId: `deep-${i - 1}`, sessionId: null })
    }
    // Within the limit the owner is found, far beyond it the walk stops.
    expect(resolveTaskOwnerUserIdForTask(db, { id: 'deep-3', triggerType: 'agent', triggerSourceId: 'deep-2', sessionId: null })).toBe(1)
    expect(resolveTaskOwnerUserIdForTask(db, { id: 'deep-12', triggerType: 'agent', triggerSourceId: 'deep-11', sessionId: null })).toBeNull()
  })
})

describe('parseStrictUserId', () => {
  it('accepts integers and integer strings only', () => {
    expect(parseStrictUserId(3)).toBe(3)
    expect(parseStrictUserId('3')).toBe(3)
    expect(parseStrictUserId(' 12 ')).toBe(12)
    expect(parseStrictUserId('3abc')).toBeNull()
    expect(parseStrictUserId('telegram-99')).toBeNull()
    expect(parseStrictUserId('')).toBeNull()
    expect(parseStrictUserId(null)).toBeNull()
    expect(parseStrictUserId(undefined)).toBeNull()
    expect(parseStrictUserId(1.5)).toBeNull()
  })
})
