/** Task outcomes stay on their lineage strand regardless of active chat state. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, listFeedItems, SessionManager, TaskStore } from '@axiom/core'
import type { Database, Task, TaskTriggerType } from '@axiom/core'
import { ChatEventBus, type ChatEvent } from './chat-event-bus.js'
import { sendTaskDoorbell } from './push/triggers.js'
import type { PushDoorbell, PushSender } from './push/sender.js'
import { routeTaskOutcome, type TaskOutcomeDeps } from './task-outcome.js'

let db: Database
let store: TaskStore
let sessionManager: SessionManager
let bus: ChatEventBus
let events: ChatEvent[]
let injections: Array<{ taskId: string; strandId: string; userId: number }>
let doorbells: Array<{ userId: number; sessionId: string; type: string }>
let telegram: string[]
let tempDataDir: string
let previousDataDir: string | undefined

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-task-outcome-'))
  process.env.DATA_DIR = tempDataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  store = new TaskStore(db)
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  bus = new ChatEventBus()
  events = []
  bus.subscribe(e => events.push(e))
  injections = []
  doorbells = []
  telegram = []
})

afterEach(() => {
  db.close()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
})

function deps(over: Partial<TaskOutcomeDeps> = {}): TaskOutcomeDeps {
  return {
    db,
    chatEventBus: bus,
    logger: { warn: () => {}, error: () => {} },
    telegramDeliveryMode: 'auto',
    hasActiveWebSocket: () => false,
    injectIntoStrand: ({ task, userId, strandId }) => {
      injections.push({ taskId: task.id, strandId, userId })

    },
    sendTelegram: () => async (message: string) => { telegram.push(message); return true },
    ringDoorbell: ({ userId, sessionId, type }) => { doorbells.push({ userId, sessionId, type }) },
    ...over,
  }
}

function interactiveSessions(): string[] {
  return (db.prepare("SELECT id FROM sessions WHERE type = 'interactive'").all() as { id: string }[]).map(r => r.id)
}

function messagesIn(sessionId: string): Array<{ role: string; content: string }> {
  return db.prepare('SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id')
    .all(sessionId) as Array<{ role: string; content: string }>
}

function backgroundSession(type: string, parent: string | null = null): string {
  return sessionManager.createSession({ type: type as 'task', source: 'system', parentSessionId: parent ?? undefined }).id
}

function finishedTask(over: {
  triggerType?: TaskTriggerType
  sessionId?: string
  summary?: string
  resultStatus?: 'completed' | 'failed' | 'question'
} = {}): Task {
  const task = store.create({
    name: 'Morning report',
    prompt: 'report',
    triggerType: over.triggerType ?? 'cronjob',
    sessionId: over.sessionId,
    agentId: 'main',
  })
  return store.update(task.id, {
    status: over.resultStatus === 'question' ? 'paused' : 'completed',
    resultStatus: over.resultStatus ?? 'completed',
    resultSummary: over.summary ?? 'Two new mails, nothing urgent',
    completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
  })!
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('a task without a strand origin', () => {
  it('writes a cron report into the feed and creates NO interactive session', async () => {
    const taskSession = backgroundSession('task')
    const task = finishedTask({ triggerType: 'cronjob', sessionId: taskSession })

    const result = routeTaskOutcome(deps(), {
      task, injection: '<task_injection/>', userId: 1, agentId: 'main', durationMinutes: 3,
    })
    await settle()

    expect(result.target).toBe('feed')
    expect(result.strandId).toBeNull()
    const items = listFeedItems(db, '1')
    expect(items.length).toBe(1)
    expect(items[0]).toMatchObject({
      kind: 'cron_report',
      title: 'Morning report',
      body: 'Two new mails, nothing urgent',
      taskId: task.id,
      strandId: null,
      agentId: 'main',
      readAt: null,
    })

    expect(injections).toEqual([])
    expect(interactiveSessions()).toEqual([])
    expect(doorbells).toEqual([])
    // The result row stays under the task's own (non-strand) session.
    expect(messagesIn(taskSession).map(m => m.role)).toEqual(['system'])
    expect(events.filter(e => e.type === 'feed_item').length).toBe(1)
    expect((events.find(e => e.type === 'feed_item')!.feedItem)!.id).toBe(items[0].id)
    // Telegram still hears about it, now without an LLM turn in between.
    expect(telegram.length).toBe(1)
    expect(telegram[0]).toContain('Morning report')
  })

  it('maps a heartbeat and a consolidation run to their own kinds', async () => {
    routeTaskOutcome(deps(), {
      task: finishedTask({ triggerType: 'heartbeat', sessionId: backgroundSession('heartbeat') }),
      injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1,
    })
    routeTaskOutcome(deps(), {
      task: finishedTask({ triggerType: 'consolidation', sessionId: backgroundSession('consolidation') }),
      injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1,
    })
    await settle()
    expect(listFeedItems(db, '1').map(i => i.kind).sort()).toEqual(['heartbeat', 'system'])
    expect(interactiveSessions()).toEqual([])
  })

  it('keeps a cronjob out of a strand even when its session has an interactive parent', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Mailbox')
    const task = finishedTask({ triggerType: 'cronjob', sessionId: backgroundSession('task', strand.id) })
    const result = routeTaskOutcome(deps(), {
      task, injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1,
    })
    await settle()
    expect(result.target).toBe('feed')
    expect(injections).toEqual([])
    expect(messagesIn(strand.id)).toEqual([])
    expect(listFeedItems(db, '1')[0].strandId).toBeNull()
  })

  it('still writes the feed item when there is no telegram and no bus', async () => {
    const task = finishedTask({ triggerType: 'cronjob', sessionId: backgroundSession('task') })
    const result = routeTaskOutcome(
      deps({ chatEventBus: null, sendTelegram: () => undefined }),
      { task, injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1 },
    )
    await settle()
    expect(result.feedItemId).not.toBeNull()
    expect(listFeedItems(db, '1').length).toBe(1)
    expect(telegram).toEqual([])
  })
})

describe('a task that came out of a strand', () => {
  it('delivers into the strand AND writes a feed item, ringing exactly once', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Deploy')
    const task = finishedTask({
      triggerType: 'user',
      sessionId: backgroundSession('task', strand.id),
      summary: 'Deployed, all gates green',
    })

    const result = routeTaskOutcome(deps(), {
      task, injection: '<task_injection/>', userId: 1, agentId: 'main', durationMinutes: 12,
    })
    await settle()

    expect(result).toMatchObject({ target: 'strand', strandId: strand.id })
    expect(injections).toEqual([{ taskId: task.id, strandId: strand.id, userId: 1 }])

    const rows = messagesIn(strand.id)
    expect(rows.length).toBe(1)
    expect(rows[0].role).toBe('system')
    expect(rows[0].content).toContain('Deployed, all gates green')

    const items = listFeedItems(db, '1')
    expect(items.length).toBe(1)
    expect(items[0]).toMatchObject({ kind: 'task_result', strandId: strand.id, taskId: task.id })

    expect(doorbells).toEqual([{ userId: 1, sessionId: strand.id, type: 'task_completed' }])
    // The injection response is what carries the result to Telegram here, so
    // the direct send must NOT fire a second time.
    expect(telegram).toEqual([])
    expect(events.map(e => e.type).sort()).toEqual(['feed_item', 'task_completed'])
  })

  it.each(['completed', 'failed', 'question'] as const)('ignores a callback override for %s when another strand is active', async (resultStatus) => {
    const strand = sessionManager.createThread('1', 'main', 'Deploy')
    const elsewhere = sessionManager.createThread('1', 'main', 'Another conversation')
    const task = finishedTask({ triggerType: 'user', sessionId: backgroundSession('task', strand.id), resultStatus })

    const result = routeTaskOutcome(
      deps({ injectIntoStrand: ({ task: t, strandId, userId }) => {
        injections.push({ taskId: t.id, strandId, userId })
        return elsewhere.id
      } }),
      { task, injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1 },
    )
    await settle()

    expect(result.strandId).toBe(strand.id)
    expect(injections).toEqual([{ taskId: task.id, strandId: strand.id, userId: 1 }])
    expect(messagesIn(elsewhere.id)).toEqual([])
    expect(messagesIn(strand.id).length).toBe(1)
    expect(listFeedItems(db, '1')[0].strandId).toBe(strand.id)
    expect(doorbells).toEqual([{ userId: 1, sessionId: strand.id, type: resultStatus === 'question' ? 'task_question' : resultStatus === 'failed' ? 'task_failed' : 'task_completed' }])
  })

  it('persists in the origin strand when no agent core can inject', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Deploy')
    const task = finishedTask({ triggerType: 'user', sessionId: backgroundSession('task', strand.id) })
    const result = routeTaskOutcome(
      deps({ injectIntoStrand: () => null }),
      { task, injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1 },
    )
    await settle()
    expect(result.strandId).toBe(strand.id)
    expect(messagesIn(strand.id).length).toBe(1)
    expect(listFeedItems(db, '1')[0].strandId).toBe(strand.id)
  })

  it('writes a task_question for a question, in the strand and in the feed', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Deploy')
    const task = finishedTask({
      triggerType: 'user',
      sessionId: backgroundSession('task', strand.id),
      resultStatus: 'question',
      summary: 'Which region should I deploy to?',
    })
    routeTaskOutcome(deps(), { task, injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1 })
    await settle()

    const items = listFeedItems(db, '1')
    expect(items[0]).toMatchObject({ kind: 'task_question', title: 'Question: Morning report', strandId: strand.id })
    expect(messagesIn(strand.id).length).toBe(1)
    expect(doorbells).toEqual([{ userId: 1, sessionId: strand.id, type: 'task_question' }])
  })

  it('writes a task_question into the feed only when the question has no strand', async () => {
    const task = finishedTask({
      triggerType: 'cronjob',
      sessionId: backgroundSession('task'),
      resultStatus: 'question',
      summary: 'Which region should I deploy to?',
    })
    const result = routeTaskOutcome(deps(), { task, injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1 })
    await settle()
    expect(result.target).toBe('feed')
    expect(listFeedItems(db, '1')[0].kind).toBe('task_question')
    expect(interactiveSessions()).toEqual([])
    expect(doorbells).toEqual([])
  })
})

/**
 * The doorbell, through the REAL trigger (`push/triggers.ts`) instead of a
 * counting stub, so "one event rings at most once" is a statement about the
 * shipped filter (`isPushableSession`) and the shipped call site.
 */
