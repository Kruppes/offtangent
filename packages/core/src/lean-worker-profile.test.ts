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
import { ScheduledTaskStore } from './scheduled-task-store.js'
import {
  LEAN_SYSTEM_PROMPT,
  LEAN_TOOL_WHITELIST,
  buildLeanKickoff,
  checkLeanPreconditions,
  isLocalProvider,
  parseWorkerProfileInput,
  selectLeanTools,
} from './lean-worker-profile.js'

// Finding 3: simulate a seal whose output depends on the secret store
// (known-value redaction hitting a word of the prompt). The lean system
// prompt must not pass through it; the normal envelope still does.
const sealState = vi.hoisted(() => ({ rewrite: false }))
vi.mock('./secret-boundary.js', async (importOriginal) => {
  const original = await importOriginal() as { sealSystemText: (text: string, source: string) => string }
  return {
    ...original,
    sealSystemText: (text: string, source: string) => {
      const sealed = original.sealSystemText(text, source)
      return sealState.rewrite ? sealed.replace(/worker/g, '[SEALED:worker]') : sealed
    },
  }
})

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0) }
})

type Captured = { systemPrompt: string; tools: { name: string }[]; kickoff: string | null }
const captures: Captured[] = []

vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation((options: { initialState: { systemPrompt: string; tools: { name: string }[] } }) => {
      const messages: unknown[] = []
      const entry: Captured = { systemPrompt: options.initialState.systemPrompt, tools: options.initialState.tools, kickoff: null }
      captures.push(entry)
      return {
        subscribe: vi.fn(() => () => {}),
        prompt: vi.fn(async (text: string) => {
          entry.kickoff = text
          messages.push({ role: 'assistant', content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY:\n```json\n{"total":"12.50"}\n```' }] })
        }),
        abort: vi.fn(),
        state: { get messages() { return messages } },
      }
    }),
  }
})

const localOllama: ProviderConfig = {
  id: 'ollama-id',
  name: 'Ollama',
  type: 'ollama',
  providerType: 'ollama',
  provider: 'ollama',
  baseUrl: 'http://gpu-box.local:11434',
  apiKey: '',
  enabledModels: ['qwen3.8:27b-mlx'],
  models: [],
  status: 'connected',
  authMethod: 'api-key',
} as unknown as ProviderConfig

const cloud: ProviderConfig = { ...localOllama, id: 'cloud-id', name: 'Cloud', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com' } as unknown as ProviderConfig

const SCHEMA = '{"type":"object","required":["total"],"properties":{"total":{"type":"string"}}}'

function fakeTool(name: string) {
  return { name, label: name, description: `${name} tool`, parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) }
}

