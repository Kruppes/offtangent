import { describe, expect, it } from 'vitest'
import { NUM_CTX_MAX, NUM_CTX_MIN, nativeModelPatch, parseNumCtxInput } from './nativeModelSettings'

describe('native Ollama model settings (edit dialog)', () => {
  it('parses the baseline strictly: empty = reset, integer within bounds, everything else invalid', () => {
    expect(parseNumCtxInput('')).toBeNull()
    expect(parseNumCtxInput('   ')).toBeNull()
    expect(parseNumCtxInput(undefined)).toBeNull()
    expect(parseNumCtxInput('40960')).toBe(40960)
    expect(parseNumCtxInput(40960)).toBe(40960)
    expect(parseNumCtxInput(String(NUM_CTX_MIN))).toBe(NUM_CTX_MIN)
    expect(parseNumCtxInput(String(NUM_CTX_MAX))).toBe(NUM_CTX_MAX)
    for (const bad of ['1023', String(NUM_CTX_MAX + 1), '4096.5', '1e5', '40k', '-4096', '0', 'abc', '99999999999999999999']) {
      expect(parseNumCtxInput(bad), bad).toBe('invalid')
    }
  })
  it('sends only changed native fields; empty resets with null; unchecked thinking resets with null', () => {
    expect(nativeModelPatch({ ollamaNumCtx: '', reasoning: false }, undefined)).toEqual({})
    expect(nativeModelPatch({ ollamaNumCtx: '40960', reasoning: true }, undefined)).toEqual({ ollamaNumCtx: 40960, reasoning: true })
    expect(nativeModelPatch({ ollamaNumCtx: '40960', reasoning: true }, { ollamaNumCtx: 40960, reasoning: true })).toEqual({})
    expect(nativeModelPatch({ ollamaNumCtx: '', reasoning: false }, { ollamaNumCtx: 40960, reasoning: true })).toEqual({ ollamaNumCtx: null, reasoning: null })
    expect(nativeModelPatch({ ollamaNumCtx: '12', reasoning: true }, undefined)).toBe('invalid')
  })
})
