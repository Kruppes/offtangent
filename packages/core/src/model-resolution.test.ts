import { describe, expect, it } from 'vitest'
import { resolveEffectiveModel, type ModelSelection } from './model-resolution.js'

const selections = {
  turn: { providerId: 'openai', modelId: 'turn' },
  strand: { providerId: 'anthropic', modelId: 'strand' },
  persona: { providerId: 'openai', modelId: 'persona' },
  global: { providerId: 'anthropic', modelId: 'global' },
  fallback: { providerId: 'openai', modelId: 'fallback' },
} satisfies Record<string, ModelSelection>

const providers = [
  { id: 'openai', providerType: 'openai-codex', enabledModels: ['turn', 'persona', 'fallback'], modelStatuses: {} },
  { id: 'anthropic', providerType: 'anthropic', enabledModels: ['strand', 'global'], modelStatuses: {} },
]

function resolve(overrides: Partial<Parameters<typeof resolveEffectiveModel>[0]> = {}) {
  return resolveEffectiveModel({
    turnOverride: selections.turn,
    strandPin: selections.strand,
    personaPin: selections.persona,
    globalActive: selections.global,
    fallback: selections.fallback,
    providers,
    ...overrides,
  })
}

describe('resolveEffectiveModel', () => {
  it.each([
    ['turn', {}],
    ['strand', { turnOverride: null }],
    ['persona', { turnOverride: null, strandPin: null }],
    ['global', { turnOverride: null, strandPin: null, personaPin: null }],
    ['fallback', { turnOverride: null, strandPin: null, personaPin: null, globalActive: null }],
  ] as const)('resolves the %s tier', (source, overrides) => {
    expect(resolve(overrides)?.source).toBe(source)
  })

  it('degrades past a deleted strand model and reports why', () => {
    const result = resolve({
      turnOverride: null,
      strandPin: { providerId: 'anthropic', modelId: 'deleted' },
    })
    expect(result).toMatchObject({ ...selections.persona, source: 'persona' })
    expect(result?.degradedReason).toContain('strand:model_missing_or_disabled')
  })

  it('degrades past a model whose status is error', () => {
    const result = resolve({
      turnOverride: null,
      providers: providers.map(provider => provider.id === 'anthropic'
        ? { ...provider, modelStatuses: { strand: 'error' as const } }
        : provider),
    })
    expect(result).toMatchObject({ ...selections.persona, source: 'persona' })
    expect(result?.degradedReason).toContain('strand:model_error')
  })

  it('reports every rejected tier and returns null if none is usable', () => {
    const result = resolveEffectiveModel({
      strandPin: { providerId: 'gone', modelId: 'x' },
      fallback: { providerId: 'openai', modelId: 'also-gone' },
      providers,
    })
    expect(result).toBeNull()
  })

  it('never auto-selects Z.AI or Moonshot as fallback', () => {
    for (const providerType of ['zai', 'moonshot']) {
      expect(resolveEffectiveModel({
        fallback: { providerId: 'restricted', modelId: 'm' },
        providers: [{ id: 'restricted', providerType, enabledModels: ['m'] }],
      })).toBeNull()
    }
  })
})
