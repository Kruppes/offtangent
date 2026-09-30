/**
 * Fix 2a (plan 2026-09-19): AgentCore keeps ONE turn queue per persona, not
 * one per process. A long turn of persona `coder` must not delay a turn of
 * persona `main` any more (incident 2026-09-18: a capture answer waited 20 min
 * behind a 23-min hotfix turn). Since the strand isolation the queue key is
 * the strand: two turns of the SAME strand still serialize (one runtime, one
 * loaded transcript), two strands of the same persona run in parallel.
 *
 * The runtime mock blocks in `streamPrompt` until the test releases it, which
 * is the only thing these tests need from a runtime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { ResponseChunk, TurnStreamChunk } from './agent-runtime-types.js'

const { gates, started } = vi.hoisted(() => ({
  /** text -> resolver that lets that prompt finish. */
  gates: new Map<string, () => void>(),
  /** Prompts that reached a runtime, in order. */
  started: [] as string[],
}))

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
  appendToDailyFile: vi.fn(),
  resolveAgentMemoryDir: vi.fn(() => undefined),
}))

vi.mock('./pi-models.js', () => ({
  completeSimple: vi.fn(async () => 'summary'),
}))

vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

vi.mock('./agent-runtime.js', () => ({
  createAgentRuntime: vi.fn(() => {
    const messages: Array<{ role: string; text: string }> = []
    return {
      streamPrompt: vi.fn(async function* (raw: string): AsyncGenerator<ResponseChunk> {
        // The runtime receives the prompt with the turn's context block and
        // trailing time context; key the gates on the user text itself.
        const text = raw.trim()
        started.push(text)
        await new Promise<void>((resolve) => { gates.set(text, resolve) })
        messages.push({ role: 'assistant', text })
        yield { type: 'text', text: `reply to ${text}` }
        yield { type: 'done' }
      }),
      retryLastTurn: vi.fn(async function* (): AsyncGenerator<ResponseChunk> { yield { type: 'done' } }),
      refreshSystemPrompt: vi.fn(),
      getCurrentTimeContext: vi.fn(() => ''),
      swapProvider: vi.fn(),
      getProviderManager: vi.fn(() => undefined),
      setProviderManager: vi.fn(),
      clearMessages: vi.fn(),
      getMessages: vi.fn(() => messages),
      setMessages: vi.fn(),
      abort: vi.fn(),
      getStateSnapshot: vi.fn(() => ({ modelId: 'mock-model', toolNames: [], messageCount: messages.length })),
      getCurrentModel: vi.fn(() => ({ id: 'mock-model' })),
      getCurrentApiKey: vi.fn(() => 'mock-key'),
      getCurrentProvider: vi.fn(() => null),
      setThinkingLevel: vi.fn(),
    }
  }),
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

const settle = (ms = 10): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Consume a turn stream in the background, dropping the queue control chunks. */
function run(stream: AsyncIterable<TurnStreamChunk>): { done: Promise<string[]> } {
  const done = (async () => {
    const out: string[] = []
    for await (const chunk of stream) {
      if (chunk.type === 'queue_waiting' || chunk.type === 'queue_started') continue
      if (chunk.type === 'text' && chunk.text) out.push(chunk.text)
    }
    return out
  })()
  return { done }
}

async function releaseWhenStarted(text: string): Promise<void> {
  for (let i = 0; i < 100 && !gates.has(text); i++) await settle(5)
  gates.get(text)?.()
}

describe('AgentCore per-persona turn queues', () => {
  let db: Database
  let agent: AgentCore

  beforeEach(() => {
    gates.clear()
    started.length = 0
    db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
    agent = new AgentCore({ model: makeModel(), apiKey: 'k', db, systemPrompt: 'sp' })
  })

  it('runs a turn of another persona while one persona is busy', async () => {
    const sm = agent.getSessionManager()
    const coderStrand = sm.createThread('1', 'coder', 'Hotfix')
    const mainStrand = sm.createThread('1', 'main', 'Capture')

    const coder = run(agent.sendMessage('1', 'long hotfix', 'web', undefined, 'coder', coderStrand.id))
    for (let i = 0; i < 100 && !gates.has('long hotfix'); i++) await settle(5)
    expect(started).toEqual(['long hotfix'])

    // main is not blocked by coder's running turn.
    const main = run(agent.sendMessage('1', 'capture question', 'web', undefined, 'main', mainStrand.id))
    await releaseWhenStarted('capture question')
    expect(await main.done).toEqual(['reply to capture question'])
    expect(started).toEqual(['long hotfix', 'capture question'])

    // Per persona: main is idle again, coder still runs.
    expect(agent.getPendingMessageCount('main')).toBe(0)
    expect(agent.getPendingMessageCount('coder')).toBe(1)
    expect(agent.getPendingMessageCount()).toBe(1)
    expect(agent.describeQueue('main', mainStrand.id)).toEqual({ position: 1, blockedBy: null })
    expect(agent.describeQueue('coder', coderStrand.id)).toEqual({ position: 2, blockedBy: { agentId: 'coder', sessionId: coderStrand.id } })
    // Strand isolation: a turn on ANOTHER strand of coder is not blocked.
    expect(agent.describeQueue('coder', sm.createThread('1', 'coder', 'Third').id)).toEqual({ position: 1, blockedBy: null })

    gates.get('long hotfix')!()
    expect(await coder.done).toEqual(['reply to long hotfix'])
    expect(agent.describeQueue('coder', coderStrand.id)).toEqual({ position: 1, blockedBy: null })
  })

  it('serializes two turns of the SAME strand and reports the blocker', async () => {
    const sm = agent.getSessionManager()
    const strand = sm.createThread('1', 'coder', 'First')

    const one = run(agent.sendMessage('1', 'first turn', 'web', undefined, 'coder', strand.id))
    for (let i = 0; i < 100 && !gates.has('first turn'); i++) await settle(5)

    const two = run(agent.sendMessage('1', 'second turn', 'web', undefined, 'coder', strand.id))
    await settle(20)
    expect(started).toEqual(['first turn'])

    expect(agent.describeQueue('coder', strand.id)).toEqual({ position: 3, blockedBy: { agentId: 'coder', sessionId: strand.id } })
    expect(agent.describePendingTurn('coder', strand.id)).toEqual({
      position: 2,
      blockedBy: { agentId: 'coder', sessionId: strand.id },
    })
    expect(agent.describePendingTurn('main', strand.id)).toBeNull()

    gates.get('first turn')!()
    expect(await one.done).toEqual(['reply to first turn'])
    await releaseWhenStarted('second turn')
    expect(await two.done).toEqual(['reply to second turn'])
    expect(started).toEqual(['first turn', 'second turn'])
    expect(agent.describePendingTurn('coder', strand.id)).toBeNull()
  })

  it('runs two strands of the SAME persona in parallel (strand isolation)', async () => {
    const sm = agent.getSessionManager()
    const first = sm.createThread('1', 'coder', 'First')
    const second = sm.createThread('1', 'coder', 'Second')

    const one = run(agent.sendMessage('1', 'first turn', 'web', undefined, 'coder', first.id))
    for (let i = 0; i < 100 && !gates.has('first turn'); i++) await settle(5)

    // The second strand starts while the first one is still streaming.
    const two = run(agent.sendMessage('1', 'second turn', 'web', undefined, 'coder', second.id))
    await releaseWhenStarted('second turn')
    expect(await two.done).toEqual(['reply to second turn'])
    expect(started).toEqual(['first turn', 'second turn'])
    // The still running strand never appeared as a blocker of the other one.
    expect(agent.describePendingTurn('coder', second.id)).toBeNull()

    gates.get('first turn')!()
    expect(await one.done).toEqual(['reply to first turn'])
  })

  it('reports nothing pending for a persona that never ran a turn', () => {
    expect(agent.getPendingMessageCount('never-used')).toBe(0)
    expect(agent.describeQueue('never-used')).toEqual({ position: 1, blockedBy: null })
    expect(agent.describePendingTurn('never-used', 'strand-x')).toBeNull()
  })
})
