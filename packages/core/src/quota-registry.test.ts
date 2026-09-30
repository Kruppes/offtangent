import { describe, expect, it } from 'vitest'
import { getQuotaAdapter, isQuotaProvider } from './quota-registry.js'
import type { ProviderConfig } from './provider-config.js'

function provider(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'p',
    name: 'p',
    type: 'x',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    enabledModels: ['m'],
    ...overrides,
  }
}

const anthropicOAuth = provider({
  providerType: 'anthropic-oauth',
  authMethod: 'oauth',
  oauthCredentials: { refresh: 'r', access: 'a', expires: Date.now() + 60_000 },
})

const codexOAuth = provider({
  providerType: 'openai-codex',
  authMethod: 'oauth',
  oauthCredentials: { refresh: 'r', access: 'a', expires: Date.now() + 60_000 },
})

const apiKeyProvider = provider({ providerType: 'openai', authMethod: 'api-key', apiKey: 'sk' })

describe('quota registry', () => {
  it('resolves the correct adapter by provider family', () => {
    expect(getQuotaAdapter(anthropicOAuth)?.kind).toBe('anthropic')
    expect(getQuotaAdapter(codexOAuth)?.kind).toBe('openai-codex')
    expect(getQuotaAdapter(apiKeyProvider)).toBeNull()
  })

  it('reports quota support', () => {
    expect(isQuotaProvider(anthropicOAuth)).toBe(true)
    expect(isQuotaProvider(codexOAuth)).toBe(true)
    expect(isQuotaProvider(apiKeyProvider)).toBe(false)
  })
})
