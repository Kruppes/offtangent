/**
 * Goal 4: parallel strands must not burst one credential.
 *
 * The limiter is the only thing between "strands are isolated" and "the
 * account gets throttled", so the tests pin the properties that matter:
 * it bounds, it waits instead of failing, it is fair, and paid API keys stay
 * unlimited.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProviderConcurrencyLimiter,
  defaultLimitFor,
  isRateLimitError,
  retryAfterMsFromError,
  rateLimitBackoffMs,
} from './provider-concurrency.js'

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('./config.js', () => ({
  loadConfig: (filename: string) => (filename === 'settings.json' ? settings.value : {}),
}))

afterEach(() => {
  settings.value = {}
})

const oauthProvider = { type: 'anthropic-oauth' }
const paidProvider = { type: 'anthropic' }

describe('ProviderConcurrencyLimiter', () => {
  it('never lets more than `limit` calls run at once and hands the slot on', async () => {
    const limiter = new ProviderConcurrencyLimiter({ 'anthropic-oauth': 2 })
    let running = 0
    let peak = 0
    const done: string[] = []

    const call = async (name: string) => {
      const release = await limiter.acquire('anthropic-oauth', oauthProvider)
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 5))
      running--
      done.push(name)
      release()
    }

    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(call))
    expect(peak).toBe(2)
    expect(done).toHaveLength(5)
    const stats = limiter.getStatsFor('anthropic-oauth')
    expect(stats?.acquired).toBe(5)
    expect(stats?.waited).toBe(3)
    expect(stats?.active).toBe(0)
    expect(stats?.waiting).toBe(0)
  })

  it('makes the caller wait instead of rejecting, and reports the wait', async () => {
    const limiter = new ProviderConcurrencyLimiter({ p: 1 })
    const waits: Array<{ providerId: string; waiting: number; limit: number }> = []
    const resumes: number[] = []

    const first = await limiter.acquire('p', oauthProvider)
    let secondAcquired = false
    const second = limiter.acquire('p', oauthProvider, {
      onWait: info => waits.push(info),
      onResume: info => resumes.push(info.waitedMs),
    }).then(release => { secondAcquired = true; return release })

    await new Promise(r => setTimeout(r, 10))
    expect(secondAcquired).toBe(false)
    expect(waits).toEqual([{ providerId: 'p', waiting: 1, limit: 1 }])
    expect(limiter.getStatsFor('p')?.waiting).toBe(1)

    first()
    const release = await second
    expect(secondAcquired).toBe(true)
    expect(resumes).toHaveLength(1)
    release()
    expect(limiter.getStatsFor('p')?.active).toBe(0)
  })

  it('is fair: waiters are served in arrival order', async () => {
    const limiter = new ProviderConcurrencyLimiter({ p: 1 })
    const order: number[] = []
    const first = await limiter.acquire('p', oauthProvider)
    const rest = [1, 2, 3].map(async n => {
      const release = await limiter.acquire('p', oauthProvider)
      order.push(n)
      release()
    })
    await new Promise(r => setTimeout(r, 5))
    first()
    await Promise.all(rest)
    expect(order).toEqual([1, 2, 3])
  })

  it('counts each provider separately', async () => {
    const limiter = new ProviderConcurrencyLimiter({ a: 1, b: 1 })
    const releaseA = await limiter.acquire('a', oauthProvider)
    const releaseB = await limiter.acquire('b', oauthProvider)
    expect(limiter.getStatsFor('a')?.active).toBe(1)
    expect(limiter.getStatsFor('b')?.active).toBe(1)
    releaseA()
    releaseB()
    expect(limiter.getStats().map(s => s.providerId).sort()).toEqual(['a', 'b'])
  })

  it('releases idempotently: a double release never hands out a phantom slot', async () => {
    const limiter = new ProviderConcurrencyLimiter({ p: 1 })
    const release = await limiter.acquire('p', oauthProvider)
    release()
    release()
    expect(limiter.getStatsFor('p')?.active).toBe(0)

    let running = 0
    let peak = 0
    await Promise.all([0, 1].map(async () => {
      const r = await limiter.acquire('p', oauthProvider)
      running++
      peak = Math.max(peak, running)
      await new Promise(res => setTimeout(res, 5))
      running--
      r()
    }))
    expect(peak).toBe(1)
  })

  it('leaves paid API-key providers unlimited but caps subscription providers', async () => {
    expect(defaultLimitFor(paidProvider)).toBe(0)
    expect(defaultLimitFor(oauthProvider)).toBe(4)
    expect(defaultLimitFor({ type: 'openai' })).toBe(0)
    // Real ProviderConfig shape: `authMethod` decides, not the type string.
    expect(defaultLimitFor({ type: 'openai-completions', providerType: 'opencode-go', authMethod: 'oauth' })).toBe(4)
    expect(defaultLimitFor({ type: 'openai-completions', providerType: 'openai', authMethod: 'api-key' })).toBe(0)
    expect(defaultLimitFor({ type: 'openai-responses', providerType: 'openai-codex' })).toBe(4)

    const limiter = new ProviderConcurrencyLimiter()
    expect(limiter.limitFor('openai', paidProvider)).toBeNull()
    expect(limiter.limitFor('anthropic-oauth', oauthProvider)).toBe(4)

    let running = 0
    let peak = 0
    await Promise.all(Array.from({ length: 12 }, async () => {
      const release = await limiter.acquire('openai', paidProvider)
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 2))
      running--
      release()
    }))
    expect(peak).toBe(12)
  })

  it('reads limits from settings.json, specific before default', () => {
    settings.value = { concurrency: { perProvider: { default: 2, 'anthropic-oauth': 5 } } }
    const limiter = new ProviderConcurrencyLimiter()
    expect(limiter.limitFor('anthropic-oauth', oauthProvider)).toBe(5)
    expect(limiter.limitFor('openai', paidProvider)).toBe(2)

    settings.value = { concurrency: { perProvider: { 'anthropic-oauth': 0 } } }
    const unlimited = new ProviderConcurrencyLimiter()
    expect(unlimited.limitFor('anthropic-oauth', oauthProvider)).toBeNull()
  })
})

describe('rate-limit classification', () => {
  it('recognizes 429, overloaded and concurrency errors', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true)
    expect(isRateLimitError({ status: 529 })).toBe(true)
    expect(isRateLimitError(new Error('rate_limit_error: too many requests'))).toBe(true)
    expect(isRateLimitError(new Error('{"type":"overloaded_error"}'))).toBe(true)
    expect(isRateLimitError(new Error('concurrent requests limit exceeded'))).toBe(true)
  })

  it('does not swallow auth errors (a 401 must stay an auth error)', () => {
    expect(isRateLimitError({ status: 401, message: 'invalid_api_key' })).toBe(false)
    expect(isRateLimitError(new Error('OAuth token expired'))).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
  })

  it('reads Retry-After from headers, plain objects and message text', () => {
    expect(retryAfterMsFromError({ status: 429, headers: { 'retry-after': '3' } })).toBe(3000)
    expect(retryAfterMsFromError({ status: 429, headers: new Headers({ 'retry-after': '2' }) })).toBe(2000)
    expect(retryAfterMsFromError(new Error('rate limited, retry-after: 7'))).toBe(7000)
    // Turn errors reach the runner as plain strings, not Error objects.
    expect(retryAfterMsFromError('429 rate_limit_error (retry-after: 17)')).toBe(17000)
    expect(retryAfterMsFromError(new Error('rate limited'))).toBeNull()
  })

  it('prefers Retry-After over exponential backoff and jitters otherwise', () => {
    expect(rateLimitBackoffMs(3, { status: 429, headers: { 'retry-after': '5' } })).toBe(5000)
    expect(rateLimitBackoffMs(0, new Error('rate limit'), { jitter: () => 1 })).toBe(1000)
    expect(rateLimitBackoffMs(2, new Error('rate limit'), { jitter: () => 1 })).toBe(4000)
    expect(rateLimitBackoffMs(2, new Error('rate limit'), { jitter: () => 0 })).toBe(2000)
    expect(rateLimitBackoffMs(20, new Error('rate limit'), { jitter: () => 1 })).toBe(60_000)
  })
})
