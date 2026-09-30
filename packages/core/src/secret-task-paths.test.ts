/**
 * F2 (review A-A2/B-A2, triage 19:25): the background-task channel had no
 * secret boundary of its own.
 *
 * Three holes, one test file:
 *  1. `tasks.prompt` was written to the database exactly as the caller handed
 *     it in (`TaskStore.create`) — a token in a task prompt was stored in clear
 *     text and shipped to the task model on every turn.
 *  2. The task SYSTEM prompt (task prompt + attached `SKILL.md` + output
 *     schema) went into `new PiAgent({ initialState: { systemPrompt } })`
 *     unsealed.
 *  3. The interactive runtime's system prompt never passed `redactMessages`
 *     (pi-agent keeps it outside the message list), so only the sections that
 *     `memory.ts` seals were covered.
 *
 * Canaries are assembled at runtime; the repo holds no credential literal.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ProviderConfig } from './provider-config.js'

const captured = vi.hoisted(() => ({ systemPrompts: [] as string[] }))

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation((options: { initialState: { systemPrompt: string } }) => {
    captured.systemPrompts.push(options.initialState.systemPrompt)
    return {
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
      abort: vi.fn(),
      state: { get messages() { return [] }, systemPrompt: options.initialState.systemPrompt },
    }
  }),
}))

const { initDatabase } = await import('./database.js')
const { TaskStore } = await import('./task-store.js')
const { TaskRunner } = await import('./task-runner.js')
const { SessionManager } = await import('./session-manager.js')
const { createAgentRuntime } = await import('./agent-runtime.js')
const { invalidateSecretHandleCache, listSecrets, resolveSecret } = await import('./secret-store.js')
const { invalidateKnownValues, SECRET_HANDLE_RE } = await import('./secret-boundary.js')

type Database = ReturnType<typeof initDatabase>

/** `ghp_` plus 36 alphanumerics — the structural `github-token` rule. */
const CANARY = ['ghp', '_', 'T4sk', 'Fake', 'Token', '0000', 'abcdefghij', 'klmnopqr'].join('')

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
} as unknown as ProviderConfig

let tmpDir: string
let dbPath: string
let db: Database
let store: InstanceType<typeof TaskStore>
let runner: InstanceType<typeof TaskRunner>
let previous: Record<string, string | undefined> = {}

function handles(text: string): string[] {
  return [...text.matchAll(new RegExp(SECRET_HANDLE_RE.source, 'g'))].map(match => match[1]!)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-seal-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-task-path-sealing'
  invalidateSecretHandleCache()
  invalidateKnownValues()
  captured.systemPrompts = []
  dbPath = path.join(tmpDir, 'tasks.db')
  db = initDatabase(dbPath)
  store = new TaskStore(db)
  runner = new TaskRunner({
    db,
    buildModel: () => ({} as never),
    getApiKey: async () => 'test-key',
    tools: [],
    sessionManager: new SessionManager({ db }),
    onTaskComplete: () => {},
    memoryDir: path.join(tmpDir, 'memory'),
  } as never)
})

afterEach(() => {
  runner.dispose()
  db.close()
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

describe('F2: the task prompt is sealed before it is stored', () => {
  it('replaces a canary in tasks.prompt by a handle (stored row)', () => {
    const task = store.create({
      name: 'Deploy',
      prompt: `deploy with ${CANARY} please`,
      triggerType: 'agent',
      sessionId: 'seal-1',
    })
    const row = db.prepare('SELECT prompt FROM tasks WHERE id = ?').get(task.id) as { prompt: string }
    expect(row.prompt).not.toContain(CANARY)
    expect(handles(row.prompt)).toHaveLength(1)
    expect(resolveSecret(handles(row.prompt)[0]!)).toBe(CANARY)
    // The object handed back to the caller must not carry the raw value either.
    expect(task.prompt).not.toContain(CANARY)
  })

  it('leaves a prompt without a secret byte-identical', () => {
    const task = store.create({ name: 'Plain', prompt: 'tidy the docs', triggerType: 'agent', sessionId: 'seal-2' })
    expect(task.prompt).toBe('tidy the docs')
    expect(listSecrets()).toEqual([])
  })
})

describe('F2: the task system prompt is sealed before it reaches the model', () => {
  it('carries no canary from the task prompt (request to the mocked model)', async () => {
    const task = store.create({
      name: 'Deploy',
      prompt: `deploy with ${CANARY} please`,
      triggerType: 'agent',
      sessionId: 'seal-3',
    })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(captured.systemPrompts.length).toBeGreaterThanOrEqual(1)
    for (const prompt of captured.systemPrompts) expect(prompt).not.toContain(CANARY)
    expect(handles(captured.systemPrompts[0]!).length).toBeGreaterThanOrEqual(1)
  })

  it('seals a canary that only an attached SKILL.md contributes', async () => {
    const skillsDir = path.join(tmpDir, 'skills_agent', 'canary-skill')
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), `# canary skill\n\nuse token ${CANARY}\n`)
    const task = store.create({ name: 'Skilled', prompt: 'do the thing', triggerType: 'agent', sessionId: 'seal-4' })
    await runner.startTask(task, mockProvider, { attachedSkills: ['canary-skill'] } as never)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(captured.systemPrompts.length).toBeGreaterThanOrEqual(1)
    const prompt = captured.systemPrompts[0]!
    expect(prompt).toContain('canary skill')
    expect(prompt).not.toContain(CANARY)
    expect(handles(prompt).length).toBeGreaterThanOrEqual(1)
  })
})

describe('F2: the interactive system prompt passes the boundary too', () => {
  it('seals an injected system prompt before the runtime hands it to the model', () => {
    const memDb = initDatabase(':memory:')
    try {
      createAgentRuntime({
        model: {
          id: 'gpt-4o', name: 'GPT-4o', api: 'openai-completions' as const, provider: 'openai',
          baseUrl: 'https://api.openai.com/v1', reasoning: false,
          input: ['text' as const], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000, maxTokens: 4096,
        } as never,
        apiKey: 'sk-not-a-real-key',
        db: memDb,
        tools: [],
        memoryDir: path.join(tmpDir, 'memory'),
        systemPrompt: `You are a bot. Deploy key: ${CANARY}`,
      } as never)
      const prompt = captured.systemPrompts.at(-1)!
      expect(prompt).not.toContain(CANARY)
      expect(handles(prompt)).toHaveLength(1)
      expect(resolveSecret(handles(prompt)[0]!)).toBe(CANARY)
    } finally {
      memDb.close()
    }
  })
})
