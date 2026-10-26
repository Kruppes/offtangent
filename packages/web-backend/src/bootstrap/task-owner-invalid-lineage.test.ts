import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager, resolveTaskOwnerUserIdForTask, resolveTaskOwnershipForTask, runWithTaskExecutionContext } from '@axiom/core'
import type { createTaskRuntime, createSendFileTool, Task } from '@axiom/core'
import { createRuntimeComposition } from './runtime-composition.js'

/**
 * B-01 (independent release review 2026-10-26): an INVALID task ownership
 * lineage (contradictory owners, broken chain) must never be treated as
 * legitimately unowned system work. Only `none` gets the provisioned fallback
 * user; `invalid` gets no identity, no strand and no personal side effects.
 *
 * The first four tests are the reviewer's repros (repros/runtime-owner.test.ts)
 * integrated verbatim in their assertions; the rest cover the other runtime
 * fallback consumers (delivery, restart notices, task tools).
 */
const captured = vi.hoisted(() => ({
  runner: null as Parameters<typeof createTaskRuntime>[0]['runner'] | null,
  files: [] as Parameters<typeof createSendFileTool>[0][],
}))
vi.mock('@axiom/core', async importOriginal => {
  const core = await importOriginal<typeof import('@axiom/core')>()
  return {
    ...core,
    createTaskRuntime: (options: Parameters<typeof createTaskRuntime>[0]) => {
      captured.runner = options.runner
      return core.createTaskRuntime(options)
    },
    createSendFileTool: (options: Parameters<typeof createSendFileTool>[0]) => {
      captured.files.push(options)
      return core.createSendFileTool(options)
    },
  }
})

let composition: Awaited<ReturnType<typeof createRuntimeComposition>>
let previousDataDir: string | undefined
let dataDir: string
let sessions: SessionManager
let strand2: string

