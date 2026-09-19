import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, TaskStore, initTasksTable } from '@axiom/core'
import type { AgentCore, Database, Task, ProviderConfig } from '@axiom/core'
import {
  MemoryConsolidationScheduler,
  DEFAULT_CONSOLIDATION_SETTINGS,
  buildConsolidationTaskPrompt,
  listPersonaConsolidationTargets,
} from './memory-consolidation-scheduler.js'

let tempDataDir: string
let previousDataDir: string | undefined
let db: Database

function writeConfig(name: string, value: object): void {
  const configDir = path.join(tempDataDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, name), JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-provider',
    name: 'TestProvider',
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    enabledModels: ['gpt-4o'],
    ...overrides,
  }
}

function createMockTaskRuntime(taskStore: TaskStore) {
  const startedTasks: Array<{ task: Task; provider: ProviderConfig }> = []
  let taskCompletionCallback: ((taskId: string) => void) | null = null

  return {
    startedTasks,
    setTaskCompletionCallback(cb: (taskId: string) => void) {
      taskCompletionCallback = cb
    },
    create: vi.fn((input) => taskStore.create(input)),
    getById: vi.fn((taskId: string) => taskStore.getById(taskId)),
    start: vi.fn(async (task: Task, provider: ProviderConfig) => {
      startedTasks.push({ task, provider })
      if (taskCompletionCallback) {
        setTimeout(() => taskCompletionCallback?.(task.id), 10)
      }
      return task.id
    }),
  }
}

