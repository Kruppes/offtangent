import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchMoonshotBalance,
  getMoonshotBalanceForProvider,
  isMoonshotBalanceProvider,
  moonshotBalanceAdapter,
  moonshotRegionForBaseUrl,
  parseMoonshotBalancePayload,
  resetMoonshotBalanceState,
  MOONSHOT_BALANCE_INITIAL_BACKOFF_MS,
  MOONSHOT_BALANCE_MAX_BACKOFF_MS,
  MOONSHOT_BALANCE_RATE_LIMIT_INITIAL_BACKOFF_MS,
  MOONSHOT_BALANCE_REFUSED_RETRY_MS,
} from './moonshot-balance.js'
import { getQuotaAdapter } from './quota-registry.js'
import type { ProviderConfig } from './provider-config.js'

const KEY = 'sk_moonshot-test-key-0123456789'

/** The literal answer of the live endpoint (amount values only). */
const VALID_BODY = {
  code: 0,
  data: { available_balance: 13.505731, voucher_balance: 0, cash_balance: 13.505731 },
  scode: '0x0',
  status: true,
}

function mockResponse(init: {
  ok: boolean
  status: number
  json?: unknown
  jsonThrows?: boolean
  headers?: Record<string, string>
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    headers: { get: (name: string) => init.headers?.[name.toLowerCase()] ?? null },
    json: async () => {
      if (init.jsonThrows) throw new SyntaxError('Unexpected token < in JSON at position 0')
      return init.json ?? {}
    },
  } as unknown as Response
}

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

describe('moonshotRegionForBaseUrl', () => {
  it('maps moonshot.cn hosts to cn and everything else to intl', () => {
    expect(moonshotRegionForBaseUrl('https://api.moonshot.cn/v1')).toBe('cn')
    expect(moonshotRegionForBaseUrl('https://api.moonshot.ai/v1')).toBe('intl')
    expect(moonshotRegionForBaseUrl('')).toBe('intl')
    expect(moonshotRegionForBaseUrl('not a url')).toBe('intl')
    // A look-alike host must not count as China.
    expect(moonshotRegionForBaseUrl('https://moonshot.cn.example.com/v1')).toBe('intl')
  })

  it('canonicalizes the host (case, trailing dot) and compares it exactly', () => {
    expect(moonshotRegionForBaseUrl('https://api.moonshot.cn./v1')).toBe('cn')
    expect(moonshotRegionForBaseUrl('https://API.MOONSHOT.CN/v1')).toBe('cn')
    expect(moonshotRegionForBaseUrl('https://Api.Moonshot.Cn../v1')).toBe('cn')
    expect(moonshotRegionForBaseUrl('https://api.moonshot.ai./v1')).toBe('intl')
    // Only the known API host counts, not any host under moonshot.cn.
    expect(moonshotRegionForBaseUrl('https://evil.api.moonshot.cn.example.com/v1')).toBe('intl')
    expect(moonshotRegionForBaseUrl('https://xapi.moonshot.cn/v1')).toBe('intl')
  })
})

describe('parseMoonshotBalancePayload', () => {
  it('parses a valid answer (intl → USD)', () => {
    expect(parseMoonshotBalancePayload(VALID_BODY, 'intl')).toEqual({
      amount: 13.505731,
      currency: 'USD',
      cash: 13.505731,
      voucher: 0,
    })
  })

  it('uses CNY for the China region', () => {
    expect(parseMoonshotBalancePayload(VALID_BODY, 'cn')?.currency).toBe('CNY')
  })

  it('rejects status:false', () => {
    expect(parseMoonshotBalancePayload({ ...VALID_BODY, status: false }, 'intl')).toBeNull()
  })

  it('rejects a non-zero code', () => {
    expect(parseMoonshotBalancePayload({ ...VALID_BODY, code: 401 }, 'intl')).toBeNull()
  })

  it('rejects non-objects and a missing data block', () => {
    expect(parseMoonshotBalancePayload(null, 'intl')).toBeNull()
    expect(parseMoonshotBalancePayload('<html>', 'intl')).toBeNull()
    expect(parseMoonshotBalancePayload([], 'intl')).toBeNull()
    expect(parseMoonshotBalancePayload({ code: 0, status: true }, 'intl')).toBeNull()
    expect(parseMoonshotBalancePayload({ code: 0, status: true, data: {} }, 'intl')).toBeNull()
    expect(parseMoonshotBalancePayload({ code: 0, status: true, data: { available_balance: 'abc' } }, 'intl')).toBeNull()
  })

  it('tolerates missing optional fields', () => {
    expect(parseMoonshotBalancePayload({ data: { available_balance: 5 } }, 'intl')).toEqual({
      amount: 5,
      currency: 'USD',
      cash: null,
      voucher: null,
    })
    // No available_balance: fall back to cash + voucher.
    expect(parseMoonshotBalancePayload({ status: true, data: { cash_balance: 2, voucher_balance: 1.5 } }, 'cn')).toEqual({
      amount: 3.5,
      currency: 'CNY',
      cash: 2,
      voucher: 1.5,
    })
  })

  it('does not sum cash + voucher when only one of them is a number', () => {
    // Only cash: no amount → no display.
    expect(parseMoonshotBalancePayload({ status: true, data: { cash_balance: 2 } }, 'intl')).toBeNull()
    expect(parseMoonshotBalancePayload({ status: true, data: { cash_balance: 2, voucher_balance: 'x' } }, 'intl')).toBeNull()
    // Only voucher: no amount → no display.
    expect(parseMoonshotBalancePayload({ status: true, data: { voucher_balance: 1.5 } }, 'intl')).toBeNull()
    expect(parseMoonshotBalancePayload({ status: true, data: { cash_balance: null, voucher_balance: 1.5 } }, 'intl')).toBeNull()
  })
})

