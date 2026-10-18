/** Task outcomes stay on their lineage strand regardless of active chat state. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, listFeedItems, SessionManager, TaskStore, archivePendingTaskNotices } from '@axiom/core'
import type { Database, Task, TaskTriggerType } from '@axiom/core'
import { ChatEventBus, type ChatEvent } from './chat-event-bus.js'
import { sendTaskDoorbell } from './push/triggers.js'
import type { PushDoorbell, PushSender } from './push/sender.js'
import { deliverSubtaskResultToParent, routeTaskOutcome, type TaskOutcomeDeps } from './task-outcome.js'

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

describe('sub-task outcome without a session parent edge', () => {
  it('delivers a child result to its running parent instead of only the feed', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Research')
    const parent = store.create({ name: 'Parent', prompt: 'delegate', triggerType: 'user',
      sessionId: backgroundSession('task', strand.id), agentId: 'main' })
    const child = store.create({ name: 'Child', prompt: 'result', triggerType: 'agent',
      triggerSourceId: parent.id, sessionId: backgroundSession('task'), agentId: 'builder', delegatedBy: 'main' })
    const done = store.update(child.id, { status: 'completed', resultStatus: 'completed', resultSummary: 'Done' })!
    const received: string[] = []
    const result = await routeTaskOutcome(deps({
      deliverToParent: ({ parentTask, injection, agentId }) => {
        received.push(`${parentTask.id}:${injection}:${agentId}`)
        return true
      },
    }), { task: done, injection: '<task_injection>Done</task_injection>', userId: 1,
      agentId: 'main', durationMinutes: 1 })
    await settle()
    expect(result.target).toBe('parent')
    expect(store.getById(child.id)?.agentNotifiedAt).toBeTruthy()
    expect(archivePendingTaskNotices(db)).toEqual({ delivered: 0, quarantined: 0 })
    expect(received).toEqual([`${parent.id}:<task_injection>Done</task_injection>:main`])
    expect(injections).toEqual([])
    expect(telegram).toEqual([])
    expect(doorbells).toEqual([])
    expect(listFeedItems(db, '1')).toHaveLength(0)
    expect(result.feedItemId).toBeNull()
  })

  it('resumes a paused parent once with the caller persona', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Research')
    const parent = store.create({ name: 'Paused parent', prompt: 'wait', triggerType: 'user',
      sessionId: backgroundSession('task', strand.id), agentId: 'builder', delegatedBy: 'main' })
    store.update(parent.id, { status: 'paused' })
    const child = store.create({ name: 'Child', prompt: 'result', triggerType: 'agent',
      triggerSourceId: parent.id, sessionId: backgroundSession('task'), agentId: 'builder' })
    const done = store.update(child.id, { status: 'completed', resultStatus: 'completed' })!
    const delivered: string[] = []
    const result = await routeTaskOutcome(deps({ deliverToParent: async ({ parentTask, agentId }) => {
      delivered.push(`${parentTask.id}:${agentId}`)
      return true
    } }), { task: done, injection: 'x', userId: 1, agentId: 'builder', durationMinutes: 1 })
    expect(result.target).toBe('parent')
    expect(delivered).toEqual([`${parent.id}:main`])
    expect(injections).toEqual([])
    expect(telegram).toEqual([])
  })

  it('recurses to the original strand after parent and grandparent have finished', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Research')
    const grandparent = store.create({ name: 'Root', prompt: 'delegate', triggerType: 'user',
      sessionId: backgroundSession('task', strand.id), agentId: 'main' })
    store.update(grandparent.id, { status: 'completed' })
    const parent = store.create({ name: 'Parent', prompt: 'delegate', triggerType: 'agent',
      triggerSourceId: grandparent.id, sessionId: backgroundSession('task'), agentId: 'builder', delegatedBy: 'main' })
    store.update(parent.id, { status: 'completed' })
    const child = store.create({ name: 'Child', prompt: 'result', triggerType: 'agent',
      triggerSourceId: parent.id, sessionId: backgroundSession('task'), agentId: 'builder' })
    const done = store.update(child.id, { status: 'completed', resultStatus: 'completed' })!
    const agents: string[] = []
    const result = await routeTaskOutcome(deps({ injectIntoStrand: ({ agentId }) => { agents.push(agentId) },
      deliverToParent: () => { throw new Error('finished parent must not be resumed') },
    }), { task: done, injection: 'x', userId: 1, agentId: 'builder', durationMinutes: 1 })
    await settle()
    expect(result).toMatchObject({ target: 'strand', strandId: strand.id })
    expect(agents).toEqual(['main'])
    expect(messagesIn(strand.id)).toHaveLength(1)
    expect(listFeedItems(db, '1')).toHaveLength(1)
    expect(telegram).toEqual([])
  })

  it('answers in the strand as the strand persona when a non-delegated middle task has stopped', async () => {
    // main strand -> root (main) -> P1 (builder, delegated by main) -> P2 (builder, self) -> child.
    // All ancestors finished: the result belongs in Main's strand, answered by Main,
    // not by Bob just because the nearest stopped ancestor runs as Bob.
    const strand = sessionManager.createThread('1', 'main', 'Research')
    const root = store.create({ name: 'Root', prompt: 'delegate', triggerType: 'user',
      sessionId: backgroundSession('task', strand.id), agentId: 'main' })
    store.update(root.id, { status: 'completed' })
    const p1 = store.create({ name: 'P1', prompt: 'delegate', triggerType: 'agent',
      triggerSourceId: root.id, sessionId: backgroundSession('task'), agentId: 'builder', delegatedBy: 'main' })
    store.update(p1.id, { status: 'completed' })
    const p2 = store.create({ name: 'P2', prompt: 'delegate', triggerType: 'agent',
      triggerSourceId: p1.id, sessionId: backgroundSession('task'), agentId: 'builder' })
    store.update(p2.id, { status: 'completed' })
    const child = store.create({ name: 'Child', prompt: 'result', triggerType: 'agent',
      triggerSourceId: p2.id, sessionId: backgroundSession('task'), agentId: 'builder' })
    const done = store.update(child.id, { status: 'completed', resultStatus: 'completed' })!
    const agents: string[] = []
    const rings: string[] = []
    const result = await routeTaskOutcome(deps({
      injectIntoStrand: ({ agentId }) => { agents.push(agentId) },
      ringDoorbell: ({ agentId }) => { rings.push(agentId) },
    }), { task: done, injection: 'x', userId: 1, agentId: 'builder', durationMinutes: 1 })
    await settle()
    expect(result).toMatchObject({ target: 'strand', strandId: strand.id })
    expect(agents).toEqual(['main'])
    expect(rings.every(a => a === 'main')).toBe(true)
    const feed = listFeedItems(db, '1')
    expect(feed).toHaveLength(1)
    expect(feed[0].agentId).toBe('main')
  })

  it('terminates on a cyclic task-parent chain without a strand and lands in the feed once', async () => {
    const a = store.create({ name: 'A', prompt: 'x', triggerType: 'agent', sessionId: backgroundSession('task'), agentId: 'main' })
    const b = store.create({ name: 'B', prompt: 'x', triggerType: 'agent', triggerSourceId: a.id,
      sessionId: backgroundSession('task'), agentId: 'main' })
    db.prepare('UPDATE tasks SET trigger_source_id = ? WHERE id = ?').run(b.id, a.id)
    store.update(a.id, { status: 'completed' })
    const done = store.update(b.id, { status: 'completed', resultStatus: 'completed' })!
    const result = await routeTaskOutcome(deps({ deliverToParent: () => { throw new Error('stopped parent') } }),
      { task: done, injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1 })
    await settle()
    expect(result.target).toBe('feed')
    expect(injections).toEqual([])
    expect(listFeedItems(db, '1')).toHaveLength(1)
  })

  it('treats a deleted parent like a task without lineage (feed, no throw)', async () => {
    const child = store.create({ name: 'Child', prompt: 'result', triggerType: 'agent',
      triggerSourceId: 'gone-parent-id', sessionId: backgroundSession('task'), agentId: 'main' })
    const done = store.update(child.id, { status: 'completed', resultStatus: 'completed' })!
    const result = await routeTaskOutcome(deps({ deliverToParent: () => { throw new Error('no parent') } }),
      { task: done, injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1 })
    await settle()
    expect(result.target).toBe('feed')
    expect(injections).toEqual([])
    expect(listFeedItems(db, '1')).toHaveLength(1)
  })

  it('falls back exactly once to the strand if a finishing parent cannot be steered', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Research')
    const parent = store.create({ name: 'Parent', prompt: 'delegate', triggerType: 'user',
      sessionId: backgroundSession('task', strand.id), agentId: 'main' })
    const child = store.create({ name: 'Child', prompt: 'result', triggerType: 'agent',
      triggerSourceId: parent.id, sessionId: backgroundSession('task'), agentId: 'builder', delegatedBy: 'main' })
    const done = store.update(child.id, { status: 'completed', resultStatus: 'completed' })!
    const result = await routeTaskOutcome(deps({ deliverToParent: () => false }),
      { task: done, injection: 'x', userId: 1, agentId: 'builder', durationMinutes: 1 })
    await settle()
    expect(result.target).toBe('strand')
    expect(injections).toHaveLength(1)
    expect(messagesIn(strand.id)).toHaveLength(1)
    expect(listFeedItems(db, '1')).toHaveLength(1)
    expect(telegram).toEqual([])
  })
})

describe('atomic task-outcome delivery receipt (B3)', () => {
  it('commits the live cron outcome with its notice marker so boot creates no duplicate', async () => {
    const strand = sessionManager.createThread('1', 'main')
    const task = store.create({ name: 'Cron fixture', prompt: 'synthetic', triggerType: 'cronjob', sessionId: backgroundSession('task', strand.id) })
    const done = store.update(task.id, { status: 'completed', resultSummary: 'OWN_SENTINEL', resultStatus: 'completed' })!
    const result = await routeTaskOutcome(deps(), { task: done, injection: 'synthetic', userId: 1, agentId: 'main', durationMinutes: 1 })
    expect(result.feedItemId).toBeTruthy()
    expect(store.getById(task.id)?.agentNotifiedAt).toBeTruthy()
    expect(archivePendingTaskNotices(db)).toEqual({ delivered: 0, quarantined: 0 })
    expect(listFeedItems(db, '1').filter(item => item.taskId === task.id)).toHaveLength(1)
  })
  it('rolls the card back if its delivery mark cannot commit', async () => {
    const task = store.create({ name: 'Fixture', prompt: 'synthetic', triggerType: 'user' })
    const done = store.update(task.id, { status: 'completed', resultSummary: 'PRESERVED_SENTINEL', resultStatus: 'completed' })!
    db.exec("CREATE TRIGGER fixture_mark_failure BEFORE UPDATE OF agent_notified_at ON tasks BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
    const result = await routeTaskOutcome(deps(), { task: done, injection: 'synthetic', userId: 1, agentId: 'main', durationMinutes: 1 })
    expect(result.feedItemId).toBeNull()
    expect(listFeedItems(db, '1')).toEqual([])
    expect(events.filter(e => e.type === 'feed_item')).toEqual([])
    expect(store.getById(task.id)?.agentNotifiedAt).toBeNull()
    expect(store.getById(task.id)?.resultSummary).toBe('PRESERVED_SENTINEL')
  })
})

describe('a task without a strand origin', () => {
  it('writes a cron report into the feed and creates NO interactive session', async () => {
    const taskSession = backgroundSession('task')
    const task = finishedTask({ triggerType: 'cronjob', sessionId: taskSession })

    const result = await routeTaskOutcome(deps(), {
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
    await routeTaskOutcome(deps(), {
      task: finishedTask({ triggerType: 'heartbeat', sessionId: backgroundSession('heartbeat') }),
      injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1,
    })
    await routeTaskOutcome(deps(), {
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
    const result = await routeTaskOutcome(deps(), {
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
    const result = await routeTaskOutcome(
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

    const result = await routeTaskOutcome(deps(), {
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

    const result = await routeTaskOutcome(
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
    const result = await routeTaskOutcome(
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
    await routeTaskOutcome(deps(), { task, injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1 })
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
    const result = await routeTaskOutcome(deps(), { task, injection: 'x', userId: 1, agentId: 'main', durationMinutes: 1 })
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
    await routeTaskOutcome(depsWithRealTrigger(rung), {
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
    await routeTaskOutcome(depsWithRealTrigger(rung2), {
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
      await routeTaskOutcome(depsWithRealTrigger(rung), {
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

describe('deliverSubtaskResultToParent', () => {
  function runtime(state: { paused?: boolean; runningAfterResume?: boolean; steered?: boolean }) {
    const calls: string[] = []
    let running = false
    return {
      calls,
      rt: {
        isPaused: () => state.paused ?? false,
        isRunning: () => running,
        resume: async (id: string, text: string) => {
          calls.push(`resume:${id}:${text.includes('<subtask_result task_id="c1">')}`)
          running = state.runningAfterResume ?? true
          return true
        },
        steer: (id: string) => {
          calls.push(`steer:${id}`)
          return state.steered
            ? { delivered: true, mode: 'steered' as const }
            : { delivered: false, mode: 'none' as const, reason: 'between runs' }
        },
      },
    }
  }

  it('resumes a paused parent and counts it as delivered while it runs', async () => {
    const { rt, calls } = runtime({ paused: true })
    expect(await deliverSubtaskResultToParent(rt, { id: 'p', status: 'paused' }, 'c1', 'x')).toBe(true)
    expect(calls).toEqual(['resume:p:true'])
  })

  it('reports NOT delivered when the resumed parent was aborted at once (deadline passed while paused)', async () => {
    const { rt } = runtime({ paused: true, runningAfterResume: false })
    expect(await deliverSubtaskResultToParent(rt, { id: 'p', status: 'paused' }, 'c1', 'x')).toBe(false)
  })

  it('does not resume a row that is paused in the DB but has no paused agent (after a restart)', async () => {
    const { rt, calls } = runtime({ paused: false })
    expect(await deliverSubtaskResultToParent(rt, { id: 'p', status: 'paused' }, 'c1', 'x')).toBe(false)
    expect(calls).toEqual([])
  })

  it('steers a running parent and passes the steer verdict through', async () => {
    const yes = runtime({ steered: true })
    expect(await deliverSubtaskResultToParent(yes.rt, { id: 'p', status: 'running' }, 'c1', 'x')).toBe(true)
    const no = runtime({ steered: false })
    expect(await deliverSubtaskResultToParent(no.rt, { id: 'p', status: 'running' }, 'c1', 'x')).toBe(false)
  })
})


it('delivers an existing worker through the new strand persona without rewriting execution identity', async () => {
  const strand = sessionManager.createThread('1', 'main', 'Auto orchestration', null, 'auto')
  const worker = store.create({ name: 'Worker', prompt: 'result', triggerType: 'user', sessionId: backgroundSession('task', strand.id), agentId: 'builder', delegatedBy: 'main' })
  sessionManager.updateThread('1', strand.id, { agentId: 'coder' })
  const done = store.update(worker.id, { status: 'completed', resultStatus: 'completed' })!
  const deliveries: string[] = []
  await routeTaskOutcome(deps({ injectIntoStrand: ({ agentId, strandId }) => { deliveries.push(`${strandId}:${agentId}`) } }), { task: done, injection: 'worker report', userId: 1, agentId: 'builder', durationMinutes: 1 })
  expect(deliveries).toEqual([`${strand.id}:coder`])
  expect(store.getById(worker.id)).toMatchObject({ agentId: 'builder', delegatedBy: 'main' })
})
