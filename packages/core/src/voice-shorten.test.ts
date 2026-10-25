import { describe, it, expect } from 'vitest'
import { shortenForVoice } from './voice-shorten.js'

describe('shortenForVoice (H3)', () => {
  it('returns the model text, flattened and unquoted', async () => {
    const out = await shortenForVoice('Ein sehr langer Text.', 100, { complete: async () => '„Kurz:\n ja."' })
    expect(out).toBe('Kurz: ja.')
  })
  it('is null when the answer is too long, empty or the model fails', async () => {
    expect(await shortenForVoice('x', 5, { complete: async () => 'viel zu lang' })).toBeNull()
    expect(await shortenForVoice('x', 50, { complete: async () => '  ' })).toBeNull()
    expect(await shortenForVoice('x', 50, { complete: async () => { throw new Error('down') } })).toBeNull()
    expect(await shortenForVoice('   ', 50, { complete: async () => 'ja' })).toBeNull()
  })
  it('is null without a model chain', async () => {
    expect(await shortenForVoice('Text', 50, { chain: [] })).toBeNull()
  })
})
