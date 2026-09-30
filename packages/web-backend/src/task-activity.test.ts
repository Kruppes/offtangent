/**
 * Strand activity frames: a task that cannot be attached to a strand must be
 * dropped, never broadcast to "the strand that happens to be running".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, TaskStore } from '@axiom/core'
import type { Database, Task } from '@axiom/core'
import { ChatEventBus, type ChatEvent } from './chat-event-bus.js'
import { broadcastTaskActivity } from './task-activity.js'

let db: Database
let store: TaskStore
let bus: ChatEventBus
let events: ChatEvent[]

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('admin', 'x', 'admin')
  store = new TaskStore(db)
  bus = new ChatEventBus()
  events = []
  bus.subscribe(e => events.push(e))
})

afterEach(() => db.close())

function session(id: string, type: string, parent: string | null = null): string {
  db.prepare(
    `INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES (?, 'system', ?, ?, '1')`,
  ).run(id, type, parent)
  return id
}

function deps() {
  return { db, chatEventBus: bus, resolveUserId: () => 1 }
}

function task(over: { name?: string; sessionId?: string | null; triggerSourceId?: string } = {}): Task {
  return store.create({
    name: over.name ?? 'T',
    prompt: 'p',
    triggerType: 'agent',
    triggerSourceId: over.triggerSourceId,
    sessionId: over.sessionId ?? undefined,
    agentId: 'main',
  })
}

describe('broadcastTaskActivity', () => {
  it('emits task_started carrying strand, task and parent ids', () => {
    const strand = session('strand-a', 'interactive')
    session('sess-top', 'task', strand)
    const top = task({ name: 'Top', sessionId: 'sess-top' })
    const sub = task({ name: 'Sub', triggerSourceId: top.id })

    expect(broadcastTaskActivity(deps(), 'started', sub)).toBe(true)
    expect(events).toHaveLength(1)
    const frame = events[0]!
    expect(frame.type).toBe('task_started')
    expect(frame.sessionId).toBe(strand)
    expect(frame.taskId).toBe(sub.id)
    expect(frame.taskParentId).toBe(top.id)
    expect(frame.taskName).toBe('Sub')
    expect(frame.taskStatus).toBe('running')
    expect(frame.agentId).toBe('main')
    expect(frame.userId).toBe(1)
  })

  it('drops a frame whose task has no resolvable strand instead of guessing', () => {
    // A strand exists and is "the only one running" — the forbidden fallback.
    session('strand-b', 'interactive')
    const orphan = task({ name: 'Orphan', sessionId: null })

    expect(broadcastTaskActivity(deps(), 'started', orphan)).toBe(false)
    expect(events).toEqual([])
  })

  it('drops a frame for a cronjob wave (no interactive ancestor)', () => {
    session('strand-c', 'interactive')
    const cronSession = session('sess-cron', 'task', null)
    const cron = store.create({ name: 'cron', prompt: 'p', triggerType: 'cronjob', sessionId: cronSession, agentId: 'main' })
    const sub = task({ name: 'cron-sub', triggerSourceId: cron.id })

    expect(broadcastTaskActivity(deps(), 'started', cron)).toBe(false)
    expect(broadcastTaskActivity(deps(), 'started', sub)).toBe(false)
    expect(events).toEqual([])
  })

  it('emits task_finished with status and failure reason', () => {
    const strand = session('strand-d', 'interactive')
    session('sess-f', 'task', strand)
    const failing = task({ name: 'Boom', sessionId: 'sess-f' })
    store.update(failing.id, { status: 'failed', resultStatus: 'failed', errorMessage: 'exit 1', completedAt: '2025-09-15 10:00:00' })

    expect(broadcastTaskActivity(deps(), 'finished', store.getById(failing.id)!)).toBe(true)
    const frame = events[0]!
    expect(frame.type).toBe('task_finished')
    expect(frame.taskStatus).toBe('failed')
    expect(frame.taskResultStatus).toBe('failed')
    expect(frame.taskError).toBe('exit 1')
    expect(frame.taskCompletedAt).toBe('2025-09-15 10:00:00')
  })

  it('emits task_progress for a running task', () => {
    const strand = session('strand-e', 'interactive')
    session('sess-p', 'task', strand)
    const running = task({ name: 'Running', sessionId: 'sess-p' })
    expect(broadcastTaskActivity(deps(), 'progress', running)).toBe(true)
    expect(events[0]!.type).toBe('task_progress')
    expect(events[0]!.sessionId).toBe(strand)
  })

  /**
   * The App reads these exact keys. Renaming one silently breaks a client
   * that ships separately from the backend.
   */
  it('carries the live token and cost stand on every phase', () => {
    const strand = session('strand-g', 'interactive')
    session('sess-g', 'task', strand)
    const running = task({ name: 'Counting', sessionId: 'sess-g' })
    store.update(running.id, {
      promptTokens: 78,
      completionTokens: 8221,
      cacheRead: 1308532,
      cacheWrite: 55092,
      estimatedCost: 1.204506,
      toolCallCount: 38,
    })

    const fresh = store.getById(running.id)!
    for (const phase of ['started', 'progress', 'finished'] as const) {
      events = []
      expect(broadcastTaskActivity(deps(), phase, fresh)).toBe(true)
      const frame = events[0]!
      expect(frame.taskPromptTokens).toBe(78)
      expect(frame.taskCompletionTokens).toBe(8221)
      expect(frame.taskCacheRead).toBe(1308532)
      expect(frame.taskCacheWrite).toBe(55092)
      expect(frame.taskEstimatedCost).toBeCloseTo(1.204506, 6)
      expect(frame.taskToolCallCount).toBe(38)
    }
  })

  it('sends 0 instead of undefined for a task that has not billed anything', () => {
    const strand = session('strand-h', 'interactive')
    session('sess-h', 'task', strand)
    const fresh = task({ name: 'Fresh', sessionId: 'sess-h' })
    expect(broadcastTaskActivity(deps(), 'started', fresh)).toBe(true)
    const frame = events[0]!
    expect(frame.taskPromptTokens).toBe(0)
    expect(frame.taskCompletionTokens).toBe(0)
    expect(frame.taskCacheRead).toBe(0)
    expect(frame.taskCacheWrite).toBe(0)
    expect(frame.taskEstimatedCost).toBe(0)
  })

  it('is a no-op without a bus', () => {
    const strand = session('strand-f', 'interactive')
    session('sess-n', 'task', strand)
    const t = task({ sessionId: 'sess-n' })
    expect(broadcastTaskActivity({ db, chatEventBus: null, resolveUserId: () => 1 }, 'started', t)).toBe(false)
  })
})
