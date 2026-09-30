import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { ResponseChunk } from './agent-runtime-types.js'

const { streamPromptMock } = vi.hoisted(() => ({
  streamPromptMock: vi.fn(),
}))

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
  appendToDailyFile: vi.fn(),
}))

vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

vi.mock('./agent-runtime.js', () => ({
  createAgentRuntime: vi.fn(() => ({
    streamPrompt: streamPromptMock,
    retryLastTurn: streamPromptMock,
    refreshSystemPrompt: vi.fn(),
    getCurrentTimeContext: vi.fn(() => '<current_time>Current time: 12:00 (UTC)</current_time>'),
    swapProvider: vi.fn(),
    getProviderManager: vi.fn(() => undefined),
    clearMessages: vi.fn(),
    abort: vi.fn(),
    getStateSnapshot: vi.fn(() => ({
      modelId: 'mock-model',
      toolNames: [],
      messageCount: 0,
    })),
    getCurrentModel: vi.fn(() => ({ id: 'mock-model' })),
    getCurrentApiKey: vi.fn(() => 'mock-key'),
    setThinkingLevel: vi.fn(),
  })),
  createYoloTools: vi.fn(() => []),
  isRetryablePreStreamError: vi.fn(() => false),
}))

function makeModel() {
  return {
    id: 'gpt-4o',
    name: 'GPT-4o',
    api: 'openai-completions' as const,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text' as const, 'image' as const],
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

describe('AgentCore task injection chunk metadata', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    streamPromptMock.mockReset()
    streamPromptMock.mockImplementation(async function* () {
      yield { type: 'text', text: 'injection response' }
      yield { type: 'done' }
    })
  })

  it('includes the actual sessionId on task injection chunks', async () => {
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })

    const chunks: ResponseChunk[] = []
    agent.setOnTaskInjectionChunk((chunk) => {
      chunks.push(chunk)
    })

    await agent.injectTaskResult('<task_injection>done</task_injection>', '1', '11111111-2222-3333-4444-555555555555')

    expect(streamPromptMock).toHaveBeenCalledTimes(1)
    const usedSessionId = streamPromptMock.mock.calls[0][1] as string

    expect(usedSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every(chunk => chunk.sessionId === usedSessionId)).toBe(true)

    await agent.dispose()
    db.close()
  })

  it('honors a forced sessionId so chunks always report the caller-pinned id', async () => {
    // Guards the correlation contract used by runtime-composition: the
    // caller pre-resolves a session id, pins it via the third argument,
    // and every emitted chunk carries that session id.
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })

    const forcedSessionId = '11111111-2222-3333-4444-555555555555'
    const chunks: ResponseChunk[] = []
    agent.setOnTaskInjectionChunk((chunk) => {
      chunks.push(chunk)
    })

    await agent.injectTaskResult('<task_injection>done</task_injection>', '1', forcedSessionId)

    expect(streamPromptMock).toHaveBeenCalledTimes(1)
    expect(streamPromptMock.mock.calls[0][1]).toBe(forcedSessionId)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every(chunk => chunk.sessionId === forcedSessionId)).toBe(true)

    await agent.dispose()
    db.close()
  })

  it('tags every chunk with a caller-supplied injectionId for per-call correlation', async () => {
    // Regression guard: concurrent task completions for the same user
    // resolve to the same cached session id, so the chunk handler MUST
    // correlate via `chunk.injectionId` (unique per call) instead of
    // `chunk.sessionId` (shared). This verifies the id is propagated
    // verbatim onto every emitted chunk.
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })

    const injectionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const chunks: ResponseChunk[] = []
    agent.setOnTaskInjectionChunk((chunk) => {
      chunks.push(chunk)
    })

    await agent.injectTaskResult(
      '<task_injection>done</task_injection>',
      '1',
      'strand-A',
      injectionId,
    )

    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every(chunk => chunk.injectionId === injectionId)).toBe(true)

    await agent.dispose()
    db.close()
  })

  it('mints a fresh injectionId when the caller does not supply one', async () => {
    // When no injectionId is supplied, AgentCore generates one so every
    // call still has a unique correlation token (needed for callers that
    // don't yet pre-register metadata).
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })

    const chunks: ResponseChunk[] = []
    agent.setOnTaskInjectionChunk((chunk) => {
      chunks.push(chunk)
    })

    await agent.injectTaskResult('<task_injection>done</task_injection>', '1', '11111111-2222-3333-4444-555555555555')

    expect(chunks.length).toBeGreaterThan(0)
    const ids = new Set(chunks.map(c => c.injectionId))
    expect(ids.size).toBe(1)
    const [onlyId] = ids
    expect(onlyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    await agent.dispose()
    db.close()
  })

  it('refuses an injection without lineage even when strand B is active', async () => {
    const agent = new AgentCore({ model: makeModel(), apiKey: 'k', db, tools: [] })
    const b = agent.getSessionManager().createThread('1', 'main', 'B')
    agent.getSessionManager().activateSession('1', b.id)
    const before = db.prepare('SELECT COUNT(*) AS n FROM sessions').get()
    await expect(agent.injectTaskResult('result from orphan task', '1')).rejects.toThrow(/lineage/i)
    expect(streamPromptMock).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual(before)
    expect(agent.getSessionManager().getSession('1')?.id).toBe(b.id)
    await agent.dispose()
    db.close()
  })

  it('binds tools in user turns and retries without leaking attribution to the consumer', async () => {
    const agent = new AgentCore({ model: makeModel(), apiKey: 'k', db, tools: [] })
    const a = agent.getSessionManager().createThread('1', 'main', 'A')
    const seen: unknown[] = []
    streamPromptMock.mockImplementation(async function* () {
      await Promise.resolve()
      seen.push([agent.getCurrentInteractiveSessionId(), agent.getCurrentToolUserId(), agent.getCurrentToolAgentId()])
      yield { type: 'done' }
    })
    for await (const _chunk of agent.sendMessage('1', 'start a task', 'web', undefined, 'main', a.id)) {
      expect(agent.getCurrentInteractiveSessionId()).toBeNull()
    }
    for await (const _chunk of agent.retryTurn('1', 'start a task', 'web', undefined, 'main', a.id)) {
      expect(agent.getCurrentInteractiveSessionId()).toBeNull()
    }
    expect(seen).toEqual([[a.id, 1, 'main'], [a.id, 1, 'main']])
    await agent.dispose()
    db.close()
  })

  it('keeps parent session and tool attribution local across overlapping turns', async () => {
    const agent = new AgentCore({ model: makeModel(), apiKey: 'k', db, tools: [] })
    let releaseA!: () => void
    const gateA = new Promise<void>(resolve => { releaseA = resolve })
    let enteredA!: () => void
    const startedA = new Promise<void>(resolve => { enteredA = resolve })
    let releaseB!: () => void
    const gateB = new Promise<void>(resolve => { releaseB = resolve })
    let enteredB!: () => void
    const startedB = new Promise<void>(resolve => { enteredB = resolve })
    const seen: unknown[] = []
    const capture = () => seen.push([
      agent.getCurrentInteractiveSessionId(), agent.getCurrentToolUserId(), agent.getCurrentToolAgentId(),
    ])
    streamPromptMock.mockImplementation(async function* (_text: string, sessionId: string) {
      capture()
      if (sessionId === 'A') { enteredA(); await gateA }
      else { enteredB(); await gateB }
      capture()
      yield { type: 'done' }
    })
    // Simulate the queue watchdog releasing a stalled A while its underlying
    // tool promise is still alive. Different personas have separate runtimes.
    const process = agent as unknown as {
      processTaskInjection(user: string, text: string, session: string, injection: string, persona: string): AsyncIterable<ResponseChunk>
    }
    const drain = async (stream: AsyncIterable<ResponseChunk>) => { for await (const _chunk of stream) { /* drain */ } }
    const a = drain(process.processTaskInjection('1', 'task A', 'A', 'ia', 'main'))
    await startedA
    const b = drain(process.processTaskInjection('2', 'task B', 'B', 'ib', 'other'))
    await startedB
    releaseA()
    await a
    releaseB()
    await b
    expect(seen).toEqual([[ 'A', 1, 'main' ], [ 'B', 2, 'other' ], [ 'A', 1, 'main' ], [ 'B', 2, 'other' ]])
    expect(agent.getCurrentInteractiveSessionId()).toBeNull()
    expect(agent.getCurrentToolUserId()).toBeUndefined()
    expect(agent.getCurrentToolAgentId()).toBeUndefined()
    await agent.dispose()
    db.close()
  })
})
