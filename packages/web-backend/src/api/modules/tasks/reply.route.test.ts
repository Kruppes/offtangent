/**
 * `POST /api/tasks/:id/reply` (API contract 2026-09-18, A) end to end: the
 * three outcomes (resumed 200 / running 409 / follow-up 201) and the three
 * refusals (400 empty text, 403 foreign task, 404 unknown task).
 *
 * The route is wired to the REAL shared reply function (`createTaskReply`),
 * only the task runtime underneath is faked — that is the whole point of the
 * refactor: Telegram and HTTP run the same decision tree.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Database, ProviderConfig, Task, TaskRuntimeTaskBoundary } from '@axiom/core'
import { TaskStore, initDatabase, initTasksTable } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'
import { createTaskReply } from '../../../task-reply.js'

let db: Database
let server: http.Server
let baseUrl: string
let ownerToken: string
let strangerToken: string
let tempDataDir: string
let previousDataDir: string | undefined

/** What the fake runtime was asked to do during one test. */
let resumeCalls: Array<{ taskId: string; message: string }> = []
let startCalls: Array<{ taskId: string; providerName: string; parentSessionId: string | null }> = []
let resumeResult = true
let parentSessionLookups: Array<{ userId: string; source: string; agentId: string }> = []

const PROVIDER: ProviderConfig = {
  id: 'prov-1',
  name: 'TestProvider',
  type: 'openai-completions',
  providerType: 'openai',
  provider: 'openai',
  baseUrl: 'https://example.invalid',
  apiKey: '',
  enabledModels: ['model-a', 'model-b'],
}

const DEFAULT_PROVIDER: ProviderConfig = { ...PROVIDER, id: 'prov-default', name: 'DefaultProvider', enabledModels: ['fallback-model'] }

function store(): TaskStore {
  return new TaskStore(db)
}

/** A task runtime that reads the real rows but never starts a process. */
function fakeTaskRuntime(): TaskRuntimeTaskBoundary {
  const boundary = {
    create: (input: Parameters<TaskRuntimeTaskBoundary['create']>[0]) => store().create(input),
    getById: (id: string) => store().getById(id),
    list: () => store().list({}),
    update: (id: string, updates: Parameters<TaskRuntimeTaskBoundary['update']>[1]) => store().update(id, updates),
    start: async (task: Task, provider: ProviderConfig, _overrides?: unknown, parentSessionId?: string | null) => {
      startCalls.push({ taskId: task.id, providerName: provider.name, parentSessionId: parentSessionId ?? null })
      return task.id
    },
    resume: async (taskId: string, message: string) => {
      resumeCalls.push({ taskId, message })
      return resumeResult
    },
    abort: () => {},
    isRunning: () => false,
    getRunningIds: () => [],
    isPaused: () => false,
    getPausedIds: () => [],
    cleanupStalePaused: () => 0,
    recover: async () => ({ resumed: 0, failed: 0 }),
  } as unknown as TaskRuntimeTaskBoundary
  return boundary
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-task-reply-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  initTasksTable(db)
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'owner', 'x', 'user')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'stranger', 'x', 'user')

  const runtime = fakeTaskRuntime()
  const replyToTask = createTaskReply({
    tasks: runtime,
    resolveProvider: (nameOrId: string) => (nameOrId === PROVIDER.name || nameOrId === PROVIDER.id ? PROVIDER : null),
    getDefaultProvider: () => DEFAULT_PROVIDER,
    getMaxDurationMinutes: () => 42,
    getParentSessionId: (userId, source, agentId) => {
      parentSessionLookups.push({ userId, source, agentId })
      return `session-of-${userId}-${source}`
    },
  })

  server = http.createServer(createApp({
    db,
    replyToTask,
    getTaskRuntime: () => ({ tasks: runtime }) as never,
  }))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  ownerToken = generateAccessToken({ userId: 1, username: 'owner', role: 'user' })
  strangerToken = generateAccessToken({ userId: 2, username: 'stranger', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM sessions').run()
  resumeCalls = []
  startCalls = []
  parentSessionLookups = []
  resumeResult = true
})

/**
 * A task owned by user 1: its session has no parent and carries the user id,
 * which is exactly what `resolveTaskOwnerUserIdForTask` walks.
 */
