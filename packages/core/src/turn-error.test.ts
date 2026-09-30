import { describe, it, expect } from 'vitest'
import {
  TURN_ERROR_KIND,
  buildTurnErrorMetadata,
  formatTurnErrorContent,
  parseTurnErrorMetadata,
} from './turn-error.js'
import type { TurnErrorInfo } from './agent-runtime-types.js'

function info(overrides: Partial<TurnErrorInfo> = {}): TurnErrorInfo {
  return {
    cause: 'non_retryable',
    error: '401 Unauthorized: API key expired',
    attempts: 0,
    retryable: false,
    occurredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('turn error metadata', () => {
  it('round-trips through the persisted metadata shape', () => {
    const metadata = buildTurnErrorMetadata(info({ cause: 'retry_exhausted', attempts: 3, retryable: true }))

    expect(metadata).toEqual({
      kind: TURN_ERROR_KIND,
      cause: 'retry_exhausted',
      error: '401 Unauthorized: API key expired',
      attempts: 3,
      retryable: true,
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    expect(parseTurnErrorMetadata(JSON.stringify(metadata))).toEqual(metadata)
  })

  it('ignores metadata of other row kinds and unparsable payloads', () => {
    expect(parseTurnErrorMetadata(null)).toBeNull()
    expect(parseTurnErrorMetadata('not json')).toBeNull()
    expect(parseTurnErrorMetadata(JSON.stringify({ kind: 'provider_stall' }))).toBeNull()
    expect(parseTurnErrorMetadata(JSON.stringify({ kind: TURN_ERROR_KIND }))).toBeNull()
  })

  it('falls back to a non-retryable cause for unknown values', () => {
    const parsed = parseTurnErrorMetadata(JSON.stringify({
      kind: TURN_ERROR_KIND,
      cause: 'something_else',
      error: 'boom',
    }))

    expect(parsed).toMatchObject({ cause: 'non_retryable', attempts: 0, retryable: false })
  })
})

describe('formatTurnErrorContent', () => {
  it('keeps the full provider error text', () => {
    const text = formatTurnErrorContent(info({ error: 'insufficient_quota: check your billing details' }))
    expect(text).toContain('insufficient_quota: check your billing details')
  })

  it('mentions how many retries were burned before giving up', () => {
    expect(formatTurnErrorContent(info({ cause: 'retry_exhausted', attempts: 1, retryable: true })))
      .toContain('after 1 retry')
    expect(formatTurnErrorContent(info({ cause: 'retry_exhausted', attempts: 3, retryable: true })))
      .toContain('after 3 retries')
  })

  it('reports an unavailable agent without blaming the provider', () => {
    const text = formatTurnErrorContent(info({ cause: 'agent_unavailable', error: 'Agent core not available' }))
    expect(text).not.toContain('Provider error')
    expect(text).toContain('Agent core not available')
  })
})