describe('doorbell, exactly once', () => {
  function recordingSender(rung: PushDoorbell[]): PushSender {
    return { sendDetached: (doorbell: PushDoorbell) => { rung.push(doorbell) } } as unknown as PushSender
  }

  function depsWithRealTrigger(rung: PushDoorbell[]): TaskOutcomeDeps {
    return deps({
      ringDoorbell: ({ userId, sessionId, agentId, type }) => {
        sendTaskDoorbell(db, recordingSender(rung), { userId, sessionId, agentId, type })
      },
    })
  }

  it('rings once for a strand result and maps the kinds', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Deploy')
    const rung: PushDoorbell[] = []
    routeTaskOutcome(depsWithRealTrigger(rung), {
      task: finishedTask({ triggerType: 'user', sessionId: backgroundSession('task', strand.id) }),
      injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1,
    })
    await settle()
    expect(rung.length).toBe(1)
    expect(rung[0]).toMatchObject({ userId: 1, kind: 'task_done', strandId: strand.id, agentId: 'main' })
    // No message content travels with the doorbell.
    expect(rung[0].preview ?? null).toBeNull()

    const question = sessionManager.createThread('1', 'main', 'Deploy 2')
    const rung2: PushDoorbell[] = []
    routeTaskOutcome(depsWithRealTrigger(rung2), {
      task: finishedTask({
        triggerType: 'user', sessionId: backgroundSession('task', question.id), resultStatus: 'question',
      }),
      injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1,
    })
    await settle()
    expect(rung2.map(d => d.kind)).toEqual(['question'])
  })

  it('never rings for a feed-only result, not even when a strand is open elsewhere', async () => {
    sessionManager.createThread('1', 'main', 'Open conversation')
    const rung: PushDoorbell[] = []
    for (const trigger of ['cronjob', 'heartbeat', 'consolidation'] as const) {
      routeTaskOutcome(depsWithRealTrigger(rung), {
        task: finishedTask({ triggerType: trigger, sessionId: backgroundSession('task') }),
        injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1,
      })
    }
    await settle()
    expect(rung).toEqual([])
    expect(listFeedItems(db, '1').length).toBe(3)
  })

  it('the trigger itself refuses a non-strand session, so a feed session could never ring', () => {
    const taskSession = backgroundSession('task')
    const rung: PushDoorbell[] = []
    sendTaskDoorbell(db, recordingSender(rung), {
      userId: 1, sessionId: taskSession, agentId: 'main', type: 'task_completed',
    })
    sendTaskDoorbell(db, recordingSender(rung), {
      userId: 1, sessionId: undefined, agentId: 'main', type: 'task_completed',
    })
    expect(rung).toEqual([])
  })
})
