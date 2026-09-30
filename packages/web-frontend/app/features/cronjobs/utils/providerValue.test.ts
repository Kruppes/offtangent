import { describe, expect, it } from 'vitest'
import { formatCronjobProvider, normalizeCronjobProviderValue } from './providerValue'

const providers = [
  { id: 'p-openai', name: 'OpenAI API', enabledModels: ['gpt-5', 'gpt-5-mini'] },
  { id: 'p-empty', name: 'Empty', enabledModels: [] },
]

describe('formatCronjobProvider', () => {
  it('returns an empty string for missing values', () => {
    expect(formatCronjobProvider(null, providers)).toBe('')
    expect(formatCronjobProvider('', providers)).toBe('')
  })

  it('formats composite values with the stored model', () => {
    expect(formatCronjobProvider('p-openai:gpt-5-mini', providers)).toBe('OpenAI API (gpt-5-mini)')
  })

  it('expands legacy names to the first enabled model', () => {
    expect(formatCronjobProvider('openai api', providers)).toBe('OpenAI API (gpt-5)')
    expect(formatCronjobProvider('p-empty', providers)).toBe('Empty')
  })

  it('falls back to the raw value when the provider is unknown', () => {
    expect(formatCronjobProvider('gone:model', providers)).toBe('gone:model')
  })
})

describe('normalizeCronjobProviderValue', () => {
  it('returns an empty string for missing values', () => {
    expect(normalizeCronjobProviderValue(undefined, providers)).toBe('')
  })

  it('keeps composite values and resolves provider names to ids', () => {
    expect(normalizeCronjobProviderValue('p-openai:gpt-5-mini', providers)).toBe('p-openai:gpt-5-mini')
    expect(normalizeCronjobProviderValue('OpenAI API:gpt-5-mini', providers)).toBe('p-openai:gpt-5-mini')
  })

  it('fills a missing model from the first enabled model', () => {
    expect(normalizeCronjobProviderValue('p-openai:', providers)).toBe('p-openai:gpt-5')
    expect(normalizeCronjobProviderValue('openai api', providers)).toBe('p-openai:gpt-5')
    expect(normalizeCronjobProviderValue('p-empty', providers)).toBe('p-empty:')
  })

  it('returns unknown composites as-is and unknown legacy names as empty', () => {
    expect(normalizeCronjobProviderValue('gone:model', providers)).toBe('gone:model')
    expect(normalizeCronjobProviderValue('gone', providers)).toBe('')
  })
})
