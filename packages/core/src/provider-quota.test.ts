import { describe, expect, it } from 'vitest'
import { limitWindowLabel, normalizeUtilization, parseRetryAfterMs } from './provider-quota.js'

describe('normalizeUtilization', () => {
  it('rounds and clamps into [0, 100]', () => {
    expect(normalizeUtilization(42.6)).toBe(43)
    expect(normalizeUtilization(-5)).toBe(0)
    expect(normalizeUtilization(150)).toBe(100)
    expect(normalizeUtilization(Number.NaN)).toBe(0)
  })
})

describe('limitWindowLabel', () => {
  it('special-cases the common ChatGPT windows', () => {
    expect(limitWindowLabel(18_000)).toBe('5h')
    expect(limitWindowLabel(604_800)).toBe('7d')
  })

  it('derives day/hour/minute labels otherwise', () => {
    expect(limitWindowLabel(172_800)).toBe('2d')
    expect(limitWindowLabel(10_800)).toBe('3h')
    expect(limitWindowLabel(900)).toBe('15m')
  })
})

describe('parseRetryAfterMs', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000)
  })

  it('returns undefined for missing or invalid headers', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs('0')).toBeUndefined()
  })
})
