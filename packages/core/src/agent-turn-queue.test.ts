/**
 * Fix 2a (plan 2026-09-19): AgentCore keeps ONE turn queue per persona, not
 * one per process. A long turn of persona `bob` must not delay a turn of
 * persona `main` any more (incident 2026-09-18: a capture answer waited 20 min
 * behind a 23-min hotfix turn), while two turns of the SAME persona still
 * serialize — they share one AgentRuntime with one loaded transcript.
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
    const bobStrand = sm.createThread('1', 'bob', 'Hotfix')
    const mainStrand = sm.createThread('1', 'main', 'Capture')

    const bob = run(agent.sendMessage('1', 'long hotfix', 'web', undefined, 'bob', bobStrand.id))
    for (let i = 0; i < 100 && !gates.has('long hotfix'); i++) await settle(5)
    expect(started).toEqual(['long hotfix'])

    // main is not blocked by bob's running turn.
    const main = run(agent.sendMessage('1', 'capture question', 'web', undefined, 'main', mainStrand.id))
    await releaseWhenStarted('capture question')
    expect(await main.done).toEqual(['reply to capture question'])
    expect(started).toEqual(['long hotfix', 'capture question'])

    // Per persona: main is idle again, bob still runs.
    expect(agent.getPendingMessageCount('main')).toBe(0)
    expect(agent.getPendingMessageCount('bob')).toBe(1)
    expect(agent.getPendingMessageCount()).toBe(1)
    expect(agent.describeQueue('main')).toEqual({ position: 1, blockedBy: null })
    expect(agent.describeQueue('bob')).toEqual({ position: 2, blockedBy: { agentId: 'bob', sessionId: bobStrand.id } })

    gates.get('long hotfix')!()
    expect(await bob.done).toEqual(['reply to long hotfix'])
    expect(agent.describeQueue('bob')).toEqual({ position: 1, blockedBy: null })
  })

  it('serializes two turns of the same persona and reports the blocker', async () => {
    const sm = agent.getSessionManager()
    const first = sm.createThread('1', 'bob', 'First')
    const second = sm.createThread('1', 'bob', 'Second')

    const one = run(agent.sendMessage('1', 'first turn', 'web', undefined, 'bob', first.id))
    for (let i = 0; i < 100 && !gates.has('first turn'); i++) await settle(5)

    const two = run(agent.sendMessage('1', 'second turn', 'web', undefined, 'bob', second.id))
    await settle(20)
    expect(started).toEqual(['first turn'])

    expect(agent.describeQueue('bob')).toEqual({ position: 3, blockedBy: { agentId: 'bob', sessionId: first.id } })
    expect(agent.describePendingTurn('bob', second.id)).toEqual({
      position: 2,
      blockedBy: { agentId: 'bob', sessionId: first.id },
    })
    // The running turn is not "pending" — the turn stream itself shows it.
    expect(agent.describePendingTurn('bob', first.id)).toBeNull()
    expect(agent.describePendingTurn('main', second.id)).toBeNull()

    gates.get('first turn')!()
    expect(await one.done).toEqual(['reply to first turn'])
    await releaseWhenStarted('second turn')
    expect(await two.done).toEqual(['reply to second turn'])
    expect(started).toEqual(['first turn', 'second turn'])
    expect(agent.describePendingTurn('bob', second.id)).toBeNull()
  })

  it('reports nothing pending for a persona that never ran a turn', () => {
    expect(agent.getPendingMessageCount('never-used')).toBe(0)
    expect(agent.describeQueue('never-used')).toEqual({ position: 1, blockedBy: null })
    expect(agent.describePendingTurn('never-used', 'strand-x')).toBeNull()
  })
})
