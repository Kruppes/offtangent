import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentCore, isRetryablePreStreamError } from './agent.js'
import { ProviderManager } from './provider-manager.js'
import type { ProviderConfig } from './provider-config.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'

// Mock the memory, config, and provider-config modules to avoid filesystem access
vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
}))

vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-primary',
    name: 'Primary',
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-primary',
    enabledModels: ['gpt-4o'],
    ...overrides,
  }
}

function makeFallbackProvider(): ProviderConfig {
  return makeProvider({
    id: 'test-fallback',
    name: 'Fallback',
    providerType: 'anthropic',
    type: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-fallback',
    enabledModels: ['claude-sonnet-4-20250514'],
  })
}

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

describe('AgentCore runtime boundary', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  it('registers search_memories by default', () => {
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    const toolNames = agentCore.getRuntimeStateSnapshot().toolNames
    expect(toolNames).toContain('search_memories')
  })

  it('swapProvider() updates runtime model id through the boundary', () => {
    const primary = makeProvider()
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
      providerConfig: primary,
    })

    const fallback = makeFallbackProvider()
    agentCore.swapProvider(fallback, 'sk-fallback')

    expect(agentCore.getRuntimeStateSnapshot().modelId).toBe('claude-sonnet-4-20250514')
  })

  it('conversation context remains intact across swapProvider calls', () => {
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    const snapshotBefore = agentCore.getRuntimeStateSnapshot()
    const fallback = makeFallbackProvider()
    agentCore.swapProvider(fallback, 'sk-fallback')
    const snapshotAfter = agentCore.getRuntimeStateSnapshot()

    expect(snapshotAfter.messageCount).toBe(snapshotBefore.messageCount)
  })

  // C4 — per-persona provider pinning.
  it('swapProviderForAgent pins ONE persona without touching the others', () => {
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
      providerConfig: makeProvider(),
    })

    agentCore.swapProviderForAgent('warren', makeFallbackProvider(), 'sk-fallback')

    expect(agentCore.getRuntimeStateSnapshot('warren').modelId).toBe('claude-sonnet-4-20250514')
    expect(agentCore.getRuntimeStateSnapshot('main').modelId).toBe('gpt-4o')
  })

  it('global swapProvider skips pinned personas (per-agent model survives global model change)', () => {
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
      providerConfig: makeProvider(),
    })

    // Pin warren to the fallback provider's model…
    agentCore.swapProviderForAgent('warren', makeFallbackProvider(), 'sk-fallback')
    // …then change the GLOBAL model (as Settings / Telegram /model would).
    const newGlobal = makeProvider({ id: 'global-2', name: 'Global2', enabledModels: ['gpt-4o-mini'] })
    agentCore.swapProvider(newGlobal, 'sk-global-2')

    // main follows the global change, warren keeps its pinned model.
    expect(agentCore.getRuntimeStateSnapshot('main').modelId).toBe('gpt-4o-mini')
    expect(agentCore.getRuntimeStateSnapshot('warren').modelId).toBe('claude-sonnet-4-20250514')
  })

  it('unpinAgentProvider re-syncs the persona to the supplied global provider', () => {
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
      providerConfig: makeProvider(),
    })

    agentCore.swapProviderForAgent('warren', makeFallbackProvider(), 'sk-fallback')
    expect(agentCore.getRuntimeStateSnapshot('warren').modelId).toBe('claude-sonnet-4-20250514')

    const global = makeProvider()
    agentCore.unpinAgentProvider('warren', global, 'sk-primary')
    expect(agentCore.getRuntimeStateSnapshot('warren').modelId).toBe('gpt-4o')

    // After unpinning, global swaps reach warren again.
    const newGlobal = makeProvider({ id: 'global-2', name: 'Global2', enabledModels: ['gpt-4o-mini'] })
    agentCore.swapProvider(newGlobal, 'sk-global-2')
    expect(agentCore.getRuntimeStateSnapshot('warren').modelId).toBe('gpt-4o-mini')
  })

  it('accepts a ProviderManager in constructor options', () => {
    const pm = new ProviderManager(makeProvider(), makeFallbackProvider())
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
      providerManager: pm,
    })

    expect(agentCore.getProviderManager()).toBe(pm)
  })

  it('works without ProviderManager (backward compatible)', () => {
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    expect(agentCore.getProviderManager()).toBeUndefined()
    expect(agentCore.getRuntimeStateSnapshot().modelId).toBe('gpt-4o')
  })
})

describe('isRetryablePreStreamError', () => {
  it('detects HTTP 429 errors', () => {
    expect(isRetryablePreStreamError(new Error('HTTP 429 Too Many Requests'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('Rate limit exceeded'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('too many requests'))).toBe(true)
  })

  it('detects HTTP 5xx errors', () => {
    expect(isRetryablePreStreamError(new Error('HTTP 500 Internal Server Error'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('HTTP 502 Bad Gateway'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('HTTP 503 Service Unavailable'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('HTTP 504 Gateway Timeout'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('internal server error'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('bad gateway'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('service unavailable'))).toBe(true)
  })

  it('detects connection errors', () => {
    expect(isRetryablePreStreamError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('ECONNRESET'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('fetch failed'))).toBe(true)
    expect(isRetryablePreStreamError(new Error('Connection refused'))).toBe(true)
  })

  it('does not retry on other errors', () => {
    expect(isRetryablePreStreamError(new Error('Invalid API key'))).toBe(false)
    expect(isRetryablePreStreamError(new Error('HTTP 401 Unauthorized'))).toBe(false)
    expect(isRetryablePreStreamError(new Error('HTTP 403 Forbidden'))).toBe(false)
    expect(isRetryablePreStreamError(new Error('Model not found'))).toBe(false)
  })
})
