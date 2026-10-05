import { describe, expect, it } from 'vitest'
import { buildModel, PROVIDER_TYPE_PRESETS, type ProviderConfig } from '../provider-config.js'
import { OLLAMA_CHAT_API } from './chat-stream.js'

/* Synthetic config only. */
describe('ollama-native provider preset (additive)', () => {
  it('adds ollama-native with the native api and server-root base URL', () => {
    expect(PROVIDER_TYPE_PRESETS['ollama-native']).toMatchObject({ apiType: OLLAMA_CHAT_API, baseUrl: 'http://localhost:11434', requiresApiKey: false })
  })
  it('leaves the existing ollama /v1 preset untouched', () => {
    expect(PROVIDER_TYPE_PRESETS.ollama).toMatchObject({ type: 'ollama', apiType: 'openai-completions', baseUrl: 'http://localhost:11434/v1' })
  })
  it('buildModel routes an ollama-native provider to the ollama-chat api', () => {
    const p = {
      id: 'p-native', name: 'native', providerType: 'ollama-native', type: OLLAMA_CHAT_API, provider: 'ollama-native',
      baseUrl: 'http://ollama.invalid:11434', model: 'synthetic:7b', apiKey: '',
    } as unknown as ProviderConfig
    const m = buildModel(p, 'synthetic:7b')
    expect(m.api).toBe(OLLAMA_CHAT_API)
    expect(m.baseUrl).toBe('http://ollama.invalid:11434')
  })
})
