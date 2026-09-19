import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskStore, type Task, type TaskTriggerType } from './task-store.js'
import { buildTaskFeedItem, feedKindForTask, feedTitleForTask, resolveTaskStrandOrigin } from './task-feed.js'

let db: Database
let store: TaskStore

beforeEach(() => {
  db = initDatabase(':memory:')
  store = new TaskStore(db)
})

afterEach(() => {
  db.close()
})

function session(id: string, type: string, parent: string | null = null): string {
  db.prepare(
    `INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES (?, 'system', ?, ?, '1')`,
  ).run(id, type, parent)
  return id
}

function task(over: { triggerType?: TaskTriggerType; sessionId?: string | null } = {}): Task {
  return store.create({
    name: 'Nightly run',
    prompt: 'do it',
    triggerType: over.triggerType ?? 'user',
    sessionId: over.sessionId ?? undefined,
    agentId: 'main',
  })
}

describe('resolveTaskStrandOrigin', () => {
  it('returns the interactive parent of a user-triggered task session', () => {
    const strand = session('strand-1', 'interactive')
    session('task-session-1', 'task', strand)
    expect(resolveTaskStrandOrigin(db, task({ sessionId: 'task-session-1' }))).toBe(strand)
  })

  it('walks more than one level of lineage', () => {
    session('strand-2', 'interactive')
    session('mid', 'task', 'strand-2')
    session('leaf', 'task', 'mid')
    expect(resolveTaskStrandOrigin(db, task({ sessionId: 'leaf' }))).toBe('strand-2')
  })

  it('accepts a task whose own session is already the strand', () => {
    session('strand-3', 'interactive')
    expect(resolveTaskStrandOrigin(db, task({ sessionId: 'strand-3' }))).toBe('strand-3')
  })

  it('returns null for a cronjob even when a lineage exists', () => {
    session('strand-4', 'interactive')
    session('cron-session', 'task', 'strand-4')
    expect(resolveTaskStrandOrigin(db, task({ triggerType: 'cronjob', sessionId: 'cron-session' }))).toBeNull()
  })

  it('returns null for heartbeat and consolidation triggers', () => {
    session('hb-session', 'heartbeat')
    expect(resolveTaskStrandOrigin(db, task({ triggerType: 'heartbeat', sessionId: 'hb-session' }))).toBeNull()
    session('cons-session', 'consolidation')
    expect(resolveTaskStrandOrigin(db, task({ triggerType: 'consolidation', sessionId: 'cons-session' }))).toBeNull()
  })

  it('returns null without a session, without a lineage, and for an unknown session id', () => {
    expect(resolveTaskStrandOrigin(db, task({ sessionId: null }))).toBeNull()
    session('lonely', 'task', null)
    expect(resolveTaskStrandOrigin(db, task({ sessionId: 'lonely' }))).toBeNull()
    expect(resolveTaskStrandOrigin(db, task({ sessionId: 'does-not-exist' }))).toBeNull()
  })

  it('survives a cyclic lineage instead of looping forever', () => {
    session('a', 'task', null)
    session('b', 'task', 'a')
    db.prepare('UPDATE sessions SET parent_session_id = ? WHERE id = ?').run('b', 'a')
    expect(resolveTaskStrandOrigin(db, task({ sessionId: 'a' }))).toBeNull()
  })
})

describe('feed kind and title', () => {
  it('maps the trigger type to the kind', () => {
    expect(feedKindForTask(task({ triggerType: 'user' }))).toBe('task_result')
    expect(feedKindForTask(task({ triggerType: 'agent' }))).toBe('task_result')
    expect(feedKindForTask(task({ triggerType: 'cronjob' }))).toBe('cron_report')
    expect(feedKindForTask(task({ triggerType: 'heartbeat' }))).toBe('heartbeat')
    expect(feedKindForTask(task({ triggerType: 'consolidation' }))).toBe('system')
  })

  it('a question is a question regardless of the trigger', () => {
    const cron = task({ triggerType: 'cronjob' })
    const asked = store.update(cron.id, { status: 'paused', resultStatus: 'question' })!
    expect(feedKindForTask(asked)).toBe('task_question')
    expect(feedTitleForTask(asked)).toBe('Question: Nightly run')
  })

  it('marks a failure in the title and leaves a success plain', () => {
    const t = task()
    expect(feedTitleForTask(t)).toBe('Nightly run')
    const failed = store.update(t.id, { status: 'failed', resultStatus: 'failed' })!
    expect(feedTitleForTask(failed)).toBe('Failed: Nightly run')
  })
})

describe('buildTaskFeedItem', () => {
  it('carries summary, task id, persona and the strand when there is one', () => {
    const t = store.update(task().id, { resultStatus: 'completed', resultSummary: 'All green' })!
    expect(buildTaskFeedItem(t, { userId: '1', strandId: 'strand-9' })).toEqual({
      userId: '1',
      kind: 'task_result',
      title: 'Nightly run',
      body: 'All green',
      agentId: 'main',
      taskId: t.id,
      strandId: 'strand-9',
    })
  })

  it('falls back to the error message and to no strand', () => {
    const t = store.update(task().id, { status: 'failed', resultStatus: 'failed', errorMessage: 'provider 400' })!
    const item = buildTaskFeedItem(t, { userId: '1' })
    expect(item.body).toBe('provider 400')
    expect(item.strandId).toBeNull()
  })
})
