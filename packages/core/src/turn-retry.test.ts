import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RETRY_POLICY,
  formatRetryScheduledContent,
  isAbortError,
  isRetryableTurnError,
  loadRetryPolicy,
  retryDelayMs,
} from './turn-retry.js'

describe('loadRetryPolicy', () => {
  it('falls back to the pi defaults when the settings file has no retry block', () => {
    expect(loadRetryPolicy(() => ({}))).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2_000 })
    expect(DEFAULT_RETRY_POLICY).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2_000 })
  })

  it('falls back to the defaults when the settings file cannot be read', () => {
    expect(loadRetryPolicy(() => { throw new Error('nope') })).toEqual(DEFAULT_RETRY_POLICY)
  })

  it('respects configured overrides', () => {
    expect(loadRetryPolicy(() => ({ retry: { enabled: false, maxRetries: 5, baseDelayMs: 500 } }))).toEqual({
      enabled: false,
      maxRetries: 5,
      baseDelayMs: 500,
    })
  })

  it('allows disabling retries via maxRetries: 0 but ignores nonsense values', () => {
    expect(loadRetryPolicy(() => ({ retry: { maxRetries: 0 } })).maxRetries).toBe(0)
    expect(loadRetryPolicy(() => ({ retry: { maxRetries: -1, baseDelayMs: 0 } }))).toEqual(DEFAULT_RETRY_POLICY)
    expect(loadRetryPolicy(() => ({ retry: { enabled: 'yes', baseDelayMs: 'soon' } }))).toEqual(DEFAULT_RETRY_POLICY)
  })
})

describe('isRetryableTurnError', () => {
  it('treats transient provider and transport failures as retryable', () => {
    for (const error of [
      '429 Too Many Requests',
      'Error: 503 Service Unavailable',
      'Provider overloaded, please try again',
      'request timed out',
      'fetch failed',
      'socket hang up',
    ]) {
      expect(isRetryableTurnError(error), error).toBe(true)
    }
  })

  it('treats auth, quota and billing failures as terminal', () => {
    for (const error of [
      '401 Unauthorized: invalid api key',
      'insufficient_quota: You exceeded your current quota',
      'Your credit balance is too low — billing required',
      'Monthly usage limit reached',
      'Agent error: something exploded',
    ]) {
      expect(isRetryableTurnError(error), error).toBe(false)
    }
  })
})

describe('isRetryableTurnError (watchdog)', () => {
  it('does not classify the watchdog stall abort — the runner marks it retryable itself', () => {
    // Guards the reason the runner tracks stall aborts explicitly instead of
    // re-classifying their message text.
    expect(isRetryableTurnError('Provider stopped responding after 90s. Connection aborted — please retry.')).toBe(false)
  })
})

describe('retryDelayMs', () => {
  it('doubles the base delay per attempt', () => {
    const policy = { enabled: true, maxRetries: 3, baseDelayMs: 2_000 }
    expect([1, 2, 3].map(attempt => retryDelayMs(policy, attempt))).toEqual([2_000, 4_000, 8_000])
  })
})

describe('formatRetryScheduledContent', () => {
  it('renders the attempt counter and the backoff in seconds', () => {
    const text = formatRetryScheduledContent({ attempt: 2, maxRetries: 3, delayMs: 4_000, error: '429' })
    expect(text).toContain('(2/3)')
    expect(text).toContain('4s')
  })
})

describe('isAbortError', () => {
  it('matches the AbortError texts a cancelled fetch/stream produces', () => {
    for (const error of [
      'This operation was aborted',
      'Agent error: This operation was aborted',
      'AbortError: The operation was aborted.',
      'The user aborted a request.',
    ]) {
      expect(isAbortError(error)).toBe(true)
    }
  })

  it('does not match unrelated failures', () => {
    for (const error of [
      '429 Too Many Requests',
      'invalid api key',
      'Provider stopped responding after 90s. Connection aborted — please retry.',
      '',
    ]) {
      expect(isAbortError(error)).toBe(false)
    }
  })
})
