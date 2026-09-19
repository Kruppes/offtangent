import { describe, expect, it } from 'vitest'
import { resolveNowSetMax } from './now-set-limit.js'

describe('resolveNowSetMax', () => {
  it('returns the configured value inside the allowed range', () => {
    expect(resolveNowSetMax(() => ({ offtangent: { nowSetMax: 10 } }))).toBe(10)
    expect(resolveNowSetMax(() => ({ offtangent: { nowSetMax: 1 } }))).toBe(1)
    expect(resolveNowSetMax(() => ({ offtangent: { nowSetMax: 12 } }))).toBe(12)
  })

  it('falls back to the default for a missing, malformed or out-of-range value', () => {
    expect(resolveNowSetMax(() => ({}))).toBe(4)
    expect(resolveNowSetMax(() => ({ offtangent: {} }))).toBe(4)
    expect(resolveNowSetMax(() => ({ offtangent: { nowSetMax: '8' } }))).toBe(4)
    expect(resolveNowSetMax(() => ({ offtangent: { nowSetMax: 4.5 } }))).toBe(4)
    expect(resolveNowSetMax(() => ({ offtangent: { nowSetMax: 0 } }))).toBe(4)
    expect(resolveNowSetMax(() => ({ offtangent: { nowSetMax: 13 } }))).toBe(4)
  })

  it('falls back to the default when the settings file cannot be read', () => {
    expect(resolveNowSetMax(() => {
      throw new Error('no settings.json')
    })).toBe(4)
  })
})
