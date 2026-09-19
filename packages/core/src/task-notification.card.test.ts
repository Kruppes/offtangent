/**
 * Repro + regression for "a finished task lands as an unabridged wall of text
 * in the strand" (SPEC 7.4c neighbourhood, task card).
 *
 * Before the fix, `persistTaskResultMessage` wrote the full `resultSummary`
 * into `chat_messages.content` with no cap whatsoever, and
 * `formatTaskTelegramMessage` sent the same wall to Telegram. These tests
 * pin the cap AND the fact that nothing is lost: the full report stays in
 * `tasks.result_summary` and the row carries the structured metadata the card
 * renders from.
 */
import { describe, it, expect } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { Task } from './task-store.js'
import {
  deliverTaskNotification,
  formatTaskTelegramMessage,
  persistTaskResultMessage,
} from './task-notification.js'
import type { TaskNotificationEvent } from './task-notification.js'
import { TASK_RESULT_PREVIEW_MAX_CHARS } from './contracts/task-result-card.js'

function createTestDb(): Database {
  const db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('testuser', 'hash', 'admin')").run()
  return db
}

/** A realistic long report: many lines, ~6 kB — what a real task produces. */
function longSummary(): string {
  const lines: string[] = ['Built the interaction block renderer and the task card.']
  for (let i = 1; i <= 60; i += 1) {
    lines.push(`Step ${i}: touched packages/core/src/file-${i}.ts and verified the behaviour end to end.`)
  }
  lines.push('FINAL_MARKER_AT_THE_VERY_END')
  return lines.join('\n')
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-wall-1',
    name: 'Long Report Task',
    prompt: 'Do a lot and report it',
    status: 'completed',
    triggerType: 'user',
    triggerSourceId: null,
    provider: 'openai',
    model: 'gpt-4o',
    isDefaultModel: null,
    maxDurationMinutes: 60,
    promptTokens: 5000,
    completionTokens: 3000,
    cacheRead: 0,
    cacheWrite: 0,
    estimatedCost: 0.05,
    toolCallCount: 10,
    resultSummary: longSummary(),
    resultStatus: 'completed',
    errorMessage: null,
    createdAt: '2026-09-15 10:00:00',
    startedAt: '2026-09-15 10:00:01',
    completedAt: '2026-09-15 10:15:00',
    sessionId: 'task-task-wall-1',
    agentId: null,
    outputSchema: null,
    contextMode: null,
    handoff: null,
    agentNotifiedAt: null,
    ...overrides,
  }
}

function persistedRow(db: Database): { content: string; metadata: string } {
  return db.prepare('SELECT content, metadata FROM chat_messages WHERE user_id = 1').get() as {
    content: string
    metadata: string
  }
}

