/**
 * W5/P3 — delivery of a feed-only task outcome (cronjob) at the next run.
 *
 * The runtime mock records the exact prompt text AgentCore hands to the
 * model, which is where the announcement has to appear: before the user's
 * own message, exactly once, and never in the persisted transcript.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { ResponseChunk, TurnStreamChunk } from './agent-runtime-types.js'
import { TaskStore } from './task-store.js'

interface FakeMessage { role: string; text: string }

const { runtimes, promptSnapshots, prompts } = vi.hoisted(() => ({
  /** agentId -> the one runtime of that persona (like the real AgentCore). */
  runtimes: new Map<string, { messages: FakeMessage[] }>(),
  /** Transcript the runtime held when a prompt started, per prompt. */
  promptSnapshots: [] as Array<{ sessionId: string; history: string[] }>,
  /** Exact prompt text handed to the runtime, per turn. */
  prompts: [] as string[],
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
        promptSnapshots.push({ sessionId, history: state.messages.map(m => `${m.role}:${m.text}`) })
        prompts.push(text)
        state.messages.push({ role: 'user', text })
        state.messages.push({ role: 'assistant', text: `reply to ${text}` })
        yield { type: 'text', text: `reply to ${text}` }
        yield { type: 'done' }
      }),
      retryLastTurn: vi.fn(async function* (text: string, sessionId: string): AsyncGenerator<ResponseChunk> {
        promptSnapshots.push({ sessionId, history: state.messages.map(m => `${m.role}:${m.text}`) })
        state.messages.push({ role: 'assistant', text: `retried ${text}` })
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

describe('AgentCore announces pending task outcomes (W5/P3)', () => {
  let db: Database
  let agent: AgentCore

  function finishedCronTask(name: string, summary: string, agentId = 'main'): string {
    const store = new TaskStore(db)
    const task = store.create({ name, prompt: 'cron work', triggerType: 'cronjob', agentId })
    store.update(task.id, {
      status: 'completed',
      resultStatus: 'completed',
      resultSummary: summary,
      completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    })
    return task.id
  }

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
    runtimes.clear()
    promptSnapshots.length = 0
    prompts.length = 0
    agent = new AgentCore({ model: makeModel(), apiKey: 'k', db, systemPrompt: 'sp' })
  })

  it('delivers a completed cronjob result BEFORE the user message on the next run', async () => {
    const taskId = finishedCronTask('w4-deploy-verify-20260917', 'Deploy verified: 3/3 checks green.')

    await drain(agent.sendMessage('1', 'moin, was lief heute?', 'web', undefined, 'main'))

    expect(prompts).toHaveLength(1)
    const sent = prompts[0]
    expect(sent).toContain('<background_task_results>')
    expect(sent).toContain('w4-deploy-verify-20260917')
    expect(sent).toContain('Deploy verified: 3/3 checks green.')
    // Order matters: the outcome is context for the user's message.
    expect(sent.indexOf('</background_task_results>')).toBeLessThan(sent.indexOf('moin, was lief heute?'))
    // Bookkeeping is on the task row, so a restart cannot replay it.
    expect(new TaskStore(db).getById(taskId)!.agentNotifiedAt).toBeTruthy()
  })

  it('announces each outcome only once', async () => {
    finishedCronTask('cron-once', 'One time only.')

    await drain(agent.sendMessage('1', 'erste frage', 'web', undefined, 'main'))
    await drain(agent.sendMessage('1', 'zweite frage', 'web', undefined, 'main'))

    expect(prompts[0]).toContain('cron-once')
    expect(prompts[1]).not.toContain('cron-once')
    expect(prompts[1]).toContain('zweite frage')
  })

  it('routes an outcome to the persona that owns it', async () => {
    finishedCronTask('bobs-cron', 'Bob work done.', 'bob')

    await drain(agent.sendMessage('1', 'main frage', 'web', undefined, 'main'))
    expect(prompts[0]).not.toContain('bobs-cron')

    await drain(agent.sendMessage('1', 'bob frage', 'web', undefined, 'bob'))
    expect(prompts[1]).toContain('bobs-cron')
  })

  it('leaves a turn untouched when nothing is pending', async () => {
    await drain(agent.sendMessage('1', 'nur eine frage', 'web', undefined, 'main'))
    expect(prompts[0]).not.toContain('<background_task_results>')
  })
})
