/**
 * Strand isolation: a persona no longer owns ONE runtime that every strand
 * shares. Model, credential and model context belong to the strand, and two
 * strands of the same persona run in parallel without touching each other.
 *
 * The runtime double below is created per runtime (the factory gets the
 * session id), exactly like the real `createAgentRuntime` call, and records
 * which provider/model/credential each LLM call actually saw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase, type Database } from './database.js'
import type { AgentRuntimeBoundary } from './agent-runtime.js'
import type { ProviderConfig } from './provider-config.js'
import type { ResponseChunk, TurnStreamChunk } from './agent-runtime-types.js'

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'system'),
  appendToDailyFile: vi.fn(),
  resolveAgentMemoryDir: vi.fn(() => undefined),
}))
vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/workspace/test-config'),
}))

const providers: Record<string, ProviderConfig> = {
  alpha: { id: 'alpha', name: 'Alpha', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['alpha-model'] },
  beta: { id: 'beta', name: 'Beta', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['beta-model'] },
}

function model(id: string) {
  return { id, name: id, api: 'openai-completions' as const, provider: 'openai', baseUrl: 'https://example.invalid', reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }
}

interface CallRecord { sessionId: string; providerId: string; modelId: string; apiKey: string; historyBefore: number }

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/**
 * Build a runtime double. `onPrompt` may return a promise the stream awaits
 * in the middle of the run, which is how a turn is held open while another
 * strand starts its own.
 */
function makeRuntimeFactory(
  calls: CallRecord[],
  onPrompt?: (sessionId: string) => Promise<void> | void,
) {
  const created: Array<{ sessionId: string | undefined; providerId: () => string }> = []
  const factory = (_agentId: string, sessionId?: string): AgentRuntimeBoundary => {
    let currentProvider = providers.alpha!
    let currentModel = model('alpha-model')
    let currentKey = 'key-alpha'
    let messages: unknown[] = []
    let running: string | null = null
    created.push({ sessionId, providerId: () => currentProvider.id })
    return {
      swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string) {
        currentProvider = provider
        currentModel = model(modelId ?? provider.enabledModels?.[0] ?? '')
        currentKey = apiKey
      },
      getCurrentProvider: () => currentProvider,
      getCurrentModel: () => currentModel,
      getCurrentApiKey: () => currentKey,
      getCurrentTimeContext: () => 'time',
      refreshSystemPrompt: vi.fn(),
      getMessages: () => messages,
      setMessages: (next: unknown[]) => { messages = next },
      clearMessages: () => { messages = [] },
      getStateSnapshot: () => ({ modelId: currentModel.id, toolNames: [], messageCount: messages.length }),
      setProviderManager: vi.fn(),
      getProviderManager: () => undefined,
      setThinkingLevel: vi.fn(),
      getThinkingLevel: () => 'off',
      getRunningSessionId: () => running,
      abort: vi.fn(),
      async *streamPrompt(text: string, promptSessionId: string): AsyncIterable<ResponseChunk> {
        running = promptSessionId
        try {
          await onPrompt?.(promptSessionId)
          // Recorded AFTER the pause: a swap that lands mid-run would be
          // visible here, which is exactly the bleeding this guards against.
          calls.push({ sessionId: promptSessionId, providerId: currentProvider.id, modelId: currentModel.id, apiKey: currentKey, historyBefore: messages.length })
          messages = [...messages, { role: 'user', text }, { role: 'assistant', text: `reply ${text}` }]
          yield { type: 'text', text: `reply ${text}` }
          yield { type: 'done' }
        } finally {
          running = null
        }
      },
      async *retryLastTurn(text: string, promptSessionId: string): AsyncIterable<ResponseChunk> {
        calls.push({ sessionId: promptSessionId, providerId: currentProvider.id, modelId: currentModel.id, apiKey: currentKey, historyBefore: messages.length })
        yield { type: 'text', text: `retry ${text}` }
        yield { type: 'done' }
      },
    } as unknown as AgentRuntimeBoundary
  }
  return { factory, created }
}

