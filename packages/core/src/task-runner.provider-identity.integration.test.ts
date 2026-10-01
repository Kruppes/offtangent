import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase } from './database.js'
import { TaskStore } from './task-store.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import type { Database } from './database.js'
import type { ProviderConfig } from './provider-config.js'
import { getProviderDefaultModel } from './provider-config.js'
import { SessionManager } from './session-manager.js'
import { buildStrandTaskTree, buildTaskActivityFrame } from './task-tree.js'
import type { TaskActivityFrame, StrandTaskNode } from './task-tree.js'
import type { Task } from './task-store.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Release integration 2026-10-01: per-provider task slots (8688b40b) meet
 * per-task provider/model identity in the strand activity tree (942a24f4).
 *
 * Original header of the borrowed harness: tests for the per-provider task slots (`tasks.maxConcurrentPerProvider`,
 * `tasks.maxConcurrentByProvider`) together with the global safety cap.
 *
 * The agent mock here is *controllable*: `prompt()` returns a promise that
 * only settles when the test says so. That is what makes it possible to have
 * several tasks "running" at the same time and to check which of them the
 * runner actually started.
 */

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

interface AgentHandle {
  /** Order in which the runner constructed this agent (0-based). */
  index: number
  /** System prompt of this agent — used to map agent → task. */
  systemPrompt: string
  complete: (summary?: string) => void
  ask: (question?: string) => void
  fail: (message?: string) => void
  aborted: boolean
}

const agents: AgentHandle[] = []

vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation((options: { initialState?: { systemPrompt?: string } }) => {
      const messages: unknown[] = []
      let subscribeFn: ((event: unknown) => void) | null = null
      let settle: ((outcome: { error?: Error }) => void) | null = null

      const handle: AgentHandle = {
        index: agents.length,
        systemPrompt: String(options?.initialState?.systemPrompt ?? ''),
        aborted: false,
        complete: (summary = 'All good') => {
          if (subscribeFn) {
            subscribeFn({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: `STATUS: completed\nSUMMARY: ${summary}` }],
                provider: 'test-provider',
                model: 'test-model',
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
              },
            })
          }
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: `STATUS: completed\nSUMMARY: ${summary}` }],
          })
          settle?.({})
        },
        ask: (question = 'Which database should I use, Postgres or MySQL?') => {
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: `STATUS: question\nSUMMARY: ${question}` }],
          })
          settle?.({})
        },
        fail: (message = 'LLM API error') => {
          settle?.({ error: new Error(message) })
        },
      }
      agents.push(handle)

      return {
        subscribe: vi.fn((fn: (event: unknown) => void) => {
          subscribeFn = fn
          return () => { subscribeFn = null }
        }),
        prompt: vi.fn(() => {
          return new Promise<void>((resolve, reject) => {
            settle = (outcome) => {
              settle = null
              if (outcome.error) reject(outcome.error)
              else resolve()
            }
          })
        }),
        abort: vi.fn(() => {
          handle.aborted = true
          settle?.({})
        }),
        state: { get messages() { return messages } },
      }
    }),
  }
})

const mockProvider: ProviderConfig = {
  id: 'test-provider-id',
  name: 'test-provider',
  type: 'openai',
  providerType: 'openai',
  provider: 'openai',
  baseUrl: 'http://localhost:1234',
  apiKey: 'test-key',
  enabledModels: ['test-model'],
  models: [],
  status: 'connected',
  authMethod: 'api-key',
}


function providerWithId(id: string, model: string): ProviderConfig {
  return { ...mockProvider, id, name: `name-${id}`, enabledModels: [model] }
}

// Synthetic fixtures only: no real provider names, prompts or strand content.
const P1 = providerWithId('provider-one', 'model-one')
const P2 = providerWithId('provider-two', 'model-two')
const STRAND = 'strand-synthetic-1'

