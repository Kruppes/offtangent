import { describe, expect, it } from 'vitest'
import { resolveNowSetMax, resolveNowSetMode } from './now-set-limit.js'

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

describe('resolveNowSetMode', () => {
  it('returns the configured mode', () => {
    expect(resolveNowSetMode(() => ({ offtangent: { nowSetMode: 'manual' } }))).toBe('manual')
    expect(resolveNowSetMode(() => ({ offtangent: { nowSetMode: 'auto' } }))).toBe('auto')
  })

  it('defaults to auto for a missing, unknown or malformed value', () => {
    expect(resolveNowSetMode(() => ({}))).toBe('auto')
    expect(resolveNowSetMode(() => ({ offtangent: {} }))).toBe('auto')
    expect(resolveNowSetMode(() => ({ offtangent: { nowSetMode: 'Manual' } }))).toBe('auto')
    expect(resolveNowSetMode(() => ({ offtangent: { nowSetMode: 7 } }))).toBe('auto')
  })

  it('falls back to the default when the settings file cannot be read', () => {
    expect(resolveNowSetMode(() => {
      throw new Error('no settings.json')
    })).toBe('auto')
  })
})