beforeEach(() => {
  tempDataDir = path.join(os.tmpdir(), `axiom-consolidation-scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(tempDataDir, { recursive: true })
  previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  initTasksTable(db)
})

afterEach(() => {
  if (previousDataDir !== undefined) {
    process.env.DATA_DIR = previousDataDir
  } else {
    delete process.env.DATA_DIR
  }
  if (tempDataDir) {
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  }
})

describe('MemoryConsolidationScheduler', () => {
  describe('constructor and basic lifecycle', () => {
    it('starts and stops without errors', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      scheduler.start()
      scheduler.stop()
    })

    it('restart reloads settings', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      scheduler.start()

      writeConfig('settings.json', {
        memoryConsolidation: { enabled: true, runAtHour: 4 },
      })

      scheduler.restart()
      const snapshot = scheduler.getSnapshot()
      expect(snapshot.enabled).toBe(true)
      expect(snapshot.runAtHour).toBe(4)

      scheduler.stop()
    })
  })

  describe('getSnapshot', () => {
    it('returns default values initially', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      const snapshot = scheduler.getSnapshot()

      expect(snapshot.enabled).toBe(DEFAULT_CONSOLIDATION_SETTINGS.enabled)
      expect(snapshot.runAtHour).toBe(DEFAULT_CONSOLIDATION_SETTINGS.runAtHour)
      expect(snapshot.lookbackDays).toBe(DEFAULT_CONSOLIDATION_SETTINGS.lookbackDays)
      expect(snapshot.lastRun).toBeNull()
      expect(snapshot.lastResult).toBeNull()
    })
  })

  describe('executeConsolidation via runNow', () => {
    it('returns error result when task runtime is not available', async () => {
      const scheduler = new MemoryConsolidationScheduler({ db })

      const result = await scheduler.runNow()

      expect(result.updated).toBe(false)
      expect(result.reason).toContain('Task runtime not available')
    })

    it('returns error result when no provider is available', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => null,
      })

      const result = await scheduler.runNow()

      expect(result.updated).toBe(false)
      expect(result.reason).toContain('No provider available')
      expect(taskRuntime.start).not.toHaveBeenCalled()
    })

    it('creates and starts a consolidation task via task runtime boundary', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: 'Nothing to report.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      const result = await scheduler.runNow()

      expect(taskRuntime.create).toHaveBeenCalledOnce()
      expect(taskRuntime.start).toHaveBeenCalledOnce()

      const startedTask = taskRuntime.startedTasks[0]
      // Manual runNow() always includes the compaction pass
      expect(startedTask.task.name).toBe('Nightly Memory Consolidation + Compaction')
      expect(startedTask.task.prompt).toContain('Weekly compaction run')
      expect(startedTask.task.triggerType).toBe('consolidation')
      expect(startedTask.task.triggerSourceId).toBe('memory-consolidation')
      expect(startedTask.task.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(startedTask.provider).toBe(provider)

      expect(startedTask.task.prompt).toContain('nightly memory consolidation')
      expect(startedTask.task.prompt).toContain('daily files')
      expect(startedTask.task.prompt).toContain('MEMORY.md')
      expect(startedTask.task.prompt).toContain('project notes')
      expect(startedTask.task.prompt).toContain('user profiles')
      expect(startedTask.task.prompt).toContain('read_chat_history')
      expect(startedTask.task.prompt).toContain('Additional input: Extracted Facts')
      expect(startedTask.task.prompt).toContain('search_memories')
      expect(startedTask.task.prompt).toContain('Do NOT write to the memories table')
      expect(startedTask.task.prompt).toContain('if no relevant facts are found, continue with the daily files alone as before')
      expect(startedTask.task.prompt).toContain('Consolidation Rules')
      expect(startedTask.task.prompt).toContain('Memory Consolidation Rules')

      expect(result.updated).toBe(false)
    })

    it('completes silently when task finishes with silent status', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: 'Nothing to update.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
          promptTokens: 100,
          completionTokens: 50,
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      const result = await scheduler.runNow()

      expect(result.updated).toBe(false)
      expect(result.usage).toEqual({ input: 100, output: 50 })
    })

    it('refreshes system prompt after task completion when agentCore is set', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()
      const mockAgentCore = { refreshSystemPrompt: vi.fn() }

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'completed',
          resultSummary: 'Updated MEMORY.md.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        agentCore: mockAgentCore as unknown as AgentCore,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      await scheduler.runNow()

      expect(mockAgentCore.refreshSystemPrompt).toHaveBeenCalledOnce()
    })

    it('deduplicates concurrent runNow calls', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: 'Done.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      const [result1, result2] = await Promise.all([
        scheduler.runNow(),
        scheduler.runNow(),
      ])

      expect(taskRuntime.start).toHaveBeenCalledOnce()
      expect(result1).toBe(result2)
    })

    it('records lastRun and lastResult after execution', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      expect(scheduler.getSnapshot().lastRun).toBeNull()

      await scheduler.runNow()

      const snapshot = scheduler.getSnapshot()
      expect(snapshot.lastRun).not.toBeNull()
      expect(snapshot.lastResult).not.toBeNull()
    })

    it('logs activity to tool_calls table', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      await scheduler.runNow()

      const rows = db.prepare(
        "SELECT * FROM tool_calls WHERE tool_name = 'memory_consolidation'"
      ).all() as Array<{ session_id: string }>
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(rows[0].session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })
  })

  describe('scoped persona memory (RC5 multi-persona bleeding)', () => {
    function makeTodayDailyContent(): { today: string; content: string } {
      const today = new Date().toISOString().split('T')[0]
      return {
        today,
        content: `# Daily Memory — ${today}\n\n## 09:00\n\nWarren scanned the portfolio.\n`,
      }
    }

    it('buildConsolidationTaskPrompt scopes persona runs to their memory root', () => {
      const prompt = buildConsolidationTaskPrompt(3, 'Be selective.', {
        memoryDir: '/data/agents/warren/memory',
        agentId: 'warren',
      })
      expect(prompt).toContain('persona agent "warren" ONLY')
      expect(prompt).toContain('/data/agents/warren/memory/MEMORY.md')
      expect(prompt).toContain("NEVER read from or write to the main agent's memory at /data/memory/")
    })

    it('persona compaction targets the persona memory root, never main', () => {
      const prompt = buildConsolidationTaskPrompt(3, 'Be selective.', {
        memoryDir: '/data/agents/warren/memory',
        agentId: 'warren',
        compactionRun: true,
      })

      expect(prompt).toContain('## Weekly compaction run')
      // Every compaction write target must live under the persona root
      expect(prompt).toContain('Rewrite `/data/agents/warren/memory/MEMORY.md`')
      expect(prompt).toContain('`/data/agents/warren/memory/users/`')
      expect(prompt).toContain('`/data/agents/warren/memory/wiki/<topic>/`')
      expect(prompt).toContain('`/data/agents/warren/memory/wiki/index.md`')
      expect(prompt).toContain('log the split in `/data/agents/warren/memory/wiki/log.md`')
      expect(prompt).toContain('Prune `/data/agents/warren/memory/wiki/log.md`')
      // The lint report target is the persona's log.md too
      expect(prompt).toContain('append a brief Lint Report section to `/data/agents/warren/memory/wiki/log.md`')

      // RC5 core guarantee: no compaction/lint instruction may point at main's
      // memory root. The only permitted /data/memory/ mention is the scoping
      // block's explicit prohibition.
      const mainRootMentions = prompt
        .split('\n')
        .filter(line => line.includes('/data/memory/'))
      expect(mainRootMentions).toEqual([
        "- NEVER read from or write to the main agent's memory at /data/memory/ or any other agent's directory under /data/agents/. Everything you touch must live under `/data/agents/warren/memory`.",
      ])
      expect(prompt).not.toContain('/data/memory/wiki/log.md')
      expect(prompt).not.toContain('/data/memory/MEMORY.md')
    })

    it('main compaction run targets the main memory root and keeps the persona guard', () => {
      const prompt = buildConsolidationTaskPrompt(3, 'Be selective.', {
        scopedPersonaGuard: true,
        compactionRun: true,
      })
      const mainMemoryDir = path.join(tempDataDir, 'memory')

      expect(prompt).toContain('## Weekly compaction run')
      expect(prompt).toContain(`Rewrite \`${mainMemoryDir}/MEMORY.md\``)
      expect(prompt).toContain(`log the split in \`${mainMemoryDir}/wiki/log.md\``)
      // Guard note and compaction section coexist
      expect(prompt).toContain('NEVER read from or write to anything under /data/agents/')
      // Compaction must not send the main run into persona roots
      expect(prompt).not.toContain('/data/agents/warren')
    })

    it('omits the compaction section when compactionRun is false', () => {
      const prompt = buildConsolidationTaskPrompt(3, 'Be selective.', {
        memoryDir: '/data/agents/warren/memory',
        agentId: 'warren',
        compactionRun: false,
      })
      expect(prompt).not.toContain('## Weekly compaction run')
      // Lint still routes to the persona's own log.md every run
      expect(prompt).toContain('append a brief Lint Report section to `/data/agents/warren/memory/wiki/log.md`')
    })

    it('buildConsolidationTaskPrompt adds the persona guard to the main run when scoped', () => {
      const prompt = buildConsolidationTaskPrompt(3, 'Be selective.', { scopedPersonaGuard: true })
      expect(prompt).toContain('NEVER read from or write to anything under /data/agents/')
      expect(prompt).toContain('Do NOT promote persona-specific content')
      expect(prompt).not.toContain('persona agent "')
    })

    it('buildConsolidationTaskPrompt is unchanged without scoping options', () => {
      const prompt = buildConsolidationTaskPrompt(3, 'Be selective.')
      expect(prompt).not.toContain('## Agent scope')
      expect(prompt).not.toContain('/data/agents/')
    })

    it('listPersonaConsolidationTargets only returns personas with daily content', () => {
      const agentsBaseDir = path.join(tempDataDir, 'agents')
      const { today, content } = makeTodayDailyContent()
      // warren: has content
      fs.mkdirSync(path.join(agentsBaseDir, 'warren', 'memory', 'daily'), { recursive: true })
      fs.writeFileSync(path.join(agentsBaseDir, 'warren', 'memory', 'daily', `${today}.md`), content, 'utf-8')
      // bob: exists but no daily content
      fs.mkdirSync(path.join(agentsBaseDir, 'bob'), { recursive: true })

      const targets = listPersonaConsolidationTargets(3, { agentsBaseDir, scopedAgentMemory: true })
      expect(targets).toEqual([
        { agentId: 'warren', memoryDir: path.join(agentsBaseDir, 'warren', 'memory') },
      ])

      expect(listPersonaConsolidationTargets(3, { agentsBaseDir, scopedAgentMemory: false })).toEqual([])
    })

    it('runNow runs an additional agent-labeled consolidation task per persona with daily content', async () => {
      writeConfig('settings.json', { multiPersona: { enabled: true } })
      const { today, content } = makeTodayDailyContent()
      const warrenDailyDir = path.join(tempDataDir, 'agents', 'warren', 'memory', 'daily')
      fs.mkdirSync(warrenDailyDir, { recursive: true })
      fs.writeFileSync(path.join(warrenDailyDir, `${today}.md`), content, 'utf-8')
      // Persona without daily content is skipped
      fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })

      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: 'Nothing to report.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      const result = await scheduler.runNow()

      expect(taskRuntime.create).toHaveBeenCalledTimes(2)
      expect(taskRuntime.start).toHaveBeenCalledTimes(2)

      const [mainRun, warrenRun] = taskRuntime.startedTasks

      // Main run: unchanged root + guard note, no persona attribution.
      // Manual runNow() always compacts, hence the "+ Compaction" suffix.
      expect(mainRun.task.name).toBe('Nightly Memory Consolidation + Compaction')
      expect(mainRun.task.prompt).toContain(path.join(tempDataDir, 'memory'))
      expect(mainRun.task.prompt).toContain('NEVER read from or write to anything under /data/agents/')
      expect(mainRun.task.agentId ?? null).toBeNull()

      // Persona run: warren's own memory root, agent-labeled task + session
      expect(warrenRun.task.name).toBe('Nightly Memory Consolidation + Compaction (warren)')
      expect(warrenRun.task.agentId).toBe('warren')
      expect(warrenRun.task.prompt).toContain(path.join(tempDataDir, 'agents', 'warren', 'memory'))
      expect(warrenRun.task.prompt).toContain('persona agent "warren" ONLY')

      // RC5 + compaction: the persona's compaction/lint writes must resolve to
      // warren's own root. A persona run must never be told to touch main's wiki.
      const warrenMemoryDir = path.join(tempDataDir, 'agents', 'warren', 'memory')
      const mainMemoryDir = path.join(tempDataDir, 'memory')
      expect(warrenRun.task.prompt).toContain('## Weekly compaction run')
      expect(warrenRun.task.prompt).toContain(`Rewrite \`${warrenMemoryDir}/MEMORY.md\``)
      expect(warrenRun.task.prompt).toContain(`log the split in \`${warrenMemoryDir}/wiki/log.md\``)
      expect(warrenRun.task.prompt).toContain(
        `append a brief Lint Report section to \`${warrenMemoryDir}/wiki/log.md\``,
      )
      expect(warrenRun.task.prompt).not.toContain(`${mainMemoryDir}/wiki`)
      expect(warrenRun.task.prompt).not.toContain(`${mainMemoryDir}/MEMORY.md`)

      // Conversely the main run compacts only main's root
      expect(mainRun.task.prompt).toContain(`Rewrite \`${mainMemoryDir}/MEMORY.md\``)
      expect(mainRun.task.prompt).not.toContain(warrenMemoryDir)

      const sessionRow = db.prepare('SELECT agent_id FROM sessions WHERE id = ?')
        .get(warrenRun.task.sessionId) as { agent_id: string }
      expect(sessionRow.agent_id).toBe('warren')

      expect(result.personaRuns).toEqual([
        { agentId: 'warren', updated: false, reason: 'Nothing to report.' },
      ])
    }, 30_000)

    it('runNow skips persona runs when scoped memory is disabled', async () => {
      writeConfig('settings.json', { multiPersona: { enabled: true, scopedMemory: false } })
      const { today, content } = makeTodayDailyContent()
      const warrenDailyDir = path.join(tempDataDir, 'agents', 'warren', 'memory', 'daily')
      fs.mkdirSync(warrenDailyDir, { recursive: true })
      fs.writeFileSync(path.join(warrenDailyDir, `${today}.md`), content, 'utf-8')

      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: 'Nothing to report.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => makeProvider(),
      })

      const result = await scheduler.runNow()

      expect(taskRuntime.create).toHaveBeenCalledTimes(1)
      expect(result.personaRuns).toBeUndefined()
      // Legacy prompt: no guard note when scoping is off
      expect(taskRuntime.startedTasks[0].task.prompt).not.toContain('## Agent scope')
    }, 30_000)
  })

  describe('setters', () => {
    it('setAgentCore updates the agentCore reference', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      const mockAgentCore = { refreshSystemPrompt: vi.fn() }
      scheduler.setAgentCore(mockAgentCore as unknown as AgentCore)
    })

    it('setTaskRuntime updates the taskRuntime reference', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      scheduler.setTaskRuntime(taskRuntime)
    })
  })
})
