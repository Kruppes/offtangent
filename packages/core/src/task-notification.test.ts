import { describe, it, expect, vi } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { Task } from './task-store.js'
import {
  formatTaskTelegramMessage,
  persistTaskResultMessage,
  deliverTaskNotification,
} from './task-notification.js'
import type { TaskNotificationEvent } from './task-notification.js'

function createTestDb(): Database {
  const db = initDatabase(':memory:')
  // Create a test user so foreign key constraints pass
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('testuser', 'hash', 'admin')").run()
  return db
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-123',
    name: 'Build React App',
    prompt: 'Build a React app with dark mode',
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
    resultSummary: 'Successfully built a React app with dark mode toggle.',
    resultStatus: 'completed',
    errorMessage: null,
    createdAt: '2026-03-29 10:00:00',
    startedAt: '2026-03-29 10:00:01',
    completedAt: '2026-03-29 10:15:00',
    sessionId: 'task-task-123',
    agentId: null,
    outputSchema: null,
    contextMode: null,
    handoff: null,
    agentNotifiedAt: null,
    ...overrides,
  }
}

describe('formatTaskTelegramMessage', () => {
  it('formats completed task with emoji, name, summary, duration, tokens', () => {
    const task = makeTask()
    const msg = formatTaskTelegramMessage(task, 15)

    expect(msg).toContain('✅')
    expect(msg).toContain('Build React App')
    expect(msg).toContain('Successfully built a React app')
    expect(msg).toContain('15min')
    expect(msg).toContain('8.0k tokens')
  })

  it('formats failed task with ❌ emoji', () => {
    const task = makeTask({
      status: 'failed',
      resultStatus: 'failed',
      resultSummary: 'Could not install dependencies',
    })
    const msg = formatTaskTelegramMessage(task, 5)

    expect(msg).toContain('❌')
    expect(msg).toContain('Could not install dependencies')
  })

  it('formats question task with ❓ emoji', () => {
    const task = makeTask({
      status: 'paused',
      resultStatus: 'question',
      resultSummary: 'Which CSS framework should I use?',
    })
    const msg = formatTaskTelegramMessage(task, 3)

    expect(msg).toContain('❓')
    expect(msg).toContain('Which CSS framework should I use?')
  })

  it('uses errorMessage when resultSummary is null', () => {
    const task = makeTask({
      status: 'failed',
      resultStatus: 'failed',
      resultSummary: null,
      errorMessage: 'Out of memory',
    })
    const msg = formatTaskTelegramMessage(task, 2)

    expect(msg).toContain('Out of memory')
  })

  it('escapes HTML in task name and summary', () => {
    const task = makeTask({
      name: 'Build <App> & Test',
      resultSummary: 'Created <div> & <span> components',
    })
    const msg = formatTaskTelegramMessage(task, 5)

    expect(msg).toContain('Build &lt;App&gt; &amp; Test')
    expect(msg).toContain('Created &lt;div&gt; &amp; &lt;span&gt; components')
  })
})

describe('persistTaskResultMessage', () => {
  it('writes task result to chat_messages with system role and metadata', () => {
    const db = createTestDb()
    const task = makeTask()

    persistTaskResultMessage(db, 1, task, 15)

    const rows = db.prepare('SELECT * FROM chat_messages WHERE user_id = 1').all() as {
      role: string
      content: string
      metadata: string
      session_id: string
    }[]

    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('system')
    expect(rows[0].content).toContain('✅')
    expect(rows[0].content).toContain('Build React App')
    // With no sessions row for the task, the persist path falls back to
    // the task's own sessionId (interactive parent would be preferred
    // when present — see resolveTaskNotificationSessionId tests).
    expect(rows[0].session_id).toBe(task.sessionId)

    const metadata = JSON.parse(rows[0].metadata)
    expect(metadata.type).toBe('task_result')
    expect(metadata.taskId).toBe('task-123')
    expect(metadata.taskName).toBe('Build React App')
    expect(metadata.durationMinutes).toBe(15)
    expect(metadata.promptTokens).toBe(5000)
    expect(metadata.completionTokens).toBe(3000)
  })

  it('labels the task result row with the task agent_id (multi-persona bleeding regression)', () => {
    const db = createTestDb()
    const task = makeTask({ agentId: 'bob' })

    persistTaskResultMessage(db, 1, task, 15)

    const row = db.prepare('SELECT agent_id FROM chat_messages WHERE user_id = 1').get() as { agent_id: string }
    expect(row.agent_id).toBe('bob')
  })

  it("defaults the task result row agent_id to 'main' when the task has none", () => {
    const db = createTestDb()
    const task = makeTask({ agentId: null })

    persistTaskResultMessage(db, 1, task, 15)

    const row = db.prepare('SELECT agent_id FROM chat_messages WHERE user_id = 1').get() as { agent_id: string }
    expect(row.agent_id).toBe('main')
  })
})

