/**
 * Review S0-A-2, Auflage 3: the observed orchestrator scenario on the REAL
 * injection path, not a hand-built callback turn.
 *
 *   TaskRunner finishes a task
 *     -> onTaskComplete(taskId, injection)            (task-runner.ts, outside the task ALS context)
 *     -> enqueueTaskInjection(...) row, kind task_result (task-injection-queue.ts, W4 "persist first")
 *     -> AgentCore.injectTaskResult(payload, user, strand, rowId, agent)
 *        -> per-strand turn queue, type 'task_injection'
 *        -> processTaskInjection -> bindToolTurn -> runtime.streamPrompt(injection)
 *     -> the model of that chat turn calls steer_task on ANOTHER own task.
 *
 * This mirrors `deliverInjectionRun` in web-backend/bootstrap/runtime-composition.ts
 * (the strand/feed decision of `routeTaskOutcome` lives in the backend and is
 * covered by task-outcome tests there). The task-control tools are wired
 * exactly like the interactive tool set in runtime-composition.ts:
 * `getCurrentUserId: () => agentCore.getCurrentToolUserId()`.
 * Only the LLM is scripted: pi-agent-core for the background tasks and
 * `createAgentRuntime().streamPrompt` for the chat turn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { createTaskRuntime } from './task-runtime.js'
import type { TaskRuntimeBoundary } from './task-runtime.js'
import { SessionManager } from './session-manager.js'
import type { ProviderConfig } from './provider-config.js'
import { getCurrentTaskExecutionContext, runWithTaskExecutionContext } from './task-execution-context.js'
import { createTaskControlTools } from './task-control-tools.js'
import { enqueueTaskInjection, getTaskInjection } from './task-injection-queue.js'
import { AgentCore } from './agent.js'
import type { Task } from './task-store.js'

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

interface TaskAgentHandle {
  systemPrompt: string
  steerCalls: Array<{ role: string; content: Array<{ type: string; text: string }> }>
  complete: (summary?: string) => void
}

const hoisted = vi.hoisted(() => ({
  agents: [] as TaskAgentHandle[],
  /** Script of the chat turn's model: called with the injection text. */
  chatModel: null as null | ((injection: string) => Promise<string>),
  chatPrompts: [] as string[],
}))

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation((options: { initialState?: { systemPrompt?: string } }) => {
    const messages: unknown[] = []
    let settle: (() => void) | null = null
    let streaming = false
    const handle: TaskAgentHandle = {
      systemPrompt: String(options?.initialState?.systemPrompt ?? ''),
      steerCalls: [],
      complete: (summary = 'Done') => {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: `STATUS: completed\nSUMMARY: ${summary}` }] })
        settle?.()
      },
    }
    hoisted.agents.push(handle)
    return {
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(() => {
        streaming = true
        return new Promise<void>((resolve) => {
          settle = () => { settle = null; streaming = false; resolve() }
        })
      }),
      steer: vi.fn((msg: TaskAgentHandle['steerCalls'][number]) => { handle.steerCalls.push(msg) }),
      abort: vi.fn(() => { settle?.() }),
      state: {
        get messages() { return messages },
        get isStreaming() { return streaming },
      },
    }
  }),
}))

// The chat turn's model. Everything around it (queue, strand runtime choice,
// tool-turn binding) is the real AgentCore.
vi.mock('./agent-runtime.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    createAgentRuntime: vi.fn(() => ({
      streamPrompt: async function* (text: string) {
        hoisted.chatPrompts.push(text)
        const reply = hoisted.chatModel ? await hoisted.chatModel(text) : 'ok'
        yield { type: 'text', text: reply }
        yield { type: 'done' }
      },
      retryLastTurn: async function* () { yield { type: 'done' } },
      refreshSystemPrompt: vi.fn(),
      getCurrentTimeContext: vi.fn(() => '<current_time>Current time: 12:00 (UTC)</current_time>'),
      swapProvider: vi.fn(),
      getProviderManager: vi.fn(() => undefined),
      clearMessages: vi.fn(),
      abort: vi.fn(),
      getStateSnapshot: vi.fn(() => ({ modelId: 'mock-model', toolNames: [], messageCount: 0 })),
      getCurrentModel: vi.fn(() => ({ id: 'mock-model' })),
      getCurrentApiKey: vi.fn(() => 'mock-key'),
      setThinkingLevel: vi.fn(),
    })),
  }
})