describe('isMoonshotBalanceProvider / registry', () => {
  it('matches a kimi API-key provider only', () => {
    expect(isMoonshotBalanceProvider(provider)).toBe(true)
    expect(isMoonshotBalanceProvider({ ...provider, apiKey: '' })).toBe(false)
    expect(isMoonshotBalanceProvider({ ...provider, providerType: 'kimi-coding' })).toBe(false)
    expect(isMoonshotBalanceProvider({ ...provider, providerType: 'kimi-coding-oauth', authMethod: 'oauth' })).toBe(false)
  })

  it('is resolved by the quota registry', () => {
    expect(getQuotaAdapter(provider)?.kind).toBe('moonshot')
    expect(moonshotBalanceAdapter.quietErrors).toBe(true)
  })
})

describe('fetchMoonshotBalance', () => {
  it('calls the regional endpoint with a bearer key and returns a balance quota', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: true, status: 200, json: VALID_BODY }))
    const result = await fetchMoonshotBalance('cn', KEY, fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.moonshot.cn/v1/users/me/balance')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(result.quota?.kind).toBe('moonshot')
    expect(result.quota?.windows).toEqual([])
    expect(result.quota?.balance).toEqual({ amount: 13.505731, currency: 'CNY', cash: 13.505731, voucher: 0 })
  })

  it('returns no quota for broken JSON', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: true, status: 200, jsonThrows: true }))
    const result = await fetchMoonshotBalance('intl', KEY, fetchImpl as unknown as typeof fetch)
    expect(result.quota).toBeNull()
    expect(result.error).toMatch(/no JSON/)
  })

  it('returns no quota for status:false', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: true, status: 200, json: { ...VALID_BODY, status: false } }))
    const result = await fetchMoonshotBalance('intl', KEY, fetchImpl as unknown as typeof fetch)
    expect(result.quota).toBeNull()
  })

  it('passes 429 with Retry-After through and never throws on network errors', async () => {
    const limited = vi.fn(async () => mockResponse({ ok: false, status: 429, headers: { 'retry-after': '120' } }))
    const r1 = await fetchMoonshotBalance('intl', KEY, limited as unknown as typeof fetch)
    expect(r1).toMatchObject({ quota: null, status: 429, retryAfterMs: 120_000 })

    const broken = vi.fn(async () => {
      throw new Error(`connect failed Authorization: Bearer ${KEY}`)
    })
    const r2 = await fetchMoonshotBalance('intl', KEY, broken as unknown as typeof fetch)
    expect(r2.quota).toBeNull()
    expect(r2.error).not.toContain(KEY)
  })
})

