/**
 * Offtangent Stufe 1: per-thread model transcripts inside ONE runtime per
 * persona.
 *
 * There is a single AgentRuntime per persona, so two threads of the same
 * persona would share `state.messages` — thread B would see thread A's
 * conversation (and vice versa) and the model would answer from the wrong
 * context. AgentCore therefore parks/loads the transcript around every turn.
 *
 * The runtime mock below behaves like the real one in the only aspect that
 * matters here: `streamPrompt` appends to the transcript it currently holds,
 * and `getMessages`/`setMessages` read/replace it wholesale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { ResponseChunk, TurnStreamChunk } from './agent-runtime-types.js'

interface FakeMessage { role: string; text: string }

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
        promptSnapshots.push({ sessionId, history: state.messages.map(m => `${m.role}:${m.text}`) })
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

describe('AgentCore thread transcripts', () => {
  let db: Database
  let agent: AgentCore

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
    runtimes.clear()
    promptSnapshots.length = 0
    agent = new AgentCore({ model: makeModel(), apiKey: 'k', db, systemPrompt: 'sp' })
  })

  it('keeps two threads of the SAME persona isolated', async () => {
    const sm = agent.getSessionManager()
    const a = sm.createThread('1', 'main', 'Thread A')
    const b = sm.createThread('1', 'main', 'Thread B')

    await drain(agent.sendMessage('1', 'alpha one', 'web', undefined, 'main', a.id))
    await drain(agent.sendMessage('1', 'beta one', 'web', undefined, 'main', b.id))
    await drain(agent.sendMessage('1', 'alpha two', 'web', undefined, 'main', a.id))

    expect(promptSnapshots.map(s => s.sessionId)).toEqual([a.id, b.id, a.id])
    // First turn in A: empty context.
    expect(promptSnapshots[0].history).toEqual([])
    // First turn in B: must NOT contain A's messages.
    expect(promptSnapshots[1].history).toEqual([])
    // Second turn in A: only A's own history, nothing from B.
    expect(promptSnapshots[2].history.join('\n')).toContain('alpha one')
    expect(promptSnapshots[2].history.join('\n')).not.toContain('beta one')

    // Back to B: its own history is restored, still without A's turns.
    await drain(agent.sendMessage('1', 'beta two', 'web', undefined, 'main', b.id))
    const backInB = promptSnapshots[3].history.join('\n')
    expect(backInB).toContain('beta one')
    expect(backInB).not.toContain('alpha one')
    expect(backInB).not.toContain('alpha two')
  })

  it('parks B while a task result runs in A, then restores B without task context', async () => {
    const sm = agent.getSessionManager()
    const a = sm.createThread('1', 'main', 'A')
    const b = sm.createThread('1', 'main', 'B')
    await drain(agent.sendMessage('1', 'alpha-private', 'web', undefined, 'main', a.id))
    await drain(agent.sendMessage('1', 'beta-private', 'web', undefined, 'main', b.id))
    await agent.injectTaskResult('alpha-task-result', '1', a.id)
    expect(promptSnapshots[2].sessionId).toBe(a.id)
    expect(promptSnapshots[2].history.join(' ')).toContain('alpha-private')
    expect(promptSnapshots[2].history.join(' ')).not.toContain('beta-private')
    expect(sm.getSession('1')?.id).toBe(b.id)
    await drain(agent.sendMessage('1', 'beta-followup', 'web', undefined, 'main', b.id))
    expect(promptSnapshots[3].history.join(' ')).toContain('beta-private')
    expect(promptSnapshots[3].history.join(' ')).not.toContain('alpha-')
    await drain(agent.sendMessage('1', 'alpha-followup', 'web', undefined, 'main', a.id))
    expect(promptSnapshots[4].history.join(' ')).toContain('alpha-task-result')
    expect(promptSnapshots[4].history.join(' ')).not.toContain('beta-')
  })

  it('keeps a manual retry on the explicit thread transcript', async () => {
    const sm = agent.getSessionManager()
    const a = sm.createThread('1', 'main', 'A')
    const b = sm.createThread('1', 'main', 'B')

    await drain(agent.sendMessage('1', 'alpha one', 'web', undefined, 'main', a.id))
    await drain(agent.sendMessage('1', 'beta one', 'web', undefined, 'main', b.id))
    await drain(agent.retryTurn('1', 'alpha one', 'web', undefined, 'main', a.id))

    const retrySnapshot = promptSnapshots[2]
    expect(retrySnapshot.sessionId).toBe(a.id)
    expect(retrySnapshot.history.join('\n')).toContain('alpha one')
    expect(retrySnapshot.history.join('\n')).not.toContain('beta one')
  })

  it('routes an explicit sessionId through activateSession, never through topic-shift detection', async () => {
    const sm = agent.getSessionManager()
    const thread = sm.createThread('1', 'main', 'A')
    const resolveSpy = vi.spyOn(sm, 'resolveSession')
    const activateSpy = vi.spyOn(sm, 'activateSession')

    await drain(agent.sendMessage('1', 'hello', 'web', undefined, 'main', thread.id))

    // A brand-new thread has no transcript loaded or parked -> cold start,
    // so the manager gets to queue the thread's own continuity injection.
    expect(activateSpy).toHaveBeenCalledWith('1', thread.id, 'main', { messageText: 'hello', hasTranscript: false })
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it('without a sessionId behaves exactly like before (resolveSession path)', async () => {
    const sm = agent.getSessionManager()
    const resolveSpy = vi.spyOn(sm, 'resolveSession')
    const activateSpy = vi.spyOn(sm, 'activateSession')

    await drain(agent.sendMessage('1', 'hello', 'web'))

    expect(resolveSpy).toHaveBeenCalledWith('1', 'web', 'hello', 'main')
    expect(activateSpy).not.toHaveBeenCalled()
    // ... and the legacy single-session behaviour is untouched: a second
    // message continues in the same session with the accumulated transcript.
    await drain(agent.sendMessage('1', 'again', 'web'))
    expect(promptSnapshots[0].sessionId).toBe(promptSnapshots[1].sessionId)
    expect(promptSnapshots[1].history.join('\n')).toContain('hello')
  })

  it('titles a strand that a plain chat turn created, from the first user message only', async () => {
    const long = 'Die Strand Zuordnung ist immer noch extrem lueckenhaft und trifft daneben'
    await drain(agent.sendMessage('1', long, 'web'))
    const sessionId = promptSnapshots[0].sessionId
    const first = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title: string | null }
    expect(first.title).toBeTruthy()
    expect(first.title!.length).toBeLessThanOrEqual(60)
    expect(long.startsWith(first.title!.replace(/…$/, ''))).toBe(true)

    await drain(agent.sendMessage('1', 'ein ganz anderer zweiter satz', 'web'))
    const second = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title: string | null }
    expect(second.title).toBe(first.title)
  })

  it('isolates threads of DIFFERENT personas as before (one runtime each)', async () => {
    const sm = agent.getSessionManager()
    const mainThread = sm.createThread('1', 'main', 'main thread')
    const bobThread = sm.createThread('1', 'bob', 'bob thread')

    await drain(agent.sendMessage('1', 'to main', 'web', undefined, 'main', mainThread.id))
    await drain(agent.sendMessage('1', 'to bob', 'web', undefined, 'bob', bobThread.id))

    const mainTranscript = runtimes.get('main')!.messages.map(m => m.text).join('\n')
    const bobTranscript = runtimes.get('bob')!.messages.map(m => m.text).join('\n')
    expect(mainTranscript).toContain('to main')
    expect(mainTranscript).not.toContain('to bob')
    expect(bobTranscript).toContain('to bob')
    expect(bobTranscript).not.toContain('to main')
  })

  it('keeps the live thread intact when the sweep closes a parked one', async () => {
    // The parked-thread sweep ends a session that is NOT in the slot. The
    // onSessionEnd listener must therefore only drop that thread's transcript
    // — clearing the runtime would wipe the context of the thread the user is
    // actually writing in.
    const sm = agent.getSessionManager()
    const parked = sm.createThread('1', 'main', 'Parked')
    const live = sm.createThread('1', 'main', 'Live')

    await drain(agent.sendMessage('1', 'parked one', 'web', undefined, 'main', parked.id))
    await drain(agent.sendMessage('1', 'live one', 'web', undefined, 'main', live.id))

    // Age the parked row past the 24h budget (the live one holds the slot).
    const stale = new Date(Date.now() - 30 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
    db.prepare('UPDATE sessions SET last_activity = ?, started_at = ? WHERE id = ?').run(stale, stale, parked.id)

    expect(await sm.sweepParkedThreads()).toBe(1)
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(parked.id) as { ended_at: string | null }).ended_at).not.toBeNull()
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(live.id) as { ended_at: string | null }).ended_at).toBeNull()

    promptSnapshots.length = 0
    await drain(agent.sendMessage('1', 'live two', 'web', undefined, 'main', live.id))
    // The live thread still has its context ...
    expect(promptSnapshots[0].history.join('\n')).toContain('live one')

    // ... while the swept thread starts cold (transcript dropped) and is
    // reopened by the message.
    promptSnapshots.length = 0
    await drain(agent.sendMessage('1', 'parked two', 'web', undefined, 'main', parked.id))
    expect(promptSnapshots[0].history).toEqual([])
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(parked.id) as { ended_at: string | null }).ended_at).toBeNull()
  })

  it('evicts the transcript of a deleted strand, live one included (SPEC 7.5b)', async () => {
    const sm = agent.getSessionManager()
    const parked = sm.createThread('1', 'main', 'Parked')
    const live = sm.createThread('1', 'main', 'Live')

    await drain(agent.sendMessage('1', 'parked one', 'web', undefined, 'main', parked.id))
    await drain(agent.sendMessage('1', 'live one', 'web', undefined, 'main', live.id))

    // The live thread is the one loaded in the runtime: evicting it must
    // clear the runtime array too, otherwise the next turn would persist the
    // deleted session's context back into the database.
    agent.evictSessionTranscript('1', 'main', live.id)
    expect(runtimes.get('main')!.messages).toEqual([])

    agent.evictSessionTranscript('1', 'main', parked.id)

    promptSnapshots.length = 0
    await drain(agent.sendMessage('1', 'parked two', 'web', undefined, 'main', parked.id))
    expect(promptSnapshots[0].history).toEqual([])

    promptSnapshots.length = 0
    await drain(agent.sendMessage('1', 'live two', 'web', undefined, 'main', live.id))
    expect(promptSnapshots[0].history.join('\n')).not.toContain('live one')
  })

  it('drops the least recently used transcripts beyond the per-persona cap', async () => {
    const sm = agent.getSessionManager()
    const threads = Array.from({ length: 10 }, (_, i) => sm.createThread('1', 'main', `T${i}`))

    for (const [i, thread] of threads.entries()) {
      await drain(agent.sendMessage('1', `msg ${i}`, 'web', undefined, 'main', thread.id))
    }
    promptSnapshots.length = 0

    // The oldest thread was evicted (cap 8 parked transcripts): it starts
    // empty again, exactly like after a restart.
    await drain(agent.sendMessage('1', 'again 0', 'web', undefined, 'main', threads[0].id))
    expect(promptSnapshots[0].history).toEqual([])

    // A recent one still has its context.
    promptSnapshots.length = 0
    await drain(agent.sendMessage('1', 'again 9', 'web', undefined, 'main', threads[9].id))
    expect(promptSnapshots[0].history.join('\n')).toContain('msg 9')
  })
})