describe('task result card: the strand gets a card, not the wall', () => {
  it('caps the visible part of a long result summary', () => {
    const db = createTestDb()
    const task = makeTask()
    expect(task.resultSummary!.length).toBeGreaterThan(4000)

    persistTaskResultMessage(db, 1, task, 15)
    const row = persistedRow(db)

    // The repro: this was ~6000 characters before the fix.
    expect(row.content.length).toBeLessThan(TASK_RESULT_PREVIEW_MAX_CHARS + 260)
    expect(row.content).not.toContain('FINAL_MARKER_AT_THE_VERY_END')
    expect(row.content).not.toContain('Step 40:')
  })

  it('keeps the headline, the opening of the report and a pointer to the rest', () => {
    const db = createTestDb()
    persistTaskResultMessage(db, 1, makeTask(), 15)
    const row = persistedRow(db)

    expect(row.content).toContain('✅')
    expect(row.content).toContain('Long Report Task')
    expect(row.content).toContain('Built the interaction block renderer')
    expect(row.content).toContain('more characters')
    expect(row.content).toContain('task-wall-1')
  })

  it('marks the truncation in metadata so the card can offer "show all"', () => {
    const db = createTestDb()
    const task = makeTask()
    persistTaskResultMessage(db, 1, task, 15)
    const metadata = JSON.parse(persistedRow(db).metadata) as Record<string, unknown>

    expect(metadata.type).toBe('task_result')
    expect(metadata.taskId).toBe('task-wall-1')
    expect(metadata.resultTruncated).toBe(true)
    expect(metadata.resultFullLength).toBe(task.resultSummary!.length)
    expect(typeof metadata.resultPreview).toBe('string')
    expect((metadata.resultPreview as string).length).toBeLessThanOrEqual(TASK_RESULT_PREVIEW_MAX_CHARS + 1)
    expect(metadata.resultBodyKind).toBe('summary')
  })

  it('leaves a short summary untouched and does not claim truncation', () => {
    const db = createTestDb()
    const task = makeTask({ resultSummary: 'All good. Two files changed.' })
    persistTaskResultMessage(db, 1, task, 2)
    const row = persistedRow(db)
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>

    expect(row.content).toContain('All good. Two files changed.')
    expect(row.content).not.toContain('more characters')
    expect(metadata.resultTruncated).toBe(false)
  })

  it('keeps a failed task visible with its failure reason', () => {
    const db = createTestDb()
    const task = makeTask({
      status: 'failed',
      resultStatus: 'failed',
      resultSummary: null,
      errorMessage: 'npm ci failed: EACCES on /tmp/config',
    })
    persistTaskResultMessage(db, 1, task, 1)
    const row = persistedRow(db)
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>

    expect(row.content).toContain('❌')
    expect(row.content).toContain('npm ci failed: EACCES on /tmp/config')
    expect(metadata.resultBodyKind).toBe('error')
    expect(metadata.taskResultStatus).toBe('failed')
  })

  it('truncates the Telegram notification too and says where the rest is', () => {
    const task = makeTask()
    const message = formatTaskTelegramMessage(task, 15)

    expect(message).not.toContain('FINAL_MARKER_AT_THE_VERY_END')
    expect(message.length).toBeLessThan(TASK_RESULT_PREVIEW_MAX_CHARS + 320)
    expect(message).toContain('Long Report Task')
    expect(message).toContain('more characters')
    expect(message).toContain('15min')
  })

  it('does not touch the stored full report — it stays retrievable', () => {
    // The card is a view. `tasks.result_summary` is the record, and
    // GET /api/tasks/:id serves it unchanged.
    const db = createTestDb()
    const task = makeTask()
    db.prepare(
      `INSERT INTO tasks (id, name, prompt, status, trigger_type, max_duration_minutes, result_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(task.id, task.name, task.prompt, 'completed', 'user', 60, task.resultSummary)

    persistTaskResultMessage(db, 1, task, 15)

    const stored = db.prepare('SELECT result_summary FROM tasks WHERE id = ?').get(task.id) as {
      result_summary: string
    }
    expect(stored.result_summary).toBe(task.resultSummary)
    expect(stored.result_summary).toContain('FINAL_MARKER_AT_THE_VERY_END')
  })
})

describe('all three delivery paths of a task result are capped', () => {
  // task-notification.ts has exactly three ways out: the Telegram HTML
  // payload, the persisted chat_messages row, and the broadcast event that
  // live web clients render. A cap on only one of them would still leave the
  // wall of text somewhere.
  it('caps Telegram, the persisted row and the broadcast event in one delivery', async () => {
    const db = createTestDb()
    const task = makeTask()
    const events: TaskNotificationEvent[] = []
    let telegramPayload = ''

    const result = await deliverTaskNotification({
      db,
      userId: 1,
      task,
      durationMinutes: 15,
      telegramDeliveryMode: 'always',
      hasActiveWebSocket: () => false,
      sendTelegram: async (message) => { telegramPayload = message; return true },
      broadcastEvent: event => { events.push(event) },
    })

    expect(result).toEqual({ persisted: true, telegramSent: true, broadcastSent: true })

    // 1. persisted row
    const row = persistedRow(db)
    expect(row.content.length).toBeLessThan(TASK_RESULT_PREVIEW_MAX_CHARS + 260)
    expect(row.content).not.toContain('FINAL_MARKER_AT_THE_VERY_END')

    // 2. Telegram HTML
    expect(telegramPayload).not.toContain('FINAL_MARKER_AT_THE_VERY_END')
    expect(telegramPayload.length).toBeLessThan(TASK_RESULT_PREVIEW_MAX_CHARS + 320)

    // 3. broadcast event (what a connected web client renders live)
    expect(events).toHaveLength(1)
    expect(events[0]!.taskSummary).not.toContain('FINAL_MARKER_AT_THE_VERY_END')
    expect(events[0]!.taskSummary.length).toBeLessThanOrEqual(TASK_RESULT_PREVIEW_MAX_CHARS + 1)
    expect(events[0]!.taskSummaryTruncated).toBe(true)
    expect(events[0]!.taskSummaryFullLength).toBe(task.resultSummary!.length)
    // The live card and the reloaded card show the same preview.
    expect(row.content).toContain(events[0]!.taskSummary.slice(0, 40))
  })

  it('does not claim truncation on the broadcast event of a short report', async () => {
    const db = createTestDb()
    const events: TaskNotificationEvent[] = []
    await deliverTaskNotification({
      db,
      userId: 1,
      task: makeTask({ resultSummary: 'Two files changed, tests green.' }),
      durationMinutes: 1,
      telegramDeliveryMode: 'auto',
      hasActiveWebSocket: () => true,
      broadcastEvent: event => { events.push(event) },
    })
    expect(events[0]!.taskSummary).toBe('Two files changed, tests green.')
    expect(events[0]!.taskSummaryTruncated).toBe(false)
  })
})