describe('getMoonshotBalanceForProvider (throttling, logging)', () => {
  let clock = 0
  const now = () => clock
  const logger = { warn: vi.fn() }

  beforeEach(() => {
    resetMoonshotBalanceState()
    clock = 1_000_000
    logger.warn.mockReset()
  })
  afterEach(() => resetMoonshotBalanceState())

  it('logs failures without the key', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: true, status: 200, jsonThrows: true }))
    const result = await getMoonshotBalanceForProvider(provider, fetchImpl as unknown as typeof fetch, now, logger)
    expect(result.quota).toBeNull()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0]?.[0])).not.toContain(KEY)
  })

  it('backs off after a 5xx and doubles the pause', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: false, status: 503 }))
    const f = fetchImpl as unknown as typeof fetch
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += MOONSHOT_BALANCE_INITIAL_BACKOFF_MS - 1
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += 1
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // Second failure: the pause is now twice as long.
    clock += MOONSHOT_BALANCE_INITIAL_BACKOFF_MS
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    clock += MOONSHOT_BALANCE_INITIAL_BACKOFF_MS
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('pauses a refused key for hours, but a new key is asked right away', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: false, status: 401 }))
    const f = fetchImpl as unknown as typeof fetch
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    clock += MOONSHOT_BALANCE_REFUSED_RETRY_MS - 1
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    await getMoonshotBalanceForProvider({ ...provider, apiKey: 'sk_another-moonshot-key-987654' }, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('a success clears the pause', async () => {
    let fail = true
    const fetchImpl = vi.fn(async () =>
      fail ? mockResponse({ ok: false, status: 500 }) : mockResponse({ ok: true, status: 200, json: VALID_BODY }),
    )
    const f = fetchImpl as unknown as typeof fetch
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    fail = false
    clock += MOONSHOT_BALANCE_INITIAL_BACKOFF_MS
    const ok = await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(ok.quota?.balance?.amount).toBe(13.505731)
    const again = await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(again.quota).not.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('pauses a 429 itself: 20 min, doubling to 2 h, bound to the key', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: false, status: 429 }))
    const f = fetchImpl as unknown as typeof fetch
    const first = await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(first).toMatchObject({ quota: null, status: 429, retryAfterMs: MOONSHOT_BALANCE_RATE_LIMIT_INITIAL_BACKOFF_MS })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += MOONSHOT_BALANCE_RATE_LIMIT_INITIAL_BACKOFF_MS - 1
    const paused = await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(paused).toMatchObject({ quota: null, status: 429, retryAfterMs: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    clock += 1
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // Each further 429 doubles the pause: 40 min, 80 min, then capped at 2 h.
    const minute = 60 * 1000
    for (const pauseMs of [40 * minute, 80 * minute, 120 * minute, 120 * minute]) {
      const calls = fetchImpl.mock.calls.length
      clock += pauseMs - 1
      await getMoonshotBalanceForProvider(provider, f, now, logger)
      expect(fetchImpl).toHaveBeenCalledTimes(calls)
      clock += 1
      await getMoonshotBalanceForProvider(provider, f, now, logger)
      expect(fetchImpl).toHaveBeenCalledTimes(calls + 1)
    }
    expect(MOONSHOT_BALANCE_MAX_BACKOFF_MS).toBe(120 * minute)

    // A new key is not bound by the pause.
    const calls = fetchImpl.mock.calls.length
    await getMoonshotBalanceForProvider({ ...provider, apiKey: 'sk_another-moonshot-key-987654' }, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(calls + 1)
  })

  it('a longer Retry-After wins over the 429 backoff, a shorter one does not', async () => {
    const longRa = vi.fn(async () => mockResponse({ ok: false, status: 429, headers: { 'retry-after': '3600' } }))
    const r1 = await getMoonshotBalanceForProvider(provider, longRa as unknown as typeof fetch, now, logger)
    expect(r1.retryAfterMs).toBe(3_600_000)
    clock += 3_600_000 - 1
    await getMoonshotBalanceForProvider(provider, longRa as unknown as typeof fetch, now, logger)
    expect(longRa).toHaveBeenCalledTimes(1)

    resetMoonshotBalanceState()
    const shortRa = vi.fn(async () => mockResponse({ ok: false, status: 429, headers: { 'retry-after': '60' } }))
    const r2 = await getMoonshotBalanceForProvider(provider, shortRa as unknown as typeof fetch, now, logger)
    expect(r2.retryAfterMs).toBe(MOONSHOT_BALANCE_RATE_LIMIT_INITIAL_BACKOFF_MS)
    clock += 60_000
    await getMoonshotBalanceForProvider(provider, shortRa as unknown as typeof fetch, now, logger)
    expect(shortRa).toHaveBeenCalledTimes(1)
  })

  it('a manual refresh (force) keeps the 429 pause and sends no request', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: false, status: 429 }))
    const f = fetchImpl as unknown as typeof fetch
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    clock += 60_000
    const forced = await getMoonshotBalanceForProvider(provider, f, now, logger, { force: true })
    expect(forced).toMatchObject({ quota: null, status: 429 })
    expect(forced.retryAfterMs).toBe(MOONSHOT_BALANCE_RATE_LIMIT_INITIAL_BACKOFF_MS - 60_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a manual refresh (force) tests a refused key with exactly one request', async () => {
    let status = 401
    const fetchImpl = vi.fn(async () =>
      status === 200 ? mockResponse({ ok: true, status: 200, json: VALID_BODY }) : mockResponse({ ok: false, status }),
    )
    const f = fetchImpl as unknown as typeof fetch
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Automatic polling stays paused.
    clock += 60_000
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Manual refresh: one request, still refused → pause renewed for polling.
    const stillRefused = await getMoonshotBalanceForProvider(provider, f, now, logger, { force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(stillRefused).toMatchObject({ quota: null, status: 401 })
    clock += MOONSHOT_BALANCE_REFUSED_RETRY_MS - 1
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // Key works again: the manual refresh shows the balance and ends the pause.
    status = 200
    const ok = await getMoonshotBalanceForProvider(provider, f, now, logger, { force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(ok.quota?.balance?.amount).toBe(13.505731)
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('force does not lift the 5xx backoff', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: false, status: 503 }))
    const f = fetchImpl as unknown as typeof fetch
    await getMoonshotBalanceForProvider(provider, f, now, logger)
    await getMoonshotBalanceForProvider(provider, f, now, logger, { force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('the registered adapter forwards force', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let status = 401
    const fetchImpl = vi.fn(async () => mockResponse({ ok: false, status }))
    const f = fetchImpl as unknown as typeof fetch
    await moonshotBalanceAdapter.fetch(provider, f)
    await moonshotBalanceAdapter.fetch(provider, f)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    status = 403
    await moonshotBalanceAdapter.fetch(provider, f, { force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(KEY)
    warn.mockRestore()
  })
})
