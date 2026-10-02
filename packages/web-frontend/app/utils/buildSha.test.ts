import { describe, expect, it } from 'vitest'
import { formatVersionLabel, normalizeBuildSha } from './buildSha'

describe('normalizeBuildSha', () => {
  it('is empty for missing or empty input', () => {
    expect(normalizeBuildSha(undefined)).toBe('')
    expect(normalizeBuildSha(null)).toBe('')
    expect(normalizeBuildSha('')).toBe('')
    expect(normalizeBuildSha('   ')).toBe('')
    expect(normalizeBuildSha(1234567)).toBe('')
  })
  it('shortens a valid full or short commit to 7 characters', () => {
    expect(normalizeBuildSha('0123456789abcdef0123456789abcdef01234567')).toBe('0123456')
    expect(normalizeBuildSha('abc1234')).toBe('abc1234')
    expect(normalizeBuildSha(' ABC1234DEF\n')).toBe('abc1234')
    expect(normalizeBuildSha('abc')).toBe('abc')
  })
  it('drops anything that is not a plain hex commit', () => {
    expect(normalizeBuildSha('unknown')).toBe('')
    expect(normalizeBuildSha('abc1234-dirty')).toBe('')
    expect(normalizeBuildSha('<script>')).toBe('')
    expect(normalizeBuildSha('g123456')).toBe('')
    expect(normalizeBuildSha('0123456789abcdef0123456789abcdef012345678')).toBe('') // 41 chars
  })
})

describe('formatVersionLabel', () => {
  it('appends the short commit when there is one', () => {
    expect(formatVersionLabel('0.30.0', '0123456789abcdef0123456789abcdef01234567')).toBe('v0.30.0 · 0123456')
  })
  it('shows only the version without a valid commit (no separator, no placeholder)', () => {
    expect(formatVersionLabel('0.30.0', '')).toBe('v0.30.0')
    expect(formatVersionLabel('0.30.0', undefined)).toBe('v0.30.0')
    expect(formatVersionLabel('0.30.0', 'not-a-sha')).toBe('v0.30.0')
  })
})
