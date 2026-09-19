/**
 * SPEC 11.3: strand turn context by token budget, through AgentCore.
 *
 * The runtime mock appends content shaped messages like the real pi agent,
 * so the trim and the strip of the per turn block can be observed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { ResponseChunk, TurnStreamChunk } from './agent-runtime-types.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'
import { insertSessionSummary } from './session-summary-store.js'

interface FakeMessage { role: string; content: Array<{ type: 'text'; text: string }>; timestamp: number }

const { runtimes, promptSnapshots } = vi.hoisted(() => ({
  /** agentId -> the one runtime of that persona (like the real AgentCore). */
  runtimes: new Map<string, { messages: FakeMessage[] }>(),
  /** Transcript the runtime held when a prompt started, per prompt. */
  promptSnapshots: [] as Array<{ sessionId: string; history: string[] }>,
}))

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
  appendToDailyFile: vi.fn(),
  // Summaries of swept threads must not reach a real memory root from a test.
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
    const state = { messages: [] as FakeMessage[] }
    runtimes.set(agentId, state)
    const runtime = {
      streamPrompt: vi.fn(async function* (text: string, sessionId: string): AsyncGenerator<ResponseChunk> {
        promptSnapshots.push({ sessionId, history: state.messages.map(m => `${m.role}:${m.content[0].text}`) })
        state.messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 })
        const reply = `reply to ${text.slice(-60)}`
        state.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }], timestamp: 2 })
        yield { type: 'text', text: reply }
        yield { type: 'done' }
      }),
      retryLastTurn: vi.fn(async function* (text: string, sessionId: string): AsyncGenerator<ResponseChunk> {
        promptSnapshots.push({ sessionId, history: state.messages.map(m => `${m.role}:${m.content[0].text}`) })
        state.messages.push({ role: 'assistant', content: [{ type: 'text', text: `retried ${text}` }], timestamp: 3 })
        yield { type: 'text', text: `retried ${text}` }
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
      setThinkingLevel: vi.fn(),
    }
    return runtime
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

describe('AgentCore strand context (SPEC 11.3)', () => {
  let db: Database
  let agent: AgentCore

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
    runtimes.clear()
    promptSnapshots.length = 0
    setHeuristicsOverrideForTests(null)
    agent = new AgentCore({ model: makeModel(), apiKey: 'k', db, systemPrompt: 'sp' })
  })

  function persistUser(sessionId: string, text: string): void {
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'user', ?, 'main')").run(sessionId, text)
  }
  function persistAssistant(sessionId: string, text: string): void {
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'assistant', ?, 'main')").run(sessionId, text)
  }

  it('prepends nothing for a short strand', async () => {
    const t = agent.getSessionManager().createThread('1', 'main', 'T')
    persistUser(t.id, 'hello there')
    await drain(agent.sendMessage('1', 'hello there', 'web', undefined, 'main', t.id))
    const stored = runtimes.get('main')!.messages
    expect(stored[0].content[0].text).not.toContain('<strand_context>')
    expect(promptSnapshots[0].history).toEqual([])
  })

  it('trims the window to the budget, indexes the rest with ids, and strips the block from the transcript', async () => {
    setHeuristicsOverrideForTests({ strand: { windowTokens: 60, indexLines: 60, retrievalHits: 5, retrievalChars: 1200 } })
    const t = agent.getSessionManager().createThread('1', 'main', 'T')
    insertSessionSummary(db, t.id, { goal: 'Talk about kubernetes.', decisions: [], open: ['pick a cluster'], artifacts: [], next: [] }, null, null)

    const turns = ['first message about kubernetes clusters', 'second message about billing', 'third message about redis']
    for (const text of turns) {
      persistUser(t.id, text)
      await drain(agent.sendMessage('1', text, 'web', undefined, 'main', t.id))
      persistAssistant(t.id, `reply to ${text}`)
    }

    // The runtime mock echoes the prompt into the user message; with a 60
    // token budget the oldest turns fall out of the window.
    const messages = runtimes.get('main')!.messages
    for (const m of messages) {
      expect(m.content[0].text).not.toContain('<strand_context>')
    }
    expect(messages.length).toBeLessThan(6)

    const fourth = 'fourth message, what did we decide about kubernetes'
    persistUser(t.id, fourth)
    const spy = runtimes.get('main')!
    await drain(agent.sendMessage('1', fourth, 'web', undefined, 'main', t.id))
    const promptedText = (spy.messages.find(m => m.content[0].text.includes('fourth message')) as FakeMessage).content[0].text
    // The block was stripped after the turn...
    expect(promptedText).not.toContain('<strand_context>')
    expect(promptedText.startsWith(fourth)).toBe(true)
    // ...but the prompt that went out carried it (the mock recorded the raw text as the user message before stripping).
    const streamPromptCalls = (agent as unknown as { runtimes: Map<string, { streamPrompt: { mock: { calls: unknown[][] } } }> }).runtimes.get('main')!.streamPrompt.mock.calls
    const lastPrompt = streamPromptCalls[streamPromptCalls.length - 1][0] as string
    expect(lastPrompt.startsWith('<strand_context>')).toBe(true)
    expect(lastPrompt).toContain('Goal: Talk about kubernetes.')
    expect(lastPrompt).toContain('- pick a cluster')
    expect(lastPrompt).toContain('<earlier_messages>')
    expect(lastPrompt).toMatch(/\[msg:\d+\] user, \d+ chars: first message about kubernetes clusters/)
    expect(lastPrompt).toContain('<retrieved_messages>')
    expect(lastPrompt).toContain('first message about kubernetes clusters')
    expect(lastPrompt).toContain(fourth)
  })
})
