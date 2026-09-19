/**
 * Model policy of the spoken summary: a fast Anthropic model, and under no
 * circumstances a provider that is off limits for personal data on this
 * instance (Moonshot/Kimi, Z.AI/GLM).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js')
  return { ...actual, loadConfig: vi.fn(() => ({})) }
})

vi.mock('./provider-config.js', async () => {
  const actual = await vi.importActual<typeof import('./provider-config.js')>('./provider-config.js')
  return {
    ...actual,
    loadProvidersDecrypted: vi.fn(() => ({ providers: [] })),
    getApiKeyForProvider: vi.fn(async () => 'test-key'),
    buildModel: vi.fn((provider: { id: string }, modelId: string) => ({
      id: modelId,
      provider: provider.id,
      api: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      cost: { input: modelId.includes('opus') ? 5 : modelId.includes('sonnet') ? 2 : 10, output: 0 },
    })),
  }
})

import { loadConfig } from './config.js'
import { loadProvidersDecrypted } from './provider-config.js'
import type { ProvidersFile } from './provider-config.js'
import { resolveSpeechSummaryModel } from './speech-summary.js'

const providersMock = vi.mocked(loadProvidersDecrypted)
const configMock = vi.mocked(loadConfig)

function providersFile(file: { providers: unknown[]; activeProvider?: string; activeModel?: string }): ProvidersFile {
  return file as unknown as ProvidersFile
}

const ANTHROPIC = {
  id: 'anthropic-1',
  name: 'Anthropic',
  providerType: 'anthropic-oauth',
  enabledModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1'],
}
const KIMI = {
  id: 'kimi-1',
  name: 'Moonshot',
  providerType: 'kimi',
  enabledModels: ['kimi-k3'],
}
const ZAI = {
  id: 'zai-1',
  name: 'Z.AI',
  providerType: 'zai',
  enabledModels: ['glm-5.3-flash'],
}

beforeEach(() => {
  vi.clearAllMocks()
  configMock.mockReturnValue({} as never)
})

describe('resolveSpeechSummaryModel', () => {
  it('prefers a fast Anthropic model over the expensive one', async () => {
    providersMock.mockReturnValue(providersFile({
      providers: [KIMI, ANTHROPIC],
      activeProvider: 'anthropic-1',
      activeModel: 'claude-opus-5',
    }))
    const choice = await resolveSpeechSummaryModel()
    expect(choice?.modelId).toBe('claude-sonnet-5')
    expect(choice?.providerId).toBe('anthropic-1')
    expect(choice?.composite).toBe('anthropic-1:claude-sonnet-5')
  })

  it('picks the haiku class model when it is enabled', async () => {
    providersMock.mockReturnValue(providersFile({
      providers: [{ ...ANTHROPIC, enabledModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] }],
    }))
    expect((await resolveSpeechSummaryModel())?.modelId).toBe('claude-haiku-4-5')
  })

  it('falls back to the cheapest enabled Anthropic model', async () => {
    providersMock.mockReturnValue(providersFile({
      providers: [{ ...ANTHROPIC, enabledModels: ['claude-opus-5', 'claude-fable-5-1'] }],
    }))
    expect((await resolveSpeechSummaryModel())?.modelId).toBe('claude-opus-5')
  })

  it('never selects Moonshot or Z.AI, not even as the only provider', async () => {
    providersMock.mockReturnValue(providersFile({
      providers: [KIMI, ZAI],
      activeProvider: 'kimi-1',
      activeModel: 'kimi-k3',
    }))
    expect(await resolveSpeechSummaryModel()).toBeNull()
  })

  it('ignores a configured speechSummary model that points at a forbidden provider', async () => {
    providersMock.mockReturnValue(providersFile({
      providers: [ANTHROPIC, KIMI],
      activeProvider: 'anthropic-1',
      activeModel: 'claude-opus-5',
    }))
    configMock.mockReturnValue({ modelPolicy: { roles: { speechSummary: 'kimi-k3' } } } as never)
    expect((await resolveSpeechSummaryModel())?.providerId).toBe('anthropic-1')
  })

  it('honours a configured speechSummary model of an allowed provider', async () => {
    providersMock.mockReturnValue(providersFile({
      providers: [ANTHROPIC],
      activeProvider: 'anthropic-1',
      activeModel: 'claude-opus-5',
    }))
    configMock.mockReturnValue({ modelPolicy: { roles: { speechSummary: 'anthropic-1:claude-fable-5-1' } } } as never)
    expect((await resolveSpeechSummaryModel())?.modelId).toBe('claude-fable-5-1')
  })

  it('falls back to the instance default when no Anthropic provider exists', async () => {
    providersMock.mockReturnValue(providersFile({
      providers: [{ id: 'oai', name: 'OpenAI', providerType: 'openai-codex', enabledModels: ['gpt-5.5'] }],
      activeProvider: 'oai',
      activeModel: 'gpt-5.5',
    }))
    const choice = await resolveSpeechSummaryModel()
    expect(choice?.providerId).toBe('oai')
    expect(choice?.modelId).toBe('gpt-5.5')
  })

  it('returns null when nothing is configured at all', async () => {
    providersMock.mockReturnValue(providersFile({ providers: [] }))
    expect(await resolveSpeechSummaryModel()).toBeNull()
  })
})