describe('resolveTaskNotificationSessionId', () => {
  it('returns the parent interactive session id when the task session has a parent', async () => {
    const { resolveTaskNotificationSessionId } = await import('./task-notification.js')
    const db = createTestDb()
    db.prepare(
      "INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, message_count, summary_written) VALUES ('interactive-1', 1, 'web', 'interactive', NULL, datetime('now'), 0, 0)"
    ).run()
    db.prepare(
      "INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, message_count, summary_written) VALUES ('task-sess-1', 1, 'task', 'task', 'interactive-1', datetime('now'), 0, 0)"
    ).run()
    const task = makeTask({ sessionId: 'task-sess-1' })
    expect(resolveTaskNotificationSessionId(db, task)).toBe('interactive-1')
  })

  it('falls back to the task session id when there is no parent', async () => {
    const { resolveTaskNotificationSessionId } = await import('./task-notification.js')
    const db = createTestDb()
    db.prepare(
      "INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, message_count, summary_written) VALUES ('task-sess-2', 1, 'task', 'task', NULL, datetime('now'), 0, 0)"
    ).run()
    const task = makeTask({ sessionId: 'task-sess-2' })
    expect(resolveTaskNotificationSessionId(db, task)).toBe('task-sess-2')
  })

  it('returns null for legacy tasks without sessionId instead of throwing', async () => {
    // Regression guard: a previous implementation threw here, which corrupted
    // task state because the throw propagated through TaskRunner's
    // onTaskComplete → catch path and re-marked completed tasks as failed.
    const { resolveTaskNotificationSessionId } = await import('./task-notification.js')
    const db = createTestDb()
    const task = makeTask({ sessionId: null })
    expect(resolveTaskNotificationSessionId(db, task)).toBeNull()
  })

  it('persistTaskResultMessage skips (does not throw) when no session resolvable', async () => {
    // Same regression guard from the persistence side: without a session
    // to attach the row to we log and return; previously this threw and
    // bubbled up through deliverTaskNotification.
    const db = createTestDb()
    const task = makeTask({ sessionId: null })
    // Should not throw.
    persistTaskResultMessage(db, 1, task, 15)
    const rows = db.prepare('SELECT * FROM chat_messages WHERE user_id = 1').all()
    expect(rows).toHaveLength(0)
  })
})