vi.mock('./memory.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    ensureMemoryStructure: vi.fn(),
    ensureConfigStructure: vi.fn(),
    assembleSystemPrompt: vi.fn(() => 'test system prompt'),
    appendToDailyFile: vi.fn(),
  }
})

vi.mock('./config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
    ensureConfigTemplates: vi.fn(),
  }
})

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

function chatModelDef() {
  return {
    id: 'gpt-4o',
    name: 'GPT-4o',
    api: 'openai-completions' as const,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text' as const],
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n')
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('task_injection -> real chat turn -> steer_task on another own task (review S0-A-2 / Auflage 3)', () => {
  let tmpDir: string
  let previousDataDir: string | undefined
  let db: Database
  let runtime: TaskRuntimeBoundary
  let agentCore: AgentCore
  let chatTools: ReturnType<typeof createTaskControlTools>
  let alice: number
  let aliceStrand: string
  const deliveries: Array<Promise<void>> = []
  const injectionRows: string[] = []
  let callbackContextTaskId: string | null | undefined

  async function startTask(name: string, parentTaskId?: string): Promise<Task> {
    const task = runtime.tasks.create({ name, prompt: `Work on ${name}`, triggerType: 'agent', triggerSourceId: parentTaskId })
    await runtime.tasks.start(task, provider, undefined, aliceStrand)
    await flush()
    return runtime.tasks.getById(task.id)!
  }

  function agentFor(name: string): TaskAgentHandle {
    const agent = hoisted.agents.find((a) => a.systemPrompt.includes(`Work on ${name}`))
    if (!agent) throw new Error(`no agent for ${name}`)
    return agent
  }

  beforeEach(() => {
    hoisted.agents.length = 0
    hoisted.chatPrompts.length = 0
    hoisted.chatModel = null
    deliveries.length = 0
    injectionRows.length = 0
    callbackContextTaskId = undefined
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-injection-turn-'))
    previousDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmpDir
    db = initDatabase(path.join(tmpDir, 'axiom.db'))
    const sessionManager = new SessionManager({ db })
    alice = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('alice', 'x', 'user').lastInsertRowid)
    aliceStrand = sessionManager.getOrCreateSession(String(alice), 'web', 'main').id

    runtime = createTaskRuntime({
      db,
      runner: {
        buildModel: () => ({} as never),
        getApiKey: async () => 'test-key',
        tools: [],
        sessionManager,
        getMaxConcurrentTasks: () => 0,
        getProviderTaskLimits: () => ({ perProvider: 0 }),
        // deliverInjectionRun of runtime-composition.ts, minus the
        // strand/feed routing: persist the row, then start the strand turn.
        onTaskComplete: (taskId, injection) => {
          callbackContextTaskId = getCurrentTaskExecutionContext()?.taskId ?? null
          const row = enqueueTaskInjection(db, {
            taskId,
            kind: 'task_result',
            userId: alice,
            agentId: 'main',
            sessionId: aliceStrand, // the lineage strand routeTaskOutcome resolves
            payload: injection,
          })
          injectionRows.push(row.id)
          deliveries.push(agentCore.injectTaskResult(row.payload, String(row.userId), row.sessionId, row.id, row.agentId ?? 'main'))
        },
      },
      scheduler: { getDefaultProvider: () => null, resolveProvider: () => null },
    })

    chatTools = createTaskControlTools({
      taskRuntime: runtime.tasks,
      db,
      getCurrentUserId: () => agentCore?.getCurrentToolUserId(),
      getCurrentAgentId: () => agentCore?.getCurrentToolAgentId(),
    })
    agentCore = new AgentCore({
      model: chatModelDef(),
      apiKey: 'sk-test',
      db,
      // The interactive tool set as runtime-composition.ts wires it.
      tools: chatTools,
    })
  })

  afterEach(async () => {
    runtime.dispose()
    await flush()
    await agentCore.dispose()
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // 'ended from inside its parent task' is the leaking path of A4: the parent
  // (still running) cancels its sub-task with cancel_task, so onTaskComplete
  // fires inside the parent's task execution context. Without
  // runOutsideTaskExecutionContext (task-runner.ts) the injected strand turn
  // inherits that context and steer_task treats the caller as the parent task.
  const triggers = ['normal completion', 'ended from inside its parent task'] as const
  for (const trigger of triggers) it(`the injected turn of the strand steers ANOTHER own task through the real tool (${trigger})`, async () => {
    const parent = trigger === 'normal completion' ? null : await startTask('NotifierParent')
    const notifier = await startTask('NotifierRun', parent?.id)
    const other = await startTask('OtherOwnRun')
    expect(runtime.tasks.isRunning(other.id)).toBe(true)

    const seen: { userId?: number; agentId?: string; taskCtx?: string | null; steer?: string; get?: string } = {}
    // The same tool instances the AgentCore was built with.
    const byName = (name: string) => chatTools.find((t) => t.name === name)!
    hoisted.chatModel = async (injection) => {
      // Inside the strand turn the queue started for the injection.
      seen.userId = agentCore.getCurrentToolUserId()
      seen.agentId = agentCore.getCurrentToolAgentId()
      seen.taskCtx = getCurrentTaskExecutionContext()?.taskId ?? null
      expect(injection).toContain(notifier.id)
      seen.get = text(await byName('get_task').execute('g1', { task_id: other.id }) as never)
      seen.steer = text(await byName('steer_task').execute('s1', { task_id: other.id, message: 'focus on the tests' }) as never)
      return 'steered the other run'
    }

    if (parent) {
      const cancel = chatTools.find((t) => t.name === 'cancel_task')!
      const res = await runWithTaskExecutionContext({ provider: null, taskId: parent.id, userId: alice, agentId: null }, () =>
        cancel.execute('p1', { task_id: notifier.id, reason: 'notifier done' }))
      expect(text(res as never)).toContain('cancelled')
    } else {
      agentFor('NotifierRun').complete('notifier done')
    }
    await flush()
    expect(deliveries).toHaveLength(1)
    await deliveries[0]
    await flush()

    expect(runtime.tasks.getById(notifier.id)!.status).toBe(parent ? 'failed' : 'completed')
    expect(callbackContextTaskId).toBeNull()
    // Exactly one real chat turn ran, with the task_injection payload.
    expect(hoisted.chatPrompts).toHaveLength(1)
    if (parent) {
      // S0-A third review: a cancelled run's injection carries the error
      // class, never the free-text cancel reason.
      expect(hoisted.chatPrompts[0]).toContain('Task aborted by the runner, error class: cancelled')
      expect(hoisted.chatPrompts[0]).not.toContain('notifier done')
    } else {
      expect(hoisted.chatPrompts[0]).toContain('notifier done')
    }
    const turn = db.prepare("SELECT trigger, status, session_id FROM strand_turns WHERE trigger = 'task_injection'").all() as Array<{ trigger: string; status: string; session_id: string }>
    expect(turn).toHaveLength(1)
    expect(turn[0]!.session_id).toBe(aliceStrand)
    expect(turn[0]!.status).toBe('completed')
    expect(getTaskInjection(db, injectionRows[0]!)).not.toBeNull()

    // The turn ran as the strand owner, not as the finished task.
    expect(seen.userId).toBe(alice)
    expect(seen.agentId).toBe('main')
    expect(seen.taskCtx).toBeNull()
    expect(seen.get).toContain('OtherOwnRun')
    expect(seen.get).not.toMatch(/not found or not manageable/)
    expect(seen.steer).toContain('Delivered')
    expect(agentFor('OtherOwnRun').steerCalls.at(-1)?.content[0]?.text).toContain('focus on the tests')
    expect(runtime.tasks.isRunning(other.id)).toBe(true)
  })
})
