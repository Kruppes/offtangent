import { describe, expect, it } from 'vitest'
import { PROVIDER_TYPE_PRESETS } from '@axiom/core'
import {
  parseFallbackPayload,
  parseOAuthCodePayload,
  parseOAuthLoginPayload,
  parseOllamaProbePayload,
  parseProviderCreatePayload,
  parseProviderModelUpdatePayload,
  parseProviderTypeParam,
  parseProviderUpdatePayload,
  validateOllamaUrl,
} from './schema.js'

describe('providers schema', () => {
  it('validates provider type params', () => {
    expect(parseProviderTypeParam('openai')).toEqual({ ok: true, value: 'openai' })

    const invalid = parseProviderTypeParam('not-a-provider')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) {
      expect(invalid.error).toContain('Invalid provider type. Must be one of:')
    }
  })

  it('parses fallback payload semantics', () => {
    expect(parseFallbackPayload({ providerId: null })).toEqual({
      ok: true,
      value: { providerId: null, modelId: null },
    })

    expect(parseFallbackPayload({ providerId: 'provider-1', modelId: 'model-a' })).toEqual({
      ok: true,
      value: { providerId: 'provider-1', modelId: 'model-a' },
    })

    expect(parseFallbackPayload({ providerId: '   ' })).toEqual({
      ok: false,
      error: 'providerId must be a non-empty string or null',
    })
  })

  it('keeps create/update validation outcomes stable', () => {
    expect(parseProviderCreatePayload({}, PROVIDER_TYPE_PRESETS as unknown as typeof PROVIDER_TYPE_PRESETS)).toEqual({
      ok: false,
      error: 'Provider name is required',
    })

    expect(parseProviderUpdatePayload({ providerType: 'invalid-provider' })).toEqual({
      ok: false,
      error: expect.stringContaining('Invalid provider type. Must be one of:'),
    })
  })

  it('parses oauth payloads and validates required code', () => {
    expect(parseOAuthLoginPayload({ providerType: 'openai', name: 'OpenAI', enabledModels: ['gpt-4o-mini'] })).toEqual({
      ok: true,
      value: {
        providerType: 'openai',
        name: 'OpenAI',
        enabledModels: ['gpt-4o-mini'],
        providerId: undefined,
        textVerbosity: undefined,
        transport: undefined,
      },
    })

    expect(parseOAuthCodePayload({})).toEqual({ ok: false, error: 'Code is required' })
  })

  it('parses transport field on create payload (sse / websocket / websocket-cached / auto / null)', () => {
    const presets = PROVIDER_TYPE_PRESETS as unknown as typeof PROVIDER_TYPE_PRESETS
    const base = { name: 'codex', providerType: 'openai-codex', enabledModels: ['gpt-5-codex'] }

    for (const value of ['sse', 'websocket', 'websocket-cached', 'auto'] as const) {
      const result = parseProviderCreatePayload({ ...base, transport: value }, presets)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.transport).toBe(value)
    }

    // null / empty string → explicit clear
    const cleared = parseProviderCreatePayload({ ...base, transport: null }, presets)
    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(cleared.value.transport).toBeNull()

    // unknown values are dropped (undefined), not echoed back unchecked
    const garbage = parseProviderCreatePayload({ ...base, transport: 'http2' }, presets)
    expect(garbage.ok).toBe(true)
    if (garbage.ok) expect(garbage.value.transport).toBeUndefined()
  })

  it('parses transport field on update payload', () => {
    const updated = parseProviderUpdatePayload({ transport: 'websocket-cached' })
    expect(updated.ok).toBe(true)
    if (updated.ok) expect(updated.value.transport).toBe('websocket-cached')

    const cleared = parseProviderUpdatePayload({ transport: null })
    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(cleared.value.transport).toBeNull()
  })

  it('parses promptProfile field on create and update payloads (full / slim / null)', () => {
    const presets = PROVIDER_TYPE_PRESETS as unknown as typeof PROVIDER_TYPE_PRESETS
    const base = { name: 'local', providerType: 'ollama', enabledModels: ['llama3'] }

    for (const value of ['full', 'slim'] as const) {
      const result = parseProviderCreatePayload({ ...base, promptProfile: value }, presets)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.promptProfile).toBe(value)
    }

    // null / empty string → explicit clear
    const cleared = parseProviderCreatePayload({ ...base, promptProfile: null }, presets)
    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(cleared.value.promptProfile).toBeNull()

    // unknown values are dropped (undefined), not echoed back unchecked
    const garbage = parseProviderCreatePayload({ ...base, promptProfile: 'tiny' }, presets)
    expect(garbage.ok).toBe(true)
    if (garbage.ok) expect(garbage.value.promptProfile).toBeUndefined()

    const updated = parseProviderUpdatePayload({ promptProfile: 'slim' })
    expect(updated.ok).toBe(true)
    if (updated.ok) expect(updated.value.promptProfile).toBe('slim')

    const updateCleared = parseProviderUpdatePayload({ promptProfile: null })
    expect(updateCleared.ok).toBe(true)
    if (updateCleared.ok) expect(updateCleared.value.promptProfile).toBeNull()
  })

  it('parses provider extra fields on create and update payloads', () => {
    const create = parseProviderCreatePayload({
      name: 'OpenCode Go',
      providerType: 'opencode-go',
      apiKey: 'oc-key',
      enabledModels: ['glm-5.1'],
      extraFields: { workspaceId: ' workspace-1 ', authCookie: ' cookie-1 ', ignoredNumber: 123 },
    }, PROVIDER_TYPE_PRESETS as unknown as typeof PROVIDER_TYPE_PRESETS)
    expect(create.ok).toBe(true)
    if (create.ok) expect(create.value.extraFields).toEqual({ workspaceId: 'workspace-1', authCookie: 'cookie-1' })

    const update = parseProviderUpdatePayload({ extraFields: { workspaceId: '', authCookie: ' cookie-2 ' } })
    expect(update.ok).toBe(true)
    if (update.ok) expect(update.value.extraFields).toEqual({ workspaceId: '', authCookie: 'cookie-2' })
  })

  it('validates ollama probe payload and url format', () => {
    expect(parseOllamaProbePayload({ providerType: 'ollama' })).toEqual({
      ok: true,
      value: {
        providerType: 'ollama',
        baseUrl: 'http://localhost:11434',
      },
    })

    expect(parseOllamaProbePayload({ providerType: 'openai' })).toEqual({
      ok: false,
      error: 'providerType must be ollama',
    })

    expect(() => validateOllamaUrl('ftp://localhost')).toThrowError('Only http/https URLs are allowed')
    expect(() => validateOllamaUrl('http://localhost:11434')).not.toThrow()
  })

  it('parses model update payload and rejects empty / invalid input', () => {
    const descriptionOnly = parseProviderModelUpdatePayload({ description: 'Fast model for digests' })
    expect(descriptionOnly.ok).toBe(true)
    if (descriptionOnly.ok) {
      expect(descriptionOnly.value.description).toBe('Fast model for digests')
      expect(descriptionOnly.value.cost).toBeUndefined()
    }

    const costOnly = parseProviderModelUpdatePayload({ cost: { input: 0.6, output: 2.5, cacheRead: 0.15 } })
    expect(costOnly.ok).toBe(true)
    if (costOnly.ok) {
      expect(costOnly.value.cost).toEqual({ input: 0.6, output: 2.5, cacheRead: 0.15 })
      expect(costOnly.value.description).toBeUndefined()
    }

    const empty = parseProviderModelUpdatePayload({})
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error).toContain('contextWindow or cost')

    const metadata = parseProviderModelUpdatePayload({ name: 'Qwen3.8 Flash', contextWindow: 1_000_000 })
    expect(metadata.ok).toBe(true)
    if (metadata.ok) expect(metadata.value).toEqual({ name: 'Qwen3.8 Flash', contextWindow: 1_000_000 })

    const badContextWindow = parseProviderModelUpdatePayload({ contextWindow: -5 })
    expect(badContextWindow.ok).toBe(false)
    if (!badContextWindow.ok) expect(badContextWindow.error).toContain('contextWindow must be a positive integer')

    const negativeCost = parseProviderModelUpdatePayload({ cost: { input: -1 } })
    expect(negativeCost.ok).toBe(false)
    if (!negativeCost.ok) expect(negativeCost.error).toContain('No valid fields')

    const nonStringDescription = parseProviderModelUpdatePayload({ description: 42 })
    expect(nonStringDescription.ok).toBe(false)
    if (!nonStringDescription.ok) expect(nonStringDescription.error).toContain('description must be a string')
  })
})