describe('lean-worker-profile (pure)', () => {
  it('parses the profile name and rejects unknown names', () => {
    expect(parseWorkerProfileInput(undefined)).toEqual({ ok: true, profile: null })
    expect(parseWorkerProfileInput('')).toEqual({ ok: true, profile: null })
    expect(parseWorkerProfileInput('lean-local')).toEqual({ ok: true, profile: 'lean_local' })
    expect(parseWorkerProfileInput('slim').ok).toBe(false)
  })

  it('treats only loopback/private hosts as local, fails closed otherwise', () => {
    expect(isLocalProvider({ providerType: 'ollama', baseUrl: 'http://192.168.1.50:11434' })).toBe(true)
    expect(isLocalProvider({ providerType: 'ollama', baseUrl: 'http://localhost:11434' })).toBe(true)
    expect(isLocalProvider({ providerType: 'ollama', baseUrl: 'http://gpu-box.local:11434' })).toBe(true)
    expect(isLocalProvider({ providerType: 'ollama', baseUrl: 'https://ollama.com' })).toBe(false)
    expect(isLocalProvider({ providerType: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe(false)
    expect(isLocalProvider({ providerType: 'ollama', baseUrl: '' })).toBe(false)
    expect(isLocalProvider({ providerType: 'ollama', baseUrl: 'not a url' })).toBe(false)
    expect(isLocalProvider(null)).toBe(false)
  })

  it('checks the effective transport, not the stored base URL (Codex counterexample)', () => {
    // A Codex provider with a stored loopback URL still talks to chatgpt.com:
    // the runtime ignores the stored URL for this OAuth preset.
    expect(isLocalProvider({ providerType: 'openai-codex', baseUrl: 'http://localhost:8080' })).toBe(false)
    expect(isLocalProvider({ providerType: 'github-copilot', baseUrl: 'http://127.0.0.1:8080' })).toBe(false)
    expect(isLocalProvider({ providerType: 'anthropic-oauth', baseUrl: 'http://localhost:8080' })).toBe(false)
    // The plain local case stays local.
    expect(isLocalProvider({ providerType: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })).toBe(true)
  })

  it('requires a schema and a local provider', () => {
    expect(checkLeanPreconditions({ provider: localOllama, outputSchema: SCHEMA })).toBeNull()
    expect(checkLeanPreconditions({ provider: localOllama, outputSchema: null })).toMatch(/requires an output_schema/)
    expect(checkLeanPreconditions({ provider: cloud, outputSchema: SCHEMA })).toMatch(/requires a local provider.*no cloud fallback/)
  })

  it('keeps the system prompt short and free of per-run data', () => {
    // ~4 chars per token: the profile promises a 1-2k token system prompt.
    expect(LEAN_SYSTEM_PROMPT.length).toBeLessThan(8000)
    expect(LEAN_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(LEAN_SYSTEM_PROMPT).not.toMatch(/\/workspace|\/data\//)
    expect(LEAN_SYSTEM_PROMPT).not.toMatch(/MEMORY\.md|agent_skills/)
  })

  it('selects whitelisted tools in whitelist order, whatever the input order', () => {
    const tools = ['web_fetch', 'shell', 'email_read', 'read_file', 'create_task', 'list_files', 'email_list'].map(fakeTool)
    expect(selectLeanTools(tools).map(t => t.name)).toEqual([...LEAN_TOOL_WHITELIST])
    expect(selectLeanTools([...tools].reverse()).map(t => t.name)).toEqual([...LEAN_TOOL_WHITELIST])
    expect(LEAN_TOOL_WHITELIST.length).toBeGreaterThanOrEqual(3)
    expect(LEAN_TOOL_WHITELIST.length).toBeLessThanOrEqual(6)
  })

  it('puts brief, schema and budget into the kickoff', () => {
    const k = buildLeanKickoff({ taskPrompt: 'Extract the total', serializedSchema: SCHEMA, budgetMinutes: 10, workspaceDir: '/workspace' })
    expect(k).toContain('<brief>\nExtract the total\n</brief>')
    expect(k).toContain(SCHEMA)
    expect(k).toContain('10 minutes')
  })
})

describe('lean-worker-profile (runner + create_task)', () => {
  const tmpFiles: string[] = []
  let db: Database
  let runner: TaskRunner

  function boundary(): TaskRuntimeTaskBoundary {
    const store = runner.getStore()
    return {
      create: (input: CreateTaskInput) => store.create(input),
      getById: (id: string) => store.getById(id),
      list: (filters?: TaskListFilters) => store.list(filters),
      update: (id: string, updates: UpdateTaskInput) => store.update(id, updates),
      start: (task: Task, provider, overrides, parentSessionId) => runner.startTask(task, provider, overrides, parentSessionId),
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

  function tool(provider: ProviderConfig) {
    return createTaskTool({
      taskRuntime: boundary(),
      getDefaultProvider: () => provider,
      resolveProvider: () => provider,
      defaultMaxDurationMinutes: 10,
      maxDurationMinutesCap: 60,
      // Production wiring (runtime-composition taskToolsOptions) passes the
      // database and the caller's interactive strand. The MCP gate refuses an
      // unknown scope (no strand / no sessions row), so the fixture uses a
      // real, clean strand row like production does.
      db,
      getParentSessionId: () => {
        db.prepare("INSERT OR IGNORE INTO sessions (id, agent_id) VALUES ('lean-parent-strand', 'main')").run()
        return 'lean-parent-strand'
      },
    })
  }

  beforeEach(() => {
    setHeuristicsOverrideForTests({ delegation: { minBriefChars: 0 } })
    const p = path.join(os.tmpdir(), `axiom-lean-worker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({ id: 'qwen3.8:27b-mlx' } as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => '',
      tools: ['web_fetch', 'shell', 'create_task', 'read_file', 'email_read', 'list_files', 'email_list', 'web_search'].map(fakeTool) as unknown as TaskRunnerOptions['tools'],
      memoryDir: undefined,
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
    }
    runner = new TaskRunner(options)
    captures.length = 0
  })

  afterEach(() => {
    setHeuristicsOverrideForTests(null)
    runner.dispose()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* cleanup only */ }
    }
    tmpFiles.length = 0
  })

  it('rejects lean_local without output_schema or on a cloud provider (no fallback)', async () => {
    const noSchema = await tool(localOllama).execute('c', { prompt: 'x', name: 'T', worker_profile: 'lean_local' })
    expect((noSchema.details as { error?: boolean }).error).toBe(true)
    expect((noSchema.content[0] as { text: string }).text).toMatch(/output_schema/)
    const onCloud = await tool(cloud).execute('c', { prompt: 'x', name: 'T', worker_profile: 'lean_local', output_schema: SCHEMA })
    expect((onCloud.details as { error?: boolean }).error).toBe(true)
    expect((onCloud.content[0] as { text: string }).text).toMatch(/local provider/)
    const unknown = await tool(localOllama).execute('c', { prompt: 'x', name: 'T', worker_profile: 'slim', output_schema: SCHEMA })
    expect((unknown.details as { error?: boolean }).error).toBe(true)
    expect(captures).toHaveLength(0)
  })

  it('runs with the fixed system prompt, whitelisted tools and the brief in the kickoff', async () => {
    const a = await tool(localOllama).execute('c', { prompt: 'Extract the total from /workspace/a.txt', name: 'A', worker_profile: 'lean_local', output_schema: SCHEMA })
    const b = await tool(localOllama).execute('c', { prompt: 'Classify /workspace/b.txt', name: 'B', worker_profile: 'lean_local', output_schema: SCHEMA, max_duration_minutes: 5 })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(captures).toHaveLength(2)
    const [ca, cb] = captures
    // Byte-identical prefix across tasks: same system prompt, same tool list.
    expect(ca.systemPrompt).toBe(cb.systemPrompt)
    expect(ca.systemPrompt).toContain('You are a local extraction worker.')
    expect(ca.systemPrompt).not.toContain('Extract the total')
    expect(ca.systemPrompt).not.toContain('<global_rules>')
    expect(ca.systemPrompt).not.toContain('<memory_reference>')
    expect(ca.tools.map(t => t.name)).toEqual([...LEAN_TOOL_WHITELIST])
    expect(cb.tools.map(t => t.name)).toEqual([...LEAN_TOOL_WHITELIST])
    expect(ca.kickoff).toContain('Extract the total from /workspace/a.txt')
    expect(ca.kickoff).toContain('"required":["total"]')
    expect(cb.kickoff).toContain('5 minutes')

    const taskA = runner.getStore().getById((a.details as { taskId: string }).taskId)!
    expect(taskA.workerProfile).toBe('lean_local')
    expect(taskA.status).toBe('completed')
    expect((b.details as { taskId: string }).taskId).toBeTruthy()
  })

  it('fails a lean task at start when the provider is not local (runner guard, e.g. cronjob path)', async () => {
    const task = runner.getStore().create({ name: 'C', prompt: 'x', triggerType: 'cronjob', provider: 'Cloud', model: 'm', workerProfile: 'lean_local', outputSchema: SCHEMA })
    try {
      await runner.startTask(task, cloud)
    } catch {
      // Some start paths reject, others mark the task failed; both are fine.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(captures).toHaveLength(0)
    const after = runner.getStore().getById(task.id)!
    expect(after.status).toBe('failed')
  })

  it('sends the lean system prompt unsealed, independent of the secret store (finding 3)', async () => {
    sealState.rewrite = true
    try {
      await tool(localOllama).execute('c', { prompt: 'Extract the total', name: 'L', worker_profile: 'lean_local', output_schema: SCHEMA })
      await tool(localOllama).execute('c', { prompt: 'Normal worker brief', name: 'N' })
      await new Promise(resolve => setTimeout(resolve, 80))
    } finally {
      sealState.rewrite = false
    }
    expect(captures).toHaveLength(2)
    const lean = captures.find(c => c.tools.length === LEAN_TOOL_WHITELIST.length && c.systemPrompt.startsWith('You are a local'))!
    expect(lean.systemPrompt).toBe(LEAN_SYSTEM_PROMPT)
    // Control: the normal envelope does go through the (rewriting) seal.
    const normal = captures.find(c => c !== lean)!
    expect(normal.systemPrompt).toContain('[SEALED:worker]')
  })

  describe('server restart recovery (finding 1)', () => {
    function orphanLeanTask() {
      const store = runner.getStore()
      const task = store.create({ name: 'Lean R', prompt: 'Extract the total from /workspace/r.txt', triggerType: 'agent', provider: 'Ollama', model: 'qwen3.8:27b-mlx', workerProfile: 'lean_local', outputSchema: SCHEMA, sessionId: 'lean-recover-session' })
      store.update(task.id, { status: 'running' })
      db.prepare("INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status) VALUES (?, 'read_file', '{}', ?, 5, 'success')")
        .run('lean-recover-session', 'PRIVATE-RAW-KONTO DE00 1234')
      return task
    }

    it('resumes on the still-configured local provider with profile and schema', async () => {
      const task = orphanLeanTask()
      const result = await runner.recoverTasks(name => (name === 'Ollama' ? localOllama : null), cloud)
      expect(result).toEqual({ resumed: 1, failed: 0 })
      await new Promise(resolve => setTimeout(resolve, 80))
      const resumed = runner.getStore().list().find(t => t.name === 'Lean R (resumed)')!
      expect(resumed).toBeDefined()
      expect(resumed.workerProfile).toBe('lean_local')
      expect(resumed.outputSchema).toBe(SCHEMA)
      expect(resumed.provider).toBe('Ollama')
      // No raw tool output in the stored resume prompt (tool names only).
      expect(resumed.prompt).not.toContain('PRIVATE-RAW-KONTO')
      expect(resumed.prompt).toContain('read_file')
      // It ran in the lean envelope.
      expect(captures).toHaveLength(1)
      expect(captures[0].systemPrompt).toBe(LEAN_SYSTEM_PROMPT)
      expect(captures[0].tools.map(t => t.name)).toEqual([...LEAN_TOOL_WHITELIST])
      expect(runner.getStore().getById(task.id)!.status).toBe('failed')
    })

    it('fails instead of falling back to the default (cloud) provider when the local provider is gone', async () => {
      const task = orphanLeanTask()
      const result = await runner.recoverTasks(() => null, cloud)
      expect(result).toEqual({ resumed: 0, failed: 1 })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(captures).toHaveLength(0)
      const after = runner.getStore().getById(task.id)!
      expect(after.status).toBe('failed')
      expect(after.errorMessage).toMatch(/no cloud fallback/)
      expect(runner.getStore().list().some(t => t.name === 'Lean R (resumed)')).toBe(false)
    })

    it('fails when the provider of that name is no longer local', async () => {
      const task = orphanLeanTask()
      const moved = { ...localOllama, baseUrl: 'https://ollama.com' } as ProviderConfig
      const result = await runner.recoverTasks(name => (name === 'Ollama' ? moved : null), cloud)
      expect(result).toEqual({ resumed: 0, failed: 1 })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(captures).toHaveLength(0)
      expect(runner.getStore().getById(task.id)!.errorMessage).toMatch(/local provider/)
    })
  })

  it('keeps the normal envelope when no profile is set', async () => {
    await tool(localOllama).execute('c', { prompt: 'Normal task brief', name: 'N' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(captures).toHaveLength(1)
    expect(captures[0].systemPrompt).toContain('Normal task brief')
    expect(captures[0].tools.map(t => t.name)).toContain('web_fetch')
  })
})

describe('scheduled task lean columns', () => {
  it('stores and returns worker_profile + output_schema', () => {
    const p = path.join(os.tmpdir(), `axiom-lean-sched-test-${Date.now()}.db`)
    const db = initDatabase(p)
    try {
      const store = new ScheduledTaskStore(db)
      const s = store.create({ name: 'S', prompt: 'p', schedule: '0 9 * * *', workerProfile: 'lean_local', outputSchema: SCHEMA, provider: 'ollama-id:qwen3.8:27b-mlx' })
      expect(s.workerProfile).toBe('lean_local')
      expect(s.outputSchema).toBe(SCHEMA)
      const plain = store.create({ name: 'P', prompt: 'p', schedule: '0 9 * * *' })
      expect(plain.workerProfile).toBeNull()
      expect(plain.outputSchema).toBeNull()
      store.update(plain.id, { workerProfile: 'lean_local', outputSchema: SCHEMA })
      expect(store.getById(plain.id)!.workerProfile).toBe('lean_local')
    } finally {
      db.close()
      try { fs.unlinkSync(p) } catch { /* cleanup only */ }
    }
  })
})
