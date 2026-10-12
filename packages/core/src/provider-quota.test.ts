import { describe, expect, it } from 'vitest'
import { clampWaitMs, limitWindowLabel, normalizeUtilization, parseRetryAfterMs } from './provider-quota.js'

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

  it('rejects seconds that are not finite or negative instead of returning Infinity', () => {
    expect(parseRetryAfterMs('1e309')).toBeUndefined()
    expect(parseRetryAfterMs('Infinity')).toBeUndefined()
    expect(parseRetryAfterMs('-5')).toBeUndefined()
    expect(parseRetryAfterMs('-0.5')).toBeUndefined()
    expect(parseRetryAfterMs('NaN')).toBeUndefined()
    // seconds finite, seconds*1000 not
    expect(parseRetryAfterMs('1.7e306')).toBeUndefined()
    expect(parseRetryAfterMs('1.5')).toBe(1_500)
  })

  it('parses HTTP dates relative to now; past dates are ignored', () => {
    const now = Date.parse('2026-10-12T10:00:00Z')
    expect(parseRetryAfterMs('Mon, 12 Oct 2026 10:05:00 GMT', now)).toBe(5 * 60_000)
    expect(parseRetryAfterMs('Mon, 12 Oct 2026 09:55:00 GMT', now)).toBeUndefined()
    expect(parseRetryAfterMs('Mon, 12 Oct 2026 10:00:00 GMT', now)).toBeUndefined()
    expect(parseRetryAfterMs('not a date', now)).toBeUndefined()
  })

  it('a huge HTTP date stays finite and can be clamped into the safe range', () => {
    const now = Date.parse('2026-10-12T10:00:00Z')
    const ms = parseRetryAfterMs('Sat, 13 Sep 275760 00:00:00 GMT', now)
    expect(ms).toBeDefined()
    expect(Number.isFinite(ms)).toBe(true)
    expect(now + clampWaitMs(ms as number, now)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
    // A date beyond the Date range is no date at all.
    expect(parseRetryAfterMs('Sat, 13 Sep 999999 00:00:00 GMT', now)).toBeUndefined()
  })
})

describe('clampWaitMs', () => {
  it('keeps now + wait inside Number.MAX_SAFE_INTEGER', () => {
    const now = 1_000_000
    expect(clampWaitMs(60_000, now)).toBe(60_000)
    expect(clampWaitMs(Infinity, now)).toBe(Number.MAX_SAFE_INTEGER - now)
    expect(clampWaitMs(1e300, now)).toBe(Number.MAX_SAFE_INTEGER - now)
    expect(clampWaitMs(Number.NaN, now)).toBe(0)
    expect(clampWaitMs(-5, now)).toBe(0)
    expect(clampWaitMs(10, Number.MAX_SAFE_INTEGER + 10)).toBe(0)
  })
})
