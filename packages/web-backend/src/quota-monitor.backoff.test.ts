import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig, ProviderQuotaFetchResult, QuotaProviderAdapter } from '@axiom/core'

/**
 * Monitor backoff for adapters without a credential fingerprint (OAuth and
 * subscription quotas): bound to the provider id only, unchanged by a token
 * or key change.
 */

const oauthProvider: ProviderConfig = {
  id: 'oauth-1',
  name: 'Subscription',
  type: 'anthropic-messages',
  providerType: 'anthropic',
  provider: 'anthropic',
  baseUrl: 'https://example.invalid',
  apiKey: '',
  enabledModels: [],
  authMethod: 'oauth',
  oauthCredentials: { access: 'token-a', refresh: 'refresh-a', expires: 0 },
} as unknown as ProviderConfig

let currentProviders: ProviderConfig[] = [oauthProvider]
let nextResult: () => ProviderQuotaFetchResult = () => ({ quota: null, status: 429 })
const adapterFetch = vi.fn(async () => nextResult())
const fakeAdapter: QuotaProviderAdapter = {
  kind: 'anthropic',
  matches: () => true,
  fetch: adapterFetch,
}

vi.mock('@axiom/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@axiom/core')>()
  return {
    ...actual,
    loadProvidersDecrypted: () => ({ providers: currentProviders }),
    getQuotaAdapter: () => fakeAdapter,
    isQuotaProvider: () => true,
  }
})

const { QuotaMonitorService } = await import('./quota-monitor.js')

const MINUTE = 60_000

describe('QuotaMonitorService backoff without a credential fingerprint', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-10-12T10:00:00Z'))
    currentProviders = [oauthProvider]
    nextResult = () => ({ quota: null, status: 429 })
    adapterFetch.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the 15 min backoff when the OAuth token or key changes', async () => {
    const monitor = new QuotaMonitorService({ pollIntervalMs: MINUTE, logger: { error: vi.fn() } })
    monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(adapterFetch).toHaveBeenCalledTimes(1)

    // New token and even a new key: the provider-id backoff still holds.
    currentProviders = [
      {
        ...oauthProvider,
        apiKey: 'other',
        oauthCredentials: { access: 'token-b', refresh: 'refresh-b', expires: 1 },
      } as unknown as ProviderConfig,
    ]
    await vi.advanceTimersByTimeAsync(14 * MINUTE)
    expect(adapterFetch).toHaveBeenCalledTimes(1)

    // After 15 min the next poll asks again.
    await vi.advanceTimersByTimeAsync(MINUTE)
    monitor.stop()
    expect(adapterFetch).toHaveBeenCalledTimes(2)
  })

  it('an infinite retryAfterMs falls back to the regular backoff instead of pausing forever', async () => {
    nextResult = () => ({ quota: null, status: 429, retryAfterMs: Number.POSITIVE_INFINITY })
    const monitor = new QuotaMonitorService({ pollIntervalMs: MINUTE, logger: { error: vi.fn() } })
    monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(adapterFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(14 * MINUTE)
    expect(adapterFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(MINUTE)
    monitor.stop()
    expect(adapterFetch).toHaveBeenCalledTimes(2)
  })

  it('a huge retryAfterMs keeps the backoff end inside the safe integer range', async () => {
    nextResult = () => ({ quota: null, status: 429, retryAfterMs: 1e300 })
    // Latest time a Date can hold, so the error entry can still carry a timestamp.
    const nowMs = 8.64e15 - 10_000
    const monitor = new QuotaMonitorService({ now: () => nowMs, logger: { error: vi.fn() } })
    await monitor.refreshProvider(oauthProvider.id)
    const state = (monitor as unknown as { backoff: Map<string, { rateLimitedUntil: number }> }).backoff.get(
      oauthProvider.id,
    )
    expect(state).toBeDefined()
    expect(Number.isFinite(state?.rateLimitedUntil)).toBe(true)
    expect(state?.rateLimitedUntil).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
  })

  it('adapters without quietErrors (e.g. Anthropic) still store an error entry', async () => {
    expect(fakeAdapter.quietErrors).toBeUndefined()
    // Hard failure: the user must act on it, so it is surfaced.
    nextResult = () => ({ quota: null, status: 401, error: 'Unauthorized' })
    const monitor = new QuotaMonitorService({ logger: { error: vi.fn() } })
    const hard = await monitor.refreshProvider(oauthProvider.id)
    expect(hard).toMatchObject({ kind: 'anthropic', windows: [], error: 'Unauthorized' })
    expect(monitor.getSnapshot()[oauthProvider.id]?.error).toBe('Unauthorized')

    // Transient failure without any good data yet: also an error entry.
    const fresh = new QuotaMonitorService({ logger: { error: vi.fn() } })
    nextResult = () => ({ quota: null, status: 503, error: 'Service unavailable' })
    const transient = await fresh.refreshProvider(oauthProvider.id)
    expect(transient).toMatchObject({ kind: 'anthropic', error: 'Service unavailable' })
    expect(fresh.getSnapshot()[oauthProvider.id]?.error).toBe('Service unavailable')
  })
})
