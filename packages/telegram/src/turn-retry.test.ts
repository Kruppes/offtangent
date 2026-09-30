import { describe, it, expect } from 'vitest'
import type { TurnErrorInfo } from '@axiom/core'
import {
  buildTurnRetryCallbackData,
  formatTurnErrorMessage,
  formatTurnRetryResolution,
  parseTurnRetryCallbackData,
} from './turn-retry.js'

function makeError(overrides: Partial<TurnErrorInfo> = {}): TurnErrorInfo {
  return {
    cause: 'non_retryable',
    error: 'AuthenticationError: 401 invalid x-api-key',
    attempts: 0,
    retryable: false,
    occurredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('telegram turn-retry callback data', () => {
  it('round-trips the error row id', () => {
    const data = buildTurnRetryCallbackData(4711)
    expect(data).toBe('retry:4711')
    expect(parseTurnRetryCallbackData(data)).toEqual({ errorMessageId: 4711 })
  })

  it('stays within Telegram\u2019s 64-byte callback_data limit', () => {
    expect(Buffer.byteLength(buildTurnRetryCallbackData(Number.MAX_SAFE_INTEGER))).toBeLessThanOrEqual(64)
  })

  it('rejects foreign or malformed payloads', () => {
    expect(parseTurnRetryCallbackData('mail:a:entry-1')).toBeNull()
    expect(parseTurnRetryCallbackData('retry:')).toBeNull()
    expect(parseTurnRetryCallbackData('retry:abc')).toBeNull()
    expect(parseTurnRetryCallbackData('retry:-3')).toBeNull()
  })
})

describe('telegram turn-error rendering', () => {
  it('shows the full provider error text', () => {
    expect(formatTurnErrorMessage(makeError())).toContain('401 invalid x-api-key')
  })

  it('mentions how many automatic retries were spent', () => {
    expect(formatTurnErrorMessage(makeError({ attempts: 1 }))).toContain('1 automatic retry')
    expect(formatTurnErrorMessage(makeError({ attempts: 3 }))).toContain('3 automatic retries')
  })

  it('escapes provider text so it cannot break the HTML message', () => {
    const rendered = formatTurnErrorMessage(makeError({ error: '<script>boom</script>' }))
    expect(rendered).toContain('&lt;script&gt;')
    expect(rendered).not.toContain('<script>')
  })

  it('appends the resolution when the button was answered', () => {
    const rendered = formatTurnRetryResolution(makeError(), '\uD83D\uDD04 Retrying\u2026')
    expect(rendered).toContain('401 invalid x-api-key')
    expect(rendered).toContain('Retrying')
  })
})