beforeEach(async () => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(process.cwd(), '.task-owner-invalid-test-'))
  process.env.DATA_DIR = dataDir
  captured.files = []
  composition = await createRuntimeComposition({ logger: { log() {}, warn() {}, error() {} } })
  for (const id of [1, 2, 3]) {
    composition.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)")
      .run(id, `synthetic-user-${id}`, id === 1 ? 'admin' : 'user')
  }
  sessions = new SessionManager({ db: composition.db, memoryDir: path.join(dataDir, 'memory'), timeoutMinutes: 0 })
  strand2 = sessions.createThread('2', 'main', 'SYNTHETIC_USER_TWO').id
})
afterEach(async () => {
  await composition?.stopBackgroundServices()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** Parent task owned by user 2; child is a sub-task of it. With `invalid`, the
 * child's own session claims user 3 while hanging below user 2's strand. */
function fixture(invalid: boolean): { child: Task; parent: Task } {
  const tasks = composition.getTaskRuntime().tasks
  const parentSession = sessions.createSession({ type: 'task', source: 'system', parentSessionId: strand2 })
  const parent = tasks.create({ name: 'Parent owned by two', prompt: 'synthetic', triggerType: 'agent', sessionId: parentSession.id, agentId: 'main' })
  const childSession = sessions.createSession({ type: 'task', source: 'system', ...(invalid ? { parentSessionId: strand2 } : {}) })
  if (invalid) composition.db.prepare("UPDATE sessions SET user_id = 3, session_user = '3' WHERE id = ?").run(childSession.id)
  const child = tasks.create({ name: 'SYNTHETIC_PRIVATE_TWO_TASK', prompt: 'synthetic', triggerType: 'agent', triggerSourceId: parent.id, sessionId: childSession.id, agentId: 'main' })
  return { child, parent }
}
function cronTask(): Task {
  const s = sessions.createSession({ type: 'task', source: 'system' })
  return composition.getTaskRuntime().tasks.create({ name: 'Synthetic cron', prompt: 'synthetic', triggerType: 'cronjob', sessionId: s.id, agentId: 'main' })
}
function runner() {
  return captured.runner!
}
function boundContext(taskId: string) {
  return ((composition.getTaskRuntime() as unknown as { runner: unknown }).runner as {
    taskExecutionContext(id: string, provider: null): { userId?: number | null; sessionId?: string | null }
  }).taskExecutionContext(taskId, null)
}
const settle = () => new Promise(resolve => setTimeout(resolve, 15))

describe('B-01: invalid task ownership lineage in runtime fallback consumers', () => {
  // --- Reviewer repros (repros/runtime-owner.test.ts) ---------------------
  it('CONTROL: genuinely unowned system work still uses the provisioned fallback', () => {
    const t = cronTask()
    expect(resolveTaskOwnerUserIdForTask(composition.db, t)).toBeNull()
    expect(runner().resolveTaskOrigin!(t)).toMatchObject({ userId: 1, sessionId: null })
  })

  it('CONTROL: a valid orphan subtask remains user two, not fallback user one', () => {
    const { child } = fixture(false)
    expect(resolveTaskOwnerUserIdForTask(composition.db, child)).toBe(2)
    expect(runner().resolveTaskOrigin!(child)).toMatchObject({ userId: 2 })
  })

  it('SAFETY: contradictory child lineage must not acquire default admin execution identity', () => {
    const { child } = fixture(true)
    const origin = runner().resolveTaskOrigin!(child)
    const ctx = boundContext(child.id)
    expect(ctx.userId, 'invalid user-two task must not execute as fallback user one').not.toBe(1)
    expect(origin.userId).not.toBe(1)
  })

  it('SAFETY: status must not create a user-one row in the user-two strand after invalid lineage', async () => {
    const { child } = fixture(true)
    runner().onStatusUpdate!(child.id, 'Synthetic progress', { taskName: child.name, runtimeMinutes: 1, toolCallCount: 2, totalTokens: 3 })
    await settle()
    const rows = composition.db.prepare('SELECT user_id FROM chat_messages WHERE session_id = ?').all(strand2) as Array<{ user_id: unknown }>
    expect(rows.filter(r => Number(r.user_id) === 1)).toEqual([])
  })

  // --- Stricter invariants and further consumers ---------------------------
  it('classifies invalid apart from none and owner in core', () => {
    expect(resolveTaskOwnershipForTask(composition.db, cronTask())).toEqual({ kind: 'none' })
    expect(resolveTaskOwnershipForTask(composition.db, fixture(false).child)).toEqual({ kind: 'owner', userId: 2 })
    expect(resolveTaskOwnershipForTask(composition.db, fixture(true).child)).toEqual({ kind: 'invalid' })
  })

  it('treats a dangling task-parent edge as invalid, not as system work', () => {
    const s = sessions.createSession({ type: 'task', source: 'system' })
    const orphan = composition.getTaskRuntime().tasks.create({ name: 'Dangling', prompt: 'synthetic', triggerType: 'agent', triggerSourceId: 'missing-parent', sessionId: s.id, agentId: 'main' })
    expect(resolveTaskOwnershipForTask(composition.db, orphan)).toEqual({ kind: 'invalid' })
    expect(runner().resolveTaskOrigin!(orphan)).toEqual({ userId: null, sessionId: null })
  })

  it('an invalid task gets no identity and no (foreign) strand in its execution context', () => {
    const { child } = fixture(true)
    expect(runner().resolveTaskOrigin!(child)).toEqual({ userId: null, sessionId: null })
    expect(boundContext(child.id)).toMatchObject({ userId: null, sessionId: null })
  })

  it('a valid parent-owned child keeps its owner in the bound execution context', () => {
    const { child } = fixture(false)
    expect(boundContext(child.id)).toMatchObject({ userId: 2 })
  })

  it('writes no status row anywhere for an invalid lineage', async () => {
    const { child } = fixture(true)
    runner().onStatusUpdate!(child.id, 'Synthetic progress', { taskName: child.name, runtimeMinutes: 1, toolCallCount: 2, totalTokens: 3 })
    await settle()
    const count = () => (composition.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n
    expect(count()).toBe(0)
  })

  it.each(['onTaskComplete', 'onTaskPaused'] as const)('%s delivers nothing for an invalid lineage: no strand row, no feed item, notice undelivered', async callback => {
    const { child } = fixture(true)
    runner()[callback]!(child.id, '<task_injection>SYNTHETIC_RESULT</task_injection>', 'main')
    await settle()
    expect(composition.db.prepare('SELECT * FROM chat_messages').all()).toEqual([])
    expect(composition.db.prepare('SELECT * FROM task_injections').all()).toEqual([])
    const feed = composition.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feed_items'").get()
      ? composition.db.prepare('SELECT * FROM feed_items').all()
      : []
    expect(feed).toEqual([])
  })

  it('a valid parent-owned child still delivers its outcome (control)', async () => {
    const { child } = fixture(false)
    runner().onTaskComplete!(child.id, '<task_injection>SYNTHETIC_RESULT</task_injection>', 'main')
    await settle()
    const injections = composition.db.prepare('SELECT user_id FROM task_injections WHERE task_id = ?').all(child.id) as Array<{ user_id: number }>
    const feed = composition.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feed_items'").get()
      ? composition.db.prepare('SELECT user_id FROM feed_items').all() as Array<{ user_id: unknown }>
      : []
    const delivered = [...injections.map(r => Number(r.user_id)), ...feed.map(r => Number(r.user_id))]
    expect(delivered.length).toBeGreaterThan(0)
    expect(delivered.every(u => u === 2)).toBe(true)
  })

  it('send_file_to_user inside an invalid task has no user and no strand', async () => {
    const { child } = fixture(true)
    const background = captured.files.find(o => o.deliverFile && o.getCurrentInteractiveSessionId && o.getCurrentToolUserId)!
    expect(background).toBeTruthy()
    const ctx = boundContext(child.id)
    let userIds: Array<number | undefined> = []
    let sessionIds: Array<string | null | undefined> = []
    await runWithTaskExecutionContext({ provider: null, taskId: child.id, ...ctx }, async () => {
      userIds = captured.files.map(o => o.getCurrentToolUserId())
      sessionIds = captured.files.map(o => o.getCurrentInteractiveSessionId?.())
    })
    expect(userIds.every(u => u === undefined)).toBe(true)
    expect(sessionIds.every(s => s == null)).toBe(true)
  })
})
