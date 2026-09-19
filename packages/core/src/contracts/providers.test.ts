import { describe, expect, it } from 'vitest'
import { canonicalizeProviderModelRef } from './providers.js'

describe('provider contracts', () => {
  const providers = [
    { id: 'prov-1', enabledModels: ['gpt-4o-mini'] },
    { id: 'prov-2', enabledModels: ['claude-sonnet-4'] },
  ]

  it('keeps composite provider:model refs unchanged', () => {
    expect(canonicalizeProviderModelRef('prov-1:gpt-4o', providers)).toBe('prov-1:gpt-4o')
  })

  it('upgrades legacy provider-only refs to composite refs', () => {
    expect(canonicalizeProviderModelRef('prov-1', providers)).toBe('prov-1:gpt-4o-mini')
  })

  it('keeps unknown legacy refs untouched for compatibility', () => {
    expect(canonicalizeProviderModelRef('legacy-provider-id', providers)).toBe('legacy-provider-id')
  })
})
