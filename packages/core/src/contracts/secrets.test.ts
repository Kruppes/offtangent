import { describe, expect, it } from 'vitest'
import {
  SECRET_HANDLE_KINDS,
  SECRET_HANDLE_MAX_VALUE_LENGTH,
  SECRET_HANDLE_PATTERN,
  createSecretHandleRegex,
  isSecretHandleKind,
  isSecretHandleSlug,
} from './secrets.js'
import { SECRET_HANDLE_RE, secretHandle } from '../secret-boundary.js'

describe('secret handle contract', () => {
  it('stays in sync with the server-side handle regex', () => {
    // The UI builds its matcher from SECRET_HANDLE_PATTERN, the boundary uses
    // SECRET_HANDLE_RE. If these drift apart, the chat renders handles the
    // resolver does not accept (or worse, the other way round).
    expect(createSecretHandleRegex().source).toBe(SECRET_HANDLE_RE.source)
    expect(SECRET_HANDLE_PATTERN).toBe(SECRET_HANDLE_RE.source)
  })

  it('accepts the slugs the store produces and refuses the rest', () => {
    expect(isSecretHandleSlug('github-token-1')).toBe(true)
    expect(isSecretHandleSlug('pin-12')).toBe(true)
    expect(isSecretHandleSlug('9lives')).toBe(true)
    expect(isSecretHandleSlug('UPPER')).toBe(false)
    expect(isSecretHandleSlug('-leading')).toBe(false)
    expect(isSecretHandleSlug('has space')).toBe(false)
    expect(isSecretHandleSlug('has_underscore')).toBe(false)
    expect(isSecretHandleSlug('a'.repeat(65))).toBe(false)
    expect(isSecretHandleSlug('')).toBe(false)
    expect(isSecretHandleSlug(undefined)).toBe(false)
  })

  it('whitelists kinds', () => {
    expect(isSecretHandleKind('password')).toBe(true)
    expect(isSecretHandleKind('github-token')).toBe(true)
    expect(isSecretHandleKind('anything-else')).toBe(false)
    expect(isSecretHandleKind(42)).toBe(false)
    expect(SECRET_HANDLE_KINDS).toContain('secret')
  })

  it('gives every caller a fresh matcher (no shared lastIndex)', () => {
    const text = `a ${secretHandle('x-1')} b ${secretHandle('y-2')}`
    const first = [...text.matchAll(createSecretHandleRegex())].map(match => match[1])
    const second = [...text.matchAll(createSecretHandleRegex())].map(match => match[1])
    expect(first).toEqual(['x-1', 'y-2'])
    expect(second).toEqual(first)
  })

  it('caps the value length well below a pasted file', () => {
    expect(SECRET_HANDLE_MAX_VALUE_LENGTH).toBe(8192)
  })
})
