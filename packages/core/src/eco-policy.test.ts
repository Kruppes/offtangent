import { describe, it, expect } from 'vitest'
import { resolveEcoBudget, estimateEcoFixedTokens, ECO_FALLBACK_CONTEXT_WINDOW } from './eco-policy.js'

// Display-only budget of the Eco status card (plan 2026-10-05-real-eco).
describe('resolveEcoBudget', () => {
  it('reserves maxTokens (output + thinking) and a margin from the operative window', () => {
    const b = resolveEcoBudget({ contextWindow: 40960, maxTokens: 8192 })
    expect(b.outputReserve).toBe(8192)
    expect(b.safetyMargin).toBe(4096)
    expect(b.inputBudget).toBe(40960 - 8192 - 4096)
    // The diagnosed failure: a 33k prompt + 8192 output exceeded 40960.
    expect(33309 + b.outputReserve + 0).toBeGreaterThan(40960)
    expect(b.inputBudget).toBeLessThan(40960 - 8192)
  })

  it('falls back conservatively when no window is declared, never inventing a runner limit', () => {
    const b = resolveEcoBudget({ contextWindow: null, maxTokens: null })
    expect(b.contextFallback).toBe(true)
    expect(b.contextWindow).toBe(ECO_FALLBACK_CONTEXT_WINDOW)
    expect(b.inputBudget).toBeGreaterThan(0)
  })

  it('caps an absurd maxTokens at half the window so a prompt still fits', () => {
    const b = resolveEcoBudget({ contextWindow: 16000, maxTokens: 64000 })
    expect(b.outputReserve).toBe(8000)
    expect(b.inputBudget).toBe(16000 - 8000 - 1600)
  })

  it('ignores invalid values', () => {
    expect(resolveEcoBudget({ contextWindow: -5, maxTokens: Number.NaN }).contextFallback).toBe(true)
  })
})

describe('estimate', () => {
  it('counts the system prompt and tool schemas', () => {
    const tools = [{ name: 'shell', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
    expect(estimateEcoFixedTokens('x'.repeat(300), tools)).toBeGreaterThan(100 + 10)
    expect(estimateEcoFixedTokens(undefined, [])).toBe(0)
  })

})
