/**
 * get_task / steer_task / cancel_task against a real TaskRunner (through the
 * task runtime boundary) with a controllable agent mock: running, queued and
 * paused tasks, finished-task errors, access denial and the cascade to
 * sub-tasks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { createTaskRuntime } from './task-runtime.js'
import type { TaskRuntimeBoundary } from './task-runtime.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import type { ProviderConfig } from './provider-config.js'
import { runWithTaskExecutionContext } from './task-execution-context.js'
import { logToolCall } from './token-logger.js'
import { createCancelTaskTool, createGetTaskTool, createSteerTaskTool } from './task-control-tools.js'
import type { TaskControlToolsOptions } from './task-control-tools.js'
import type { Task } from './task-store.js'

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

interface AgentHandle {
  systemPrompt: string
  steerCalls: Array<{ role: string; content: Array<{ type: string; text: string }> }>
  promptCalls: string[]
  aborted: boolean
  streaming: boolean
  ask: (question?: string) => void
  complete: (summary?: string) => void
}

const hoisted = vi.hoisted(() => ({ agents: [] as AgentHandle[] }))

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation((options: { initialState?: { systemPrompt?: string } }) => {
    const messages: unknown[] = []
    let settle: (() => void) | null = null
    const handle: AgentHandle = {
      systemPrompt: String(options?.initialState?.systemPrompt ?? ''),
      steerCalls: [],
      promptCalls: [],
      aborted: false,
      streaming: false,
      ask: (question = 'Postgres or MySQL?') => {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: `STATUS: question\nSUMMARY: ${question}` }] })
        settle?.()
      },
      complete: (summary = 'Done') => {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: `STATUS: completed\nSUMMARY: ${summary}` }] })
        settle?.()
      },
    }
    hoisted.agents.push(handle)
    return {
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn((input: unknown) => {
        handle.promptCalls.push(typeof input === 'string' ? input : JSON.stringify(input))
        handle.streaming = true
        return new Promise<void>((resolve) => {
          settle = () => { settle = null; handle.streaming = false; resolve() }
        })
      }),
      steer: vi.fn((msg: AgentHandle['steerCalls'][number]) => { handle.steerCalls.push(msg) }),
      abort: vi.fn(() => { handle.aborted = true; settle?.() }),
      state: {
        get messages() { return messages },
        get isStreaming() { return handle.streaming },
      },
    }
  }),
}))

const provider: ProviderConfig = {
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

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n')
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('task control tools (get_task / steer_task / cancel_task)', () => {
  const tmpFiles: string[] = []
  let db: Database
  let runtime: TaskRuntimeBoundary
  let sessionManager: SessionManager
  let limit: number
  let alice: number
  let bob: number
  let aliceStrand: string
  let bobStrand: string
  let currentUser: number | undefined
  let currentAgent: string | undefined
  const completed: Array<{ taskId: string; injection: string }> = []

  function toolOptions(): TaskControlToolsOptions {
    return {
      taskRuntime: runtime.tasks,
      db,
      getCurrentUserId: () => currentUser,
      getCurrentAgentId: () => currentAgent,
    }
  }

  function addUser(name: string, role: 'admin' | 'user'): number {
    const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(name, 'x', role)
    return Number(info.lastInsertRowid)
  }

  async function startTask(name: string, opts: { strand?: string | null; parentTaskId?: string; agentId?: string } = {}): Promise<Task> {
    const task = runtime.tasks.create({
      name,
      prompt: `Work on ${name}`,
      triggerType: 'agent',
      triggerSourceId: opts.parentTaskId,
      agentId: opts.agentId,
    })
    await runtime.tasks.start(task, provider, undefined, opts.strand === undefined ? aliceStrand : opts.strand)
    await flush()
    return runtime.tasks.getById(task.id)!
  }

  function agentFor(name: string): AgentHandle {
    const agent = hoisted.agents.find((a) => a.systemPrompt.includes(`Work on ${name}`))
    if (!agent) throw new Error(`no agent for ${name}`)
    return agent
  }

  function asTask<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return runWithTaskExecutionContext({ provider: null, taskId, userId: alice, agentId: null }, fn)
  }

  beforeEach(() => {
    hoisted.agents.length = 0
    completed.length = 0
    limit = 0
    const p = path.join(os.tmpdir(), `axiom-taskctl-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
    sessionManager = new SessionManager({ db })
    alice = addUser('alice', 'user')
    bob = addUser('bob', 'user')
    aliceStrand = sessionManager.getOrCreateSession(String(alice), 'web', 'main').id
    bobStrand = sessionManager.getOrCreateSession(String(bob), 'web', 'main').id
    currentUser = alice
    currentAgent = 'main'
    const runnerOptions: Omit<TaskRunnerOptions, 'db'> = {
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      onTaskComplete: (taskId, injection) => { completed.push({ taskId, injection }) },
      sessionManager,
      getMaxConcurrentTasks: () => limit,
      getProviderTaskLimits: () => ({ perProvider: 0 }),
    }
    runtime = createTaskRuntime({
      db,
      runner: runnerOptions,
      scheduler: { getDefaultProvider: () => null, resolveProvider: () => null },
    })
  })

  afterEach(async () => {
    runtime.dispose()
    await flush()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  describe('cancel_task', () => {
    it('cancels a running task and records the orchestrator reason', async () => {
      const task = await startTask('Alpha')
      expect(runtime.tasks.isRunning(task.id)).toBe(true)

      const result = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: task.id, reason: 'wrong direction' })
      await flush()

      expect(text(result)).toContain('cancelled (was running')
      const row = runtime.tasks.getById(task.id)!
      expect(row.status).toBe('failed')
      expect(row.errorMessage).toBe('Cancelled by strand orchestrator: wrong direction')
      expect(row.resultSummary).toBe('Cancelled by strand orchestrator: wrong direction')
      expect(agentFor('Alpha').aborted).toBe(true)
      expect(runtime.tasks.isRunning(task.id)).toBe(false)
    })

    it('cancels a queued task so it never starts', async () => {
      limit = 1
      await startTask('Busy')
      const queued = await startTask('Waiting')
      expect(runtime.tasks.queueInfo?.(queued.id)?.queued).toBe(true)

      const result = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: queued.id, reason: 'duplicate run' })
      expect(text(result)).toContain('cancelled (was running')
      expect(runtime.tasks.queueInfo?.(queued.id)?.queued).toBe(false)
      expect(runtime.tasks.getById(queued.id)!.errorMessage).toBe('Cancelled by strand orchestrator: duplicate run')

      agentFor('Busy').complete()
      await flush()
      expect(hoisted.agents.some((a) => a.systemPrompt.includes('Work on Waiting'))).toBe(false)
    })

    it('cancels a paused task and frees its agent', async () => {
      const task = await startTask('Asker')
      agentFor('Asker').ask()
      await flush()
      expect(runtime.tasks.isPaused(task.id)).toBe(true)

      const result = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: task.id, reason: 'no longer needed' })
      expect(text(result)).toContain('cancelled (was paused')
      expect(runtime.tasks.isPaused(task.id)).toBe(false)
      const row = runtime.tasks.getById(task.id)!
      expect(row.status).toBe('failed')
      expect(row.resultStatus).toBe('failed')
      expect(row.errorMessage).toBe('Cancelled by strand orchestrator: no longer needed')
      expect(completed.some((c) => c.taskId === task.id)).toBe(true)
    })

    it('cancels a paused row whose agent is gone (after a restart)', async () => {
      const task = runtime.tasks.create({ name: 'Orphan', prompt: 'x', triggerType: 'agent' })
      const session = sessionManager.createSession({ type: 'task', source: 'task', parentSessionId: aliceStrand })
      runtime.tasks.update(task.id, { status: 'paused', resultStatus: 'question', sessionId: session.id })

      const result = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: task.id, reason: 'stale' })
      expect(text(result)).toContain('cancelled (was paused')
      expect(runtime.tasks.getById(task.id)!.status).toBe('failed')
    })

    it('refuses a finished task with a clear error', async () => {
      const task = await startTask('Finisher')
      agentFor('Finisher').complete('all good')
      await flush()
      expect(runtime.tasks.getById(task.id)!.status).toBe('completed')

      const result = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: task.id, reason: 'oops' })
      expect(text(result)).toMatch(/^Error: .*already completed; nothing to cancel/)
      expect(runtime.tasks.getById(task.id)!.status).toBe('completed')
    })

    it('requires a reason', async () => {
      const task = await startTask('Alpha')
      const result = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: task.id, reason: '   ' })
      expect(text(result)).toBe('Error: reason is required.')
      expect(runtime.tasks.isRunning(task.id)).toBe(true)
    })

    it('cascades to running, queued and paused sub-tasks (any depth)', async () => {
      limit = 3
      const parent = await startTask('Parent')
      const childRunning = await startTask('ChildRunning', { strand: null, parentTaskId: parent.id })
      const childPaused = await startTask('ChildPaused', { strand: null, parentTaskId: parent.id })
      agentFor('ChildPaused').ask()
      await flush()
      const grandchildQueued = await startTask('Grandchild', { strand: null, parentTaskId: childRunning.id })
      const grandchildQueuedToo = await startTask('Grandchild2', { strand: null, parentTaskId: childRunning.id })
      expect(runtime.tasks.queueInfo?.(grandchildQueuedToo.id)?.queued).toBe(true)
      const unrelated = await startTask('Unrelated')
      agentFor('Grandchild').complete()
      await flush()

      const result = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: parent.id, reason: 'abort the whole tree' })
      await flush()

      const out = text(result)
      expect(out).toContain('Also cancelled 3 sub-task(s)')
      for (const id of [parent.id, childRunning.id, childPaused.id, grandchildQueuedToo.id]) {
        expect(runtime.tasks.getById(id)!.status).toBe('failed')
      }
      expect(runtime.tasks.getById(childRunning.id)!.errorMessage)
        .toBe(`Cancelled together with parent task ${parent.id.slice(0, 8)}: Cancelled by strand orchestrator: abort the whole tree`)
      // Finished descendants and unrelated tasks are left alone.
      expect(runtime.tasks.getById(grandchildQueued.id)!.status).toBe('completed')
      expect(runtime.tasks.getById(unrelated.id)!.status).toBe('running')
      expect(result.details).toMatchObject({ cancelledSubTasks: [childRunning.id, childPaused.id, grandchildQueuedToo.id] })
    })

    it('cleans up remaining sub-tasks of an already finished parent', async () => {
      const parent = await startTask('Parent')
      const child = await startTask('Child', { strand: null, parentTaskId: parent.id })
      agentFor('Parent').complete()
      await flush()

      const result = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: parent.id, reason: 'leftovers' })
      expect(text(result)).toContain('only its remaining sub-tasks were cancelled')
      expect(runtime.tasks.getById(child.id)!.status).toBe('failed')
      expect(runtime.tasks.getById(parent.id)!.status).toBe('completed')
    })
  })

  describe('access control', () => {
    it('denies another user\'s task with the same answer as an unknown id', async () => {
      const foreign = await startTask('Foreign', { strand: bobStrand })
      for (const tool of [createCancelTaskTool, createSteerTaskTool, createGetTaskTool]) {
        const result = await tool(toolOptions()).execute('c1', { task_id: foreign.id, reason: 'x', message: 'y' })
        expect(text(result)).toMatch(/not found or not manageable/)
      }
      const unknown = await createGetTaskTool(toolOptions()).execute('c1', { task_id: 'does-not-exist' })
      expect(text(unknown)).toMatch(/not found or not manageable/)
      expect(runtime.tasks.isRunning(foreign.id)).toBe(true)
      expect(agentFor('Foreign').steerCalls).toHaveLength(0)

      // The owner can.
      currentUser = bob
      const own = await createGetTaskTool(toolOptions()).execute('c1', { task_id: foreign.id })
      expect(text(own)).toContain('Task "Foreign"')
    })

    it('denies a queued task of another user (owner resolved from the pending parent strand)', async () => {
      limit = 1
      await startTask('Busy')
      const foreign = await startTask('ForeignQueued', { strand: bobStrand })
      expect(runtime.tasks.queueInfo?.(foreign.id)?.queued).toBe(true)
      const denied = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: foreign.id, reason: 'x' })
      expect(text(denied)).toMatch(/not found or not manageable/)
      currentUser = bob
      const allowed = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: foreign.id, reason: 'mine' })
      expect(text(allowed)).toContain('cancelled')
    })

    it('denies a turn without a known user', async () => {
      const task = await startTask('Alpha')
      currentUser = undefined
      const result = await createCancelTaskTool(toolOptions()).execute('c1', { task_id: task.id, reason: 'x' })
      expect(text(result)).toMatch(/not found or not manageable/)
      expect(runtime.tasks.isRunning(task.id)).toBe(true)
    })

    it('limits a non-main persona to its own tasks', async () => {
      const mainTask = await startTask('MainOwned')
      const analystTask = await startTask('AnalystOwned', { agentId: 'analyst' })
      currentAgent = 'analyst'
      expect(text(await createGetTaskTool(toolOptions()).execute('c1', { task_id: mainTask.id }))).toMatch(/not found or not manageable/)
      expect(text(await createGetTaskTool(toolOptions()).execute('c1', { task_id: analystTask.id }))).toContain('AnalystOwned')
    })

    it('ownerless system tasks are admin-only', async () => {
      const system = await startTask('Cron run', { strand: null })
      expect(text(await createGetTaskTool(toolOptions()).execute('c1', { task_id: system.id }))).toMatch(/not found or not manageable/)
      currentUser = addUser('root', 'admin')
      expect(text(await createGetTaskTool(toolOptions()).execute('c1', { task_id: system.id }))).toContain('Cron run')
    })

    it('inside a task: only its own descendants, never itself, its parent or siblings', async () => {
      const parent = await startTask('Parent')
      const me = await startTask('Me', { strand: null, parentTaskId: parent.id })
      const sibling = await startTask('Sibling', { strand: null, parentTaskId: parent.id })
      const child = await startTask('MyChild', { strand: null, parentTaskId: me.id })
      const grandchild = await startTask('MyGrandchild', { strand: null, parentTaskId: child.id })
      const cancel = createCancelTaskTool(toolOptions())

      for (const target of [me, parent, sibling]) {
        const result = await asTask(me.id, () => cancel.execute('c1', { task_id: target.id, reason: 'x' }))
        expect(text(result)).toMatch(/not found or not manageable/)
        expect(runtime.tasks.getById(target.id)!.status).toBe('running')
      }

      const steer = await asTask(me.id, () => createSteerTaskTool(toolOptions()).execute('c1', { task_id: grandchild.id, message: 'narrow down' }))
      expect(text(steer)).toContain('Delivered')
      expect(agentFor('MyGrandchild').steerCalls[0]!.content[0]!.text).toContain(`<orchestrator_steer from="parent task ${me.id.slice(0, 8)}">`)

      const result = await asTask(me.id, () => cancel.execute('c1', { task_id: child.id, reason: 'not needed' }))
      expect(text(result)).toContain('cancelled')
      expect(runtime.tasks.getById(child.id)!.errorMessage).toBe(`Cancelled by parent task ${me.id.slice(0, 8)}: not needed`)
      expect(runtime.tasks.getById(grandchild.id)!.status).toBe('failed')
    })
  })

  describe('steer_task', () => {
    it('injects a marked orchestrator correction into a running task', async () => {
      const task = await startTask('Alpha')
      const result = await createSteerTaskTool(toolOptions()).execute('s1', { task_id: task.id, message: 'Use the v2 API, not v1.' })

      expect(text(result)).toContain('Delivered to task')
      expect(result.details).toMatchObject({ delivered: true, mode: 'steered' })
      const steer = agentFor('Alpha').steerCalls
      expect(steer).toHaveLength(1)
      expect(steer[0]!.role).toBe('user')
      expect(steer[0]!.content[0]!.text).toContain('<orchestrator_steer from="strand orchestrator">\nUse the v2 API, not v1.\n</orchestrator_steer>')
      expect(runtime.tasks.isRunning(task.id)).toBe(true)
    })

    it('appends the correction to the brief of a queued task, which then starts with it', async () => {
      limit = 1
      await startTask('Busy')
      const queued = await startTask('Waiting')

      const result = await createSteerTaskTool(toolOptions()).execute('s1', { task_id: queued.id, message: 'Only cover Germany.' })
      expect(result.details).toMatchObject({ delivered: true, mode: 'queued_prompt' })
      expect(runtime.tasks.getById(queued.id)!.prompt).toContain('Only cover Germany.')

      agentFor('Busy').complete()
      await flush()
      const started = agentFor('Waiting')
      expect(`${started.systemPrompt}\n${started.promptCalls.join('\n')}`).toContain('Only cover Germany.')
    })

    it('resumes a paused task with the correction', async () => {
      const task = await startTask('Asker')
      agentFor('Asker').ask()
      await flush()

      const result = await createSteerTaskTool(toolOptions()).execute('s1', { task_id: task.id, message: 'Use Postgres.' })
      await flush()
      expect(result.details).toMatchObject({ delivered: true, mode: 'resumed' })
      expect(runtime.tasks.isPaused(task.id)).toBe(false)
      expect(runtime.tasks.getById(task.id)!.status).toBe('running')
      expect(agentFor('Asker').promptCalls.at(-1)).toContain('Use Postgres.')
    })

    it('refuses a finished task', async () => {
      const task = await startTask('Finisher')
      agentFor('Finisher').complete()
      await flush()
      const result = await createSteerTaskTool(toolOptions()).execute('s1', { task_id: task.id, message: 'more' })
      expect(text(result)).toMatch(/^Error: .*already completed; it cannot be steered/)
    })

    it('reports non-delivery when the agent is between runs', async () => {
      const task = await startTask('Alpha')
      agentFor('Alpha').streaming = false
      const result = await createSteerTaskTool(toolOptions()).execute('s1', { task_id: task.id, message: 'x' })
      expect(result.details).toMatchObject({ delivered: false })
      expect(text(result)).toContain('Not delivered')
      expect(agentFor('Alpha').steerCalls).toHaveLength(0)
    })

    it('rejects an empty or oversized message', async () => {
      const task = await startTask('Alpha')
      expect(text(await createSteerTaskTool(toolOptions()).execute('s1', { task_id: task.id, message: ' ' }))).toBe('Error: message is required.')
      expect(text(await createSteerTaskTool(toolOptions()).execute('s1', { task_id: task.id, message: 'x'.repeat(5000) }))).toMatch(/too long/)
    })
  })

  describe('get_task', () => {
    it('shows status, model, usage and recent activity of a running task, truncated', async () => {
      const task = await startTask('Alpha')
      const row = runtime.tasks.getById(task.id)!
      for (let i = 0; i < 20; i++) {
        logToolCall(db, { sessionId: row.sessionId!, toolName: `tool_${i}`, input: JSON.stringify({ q: 'y'.repeat(1000) }), output: 'z'.repeat(5000), durationMs: 3, status: 'success' })
      }
      const result = await createGetTaskTool(toolOptions()).execute('g1', { task_id: task.id, events: 5 })
      const out = text(result)
      expect(out).toContain(`Task "Alpha" (${task.id})`)
      expect(out).toMatch(/Status: running/)
      expect(out).toContain('Trigger: agent')
      expect(out).toContain(`strand: ${aliceStrand}`)
      expect(out).toContain('Usage:')
      expect(out).toContain('Recent activity (last 5')
      expect(out).toContain('tool tool_19')
      expect(out).not.toContain('tool tool_10 ')
      expect(out.length).toBeLessThan(4000)
    })

    it('shows queue position for a queued task', async () => {
      limit = 1
      await startTask('Busy')
      const queued = await startTask('Waiting')
      const out = text(await createGetTaskTool(toolOptions()).execute('g1', { task_id: queued.id }))
      expect(out).toMatch(/Status: queued — position 1 of 1/)
      expect(out).toContain('not started')
    })

    it('shows the question of a paused task and the result of a finished one', async () => {
      const paused = await startTask('Asker')
      agentFor('Asker').ask('Which region?')
      await flush()
      const pausedOut = text(await createGetTaskTool(toolOptions()).execute('g1', { task_id: paused.id }))
      expect(pausedOut).toMatch(/Status: paused — waiting for an answer/)
      expect(pausedOut).toContain('Question: Which region?')

      const done = await startTask('Finisher')
      agentFor('Finisher').complete('Wrote report.md')
      await flush()
      const doneOut = text(await createGetTaskTool(toolOptions()).execute('g1', { task_id: done.id }))
      expect(doneOut).toContain('Status: completed')
      expect(doneOut).toContain('Result: Wrote report.md')
    })

    it('reports active sub-tasks', async () => {
      const parent = await startTask('Parent')
      const child = await startTask('Child', { strand: null, parentTaskId: parent.id })
      const out = text(await createGetTaskTool(toolOptions()).execute('g1', { task_id: parent.id, events: 0 }))
      expect(out).toContain('Sub-tasks: 1 total, 1 active')
      expect(out).toContain(child.id.slice(0, 8))
      const childOut = text(await createGetTaskTool(toolOptions()).execute('g1', { task_id: child.id, events: 0 }))
      expect(childOut).toContain(`parent task: ${parent.id}`)
    })
  })
})
