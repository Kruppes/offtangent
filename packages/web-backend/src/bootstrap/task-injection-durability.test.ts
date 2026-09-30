/**
 * W4: a task result must survive the restart of the container that produced
 * it. These tests drive the real composition — the queue row has to be
 * written by the production wiring, not by the test.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@axiom/core'
import type { createTaskRuntime, TaskTriggerType } from '@axiom/core'
import { createRuntimeComposition } from './runtime-composition.js'

const captured = vi.hoisted(() => ({
  runner: null as Parameters<typeof createTaskRuntime>[0]['runner'] | null,
}))
vi.mock('@axiom/core', async importOriginal => {
  const core = await importOriginal<typeof import('@axiom/core')>()
  return {
    ...core,
    createTaskRuntime: (options: Parameters<typeof createTaskRuntime>[0]) => {
      captured.runner = options.runner
      return core.createTaskRuntime(options)
    },
  }
})

const silent = { log() {}, warn() {}, error() {} }

let composition: Awaited<ReturnType<typeof createRuntimeComposition>>
let previousDataDir: string | undefined
let dataDir: string
let sessions: SessionManager
let strand: string

beforeEach(async () => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(process.cwd(), '.task-injection-durability-'))
  process.env.DATA_DIR = dataDir
  composition = await createRuntimeComposition({ logger: silent })
  composition.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run()
  sessions = new SessionManager({ db: composition.db, memoryDir: path.join(dataDir, 'memory'), timeoutMinutes: 0 })
  strand = sessions.createThread('1', 'main', 'Origin').id
})

afterEach(async () => {
  await composition?.stopBackgroundServices()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function makeTask(triggerType: TaskTriggerType, name = 'Some work') {
  const session = sessions.createSession({ type: 'task', source: 'system', parentSessionId: strand })
  return composition.getTaskRuntime().tasks.create({
    name, prompt: 'Do it', triggerType, sessionId: session.id, agentId: 'main',
  })
}

function injections(db = composition.db) {
  return db.prepare('SELECT * FROM task_injections ORDER BY rowid ASC').all() as Array<{
    id: string; task_id: string; kind: string; session_id: string; agent_id: string
    user_id: number; payload: string; status: string; attempts: number; last_error: string | null
  }>
}

/** Restart the process: new composition, same DATA_DIR, same database file. */
async function restart() {
  await composition.stopBackgroundServices()
  composition = await createRuntimeComposition({ logger: silent })
  return composition
}

describe('durable task injection queue', () => {
  it('persists a strand-bound task result before anything tries to deliver it', () => {
    const task = makeTask('agent')
    captured.runner!.onTaskComplete('' + task.id, '<task_injection>result</task_injection>', 'main')

    const rows = injections()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      task_id: task.id,
      kind: 'task_result',
      session_id: strand,
      agent_id: 'main',
      user_id: 1,
      payload: '<task_injection>result</task_injection>',
      status: 'pending',
    })
  })

  it.each(['cronjob', 'heartbeat', 'consolidation'] as const)('queues nothing for feed-only %s results', trigger => {
    const task = makeTask(trigger)
    captured.runner!.onTaskComplete(task.id, '<task_injection>result</task_injection>', 'main')
    expect(injections()).toEqual([])
  })

  it('keeps the row pending while no agent core can consume it', () => {
    // No provider is configured in this environment, so the injection cannot
    // run. Pre-W4 the payload was dropped on the floor here.
    const task = makeTask('user')
    captured.runner!.onTaskComplete(task.id, '<task_injection>result</task_injection>', 'main')
    expect(injections()[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('still holds the undelivered result after a restart', async () => {
    const task = makeTask('agent')
    captured.runner!.onTaskComplete(task.id, '<task_injection>result</task_injection>', 'main')
    const db = (await restart()).db
    const rows = injections(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ task_id: task.id, status: 'pending' })
  })
})

describe('boot resume hook', () => {
  it('queues a restart notice for a strand whose task is still running', async () => {
    makeTask('agent', 'Long runner')
    const db = (await restart()).db

    const notices = injections(db).filter(r => r.kind === 'resume_notice')
    expect(notices).toHaveLength(1)
    expect(notices[0].session_id).toBe(strand)
    expect(notices[0].payload).toContain('container was restarted')
    expect(notices[0].payload).toContain('Long runner')
    expect(notices[0].status).toBe('pending')
  })

  it.each(['cronjob', 'heartbeat'] as const)('sends no restart notice for a running %s', async trigger => {
    makeTask(trigger)
    const db = (await restart()).db
    expect(injections(db).filter(r => r.kind === 'resume_notice')).toEqual([])
  })

  it('does not add a notice when the strand already gets an undelivered result back', async () => {
    const task = makeTask('agent')
    captured.runner!.onTaskComplete(task.id, '<task_injection>result</task_injection>', 'main')
    const db = (await restart()).db
    expect(injections(db).map(r => r.kind)).toEqual(['task_result'])
  })

  it('abandons a result that sat undelivered past the age cap instead of injecting it', async () => {
    const task = makeTask('agent')
    captured.runner!.onTaskComplete(task.id, '<task_injection>result</task_injection>', 'main')
    composition.db.prepare("UPDATE task_injections SET created_at = datetime('now', '-3 days')").run()
    // Take the task out of `running` so the boot hook has nothing else to say.
    composition.getTaskRuntime().tasks.update(task.id, { status: 'completed', resultStatus: 'completed' })

    const db = (await restart()).db
    const rows = injections(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('abandoned')
    expect(rows[0].last_error).toContain('expired')
  })
})
