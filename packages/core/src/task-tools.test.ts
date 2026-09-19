import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import { createTaskTool } from './task-tools.js'
import type { ProviderConfig } from './provider-config.js'
import type { Task, CreateTaskInput, UpdateTaskInput, TaskListFilters } from './task-store.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    estimateCost: vi.fn(() => 0.001),
    // The explicit-override tests pass provider/model to create_task; the real
    // resolver reads providers.json from disk, which does not exist in tests.
    resolveProviderModelInput: vi.fn((input: { provider?: string; model?: string }) => ({
      ok: true,
      providerId: input.provider ?? 'explicit-provider-id',
      providerName: input.provider ?? 'explicit-provider',
      modelId: input.model ?? 'explicit-model',
      composite: `${input.provider ?? 'explicit-provider-id'}:${input.model ?? 'explicit-model'}`,
    })),
  }
})

vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation((_options: unknown) => {
      const messages: unknown[] = []
      return {
        subscribe: vi.fn(() => () => {}),
        prompt: vi.fn(() => new Promise<void>(() => { })),
        abort: vi.fn(),
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

describe('createTaskTool', () => {
  const tmpFiles: string[] = []
  let db: Database
  let runner: TaskRunner
  let sessionManager: SessionManager

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-task-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  function buildBoundary(): TaskRuntimeTaskBoundary {
    const store = runner.getStore()
    return {
      create: (input: CreateTaskInput) => store.create(input),
      getById: (id: string) => store.getById(id),
      list: (filters?: TaskListFilters) => store.list(filters),
      update: (id: string, updates: UpdateTaskInput) => store.update(id, updates),
      start: (task: Task, provider, overrides, parentSessionId) =>
        runner.startTask(task, provider, overrides, parentSessionId),
      resume: (taskId: string, message: string) => runner.resumeTask(taskId, message),
      abort: (taskId: string, reason?: string) => runner.abortTask(taskId, reason),
      isRunning: (taskId: string) => runner.isRunning(taskId),
      getRunningIds: () => runner.getRunningTaskIds(),
      isPaused: (taskId: string) => runner.isPaused(taskId),
      getPausedIds: () => runner.getPausedTaskIds(),
      cleanupStalePaused: () => runner.cleanupStalePausedTasks(),
      recover: (getProvider, defaultProvider) => runner.recoverTasks(getProvider, defaultProvider),
    }
  }

  beforeEach(() => {
    // The thin brief gate (SPEC 10.8) is exercised in its own block below;
    // the legacy cases use one line prompts.
    setHeuristicsOverrideForTests({ delegation: { minBriefChars: 0 } })
    db = initDatabase(tmpDbPath())
    sessionManager = new SessionManager({ db })

    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      memoryDir: undefined,
      onTaskComplete: () => { },
      sessionManager,
    }
    runner = new TaskRunner(options)
  })

  afterEach(() => {
    setHeuristicsOverrideForTests(null)
    runner.dispose()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch {
        // Cleanup failures should not mask the test result.
      }
    }
    tmpFiles.length = 0
  })

  // C5 — model inheritance chain at the create_task tool level.
  it('sub-task inherits the parent task\'s model when no provider/model is given (parent > default)', async () => {
    const { runWithTaskExecutionContext } = await import('./task-execution-context.js')
    const { resolveTaskDefaultProvider } = await import('./task-provider-resolution.js')

    const parentProvider: ProviderConfig = {
      ...mockProvider,
      id: 'parent-provider-id',
      name: 'parent-provider',
      enabledModels: ['parent-pinned-model'],
    }
    const systemDefault: ProviderConfig = {
      ...mockProvider,
      id: 'system-default-id',
      name: 'system-default',
      enabledModels: ['system-default-model'],
    }

    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      // Same wiring as the composition layer: the default resolver consults
      // the ALS task context first (parent inheritance), then falls back.
      getDefaultProvider: (agentId) => resolveTaskDefaultProvider({
        agentId,
        resolveProvider: () => null,
        getSystemDefault: () => systemDefault,
      }),
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 60,
      maxDurationMinutesCap: 240,
    })

    // Execute create_task INSIDE a running task's execution context.
    const result = await runWithTaskExecutionContext(
      { provider: parentProvider, agentId: 'warren', taskId: 'parent-task' },
      () => tool.execute('call-inherit', { prompt: 'sub work', name: 'Sub' }),
    )

    const taskId = (result.details as { taskId: string }).taskId
    const task = runner.getStore().getById(taskId)!
    expect(task.provider).toBe('parent-provider')
    expect(task.model).toBe('parent-pinned-model')
    expect(task.isDefaultModel).toBe(true)
    // Attribution flows from the tool's getCurrentAgentId (absent here), not
    // silently from the ALS — the composition layer wires that explicitly.
    runner.abortTask(taskId, 'cleanup')
  })

  it('sub-task with explicit provider/model overrides the parent task\'s model (explicit > parent)', async () => {
    const { runWithTaskExecutionContext } = await import('./task-execution-context.js')

    const parentProvider: ProviderConfig = {
      ...mockProvider,
      id: 'parent-provider-id',
      name: 'parent-provider',
      enabledModels: ['parent-pinned-model'],
    }
    const explicitProvider: ProviderConfig = {
      ...mockProvider,
      id: 'explicit-provider-id',
      name: 'explicit-provider',
      enabledModels: ['explicit-model'],
    }

    const getDefaultProvider = vi.fn(() => parentProvider)
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider,
      resolveProvider: (nameOrId) => (nameOrId === 'explicit-provider-id' ? explicitProvider : null),
      defaultMaxDurationMinutes: 60,
      maxDurationMinutesCap: 240,
    })

    const result = await runWithTaskExecutionContext(
      { provider: parentProvider, agentId: 'warren', taskId: 'parent-task' },
      () => tool.execute('call-override', {
        prompt: 'sub work',
        name: 'Sub',
        provider: 'explicit-provider-id',
        model: 'explicit-model',
      }),
    )

    const taskId = (result.details as { taskId: string }).taskId
    const task = runner.getStore().getById(taskId)!
    expect(task.provider).toBe('explicit-provider')
    expect(task.model).toBe('explicit-model')
    expect(task.isDefaultModel).toBe(false)
    // The default chain (which would have returned the parent) was never used.
    expect(getDefaultProvider).not.toHaveBeenCalled()
    runner.abortTask(taskId, 'cleanup')
  })

  it('persists max_duration_minutes from the tool input onto the Task row', async () => {
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 60,
      maxDurationMinutesCap: 240,
    })

    const result = await tool.execute('call-1', {
      prompt: 'do work',
      name: 'Test',
      max_duration_minutes: 5,
    })

    const taskId = (result.details as { taskId: string }).taskId
    const task = runner.getStore().getById(taskId)!
    expect(task.maxDurationMinutes).toBe(5)
    const first = result.content[0]
    expect(first.type).toBe('text')
    expect((first as { type: 'text'; text: string }).text).toContain('Max Duration: 5 minutes')

    runner.abortTask(taskId, 'cleanup')
  })

  it('falls back to defaultMaxDurationMinutes when the caller omits max_duration_minutes', async () => {
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 240,
    })

    const result = await tool.execute('call-2', {
      prompt: 'do work',
      name: 'Default',
    })

    const taskId = (result.details as { taskId: string }).taskId
    const task = runner.getStore().getById(taskId)!
    expect(task.maxDurationMinutes).toBe(30)

    runner.abortTask(taskId, 'cleanup')
  })

  it('caps max_duration_minutes at maxDurationMinutesCap', async () => {
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 120,
    })

    const result = await tool.execute('call-3', {
      prompt: 'do work',
      name: 'Capped',
      max_duration_minutes: 9999,
    })

    const taskId = (result.details as { taskId: string }).taskId
    const task = runner.getStore().getById(taskId)!
    expect(task.maxDurationMinutes).toBe(120)

    runner.abortTask(taskId, 'cleanup')
  })

  it('the TaskRunner timeout uses the tool-supplied max_duration_minutes', async () => {
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 999,
      maxDurationMinutesCap: 9999,
    })

    const result = await tool.execute('call-4', {
      prompt: 'do work',
      name: 'BudgetCheck',
      max_duration_minutes: 1,
    })
    const taskId = (result.details as { taskId: string }).taskId

    const longAgo = new Date(Date.now() - 2 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19)
    runner.getStore().update(taskId, { startedAt: longAgo })

    const internal = runner as unknown as {
      scheduleMaxDurationTimeout: (rt: { taskId: string; timeoutTimer: unknown; startedAtMs: number }, t: { id: string; maxDurationMinutes: number | null; startedAt: string | null }) => void
      runningTasks: Map<string, { taskId: string; timeoutTimer: unknown; startedAtMs: number }>
    }
    const rt = internal.runningTasks.get(taskId)!
    const refreshed = runner.getStore().getById(taskId)!
    internal.scheduleMaxDurationTimeout(rt, refreshed)

    const updated = runner.getStore().getById(taskId)!
    expect(updated.status).toBe('failed')
    expect(updated.errorMessage).toBe('Max duration exceeded')
  })

  it('returns a tool error instead of creating a task when no default provider is configured', async () => {
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => null,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 120,
    })

    const result = await tool.execute('call-5', { prompt: 'do work', name: 'NoProvider' })

    expect(result.details).toMatchObject({ error: true })
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('No default task provider is configured')
    expect(runner.getStore().list().filter(t => t.name === 'NoProvider')).toHaveLength(0)
  })

  // Merge regression (task-tools.ts §4.2): the merged getDefaultProvider has
  // the union signature (agentId?: string | null) => ProviderConfig | null.
  // This asserts BOTH halves at once: create_task passes the task's agentId
  // into the resolver (persona-aware, fork) AND a null return surfaces the
  // upstream 0.27.0 no-provider error instead of crashing.
  it('passes the task agentId into getDefaultProvider and honors a null return', async () => {
    const seenAgentIds: (string | null | undefined)[] = []
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: (agentId) => {
        seenAgentIds.push(agentId)
        return null // no provider configured for this persona
      },
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 120,
    })

    const { runWithTaskExecutionContext } = await import('./task-execution-context.js')
    const result = await runWithTaskExecutionContext(
      { provider: mockProvider, agentId: 'warren', taskId: 'parent-task' },
      () => tool.execute('call-persona-null', { prompt: 'do work', name: 'PersonaNull' }),
    )

    // The resolver was consulted with an agentId (persona-aware path).
    expect(seenAgentIds.length).toBe(1)
    // A null return must become a clean tool error, not a throw.
    expect(result.details).toMatchObject({ error: true })
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('No default task provider is configured')
    expect(runner.getStore().list().filter(t => t.name === 'PersonaNull')).toHaveLength(0)
  })

  describe('attached_skills', () => {
    let skillsTmpDir: string
    let originalDataDir: string | undefined

    beforeEach(() => {
      originalDataDir = process.env.DATA_DIR
      skillsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-task-tools-skills-'))
      process.env.DATA_DIR = skillsTmpDir

      const nitterDir = path.join(skillsTmpDir, 'skills_agent', 'nitter')
      fs.mkdirSync(nitterDir, { recursive: true })
      fs.writeFileSync(
        path.join(nitterDir, 'SKILL.md'),
        '---\nname: nitter\ndescription: Fetch tweets via Nitter.\n---\n\n# Nitter Skill\nAlways rotate Nitter mirrors.',
        'utf-8',
      )
    })

    afterEach(() => {
      if (originalDataDir === undefined) {
        delete process.env.DATA_DIR
      } else {
        process.env.DATA_DIR = originalDataDir
      }
      try { fs.rmSync(skillsTmpDir, { recursive: true, force: true }) } catch {
        // Cleanup failures should not mask the test result.
      }
    })

    async function runToolCapturingSystemPrompt(
      params: Record<string, unknown>,
    ): Promise<{ systemPrompt: string; details: Record<string, unknown> }> {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      type Captured = { initialState: { systemPrompt: string } }
      const captured: { value: Captured | null } = { value: null }
      MockAgent.mockImplementationOnce((agentOptions: unknown) => {
        captured.value = agentOptions as Captured
        const messages: unknown[] = []
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: ok' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const tool = createTaskTool({
        taskRuntime: buildBoundary(),
        getDefaultProvider: () => mockProvider,
        resolveProvider: () => mockProvider,
        defaultMaxDurationMinutes: 30,
        maxDurationMinutesCap: 120,
      })

      const result = await tool.execute('call-skills', params)
      await new Promise(resolve => setTimeout(resolve, 50))

      if (!captured.value) throw new Error('Agent was not instantiated')
      return {
        systemPrompt: captured.value.initialState.systemPrompt,
        details: result.details as Record<string, unknown>,
      }
    }

    it('injects the SKILL.md content of attached skills into the task system prompt', async () => {
      const { systemPrompt, details } = await runToolCapturingSystemPrompt({
        prompt: 'do work',
        name: 'WithSkills',
        attached_skills: ['nitter'],
      })

      expect(systemPrompt.startsWith('<attached_skills>')).toBe(true)
      expect(systemPrompt).toContain('<skill name="nitter">')
      expect(systemPrompt).toContain('Always rotate Nitter mirrors.')
      expect(systemPrompt).toContain('do work')
      expect(details.attachedSkills).toEqual(['nitter'])
    })

    it('normalizes attached_skills (trim + dedupe + drop empty)', async () => {
      const { details } = await runToolCapturingSystemPrompt({
        prompt: 'do work',
        name: 'NormalizedSkills',
        attached_skills: ['nitter', '  nitter  ', ''],
      })

      expect(details.attachedSkills).toEqual(['nitter'])
    })

    it('skips a missing SKILL.md and still starts the task', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { systemPrompt, details } = await runToolCapturingSystemPrompt({
          prompt: 'do work',
          name: 'MissingSkill',
          attached_skills: ['nitter', 'does-not-exist'],
        })

        expect(systemPrompt).toContain('<skill name="nitter">')
        expect(systemPrompt).not.toContain('<skill name="does-not-exist">')
        expect(details.error).not.toBe(true)
        const warned = warnSpy.mock.calls.some(args => String(args[0] ?? '').includes('does-not-exist'))
        expect(warned).toBe(true)
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('adds no attached-skills block when the parameter is omitted', async () => {
      const { systemPrompt, details } = await runToolCapturingSystemPrompt({
        prompt: 'do work',
        name: 'NoSkills',
      })

      expect(systemPrompt).not.toContain('<attached_skills>')
      expect(details.attachedSkills).toBeNull()
    })
  })

  describe('output_schema and context_mode (SPEC 11.6)', () => {
    function toolWithDb() {
      return createTaskTool({
        taskRuntime: buildBoundary(),
        getDefaultProvider: () => mockProvider,
        resolveProvider: () => mockProvider,
        defaultMaxDurationMinutes: 60,
        maxDurationMinutesCap: 240,
        getParentSessionId: () => 'strand-1',
        db,
      })
    }

    function seedStrand(): void {
      db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'h')").run()
      db.prepare("INSERT INTO sessions (id, user_id, source, type) VALUES ('strand-1', 1, 'web', 'interactive')").run()
      const ins = db.prepare("INSERT INTO chat_messages (id, session_id, user_id, role, content) VALUES (?, 'strand-1', 1, ?, ?)")
      ins.run(1, 'user', 'We need to migrate billing to kubernetes')
      ins.run(2, 'assistant', 'Start with postgres, then the service')
      ins.run(3, 'user', 'And redis?')
      ins.run(4, 'assistant', 'Redis stays outside for now')
    }

    it('stores a valid output_schema and rejects an invalid one', async () => {
      seedStrand()
      const tool = toolWithDb()
      const bad = await tool.execute('c', { prompt: 'do work', name: 'T', output_schema: '{not json' })
      expect((bad.details as { error?: boolean }).error).toBe(true)
      const notObject = await tool.execute('c', { prompt: 'do work', name: 'T', output_schema: '{"type":"array"}' })
      expect((notObject.details as { error?: boolean }).error).toBe(true)

      const ok = await tool.execute('c', { prompt: 'do work', name: 'T', output_schema: '{"type":"object","required":["findings"],"properties":{"findings":{"type":"array"}}}' })
      const taskId = (ok.details as { taskId: string }).taskId
      const task = runner.getStore().getById(taskId)!
      expect(task.outputSchema).toContain('"required":["findings"]')
      expect(task.contextMode).toBe('clean')
      expect((ok.content[0] as { text: string }).text).toContain('output_schema enforced')
      runner.abortTask(taskId, 'cleanup')
    })

    it('prepends a selected context block with summary, facts and messages by id', async () => {
      seedStrand()
      db.prepare("INSERT INTO memories (user_id, session_id, content, source, agent_id) VALUES (1, 'x', 'Billing runs on postgres 15', 'extracted_fact', 'main')").run()
      const tool = toolWithDb()
      const res = await tool.execute('c', {
        prompt: 'Evaluate the migration order',
        name: 'T',
        context_mode: 'selected',
        context: { message_ids: [1, 4, 999], memory_query: 'postgres billing' },
      })
      const taskId = (res.details as { taskId: string }).taskId
      const task = runner.getStore().getById(taskId)!
      expect(task.contextMode).toBe('selected')
      expect(task.prompt.startsWith('<delegation_context mode="selected" strand="strand-1">')).toBe(true)
      expect(task.prompt).toContain('[msg:1] User: We need to migrate billing to kubernetes')
      expect(task.prompt).toContain('[msg:4] Assistant: Redis stays outside for now')
      expect(task.prompt).not.toContain('[msg:2]')
      expect(task.prompt).toContain('Billing runs on postgres 15')
      expect(task.prompt.endsWith('Evaluate the migration order')).toBe(true)
      expect((res.details as { droppedMessageIds: number[] }).droppedMessageIds).toEqual([999])
      runner.abortTask(taskId, 'cleanup')
    })

    it('fork passes the strand window under the budget and clean passes nothing', async () => {
      seedStrand()
      const tool = toolWithDb()
      const fork = await tool.execute('c', { prompt: 'Decide the order', name: 'T', context_mode: 'fork' })
      const forkTask = runner.getStore().getById((fork.details as { taskId: string }).taskId)!
      expect(forkTask.prompt).toContain('<strand_window>')
      expect(forkTask.prompt).toContain('[msg:1] User:')
      expect(forkTask.prompt).toContain('[msg:4] Assistant:')
      runner.abortTask(forkTask.id, 'cleanup')

      const clean = await tool.execute('c', { prompt: 'Review the result', name: 'T', context_mode: 'clean' })
      const cleanTask = runner.getStore().getById((clean.details as { taskId: string }).taskId)!
      expect(cleanTask.prompt).toBe('Review the result')
      runner.abortTask(cleanTask.id, 'cleanup')

      const invalid = await tool.execute('c', { prompt: 'x', name: 'T', context_mode: 'everything' })
      expect((invalid.details as { error?: boolean }).error).toBe(true)
    })

    it('rejects a thin brief without context when the gate is on', async () => {
      setHeuristicsOverrideForTests({ delegation: { minBriefChars: 200 } })
      seedStrand()
      const tool = toolWithDb()
      const thin = await tool.execute('c', { prompt: 'do work', name: 'T' })
      expect((thin.content[0] as { text: string }).text).toContain('brief too thin')
      const withFork = await tool.execute('c', { prompt: 'do work', name: 'T', context_mode: 'fork' })
      expect((withFork.details as { taskId?: string }).taskId).toBeTruthy()
      runner.abortTask((withFork.details as { taskId: string }).taskId, 'cleanup')
    })
  })
  /**
   * Repro for "a wave is running but the strand looks dead": a task that
   * delegates a sub-task. The sub-task session gets NO parent session (that is
   * what the background task tools pass), so the only thing that can connect
   * it to the strand is the task-parent edge written here.
   */
  describe('strand visibility of sub-tasks', () => {
    it('records the delegating task on a sub-task and puts it in the strand tree', async () => {
      const { runWithTaskExecutionContext } = await import('./task-execution-context.js')
      const { buildStrandTaskTree } = await import('./task-tree.js')

      const strand = sessionManager.createSession({ type: 'interactive', source: 'web' }).id

      const tool = createTaskTool({
        taskRuntime: buildBoundary(),
        getDefaultProvider: () => mockProvider,
        resolveProvider: () => mockProvider,
        defaultMaxDurationMinutes: 60,
        maxDurationMinutesCap: 240,
        // Top level: the interactive strand is the parent session.
        getParentSessionId: () => strand,
      })

      const top = await tool.execute('call-top', { prompt: 'wave work', name: 'Wave' })
      const topId = (top.details as { taskId: string }).taskId

      // The sub-task is created from INSIDE the wave task, and its own task
      // tools pass null as parent session (background context).
      const subTool = createTaskTool({
        taskRuntime: buildBoundary(),
        getDefaultProvider: () => mockProvider,
        resolveProvider: () => mockProvider,
        defaultMaxDurationMinutes: 60,
        maxDurationMinutesCap: 240,
        getParentSessionId: () => null,
      })
      const sub = await runWithTaskExecutionContext(
        { provider: mockProvider, agentId: 'main', taskId: topId },
        () => subTool.execute('call-sub', { prompt: 'sub work', name: 'Sub' }),
      )
      const subId = (sub.details as { taskId: string }).taskId

      expect(runner.getStore().getById(subId)!.triggerSourceId).toBe(topId)

      const tree = buildStrandTaskTree(db, strand, { include: 'all' })
      expect(tree.tasks.map(t => t.name)).toEqual(['Wave', 'Sub'])
      expect(tree.tasks.find(t => t.id === subId)!.parentTaskId).toBe(topId)
      expect(tree.tasks.find(t => t.id === subId)!.depth).toBe(1)

      runner.abortTask(subId, 'cleanup')
      runner.abortTask(topId, 'cleanup')
    })
  })
  // W5/P2 — continuation_of: the successor gets the predecessor's final state.
  describe('continuation_of', () => {
    function tool() {
      return createTaskTool({
        taskRuntime: buildBoundary(),
        getDefaultProvider: () => mockProvider,
        resolveProvider: () => mockProvider,
        defaultMaxDurationMinutes: 60,
        maxDurationMinutesCap: 240,
      })
    }

    it('injects the predecessor handoff as a marked block ahead of the new brief', async () => {
      const store = runner.getStore()
      const predecessor = store.create({ name: 'W5 part one', prompt: 'do part one', triggerType: 'agent' })
      store.update(predecessor.id, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: 'Ran out of time.',
        handoff: 'Open: packages/core/src/task-runner.ts still needs the wrap-up timer',
      })

      const result = await tool().execute('call-cont', {
        prompt: 'finish part one',
        name: 'W5 part two',
        continuation_of: predecessor.id,
      })

      expect((result.details as { continuationOf: string }).continuationOf).toBe(predecessor.id)
      const taskId = (result.details as { taskId: string }).taskId
      const created = store.getById(taskId)!
      expect(created.prompt).toContain(`<continuation_of task_id="${predecessor.id}"`)
      expect(created.prompt).toContain('still needs the wrap-up timer')
      // The brief itself stays intact and comes after the block.
      expect(created.prompt.indexOf('</continuation_of>')).toBeLessThan(created.prompt.indexOf('finish part one'))
      runner.abortTask(taskId, 'cleanup')
    })

    it('falls back to the predecessor summary when no handoff was written', async () => {
      const store = runner.getStore()
      const predecessor = store.create({ name: 'Summary only', prompt: 'p', triggerType: 'agent' })
      store.update(predecessor.id, { status: 'completed', resultStatus: 'completed', resultSummary: 'Shipped the parser, docs are open.' })

      const result = await tool().execute('call-cont-2', { prompt: 'write the docs', name: 'Docs', continuation_of: predecessor.id })
      const taskId = (result.details as { taskId: string }).taskId
      expect(runner.getStore().getById(taskId)!.prompt).toContain('Shipped the parser, docs are open.')
      runner.abortTask(taskId, 'cleanup')
    })

    it('fails fast on an unknown predecessor instead of starting a context-less task', async () => {
      const before = runner.getStore().list().length
      const result = await tool().execute('call-cont-3', { prompt: 'work', name: 'Orphan', continuation_of: 'does-not-exist' })
      expect(JSON.stringify(result.content)).toContain('continuation_of task \\"does-not-exist\\" not found')
      expect((result.details as { error?: boolean }).error).toBe(true)
      expect(runner.getStore().list()).toHaveLength(before)
    })

    it('is optional — an empty value behaves like no continuation', async () => {
      const result = await tool().execute('call-cont-4', { prompt: 'plain work', name: 'Plain', continuation_of: '  ' })
      const taskId = (result.details as { taskId: string }).taskId
      const created = runner.getStore().getById(taskId)!
      expect(created.prompt).toBe('plain work')
      expect((result.details as { continuationOf: string | null }).continuationOf).toBeNull()
      runner.abortTask(taskId, 'cleanup')
    })
  })
})