describe('TaskRunner — per-provider slots and task identity in the strand activity', () => {
  let db: Database
  let store: TaskStore
  let runner: TaskRunner
  let sessionManager: SessionManager
  const tmpFiles: string[] = []
  let frames: TaskActivityFrame[]

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-taskident-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  async function flush(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 5))
    for (let i = 0; i < times; i++) await Promise.resolve()
  }

  function agentFor(taskName: string): AgentHandle | undefined {
    return agents.find(a => a.systemPrompt.includes(`Work on ${taskName}`))
  }

  /** Mirrors create_task: the pin is persisted at creation time. */
  function createTask(name: string, provider: ProviderConfig, parentTaskId?: string): Task {
    return store.create({
      name,
      prompt: `Work on ${name}`,
      triggerType: 'agent',
      ...(parentTaskId ? { triggerSourceId: parentTaskId } : {}),
      provider: provider.name,
      model: getProviderDefaultModel(provider),
    })
  }

  function nodes(): StrandTaskNode[] {
    // The snapshot is a flat, depth-annotated list; clients build the tree.
    return buildStrandTaskTree(db, STRAND, { include: 'all' }).tasks
  }

  beforeEach(() => {
    agents.length = 0
    frames = []
    db = initDatabase(tmpDbPath())
    store = new TaskStore(db)
    sessionManager = new SessionManager({ db })
    db.prepare(
      `INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES (?, 'system', 'interactive', NULL, '1')`,
    ).run(STRAND)
    runner = new TaskRunner({
      db,
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      onTaskComplete: () => { },
      sessionManager,
      getMaxConcurrentTasks: () => 12,
      getProviderTaskLimits: () => ({ perProvider: 1, byProvider: {} }),
      onTaskLifecycle: (phase, task) => {
        const frame = buildTaskActivityFrame(db, task, phase)
        if (frame) frames.push(frame)
      },
    })
  })

  afterEach(async () => {
    runner.dispose()
    await flush()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  it('shows each sub-task with its own provider/model while one waits for its provider slot', async () => {
    const parent = createTask('Parent', P1)
    await runner.startTask(parent, P1, undefined, STRAND)
    await flush()
    expect(runner.isRunning(parent.id)).toBe(true)

    // Sub-task on the busy provider waits; sub-task on the other provider passes it.
    const waiting = createTask('SubOne', P1, parent.id)
    const passing = createTask('SubTwo', P2, parent.id)
    await runner.startTask(waiting, P1)
    await runner.startTask(passing, P2)
    await flush()

    expect(runner.getQueuedTaskIds()).toEqual([waiting.id])
    expect(runner.getQueueInfo(waiting.id)).toMatchObject({ queued: true, reason: 'provider', provider: 'provider-one' })
    expect(runner.isRunning(passing.id)).toBe(true)

    // REST snapshot: identity is the task's own, never the parent's; the
    // waiting one is visibly queued (startedAt null) with its persisted pin.
    const byId = new Map(nodes().map(n => [n.id, n]))
    expect(byId.get(parent.id)).toMatchObject({ provider: 'name-provider-one', model: 'model-one' })
    expect(byId.get(waiting.id)).toMatchObject({ provider: 'name-provider-one', model: 'model-one', startedAt: null, parentTaskId: parent.id })
    expect(byId.get(passing.id)).toMatchObject({ provider: 'name-provider-two', model: 'model-two', parentTaskId: parent.id })
    expect(byId.get(passing.id)!.startedAt).toBeTruthy()

    // Live frames: the started frame of the passing task carries its identity.
    const startedPassing = frames.find(f => f.taskId === passing.id && f.phase === 'started')
    expect(startedPassing).toMatchObject({ strandId: STRAND, provider: 'name-provider-two', model: 'model-two' })
    expect(frames.some(f => f.taskId === waiting.id && f.phase === 'started')).toBe(false)

    // The parent finishes, the slot frees up, the waiting task starts and its
    // started frame still says provider-one/model-one.
    agentFor('Parent')!.complete()
    await flush()
    expect(runner.isRunning(waiting.id)).toBe(true)
    expect(frames.find(f => f.taskId === waiting.id && f.phase === 'started'))
      .toMatchObject({ strandId: STRAND, provider: 'name-provider-one', model: 'model-one' })
  })

  it('cancelling a waiting and a running sub-task keeps their identity in the finished frames', async () => {
    const parent = createTask('Parent', P1)
    await runner.startTask(parent, P1, undefined, STRAND)
    await flush()

    const waiting = createTask('SubOne', P1, parent.id)
    const running = createTask('SubTwo', P2, parent.id)
    await runner.startTask(waiting, P1)
    await runner.startTask(running, P2)
    await flush()
    expect(runner.getQueuedTaskIds()).toEqual([waiting.id])

    runner.abortTask(waiting.id, 'Aborted by user')
    runner.abortTask(running.id, 'Aborted by user')
    await flush()

    // The waiting task was never started, the running one was really aborted.
    expect(agentFor('SubOne')).toBeUndefined()
    expect(agentFor('SubTwo')!.aborted).toBe(true)
    expect(runner.isQueued(waiting.id)).toBe(false)
    expect(runner.isRunning(running.id)).toBe(false)

    for (const [task, provider, model] of [
      [waiting, 'name-provider-one', 'model-one'],
      [running, 'name-provider-two', 'model-two'],
    ] as const) {
      const finished = frames.find(f => f.taskId === task.id && f.phase === 'finished')
      expect(finished).toMatchObject({ strandId: STRAND, status: 'failed', provider, model })
    }

    // The provider slot of the parent is unaffected; a new P2 task starts at once
    // because the aborted P2 task released its slot.
    const next = createTask('SubThree', P2, parent.id)
    await runner.startTask(next, P2)
    await flush()
    expect(runner.isRunning(next.id)).toBe(true)
    expect(runner.isRunning(parent.id)).toBe(true)
  })
})