function createOwnedTask(input?: { status?: Task['status']; provider?: string; model?: string; agentId?: string; userId?: number }): Task {
  const userId = input?.userId ?? 1
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, agent_id) VALUES (?, ?, ?, 'task', 'task', ?)`,
  ).run(sessionId, userId, String(userId), input?.agentId ?? 'main')

  const task = store().create({
    name: 'Nightly report',
    prompt: 'Write the report',
    triggerType: 'user',
    sessionId,
    provider: input?.provider,
    model: input?.model,
    agentId: input?.agentId ?? 'main',
  })
  if (input?.status && input.status !== 'running') {
    store().update(task.id, {
      status: input.status,
      ...(input.status === 'completed'
        ? { resultStatus: 'completed' as const, resultSummary: 'The report is done.' }
        : {}),
    })
  }
  return store().getById(task.id)!
}

async function reply(taskId: string, body: unknown, token = ownerToken) {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/reply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : null }
}

describe('POST /api/tasks/:id/reply', () => {
  it('resumes a paused task and answers 200', async () => {
    const task = createOwnedTask({ status: 'paused' })

    const res = await reply(task.id, { text: '  yes, go ahead  ' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ outcome: 'resumed', taskId: task.id })
    expect(typeof res.body?.message).toBe('string')
    expect(res.body?.followUpTaskId).toBeUndefined()
    // The text reaches the runtime trimmed, never with the surrounding spaces.
    expect(resumeCalls).toEqual([{ taskId: task.id, message: 'yes, go ahead' }])
  })

  it('answers 409 while the task is still running and changes nothing', async () => {
    const task = createOwnedTask({ status: 'running' })

    const res = await reply(task.id, { text: 'any news?' })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ outcome: 'running', taskId: task.id })
    expect(resumeCalls).toEqual([])
    expect(startCalls).toEqual([])
  })

  it('answers 409 when the runtime refuses to resume a paused task', async () => {
    const task = createOwnedTask({ status: 'paused' })
    resumeResult = false

    const res = await reply(task.id, { text: 'here is the answer' })

    expect(res.status).toBe(409)
    expect(res.body?.error).toBe('Task could not be resumed')
  })

  it('starts a follow-up on the same provider, model and persona and answers 201', async () => {
    const task = createOwnedTask({ status: 'completed', provider: 'TestProvider', model: 'model-b', agentId: 'bob' })

    const res = await reply(task.id, { text: 'now also check the numbers' })

    expect(res.status).toBe(201)
    expect(res.body?.outcome).toBe('follow_up')
    expect(res.body?.taskId).toBe(task.id)
    const followUpId = res.body?.followUpTaskId as string
    expect(typeof followUpId).toBe('string')

    const followUp = store().getById(followUpId)!
    expect(followUp.provider).toBe('TestProvider')
    // The pinned model of the original wins over the provider's first model.
    expect(followUp.model).toBe('model-b')
    expect(followUp.agentId).toBe('bob')
    expect(followUp.maxDurationMinutes).toBe(42)
    expect(followUp.prompt).toContain('<previous_task>')
    expect(followUp.prompt).toContain('The report is done.')
    expect(followUp.prompt).toContain('Follow-up from the user: now also check the numbers')

    // Lineage: the follow-up hangs off the requester's `app` session so the
    // result is delivered back into the app.
    expect(parentSessionLookups).toEqual([{ userId: '1', source: 'app', agentId: 'bob' }])
    expect(startCalls).toEqual([
      { taskId: followUpId, providerName: 'TestProvider', parentSessionId: 'session-of-1-app' },
    ])
  })

  it('falls back to the default provider when the task pinned none', async () => {
    const task = createOwnedTask({ status: 'failed' })

    const res = await reply(task.id, { text: 'try again with fewer steps' })

    expect(res.status).toBe(201)
    const followUp = store().getById(res.body?.followUpTaskId as string)!
    expect(followUp.provider).toBe('DefaultProvider')
    expect(followUp.model).toBe('fallback-model')
    expect(followUp.isDefaultModel).toBe(true)
  })

  it('answers 400 for an empty or whitespace-only text', async () => {
    const task = createOwnedTask({ status: 'paused' })

    const empty = await reply(task.id, { text: '   ' })
    expect(empty.status).toBe(400)
    expect(empty.body?.error).toBe('validation_error')

    const missing = await reply(task.id, {})
    expect(missing.status).toBe(400)
    expect(missing.body?.error).toBe('validation_error')

    const tooLong = await reply(task.id, { text: 'x'.repeat(8001) })
    expect(tooLong.status).toBe(400)

    expect(resumeCalls).toEqual([])
  })

  it('answers 403 for a task that belongs to another user', async () => {
    const task = createOwnedTask({ status: 'paused' })

    const res = await reply(task.id, { text: 'let me in' }, strangerToken)

    expect(res.status).toBe(403)
    expect(resumeCalls).toEqual([])
  })

  it('answers 404 for an unknown task id', async () => {
    const res = await reply('does-not-exist', { text: 'hello?' })

    expect(res.status).toBe(404)
  })

  it('rejects an unauthenticated reply', async () => {
    const task = createOwnedTask({ status: 'paused' })
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(401)
  })
})
