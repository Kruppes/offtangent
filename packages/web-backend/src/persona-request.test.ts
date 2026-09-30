import { describe, it, expect } from 'vitest'
import { normalizeClientMessageId, normalizeSessionId, resolveAgentId } from './persona-request.js'

describe('resolveAgentId', () => {
  const personas = () => ['coder', 'analyst']

  it("defaults to 'main' when the client sends nothing (legacy web UI)", () => {
    expect(resolveAgentId(undefined, personas)).toBe('main')
    expect(resolveAgentId(null, personas)).toBe('main')
    expect(resolveAgentId('', personas)).toBe('main')
  })

  it("accepts 'main' and every configured persona", () => {
    expect(resolveAgentId('main', personas)).toBe('main')
    expect(resolveAgentId('coder', personas)).toBe('coder')
    expect(resolveAgentId('analyst', personas)).toBe('analyst')
  })

  it('refuses unknown or non-string ids instead of creating rows for them', () => {
    expect(resolveAgentId('advisor', personas)).toBeNull()
    expect(resolveAgentId('../main', personas)).toBeNull()
    expect(resolveAgentId(42, personas)).toBeNull()
    expect(resolveAgentId({ id: 'coder' }, personas)).toBeNull()
    expect(resolveAgentId(['coder'], personas)).toBeNull()
  })
})

describe('normalizeSessionId', () => {
  it('treats absent/empty as "no explicit thread"', () => {
    expect(normalizeSessionId(undefined)).toBeUndefined()
    expect(normalizeSessionId(null)).toBeUndefined()
    expect(normalizeSessionId('')).toBeUndefined()
  })

  it('accepts session UUIDs', () => {
    expect(normalizeSessionId('9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f')).toBe('9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f')
  })

  it('rejects malformed ids instead of silently falling back to another thread', () => {
    expect(normalizeSessionId(42)).toBeNull()
    expect(normalizeSessionId({ id: 'x' })).toBeNull()
    expect(normalizeSessionId(['x'])).toBeNull()
    expect(normalizeSessionId('a'.repeat(65))).toBeNull()
    expect(normalizeSessionId('has space')).toBeNull()
    expect(normalizeSessionId("' OR 1=1 --")).toBeNull()
  })
})

describe('normalizeClientMessageId', () => {
  it('treats absent/empty as "no key"', () => {
    expect(normalizeClientMessageId(undefined)).toBeUndefined()
    expect(normalizeClientMessageId(null)).toBeUndefined()
    expect(normalizeClientMessageId('')).toBeUndefined()
  })

  it('accepts opaque ids such as UUIDs', () => {
    expect(normalizeClientMessageId('9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f')).toBe('9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f')
    expect(normalizeClientMessageId('outbox:12.3_ok')).toBe('outbox:12.3_ok')
  })

  it('rejects malformed keys (type, length, characters)', () => {
    expect(normalizeClientMessageId(12)).toBeNull()
    expect(normalizeClientMessageId('a'.repeat(65))).toBeNull()
    expect(normalizeClientMessageId('has space')).toBeNull()
    expect(normalizeClientMessageId('new\nline')).toBeNull()
    expect(normalizeClientMessageId('<script>')).toBeNull()
  })
})
