import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase, type Database } from './database.js'
import type { AgentRuntimeBoundary } from './agent-runtime.js'
import type { ProviderConfig } from './provider-config.js'
import type { ResponseChunk } from './agent-runtime-types.js'

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'system'),
}))
vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/workspace/test-config'),
}))

const providers: Record<string, ProviderConfig> = {
  default: { id: 'default', name: 'Default', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['default-model'] },
  pinned: { id: 'pinned', name: 'Pinned', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['model-a', 'model-b'] },
}

function model(id: string) {
  return { id, name: id, api: 'openai-completions' as const, provider: 'openai', baseUrl: 'https://example.invalid', reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }
}

async function drain(iterable: AsyncIterable<unknown>) {
  for await (const _chunk of iterable) { /* drain */ }
}

describe('AgentCore per-strand model pin integration', () => {
  let db: Database
  let used: Array<{ sessionId: string; providerId: string; modelId: string }>

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'tester', 'x', 'user')").run()
    used = []
  })

  it('uses default on turn 1, the new strand pin on turn 2, and keeps a second strand isolated', async () => {
    let currentProvider = providers.default!
    let currentModel = model('default-model')
    let messages: unknown[] = []
    const swaps: Array<{ providerId: string; modelId: string }> = []
    const runtime = {
      swapProvider(provider: ProviderConfig, _apiKey: string, modelId?: string) {
        currentProvider = provider
        currentModel = model(modelId ?? provider.enabledModels?.[0] ?? '')
        swaps.push({ providerId: provider.id, modelId: currentModel.id })
      },
      getCurrentProvider: () => currentProvider,
      getCurrentModel: () => currentModel,
      getCurrentTimeContext: () => 'time',
      refreshSystemPrompt: vi.fn(),
      getMessages: () => messages,
      setMessages: (next: unknown[]) => { messages = next },
      clearMessages: () => { messages = [] },
      getStateSnapshot: () => ({ modelId: currentModel.id, toolNames: [], messageCount: messages.length }),
      setProviderManager: vi.fn(),
      getProviderManager: () => undefined,
      setThinkingLevel: vi.fn(),
      async *streamPrompt(_text: string, sessionId: string): AsyncIterable<ResponseChunk> {
        used.push({ sessionId, providerId: currentProvider.id, modelId: currentModel.id })
        yield { type: 'done' }
      },
    } as unknown as AgentRuntimeBoundary

    const core = new AgentCore({
      model: model('default-model'), apiKey: 'not-a-secret', db, tools: [], providerConfig: providers.default,
      runtimeFactory: () => runtime,
      resolveTurnModel: async ({ sessionId }) => {
        const pin = db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get(sessionId) as { model_provider_id: string | null; model_id: string | null }
        const provider = pin.model_provider_id ? providers[pin.model_provider_id]! : providers.default!
        const modelId = pin.model_id ?? 'default-model'
        return { provider, apiKey: 'not-a-secret', effective: { providerId: provider.id, modelId, source: pin.model_id ? 'strand' : 'global' } }
      },
    })
    const first = core.getSessionManager().createThread('1', 'main', 'First')
    const second = core.getSessionManager().createThread('1', 'main', 'Second')

    await drain(core.sendMessage('1', 'turn one', 'web', undefined, 'main', first.id))
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('pinned', 'model-a', first.id)
    await drain(core.sendMessage('1', 'turn two', 'web', undefined, 'main', first.id))
    // Same effective provider/model again: the integration must not rebuild or
    // swap the runtime merely because another turn starts.
    await drain(core.sendMessage('1', 'turn three, same pin', 'web', undefined, 'main', first.id))
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('pinned', 'model-b', second.id)
    await drain(core.sendMessage('1', 'other strand', 'web', undefined, 'main', second.id))
    await drain(core.sendMessage('1', 'first again', 'web', undefined, 'main', first.id))

    expect(used).toEqual([
      { sessionId: first.id, providerId: 'default', modelId: 'default-model' },
      { sessionId: first.id, providerId: 'pinned', modelId: 'model-a' },
      { sessionId: first.id, providerId: 'pinned', modelId: 'model-a' },
      { sessionId: second.id, providerId: 'pinned', modelId: 'model-b' },
      { sessionId: first.id, providerId: 'pinned', modelId: 'model-a' },
    ])
    expect(swaps).toEqual([
      { providerId: 'pinned', modelId: 'model-a' },
      { providerId: 'pinned', modelId: 'model-b' },
      { providerId: 'pinned', modelId: 'model-a' },
    ])
  })

  it('never swaps the model while a foreign run still owns the runtime', async () => {
    // The queue watchdog can release its slot 30 minutes into a silent turn
    // while that provider call is still alive. Swapping then would rewrite
    // `agent.state.model` underneath the running strand.
    let currentProvider = providers.default!
    let currentModel = model('default-model')
    let messages: unknown[] = []
    const swaps: Array<{ providerId: string; modelId: string }> = []
    let runningSessionId: string | null = null
    const runtime = {
      swapProvider(provider: ProviderConfig, _apiKey: string, modelId?: string) {
        currentProvider = provider
        currentModel = model(modelId ?? provider.enabledModels?.[0] ?? '')
        swaps.push({ providerId: provider.id, modelId: currentModel.id })
      },
      getRunningSessionId: () => runningSessionId,
      getCurrentProvider: () => currentProvider,
      getCurrentModel: () => currentModel,
      getCurrentTimeContext: () => 'time',
      refreshSystemPrompt: vi.fn(),
      getMessages: () => messages,
      setMessages: (next: unknown[]) => { messages = next },
      clearMessages: () => { messages = [] },
      getStateSnapshot: () => ({ modelId: currentModel.id, toolNames: [], messageCount: messages.length }),
      setProviderManager: vi.fn(),
      getProviderManager: () => undefined,
      setThinkingLevel: vi.fn(),
      async *streamPrompt(_text: string, sessionId: string): AsyncIterable<ResponseChunk> {
        used.push({ sessionId, providerId: currentProvider.id, modelId: currentModel.id })
        yield { type: 'done' }
      },
    } as unknown as AgentRuntimeBoundary

    const core = new AgentCore({
      model: model('default-model'), apiKey: 'not-a-secret', db, tools: [], providerConfig: providers.default,
      runtimeFactory: () => runtime,
      resolveTurnModel: async ({ sessionId }) => {
        const pin = db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get(sessionId) as { model_provider_id: string | null; model_id: string | null }
        const provider = pin.model_provider_id ? providers[pin.model_provider_id]! : providers.default!
        const modelId = pin.model_id ?? 'default-model'
        return { provider, apiKey: 'not-a-secret', effective: { providerId: provider.id, modelId, source: pin.model_id ? 'strand' : 'global' } }
      },
    })
    const victim = core.getSessionManager().createThread('1', 'main', 'Long running')
    const intruder = core.getSessionManager().createThread('1', 'main', 'Impatient')
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('pinned', 'model-b', intruder.id)

    runningSessionId = victim.id
    await drain(core.sendMessage('1', 'while the other one hangs', 'web', undefined, 'main', intruder.id))

    expect(swaps).toEqual([])
    expect(currentModel.id).toBe('default-model')

    // Once the foreign run finished, the pin applies on the next turn.
    runningSessionId = null
    await drain(core.sendMessage('1', 'now it is free', 'web', undefined, 'main', intruder.id))
    expect(swaps).toEqual([{ providerId: 'pinned', modelId: 'model-b' }])
  })

  /**
   * Incident 2026-09-24 11:49 UTC (session cb5fba90): a second strand of the
   * same persona moved the GLOBAL model to an OpenAI Codex one while a Claude
   * turn was inside its tool loop. pi-agent freezes `config.model` at run
   * start but re-resolves the API key before every LLM call, so the running
   * Anthropic request went out with the Codex access token and Anthropic
   * answered `401 authentication_error "invalid x-api-key"`. A global swap
   * must therefore wait for the running turn and land on the next one.
   */
  it('defers a global provider swap that arrives while a turn is streaming', async () => {
    let currentProvider = providers.default!
    let currentModel = model('default-model')
    let currentApiKey = 'key-default'
    let messages: unknown[] = []
    const swaps: Array<{ providerId: string; modelId: string; apiKey: string }> = []
    let runningSessionId: string | null = null
    let release!: () => void
    const midTurn = new Promise<void>(resolve => { release = resolve })
    const credentialDuringTurn: string[] = []
    const runtime = {
      swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string) {
        currentProvider = provider
        currentApiKey = apiKey
        currentModel = model(modelId ?? provider.enabledModels?.[0] ?? '')
        swaps.push({ providerId: provider.id, modelId: currentModel.id, apiKey })
      },
      getRunningSessionId: () => runningSessionId,
      getCurrentProvider: () => currentProvider,
      getCurrentModel: () => currentModel,
      getCurrentApiKey: () => currentApiKey,
      getCurrentTimeContext: () => 'time',
      refreshSystemPrompt: vi.fn(),
      getMessages: () => messages,
      setMessages: (next: unknown[]) => { messages = next },
      clearMessages: () => { messages = [] },
      getStateSnapshot: () => ({ modelId: currentModel.id, toolNames: [], messageCount: messages.length }),
      setProviderManager: vi.fn(),
      getProviderManager: () => undefined,
      setThinkingLevel: vi.fn(),
      async *streamPrompt(_text: string, sessionId: string): AsyncIterable<ResponseChunk> {
        runningSessionId = sessionId
        credentialDuringTurn.push(currentApiKey)
        // Stand-in for the provider call the tool loop is waiting on.
        await midTurn
        // What the NEXT LLM call of the same run would authenticate with.
        credentialDuringTurn.push(currentApiKey)
        runningSessionId = null
        yield { type: 'done' }
      },
    } as unknown as AgentRuntimeBoundary

    // No `resolveTurnModel` here: the deferred swap has to apply on its own.
    const core = new AgentCore({
      model: model('default-model'), apiKey: 'key-default', db, tools: [], providerConfig: providers.default,
      runtimeFactory: () => runtime,
    })
    const strand = core.getSessionManager().createThread('1', 'main', 'Streaming')
    const turn = drain(core.sendMessage('1', 'long answer', 'web', undefined, 'main', strand.id))
    for (let i = 0; i < 50 && runningSessionId === null; i++) await new Promise(r => setTimeout(r, 2))
    expect(runningSessionId).toBe(strand.id)

    core.swapProvider(providers.pinned!, 'key-pinned', 'model-a')
    expect(swaps).toEqual([])

    release()
    await turn
    // Both LLM calls of the running turn saw the credential it started with.
    expect(credentialDuringTurn).toEqual(['key-default', 'key-default'])

    await drain(core.sendMessage('1', 'next turn', 'web', undefined, 'main', strand.id))
    expect(swaps).toEqual([{ providerId: 'pinned', modelId: 'model-a', apiKey: 'key-pinned' }])
  })
})
