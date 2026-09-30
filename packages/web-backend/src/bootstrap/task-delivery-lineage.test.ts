import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager, runWithTaskExecutionContext } from '@axiom/core'
import type { createTaskRuntime, createSendFileTool, TaskTriggerType } from '@axiom/core'
import { createRuntimeComposition } from './runtime-composition.js'

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
let strand: string
let elsewhere: string

beforeEach(async () => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(process.cwd(), '.task-lineage-test-'))
  process.env.DATA_DIR = dataDir
  captured.files = []
  composition = await createRuntimeComposition({ logger: { log() {}, warn() {}, error() {} } })
  composition.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run()
  sessions = new SessionManager({ db: composition.db, memoryDir: path.join(dataDir, 'memory'), timeoutMinutes: 0 })
  strand = sessions.createThread('1', 'main', 'Origin').id
  elsewhere = sessions.createThread('1', 'main', 'Currently open').id
})
afterEach(async () => {
  await composition?.stopBackgroundServices()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function task(triggerType: TaskTriggerType, nested = false) {
  const parent = nested ? sessions.createSession({ type: 'task', source: 'system', parentSessionId: strand }).id : strand
  const session = sessions.createSession({ type: 'task', source: 'system', parentSessionId: parent })
  return composition.getTaskRuntime().tasks.create({ name: 'Artifact', prompt: 'Build', triggerType, sessionId: session.id, agentId: 'main' })
}
function rows(sessionId: string) {
  return composition.db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all(sessionId)
}

describe('runtime task delivery lineage', () => {
  it('resolves a nested task execution origin all the way to the strand', () => {
    expect(captured.runner!.resolveTaskOrigin!(task('agent', true)).sessionId).toBe(strand)
  })

  it.each(['cronjob', 'heartbeat', 'consolidation'] as const)('gives %s execution no strand even with an interactive ancestor', trigger => {
    expect(captured.runner!.resolveTaskOrigin!(task(trigger, true)).sessionId).toBeNull()
  })

  it('refuses a file without a resolvable task instead of trusting its delivery session', async () => {
    await expect(runWithTaskExecutionContext({ provider: null, taskId: 'missing', userId: 1, sessionId: elsewhere }, async () => {
      await captured.files[0]!.deliverFile!({
        userId: 1,
        sessionId: elsewhere,
        upload: { kind: 'file', originalName: 'report.txt', storedName: 'report.txt', relativePath: 'report.txt', urlPath: '/api/uploads/report.txt', mimeType: 'text/plain', size: 4 },
      })
    })).rejects.toThrow('no strand')
    expect(rows(elsewhere)).toEqual([])
    expect(rows(strand)).toEqual([])
  })

  it.each(['user', 'agent', 'cronjob', 'heartbeat', 'consolidation'] as const)(
    'delivers %s files by task lineage, ignoring a stale tool delivery session', async trigger => {
      const currentTask = task(trigger, true)
      const target = trigger === 'user' || trigger === 'agent' ? strand : currentTask.sessionId
      const frames: unknown[] = []
      composition.chatEventBus.subscribe(event => frames.push(event))
      // The first file tool is the background tool. Exercise its actual runtime callback.
      await runWithTaskExecutionContext({ provider: null, taskId: currentTask.id, userId: 1, sessionId: elsewhere, agentId: 'main' }, async () => {
        await captured.files[0]!.deliverFile!({
          userId: 1,
          sessionId: elsewhere,
          upload: { kind: 'file', originalName: 'report.txt', storedName: 'report.txt', relativePath: 'report.txt', urlPath: '/api/uploads/report.txt', mimeType: 'text/plain', size: 4 },
          caption: 'Report',
        })
      })
      expect(rows(elsewhere)).toEqual([])
      expect(rows(target!)).toHaveLength(1)
      expect(frames).toEqual([expect.objectContaining({ type: 'attachment', sessionId: target, agentId: 'main', messageId: expect.any(Number) })])
      if (target !== strand) expect(rows(strand)).toEqual([])
    },
  )

  it.each(['user', 'cronjob'] as const)('keeps %s progress rows and frames on the lineage target', async trigger => {
    const currentTask = task(trigger, true)
    const target = trigger === 'user' ? strand : currentTask.sessionId
    const frames: unknown[] = []
    composition.chatEventBus.subscribe(event => frames.push(event))
    captured.runner!.onStatusUpdate!(currentTask.id, 'Working', { taskName: currentTask.name, runtimeMinutes: 1, toolCallCount: 2, totalTokens: 3 })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(rows(elsewhere)).toEqual([])
    expect(rows(target!)).toHaveLength(1)
    expect(frames).toContainEqual(expect.objectContaining({ type: 'task_status_update', sessionId: target }))
  })
})