async function drain(stream: AsyncIterable<TurnStreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

function pinStrand(db: Database, sessionId: string, providerId: string, modelId: string) {
  db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run(providerId, modelId, sessionId)
}

describe('strand isolation', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'tester', 'x', 'user')").run()
  })

  it('runs two strands of the SAME persona in parallel, each on its own model and credential', async () => {
    const calls: CallRecord[] = []
    const hold = deferred()
    let firstStarted: (() => void) | null = null
    const firstRunning = new Promise<void>((resolve) => { firstStarted = resolve })
    const { factory } = makeRuntimeFactory(calls, async (sessionId) => {
      if (sessionId === strandA) {
        firstStarted?.()
        await hold.promise
      }
    })

    const core = new AgentCore({
      model: model('alpha-model'), apiKey: 'key-alpha', db, tools: [], providerConfig: providers.alpha,
      runtimeFactory: factory,
      resolveTurnModel: async ({ sessionId }) => {
        const pin = db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get(sessionId) as { model_provider_id: string | null; model_id: string | null }
        const provider = pin.model_provider_id ? providers[pin.model_provider_id]! : providers.alpha!
        const modelId = pin.model_id ?? 'alpha-model'
        return { provider, apiKey: `key-${provider.id}`, effective: { providerId: provider.id, modelId, source: 'strand' } }
      },
    })
    const a = core.getSessionManager().createThread('1', 'main', 'A')
    const b = core.getSessionManager().createThread('1', 'main', 'B')
    const strandA = a.id
    pinStrand(db, a.id, 'alpha', 'alpha-model')
    pinStrand(db, b.id, 'beta', 'beta-model')

    const runA = drain(core.sendMessage('1', 'from A', 'web', undefined, 'main', a.id))
    await firstRunning

    // While A is mid-run, B must be able to run to completion. With one shared
    // runtime per persona this deadlocks on the persona queue / lands on A's
    // model.
    await drain(core.sendMessage('1', 'from B', 'web', undefined, 'main', b.id))
    expect(calls).toEqual([
      { sessionId: b.id, providerId: 'beta', modelId: 'beta-model', apiKey: 'key-beta', historyBefore: 0 },
    ])

    hold.resolve()
    await runA
    expect(calls).toEqual([
      { sessionId: b.id, providerId: 'beta', modelId: 'beta-model', apiKey: 'key-beta', historyBefore: 0 },
      { sessionId: a.id, providerId: 'alpha', modelId: 'alpha-model', apiKey: 'key-alpha', historyBefore: 0 },
    ])
  })

  it('keeps the model context of two parallel strands separate', async () => {
    const calls: CallRecord[] = []
    const { factory } = makeRuntimeFactory(calls)
    const core = new AgentCore({
      model: model('alpha-model'), apiKey: 'key-alpha', db, tools: [], providerConfig: providers.alpha,
      runtimeFactory: factory,
    })
    const a = core.getSessionManager().createThread('1', 'main', 'A')
    const b = core.getSessionManager().createThread('1', 'main', 'B')

    await drain(core.sendMessage('1', 'secret of A', 'web', undefined, 'main', a.id))
    await drain(core.sendMessage('1', 'hello B', 'web', undefined, 'main', b.id))

    // B runs on its own runtime, so its first call must start from an EMPTY
    // model context, not from the two messages A produced.
    expect(calls.map(c => ({ sessionId: c.sessionId, historyBefore: c.historyBefore }))).toEqual([
      { sessionId: a.id, historyBefore: 0 },
      { sessionId: b.id, historyBefore: 0 },
    ])
    // And a third turn back in A continues A's own context.
    await drain(core.sendMessage('1', 'back in A', 'web', undefined, 'main', a.id))
    expect(calls.at(-1)).toMatchObject({ sessionId: a.id, historyBefore: 2 })
  })

  it('a global provider swap does not change an existing strand, only the default for new ones', async () => {
    const calls: CallRecord[] = []
    const { factory } = makeRuntimeFactory(calls)
    const core = new AgentCore({
      model: model('alpha-model'), apiKey: 'key-alpha', db, tools: [], providerConfig: providers.alpha,
      runtimeFactory: factory,
    })
    const existing = core.getSessionManager().createThread('1', 'main', 'Existing')

    await drain(core.sendMessage('1', 'first turn', 'web', undefined, 'main', existing.id))
    core.swapProvider(providers.beta!, 'key-beta', 'beta-model')
    await drain(core.sendMessage('1', 'second turn', 'web', undefined, 'main', existing.id))

    // The already running strand keeps the model it was started on.
    expect(calls.map(c => c.modelId)).toEqual(['alpha-model', 'alpha-model'])

    // A strand created afterwards picks the new global default up.
    const fresh = core.getSessionManager().createThread('1', 'main', 'Fresh')
    await drain(core.sendMessage('1', 'new strand', 'web', undefined, 'main', fresh.id))
    expect(calls.at(-1)).toMatchObject({ sessionId: fresh.id, providerId: 'beta', modelId: 'beta-model' })
  })

  it('runs a task injection on the model of the strand it lands in', async () => {
    const calls: CallRecord[] = []
    const { factory } = makeRuntimeFactory(calls)
    const core = new AgentCore({
      model: model('alpha-model'), apiKey: 'key-alpha', db, tools: [], providerConfig: providers.alpha,
      runtimeFactory: factory,
      resolveTurnModel: async ({ sessionId }) => {
        const pin = db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get(sessionId) as { model_provider_id: string | null; model_id: string | null }
        const provider = pin.model_provider_id ? providers[pin.model_provider_id]! : providers.alpha!
        const modelId = pin.model_id ?? 'alpha-model'
        return { provider, apiKey: `key-${provider.id}`, effective: { providerId: provider.id, modelId, source: 'strand' } }
      },
    })
    const strand = core.getSessionManager().createThread('1', 'main', 'Lineage')
    pinStrand(db, strand.id, 'beta', 'beta-model')

    // The result of a background task is written back into the strand the task
    // was started from. That turn is a turn OF that strand and must use the
    // strand's pinned model, not whatever the persona template carries.
    await core.injectTaskResult('<task_injection>done</task_injection>', '1', strand.id, undefined, 'main')

    expect(calls).toEqual([
      { sessionId: strand.id, providerId: 'beta', modelId: 'beta-model', apiKey: 'key-beta', historyBefore: 0 },
    ])
  })

  it('still serializes two messages into the SAME strand', async () => {
    const calls: CallRecord[] = []
    const order: string[] = []
    const gate = deferred()
    let firstStarted: (() => void) | null = null
    const firstRunning = new Promise<void>((resolve) => { firstStarted = resolve })
    let seen = 0
    const { factory } = makeRuntimeFactory(calls, async () => {
      seen += 1
      order.push(`start-${seen}`)
      if (seen === 1) {
        firstStarted?.()
        await gate.promise
      }
    })
    const core = new AgentCore({
      model: model('alpha-model'), apiKey: 'key-alpha', db, tools: [], providerConfig: providers.alpha,
      runtimeFactory: factory,
    })
    const strand = core.getSessionManager().createThread('1', 'main', 'Serial')

    const firstTurn = drain(core.sendMessage('1', 'one', 'web', undefined, 'main', strand.id))
    await firstRunning
    const secondTurn = drain(core.sendMessage('1', 'two', 'web', undefined, 'main', strand.id))

    // The second turn of the same strand must NOT have started yet.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(order).toEqual(['start-1'])

    gate.resolve()
    await firstTurn
    await secondTurn
    expect(order).toEqual(['start-1', 'start-2'])
    expect(calls).toHaveLength(2)
  })
})
