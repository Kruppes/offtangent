import { describe, expect, it } from 'vitest'
import { buildShaField, normalizeBuildSha } from './build-info.js'

describe('build info', () => {
  it('normalizes a valid commit to 7 hex chars', () => {
    expect(normalizeBuildSha('0123456789abcdef0123456789abcdef01234567')).toBe('0123456')
    expect(normalizeBuildSha(' ABCDEF1\n')).toBe('abcdef1')
  })
  it('drops empty and invalid values', () => {
    for (const raw of [undefined, '', ' ', 'unknown', 'abc-123', '0123456789abcdef0123456789abcdef012345678', 42]) {
      expect(normalizeBuildSha(raw)).toBe('')
    }
  })
  it('adds buildSha only when GIT_SHA is valid', () => {
    expect(buildShaField({ GIT_SHA: 'abcdef0123456789' })).toEqual({ buildSha: 'abcdef0' })
    expect(buildShaField({})).toEqual({})
    expect(buildShaField({ GIT_SHA: 'not-a-sha' })).toEqual({})
  })
})
