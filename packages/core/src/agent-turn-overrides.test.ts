/**
 * Turn-local thinking level and style instruction (U10a, quick capture mode).
 *
 * The runtime of a persona is shared by every channel: web chat, Telegram and
 * a voice puck all stream through the same object. A mode that wants a cheaper
 * reasoning level and a spoken answer must therefore borrow those two settings
 * for exactly one turn and give them back, and the instruction it adds must
 * never end up in the strand transcript.
 *
 * What is proven here:
 *   - the style hint reaches the model prompt, as a `<turn_style>` block after
 *     the user's text
 *   - it is NOT in the transcript the runtime keeps afterwards
 *   - the thinking level is set before the stream and restored after it, in
 *     that order, with the persona's own level as the value put back
 *   - a turn WITHOUT overrides touches the level not at all
 *   - a stream that throws still restores the level (a failed quick answer must
 *     not leave the persona on the wrong level)
 *   - the same level as the runtime already has causes no call at all
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { ResponseChunk, TurnStreamChunk } from './agent-runtime-types.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'

interface FakeMessage { role: string; content: Array<{ type: 'text'; text: string }>; timestamp: number }

const { runtimes, trace, failNext } = vi.hoisted(() => ({
  runtimes: new Map<string, {
    messages: FakeMessage[]
    thinkingLevel: string
    prompts: string[]
  }>(),
  /** Ordered log of everything that touched the thinking level or streamed. */
  trace: [] as string[],
  failNext: { value: false },
}))

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
  appendToDailyFile: vi.fn(),
  resolveAgentMemoryDir: vi.fn(() => undefined),
}))

vi.mock('./pi-models.js', () => ({
  completeSimple: vi.fn(async () => 'swept thread summary'),
}))

vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

vi.mock('./agent-runtime.js', () => ({
  createAgentRuntime: vi.fn((options: { agentId?: string }) => {
    const agentId = options.agentId ?? 'main'
    const state = { messages: [] as FakeMessage[], thinkingLevel: 'high', prompts: [] as string[] }
    runtimes.set(agentId, state)
    return {
      streamPrompt: vi.fn(async function* (text: string): AsyncGenerator<ResponseChunk> {
        state.prompts.push(text)
        trace.push(`stream(level=${state.thinkingLevel})`)
        if (failNext.value) {
          failNext.value = false
          throw new Error('provider exploded mid-stream')
        }
        state.messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 })
        state.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 2 })
        yield { type: 'text', text: 'ok' }
        yield { type: 'done' }
      }),
      retryLastTurn: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'done' }
      }),
      refreshSystemPrompt: vi.fn(),
      getCurrentTimeContext: vi.fn(() => '<current_time>12:00</current_time>'),
      swapProvider: vi.fn(),
      getProviderManager: vi.fn(() => undefined),
      setProviderManager: vi.fn(),
      clearMessages: vi.fn(() => { state.messages = [] }),
      getMessages: vi.fn(() => state.messages),
      setMessages: vi.fn((messages: FakeMessage[]) => { state.messages = messages }),
      abort: vi.fn(),
      getStateSnapshot: vi.fn(() => ({ modelId: 'mock-model', toolNames: [], messageCount: state.messages.length })),
      getCurrentModel: vi.fn(() => ({ id: 'mock-model' })),
      getCurrentApiKey: vi.fn(() => 'mock-key'),
      getCurrentProvider: vi.fn(() => null),
      setThinkingLevel: vi.fn((level: string) => {
        state.thinkingLevel = level
        trace.push(`set(${level})`)
      }),
      getThinkingLevel: vi.fn(() => state.thinkingLevel),
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

async function drain(stream: AsyncIterable<TurnStreamChunk>): Promise<ResponseChunk[]> {
  const chunks: ResponseChunk[] = []
  for await (const chunk of stream) {
    if (chunk.type === 'queue_waiting' || chunk.type === 'queue_started') continue
    chunks.push(chunk)
  }
  return chunks
}

describe('AgentCore turn-local overrides (U10a)', () => {
  let db: Database
  let agent: AgentCore

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
    runtimes.clear()
    trace.length = 0
    failNext.value = false
    setHeuristicsOverrideForTests(null)
    agent = new AgentCore({ model: makeModel(), apiKey: 'k', db, systemPrompt: 'sp' })
  })

  it('puts the style hint into the prompt and not into the transcript', async () => {
    const t = agent.getSessionManager().createThread('1', 'main', 'T')
    await drain(agent.sendMessage('1', 'Wie weit nach Graz?', 'puck', undefined, 'main', t.id, null, {
      styleHint: 'Antworte in zwei Saetzen, gesprochen.',
    }))

    const state = runtimes.get('main')!
    expect(state.prompts).toHaveLength(1)
    expect(state.prompts[0]).toContain('Wie weit nach Graz?')
    expect(state.prompts[0]).toContain('<turn_style>\nAntworte in zwei Saetzen, gesprochen.\n</turn_style>')
    // Order: the request first, the delivery constraint second.
    expect(state.prompts[0]!.indexOf('Wie weit nach Graz?')).toBeLessThan(state.prompts[0]!.indexOf('<turn_style>'))

    // Nothing of the hint survives in what the strand keeps.
    const persisted = db.prepare('SELECT content FROM chat_messages WHERE role = ?').all('user') as Array<{ content: string }>
    for (const row of persisted) expect(row.content).not.toContain('turn_style')
  })

  it('sets the thinking level for the turn and restores the persona level after it', async () => {
    const t = agent.getSessionManager().createThread('1', 'main', 'T')
    await drain(agent.sendMessage('1', 'Kurz?', 'puck', undefined, 'main', t.id, null, { thinkingLevel: 'off' }))

    expect(trace).toEqual(['set(off)', 'stream(level=off)', 'set(high)'])
    expect(runtimes.get('main')!.thinkingLevel).toBe('high')
  })

  it('leaves the thinking level untouched without overrides', async () => {
    const t = agent.getSessionManager().createThread('1', 'main', 'T')
    await drain(agent.sendMessage('1', 'Normal?', 'web', undefined, 'main', t.id))

    expect(trace).toEqual(['stream(level=high)'])
    expect(runtimes.get('main')!.thinkingLevel).toBe('high')
  })

  it('does nothing when the requested level is the one already in place', async () => {
    const t = agent.getSessionManager().createThread('1', 'main', 'T')
    await drain(agent.sendMessage('1', 'Gleiche Stufe?', 'puck', undefined, 'main', t.id, null, { thinkingLevel: 'high' }))

    expect(trace).toEqual(['stream(level=high)'])
  })

  it('restores the level even when the stream throws', async () => {
    const t = agent.getSessionManager().createThread('1', 'main', 'T')
    failNext.value = true

    // The stream error travels out of the turn (the caller decides what to
    // show); the point here is what happened to the level on the way out.
    await expect(drain(agent.sendMessage('1', 'Kaputt?', 'puck', undefined, 'main', t.id, null, {
      thinkingLevel: 'off',
      styleHint: 'kurz',
    }))).rejects.toThrow('provider exploded mid-stream')
    expect(trace).toEqual(['set(off)', 'stream(level=off)', 'set(high)'])
    expect(runtimes.get('main')!.thinkingLevel).toBe('high')
  })
})
