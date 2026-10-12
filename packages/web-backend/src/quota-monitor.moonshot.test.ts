import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@axiom/core'

const KEY = 'sk_moonshot-test-key-0123456789'

const provider: ProviderConfig = {
  id: 'moonshot-1',
  name: 'Moonshot',
  type: 'openai-completions',
  providerType: 'kimi',
  provider: 'moonshotai',
  baseUrl: 'https://api.moonshot.ai/v1',
  apiKey: KEY,
  enabledModels: ['kimi-k2.6'],
  authMethod: 'api-key',
}

let currentProviders: ProviderConfig[] = [provider]

vi.mock('@axiom/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@axiom/core')>()
  return { ...actual, loadProvidersDecrypted: () => ({ providers: currentProviders }) }
})

const { QuotaMonitorService } = await import('./quota-monitor.js')
const { resetMoonshotBalanceState, MOONSHOT_BALANCE_RATE_LIMIT_INITIAL_BACKOFF_MS, MOONSHOT_BALANCE_REFUSED_RETRY_MS } =
  await import('@axiom/core')

const VALID_BODY = {
  code: 0,
  data: { available_balance: 11.33, voucher_balance: 0, cash_balance: 11.33 },
  scode: '0x0',
  status: true,
}

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body ?? {},
  } as unknown as Response
}

describe('QuotaMonitorService with the Moonshot balance adapter', () => {
  const T0 = Date.parse('2026-10-12T10:00:00Z')

  beforeEach(() => {
    currentProviders = [provider]
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetMoonshotBalanceState()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetMoonshotBalanceState()
  })

  it('a manual refresh during a 429 pause answers the last good value without a request', async () => {
    const queue = [response(200, VALID_BODY), response(429)]
    const fetchImpl = vi.fn(async () => queue.shift() ?? response(200, VALID_BODY))
    const monitor = new QuotaMonitorService({ fetchImpl: fetchImpl as unknown as typeof fetch, logger: { error: vi.fn() } })

    const good = await monitor.refreshProvider(provider.id)
    expect(good?.balance?.amount).toBe(11.33)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // 429: no error entry, the last good value stays.
    vi.setSystemTime(T0 + 60_000)
    const limited = await monitor.refreshProvider(provider.id)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(limited?.balance?.amount).toBe(11.33)
    expect(limited?.error).toBeUndefined()

    // Manual refreshes inside the 20 min pause send nothing.
    for (const offset of [2 * 60_000, 10 * 60_000, 60_000 + MOONSHOT_BALANCE_RATE_LIMIT_INITIAL_BACKOFF_MS - 1]) {
      vi.setSystemTime(T0 + offset)
      const cached = await monitor.refreshProvider(provider.id)
      expect(cached?.balance?.amount).toBe(11.33)
      expect(cached?.error).toBeUndefined()
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // After the pause the next refresh asks again.
    vi.setSystemTime(T0 + 60_000 + MOONSHOT_BALANCE_RATE_LIMIT_INITIAL_BACKOFF_MS)
    await monitor.refreshProvider(provider.id)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('a manual refresh tests a refused key with one request, the poll does not', async () => {
    let status = 401
    const fetchImpl = vi.fn(async () => (status === 200 ? response(200, VALID_BODY) : response(status)))
    const monitor = new QuotaMonitorService({ fetchImpl: fetchImpl as unknown as typeof fetch, logger: { error: vi.fn() } })

    expect(await monitor.refreshProvider(provider.id)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Background poll inside the 6 h pause: no request.
    monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    monitor.stop()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(MOONSHOT_BALANCE_REFUSED_RETRY_MS).toBeGreaterThan(0)

    // Manual refresh: exactly one request, and the working key shows the balance.
    status = 200
    const refreshed = await monitor.refreshProvider(provider.id)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(refreshed?.balance?.amount).toBe(11.33)
  })

  it('a new key is asked by the next automatic poll despite the monitor 429 backoff', async () => {
    const fetchImpl = vi.fn(async () => response(429))
    const monitor = new QuotaMonitorService({
      pollIntervalMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { error: vi.fn() },
    })
    monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Same key, next poll: both pauses hold, no request.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // The user enters a new key: the next poll asks it right away.
    currentProviders = [{ ...provider, apiKey: 'sk_another-moonshot-key-987654' }]
    fetchImpl.mockImplementation(async () => response(200, VALID_BODY))
    await vi.advanceTimersByTimeAsync(60_000)
    monitor.stop()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(monitor.getSnapshot()[provider.id]?.balance?.amount).toBe(11.33)
  })
})
