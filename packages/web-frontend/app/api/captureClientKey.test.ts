import { describe, expect, it } from 'vitest'
import { captureClientKey } from './captures'

const SERVER_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

describe('captureClientKey', () => {
  it('uses crypto.randomUUID in a secure context', () => {
    expect(captureClientKey({ randomUUID: () => '00000000-0000-4000-8000-000000000000' })).toBe('00000000-0000-4000-8000-000000000000')
  })
  it('falls back without randomUUID (http, no secure context) to a valid, unique key', () => {
    const keys = new Set(Array.from({ length: 200 }, () => captureClientKey({})))
    expect(keys.size).toBe(200)
    for (const key of keys) expect(key).toMatch(SERVER_PATTERN)
    expect(captureClientKey(undefined)).toMatch(SERVER_PATTERN)
  })
  it('falls back when randomUUID throws', () => {
    expect(captureClientKey({ randomUUID: () => { throw new Error('insecure') } })).toMatch(SERVER_PATTERN)
  })
})
