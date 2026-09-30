/**
 * The trigger side of the running project assignment: the gate runs
 * synchronously, the model call does not, and nothing here may ever throw
 * into a chat turn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, putStrandProjectSuggestion } from '@axiom/core'
import type { Database, EvaluateStrandProjectResult } from '@axiom/core'
import { resetProjectAssignmentInFlight, triggerProjectAssignment } from './project-assignment-trigger.js'
import { ChatEventBus } from './chat-event-bus.js'
import type { ChatEvent } from './chat-event-bus.js'

let db: Database
const silent = { log: () => {}, warn: () => {}, error: () => {} }

function addStrand(id: string, projectId: string | null = null): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, started_at, last_activity, message_count, summary_written, agent_id, title, project_id, archived)
     VALUES (?, 1, '1', 'web', 'interactive', datetime('now'), datetime('now'), 0, 0, 'main', 'Dachrinne', ?, 0)`,
  ).run(id, projectId)
}

function addMessages(id: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
       VALUES (?, 1, ?, ?, 'main', datetime('now'))`,
    ).run(id, i % 2 === 0 ? 'user' : 'assistant', `Nachricht ${i}`)
  }
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
  db.prepare(
    `INSERT INTO projects (id, user_id, name, archived, created_at, updated_at)
     VALUES ('prj_haus', '1', 'Haus & Handwerk', 0, datetime('now'), datetime('now'))`,
  ).run()
  resetProjectAssignmentInFlight()
})

afterEach(() => {
  db.close()
})

function settled(): { promise: Promise<EvaluateStrandProjectResult>; resolve: (r: EvaluateStrandProjectResult) => void } {
  let resolve!: (r: EvaluateStrandProjectResult) => void
  const promise = new Promise<EvaluateStrandProjectResult>((res) => { resolve = res })
  return { promise, resolve }
}

describe('triggerProjectAssignment', () => {
  it('refuses a strand below the message minimum without calling the model', () => {
    addStrand('s1')
    addMessages('s1', 2)
    let calls = 0
    const started = triggerProjectAssignment({
      db,
      sessionId: 's1',
      trigger: 'message',
      deps: {
        console: silent,
        loadSettings: () => ({}),
        evaluate: async () => {
          calls += 1
          return { outcome: 'none' }
        },
      },
    })
    expect(started).toBe(false)
    expect(calls).toBe(0)
  })

  it('refuses a strand that already has a project', () => {
    addStrand('s1', 'prj_haus')
    addMessages('s1', 12)
    expect(triggerProjectAssignment({
      db,
      sessionId: 's1',
      trigger: 'message',
      deps: { console: silent, loadSettings: () => ({}), evaluate: async () => ({ outcome: 'none' }) },
    })).toBe(false)
  })

  it('obeys the kill switch in settings.json', () => {
    addStrand('s1')
    addMessages('s1', 5)
    expect(triggerProjectAssignment({
      db,
      sessionId: 's1',
      trigger: 'message',
      deps: {
        console: silent,
        loadSettings: () => ({ projectAssignment: { enabled: false } }),
        evaluate: async () => ({ outcome: 'none' }),
      },
    })).toBe(false)
  })

  it('returns before the model answers and broadcasts the result afterwards', async () => {
    addStrand('s1')
    addMessages('s1', 5)
    const bus = new ChatEventBus()
    const events: ChatEvent[] = []
    bus.subscribe(e => events.push(e))

    let released!: () => void
    const gate = new Promise<void>((res) => { released = res })
    const done = settled()

    const started = triggerProjectAssignment({
      db,
      sessionId: 's1',
      trigger: 'message',
      chatEventBus: bus,
      onSettled: done.resolve,
      deps: {
        console: silent,
        loadSettings: () => ({}),
        evaluate: async () => {
          await gate
          putStrandProjectSuggestion(db, {
            strandId: 's1', userId: '1', projectId: 'prj_haus', confidence: 0.6, reason: 'Dachrinne',
          })
          return { outcome: 'suggested', projectId: 'prj_haus', confidence: 0.6, model: 'p1:m', latencyMs: 5 }
        },
      },
    })

    expect(started).toBe(true)
    expect(events).toEqual([])

    released()
    await done.promise
    await new Promise(res => setTimeout(res, 0))

    expect(events.length).toBe(1)
    expect(events[0]!.type).toBe('strand_project_changed')
    expect(events[0]!.sessionId).toBe('s1')
    expect(events[0]!.projectId).toBeNull()
    expect(events[0]!.projectSuggestion).toMatchObject({ projectId: 'prj_haus', confidence: 0.6 })
  })

  it('does not start a second run for a strand that is already being evaluated', async () => {
    addStrand('s1')
    addMessages('s1', 5)
    let calls = 0
    let released!: () => void
    const gate = new Promise<void>((res) => { released = res })
    const done = settled()
    const deps = {
      console: silent,
      loadSettings: () => ({}),
      evaluate: async () => {
        calls += 1
        await gate
        return { outcome: 'none' } as EvaluateStrandProjectResult
      },
    }

    expect(triggerProjectAssignment({ db, sessionId: 's1', trigger: 'message', deps, onSettled: done.resolve })).toBe(true)
    expect(triggerProjectAssignment({ db, sessionId: 's1', trigger: 'session_end', deps })).toBe(false)

    released()
    await done.promise
    expect(calls).toBe(1)
  })

  it('swallows a failing evaluation instead of throwing into the turn', async () => {
    addStrand('s1')
    addMessages('s1', 5)
    const errors: string[] = []
    const started = triggerProjectAssignment({
      db,
      sessionId: 's1',
      trigger: 'message',
      deps: {
        console: { ...silent, error: (msg: string) => errors.push(String(msg)) },
        loadSettings: () => ({}),
        evaluate: async () => {
          throw new Error('provider down')
        },
      },
    })
    expect(started).toBe(true)
    await new Promise(res => setTimeout(res, 10))
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('s1')
  })
})