describe('deliverTaskNotification', () => {
  it('always persists to chat_messages', async () => {
    const db = createTestDb()
    const task = makeTask()

    const result = await deliverTaskNotification({
      db,
      userId: 1,
      task,
      durationMinutes: 15,
      telegramDeliveryMode: 'auto',
      hasActiveWebSocket: () => false,
    })

    expect(result.persisted).toBe(true)

    const rows = db.prepare('SELECT * FROM chat_messages WHERE user_id = 1').all()
    expect(rows).toHaveLength(1)
  })

  it('broadcasts task event when broadcastEvent is provided', async () => {
    const db = createTestDb()
    const task = makeTask()
    const broadcastEvent = vi.fn()

    const result = await deliverTaskNotification({
      db,
      userId: 1,
      task,
      durationMinutes: 15,
      telegramDeliveryMode: 'auto',
      hasActiveWebSocket: () => false,
      broadcastEvent,
    })

    expect(result.broadcastSent).toBe(true)
    expect(broadcastEvent).toHaveBeenCalledOnce()

    const event = broadcastEvent.mock.calls[0][0] as TaskNotificationEvent
    expect(event.type).toBe('task_completed')
    expect(event.taskId).toBe('task-123')
    expect(event.taskName).toBe('Build React App')
    expect(event.taskTokensUsed).toBe(8000)
  })

  it('broadcasts task_failed for failed tasks', async () => {
    const db = createTestDb()
    const task = makeTask({ status: 'failed', resultStatus: 'failed' })
    const broadcastEvent = vi.fn()

    await deliverTaskNotification({
      db,
      userId: 1,
      task,
      durationMinutes: 5,
      telegramDeliveryMode: 'auto',
      hasActiveWebSocket: () => false,
      broadcastEvent,
    })

    expect(broadcastEvent.mock.calls[0][0].type).toBe('task_failed')
  })

  it('broadcasts task_question for paused tasks with question', async () => {
    const db = createTestDb()
    const task = makeTask({ status: 'paused', resultStatus: 'question' })
    const broadcastEvent = vi.fn()

    await deliverTaskNotification({
      db,
      userId: 1,
      task,
      durationMinutes: 3,
      telegramDeliveryMode: 'auto',
      hasActiveWebSocket: () => false,
      broadcastEvent,
    })

    expect(broadcastEvent.mock.calls[0][0].type).toBe('task_question')
  })

  it('sends Telegram when mode=auto and no active WebSocket', async () => {
    const db = createTestDb()
    const task = makeTask()
    const sendTelegram = vi.fn().mockResolvedValue(true)

    const result = await deliverTaskNotification({
      db,
      userId: 1,
      task,
      durationMinutes: 15,
      telegramDeliveryMode: 'auto',
      hasActiveWebSocket: () => false,
      sendTelegram,
    })

    expect(result.telegramSent).toBe(true)
    expect(sendTelegram).toHaveBeenCalledOnce()
    const msg = sendTelegram.mock.calls[0][0] as string
    expect(msg).toContain('✅')
    expect(msg).toContain('Build React App')
  })

  it('suppresses Telegram when mode=auto and user has active WebSocket', async () => {
    const db = createTestDb()
    const task = makeTask()
    const sendTelegram = vi.fn().mockResolvedValue(true)

    const result = await deliverTaskNotification({
      db,
      userId: 1,
      task,
      durationMinutes: 15,
      telegramDeliveryMode: 'auto',
      hasActiveWebSocket: () => true,
      sendTelegram,
    })

    expect(result.telegramSent).toBe(false)
    expect(sendTelegram).not.toHaveBeenCalled()
  })

  it('always sends Telegram when mode=always, even with active WebSocket', async () => {
    const db = createTestDb()
    const task = makeTask()
    const sendTelegram = vi.fn().mockResolvedValue(true)

    const result = await deliverTaskNotification({
      db,
      userId: 1,
      task,
      durationMinutes: 15,
      telegramDeliveryMode: 'always',
      hasActiveWebSocket: () => true,
      sendTelegram,
    })

    expect(result.telegramSent).toBe(true)
    expect(sendTelegram).toHaveBeenCalledOnce()
  })

  it('works when user has no active connections (stores in DB, sends Telegram)', async () => {
    const db = createTestDb()
    const task = makeTask()
    const sendTelegram = vi.fn().mockResolvedValue(true)

    const result = await deliverTaskNotification({
      db,
      userId: 1,
      task,
      durationMinutes: 15,
      telegramDeliveryMode: 'auto',
      hasActiveWebSocket: () => false,
      sendTelegram,
    })

    expect(result.persisted).toBe(true)
    expect(result.telegramSent).toBe(true)

    const rows = db.prepare('SELECT * FROM chat_messages WHERE user_id = 1').all()
    expect(rows).toHaveLength(1)
  })

  it('handles Telegram send failure gracefully', async () => {
    const db = createTestDb()
    const task = makeTask()
    const sendTelegram = vi.fn().mockRejectedValue(new Error('Network error'))

    const result = await deliverTaskNotification({
      db,
      userId: 1,
      task,
      durationMinutes: 15,
      telegramDeliveryMode: 'auto',
      hasActiveWebSocket: () => false,
      sendTelegram,
    })

    expect(result.persisted).toBe(true)
    expect(result.telegramSent).toBe(false)
  })
})
