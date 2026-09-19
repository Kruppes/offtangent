import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { ResponseChunk, TurnStreamChunk } from './agent-runtime-types.js'

const { streamPromptMock, retryLastTurnMock } = vi.hoisted(() => ({
  streamPromptMock: vi.fn(),
  retryLastTurnMock: vi.fn(),
}))

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
  appendToDailyFile: vi.fn(),
}))

vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

vi.mock('./agent-runtime.js', () => ({
  createAgentRuntime: vi.fn(() => ({
    streamPrompt: streamPromptMock,
    retryLastTurn: retryLastTurnMock,
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

// Queue signals bracket the wait for the process-wide turn lock and are
// consumed by the TurnRunner; they are not part of a turn's visible output.
async function drain(stream: AsyncIterable<TurnStreamChunk>): Promise<ResponseChunk[]> {
  const chunks: ResponseChunk[] = []
  for await (const chunk of stream) {
    if (chunk.type === 'queue_waiting' || chunk.type === 'queue_started') continue
    chunks.push(chunk)
  }
  return chunks
}

describe('AgentCore.retryTurn', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    streamPromptMock.mockReset()
    retryLastTurnMock.mockReset()
    streamPromptMock.mockImplementation(async function* () {
      yield { type: 'error', error: '429 Too Many Requests' }
    })
    retryLastTurnMock.mockImplementation(async function* () {
      yield { type: 'text', text: 'second try' }
      yield { type: 'done' }
    })
  })

  it('re-runs the turn from the transcript instead of prompting the user message again', async () => {
    const agent = new AgentCore({ model: makeModel(), apiKey: 'sk-test', db, tools: [] })

    const first = await drain(agent.sendMessage('1', 'hello'))
    expect(first.map(c => c.type)).toEqual(['error'])

    const retried = await drain(agent.retryTurn('1', 'hello'))
    expect(retried.map(c => c.type)).toEqual(['text', 'done'])

    expect(streamPromptMock).toHaveBeenCalledTimes(1)
    expect(retryLastTurnMock).toHaveBeenCalledTimes(1)
    // Same session as the original turn — a retry never opens a new one.
    expect(retryLastTurnMock.mock.calls[0][1]).toBe(streamPromptMock.mock.calls[0][1])

    await agent.dispose()
    db.close()
  })

  it('routes a persona retry to that persona runtime (agentId threaded through)', async () => {
    // Track which agentId each runtime instance was built for, and which
    // runtime handled the retry. This proves the merge kept the retry inside
    // the per-persona runtime boundary (not a singular this.runtime).
    const { createAgentRuntime } = await import('./agent-runtime.js')
    const perAgentRetry: Record<string, ReturnType<typeof vi.fn>> = {}
    ;(createAgentRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementation((opts: { agentId?: string }) => {
      const id = opts.agentId ?? 'main'
      const retry = vi.fn(async function* () {
        yield { type: 'text', text: `retry-by-${id}` }
        yield { type: 'done' }
      })
      perAgentRetry[id] = retry
      return {
        streamPrompt: vi.fn(async function* () { yield { type: 'error', error: '429 Too Many Requests' } }),
        retryLastTurn: retry,
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
      }
    })

    const agent = new AgentCore({ model: makeModel(), apiKey: 'sk-test', db, tools: [] })
    // Fail then retry AS PERSONA 'bob'.
    await drain(agent.sendMessage('1', 'hello', 'telegram', undefined, 'bob'))
    const retried = await drain(agent.retryTurn('1', 'hello', 'telegram', undefined, 'bob'))

    expect(retried.map(c => c.type)).toEqual(['text', 'done'])
    // The retry ran on BOB's runtime, not main's.
    expect(perAgentRetry['bob']).toBeDefined()
    expect(perAgentRetry['bob']!).toHaveBeenCalledTimes(1)
    expect((retried[0] as { text: string }).text).toBe('retry-by-bob')
    // main's runtime (created eagerly in the constructor) never handled a retry.
    expect(perAgentRetry['main']).toBeDefined()
    expect(perAgentRetry['main']!).not.toHaveBeenCalled()

    await agent.dispose()
    db.close()
  })

  it('serializes the retry behind the failed turn without deadlocking the queue', async () => {
    const agent = new AgentCore({ model: makeModel(), apiKey: 'sk-test', db, tools: [] })

    // Consume only the first chunk of the failed turn, then retry — mirrors the
    // turn runner, which stops reading as soon as the error chunk arrives.
    // Queue signals are skipped: they bracket the wait for the lock and carry
    // no turn output, exactly as the runner treats them.
    const failed = agent.sendMessage('1', 'hello')[Symbol.asyncIterator]()
    for (;;) {
      const next = await failed.next()
      if (next.done) break
      if (next.value.type === 'queue_waiting' || next.value.type === 'queue_started') continue
      break
    }
    await failed.return?.(undefined as never)

    const retried = await drain(agent.retryTurn('1', 'hello'))
    expect(retried.map(c => c.type)).toEqual(['text', 'done'])

    await agent.dispose()
    db.close()
  })
})
