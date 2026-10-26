/**
 * B-01-R: persisted task injections (boot replay after a restart and the
 * periodic sweeper retry) must never replay the result of a task whose
 * ownership lineage is `invalid` into a strand. Drives the real composition
 * with a recording agent core: the refused row is abandoned and
 * `injectTaskResult` is never called for it, while `owner` and `none` rows
 * are still delivered (counter-checks).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager, enqueueTaskInjection, resolveTaskOwnershipForTask } from '@axiom/core'
import type { Task, TaskInjectionSweeper as SweeperType } from '@axiom/core'
import { createRuntimeComposition } from './runtime-composition.js'

const captured = vi.hoisted(() => ({
  injected: [] as { payload: string; userId: string; sessionId: string; injectionId: string }[],
  sweeper: null as unknown,
}))

vi.mock('@axiom/core', async importOriginal => {
  const core = await importOriginal<typeof import('@axiom/core')>()
  const noop: unknown = new Proxy(function noopFn() {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : noop),
    apply: () => noop,
  })
  /** Agent core that only records task-result injections. */
  class RecordingAgentCore {
    constructor() {
      return new Proxy(this, {
        get(target, prop) {
          if (prop === 'then') return undefined
          if (prop === 'injectTaskResult') {
            return (payload: string, userId: string, sessionId: string, injectionId: string) => {
              captured.injected.push({ payload, userId, sessionId, injectionId })
              return Promise.resolve()
            }
          }
          if (prop in target) return (target as Record<string | symbol, unknown>)[prop]
          return noop
        },
      })
    }
  }
  class CapturingSweeper extends core.TaskInjectionSweeper {
    constructor(options: ConstructorParameters<typeof core.TaskInjectionSweeper>[0]) {
      super({ ...options, intervalMs: 0 })
      captured.sweeper = this
    }
  }
  return {
    ...core,
    AgentCore: RecordingAgentCore,
    TaskInjectionSweeper: CapturingSweeper,
    getActiveProvider: () => ({
      id: 'p-active',
      name: 'active',
      type: 'openai-completions',
      providerType: 'openai',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      enabledModels: ['active-model'],
    }),
  }
})

const silent = { log() {}, warn() {}, error() {} }
let composition: Awaited<ReturnType<typeof createRuntimeComposition>>
let previousDataDir: string | undefined
let dataDir: string
let sessions: SessionManager
let strand2: string

beforeEach(async () => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(process.cwd(), '.b01r-injection-replay-'))
  process.env.DATA_DIR = dataDir
  captured.injected = []
  composition = await createRuntimeComposition({ logger: silent })
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

/** Same lineage fixture as the B-01 tests: parent owned by user two, child contradicts it when `invalid`. */
function fixture(): { invalid: Task; owner: Task; none: Task } {
  const tasks = composition.getTaskRuntime().tasks
  const parentSession = sessions.createSession({ type: 'task', source: 'system', parentSessionId: strand2 })
  const owner = tasks.create({ name: 'Owner parent', prompt: 'p', triggerType: 'agent', sessionId: parentSession.id, agentId: 'main' })
  const childSession = sessions.createSession({ type: 'task', source: 'system', parentSessionId: strand2 })
  composition.db.prepare("UPDATE sessions SET user_id = 3, session_user = '3' WHERE id = ?").run(childSession.id)
  const invalid = tasks.create({ name: 'Invalid child', prompt: 'p', triggerType: 'agent', triggerSourceId: owner.id, sessionId: childSession.id, agentId: 'main' })
  const cronSession = sessions.createSession({ type: 'task', source: 'system' })
  const none = tasks.create({ name: 'Cron', prompt: 'p', triggerType: 'cronjob', sessionId: cronSession.id, agentId: 'main' })
  for (const t of [owner, invalid, none]) tasks.update(t.id, { status: 'completed', resultStatus: 'completed' })
  return { invalid, owner, none }
}

/** A persisted row as written before the lineage turned invalid (or by a pre-fix build). */
function persist(task: Task, marker: string): string {
  return enqueueTaskInjection(composition.db, {
    taskId: task.id, kind: 'task_result', userId: 2, agentId: 'main', sessionId: strand2,
    payload: `<task_injection>${marker}</task_injection>`,
  }).id
}

function injectionRow(id: string, db = composition.db) {
  return db.prepare('SELECT status, last_error FROM task_injections WHERE id = ?').get(id) as { status: string; last_error: string | null }
}

describe('B-01-R: persisted injection replay gate', () => {
  it('fixture classification: invalid / owner / none', () => {
    const { invalid, owner, none } = fixture()
    expect(resolveTaskOwnershipForTask(composition.db, invalid).kind).toBe('invalid')
    expect(resolveTaskOwnershipForTask(composition.db, owner).kind).toBe('owner')
    expect(resolveTaskOwnershipForTask(composition.db, none).kind).toBe('none')
  })

  it('boot replay: an invalid task row is abandoned and never injected; owner and none rows are replayed', async () => {
    const { invalid, owner, none } = fixture()
    const bad = persist(invalid, 'INVALID_SECRET_RESULT')
    const good = persist(owner, 'OWNER_RESULT')
    const sys = persist(none, 'NONE_RESULT')

    await composition.stopBackgroundServices()
    captured.injected = []
    composition = await createRuntimeComposition({ logger: silent })

    const payloads = captured.injected.map(i => i.payload).join('\n')
    expect(payloads).not.toContain('INVALID_SECRET_RESULT')
    expect(captured.injected.some(i => i.injectionId === bad)).toBe(false)
    expect(injectionRow(bad)).toMatchObject({ status: 'abandoned' })
    expect(injectionRow(bad).last_error).toContain('B-01-R')
    // Counter-checks: owner and none still reach the agent core.
    expect(captured.injected.some(i => i.injectionId === good && i.payload.includes('OWNER_RESULT'))).toBe(true)
    expect(captured.injected.some(i => i.injectionId === sys && i.payload.includes('NONE_RESULT'))).toBe(true)
  })

  it('sweeper retry: an invalid task row is abandoned and never injected; owner row is retried', async () => {
    const { invalid, owner } = fixture()
    // Boot resume already ran for this composition; these rows are new.
    const bad = persist(invalid, 'INVALID_SECRET_RESULT')
    const good = persist(owner, 'OWNER_RESULT')
    captured.injected = []

    await (captured.sweeper as SweeperType).sweepOnce()

    expect(captured.injected.some(i => i.injectionId === bad)).toBe(false)
    expect(captured.injected.map(i => i.payload).join('\n')).not.toContain('INVALID_SECRET_RESULT')
    expect(injectionRow(bad)).toMatchObject({ status: 'abandoned' })
    expect(injectionRow(bad).last_error).toContain('B-01-R')
    expect(captured.injected.some(i => i.injectionId === good && i.payload.includes('OWNER_RESULT'))).toBe(true)
  })
})
