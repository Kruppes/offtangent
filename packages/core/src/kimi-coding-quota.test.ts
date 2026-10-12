import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderConfig } from './provider-config.js'
import {
  KIMI_QUOTA_UNAVAILABLE,
  KIMI_QUOTA_UNSUPPORTED_RETRY_MS,
  getKimiCodingQuotaForProvider,
  isKimiCodingQuotaProvider,
  kimiCodingQuotaAdapter,
  kimiQuotaRegion,
  kimiUsageUrl,
  parseKimiUsagePayload,
  resetKimiQuotaState,
} from './kimi-coding-quota.js'
import { getQuotaAdapter } from './quota-registry.js'

const NOW = new Date('2026-10-12T12:00:00.000Z')

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const CLI_SHAPE = {
  usages: {
    limit_5h: { used_ratio: 0.42, reset_time: '2026-10-12T15:00:00Z' },
    limit_7d: { used_ratio: 0.1, reset_time: 1792000000 },
    limit_month_total: { used_ratio: 0.333, reset_time: '2026-11-01T00:00:00Z' },
    limit_month_code: { used_ratio: 0, reset_time: null },
  },
  boosterWallet: { balance: { amount: 10_000_000, amountLeft: 2_500_000 } },
}

describe('parseKimiUsagePayload', () => {
  it('normalizes the CLI shape (snake_case) into four windows', () => {
    const quota = parseKimiUsagePayload(CLI_SHAPE, NOW)
    expect(quota).toEqual({
      kind: 'kimi-coding',
      windows: [
        { key: 'five_hour', label: '5h', utilization: 42, resetsAt: '2026-10-12T15:00:00.000Z', resetDisplay: 'relative' },
        { key: 'weekly', label: '7d', utilization: 10, resetsAt: new Date(1792000000 * 1000).toISOString(), resetDisplay: 'absolute' },
        { key: 'month_total', label: 'Month', utilization: 33, resetsAt: '2026-11-01T00:00:00.000Z', resetDisplay: 'absolute' },
        { key: 'month_code', label: 'Month (code)', utilization: 0, resetsAt: null, resetDisplay: 'absolute' },
      ],
      plan: 'Booster 25% left',
      fetchedAt: NOW.toISOString(),
    })
  })

  it('accepts the camelCase spelling (limit5h / monthTotal / usedRatio / resetAt / extraUsage)', () => {
    const quota = parseKimiUsagePayload({
      limit5h: { usedRatio: '0.5', resetAt: 1792000000000 },
      monthTotal: { usedRatio: 0.9 },
      extraUsage: { balanceCents: 50, totalCents: 200 },
    }, NOW)
    expect(quota?.windows.map(w => [w.key, w.utilization, w.resetsAt])).toEqual([
      ['five_hour', 50, new Date(1792000000000).toISOString()],
      ['month_total', 90, null],
    ])
    expect(quota?.plan).toBe('Booster 25% left')
  })

  it('reads a percentage-looking ratio as percent and clamps to 0..100', () => {
    const quota = parseKimiUsagePayload({ usages: { limit_5h: { used_ratio: 73 }, limit_7d: { used_ratio: 4.2 } } }, NOW)
    expect(quota?.windows.map(w => w.utilization)).toEqual([73, 4])
    const over = parseKimiUsagePayload({ usages: { limit_5h: { used_ratio: 250 } } }, NOW)
    expect(over?.windows[0].utilization).toBe(100)
  })

  it.each([
    ['null', null],
    ['a string', 'oops'],
    ['an array', [1, 2]],
    ['an empty object', {}],
    ['usages not an object', { usages: 'x' }],
    ['windows without ratio', { usages: { limit_5h: {}, limit_7d: { reset_time: 'x' } } }],
    ['negative / NaN ratios', { usages: { limit_5h: { used_ratio: -1 }, limit_7d: { used_ratio: 'NaN' } } }],
    ['windows that are not objects', { usages: { limit_5h: 0.5, limit_7d: [0.1] } }],
  ])('returns null (no quota) for %s', (_label, body) => {
    expect(parseKimiUsagePayload(body, NOW)).toBeNull()
  })

  it('drops broken windows and broken extras but keeps the good ones', () => {
    const quota = parseKimiUsagePayload({
      usages: {
        limit_5h: { used_ratio: 0.2, reset_time: 'not a date' },
        limit_7d: { used_ratio: null },
        limit_month_total: 'garbage',
      },
      boosterWallet: { balance: { amount: 0, amountLeft: 5 } },
    }, NOW)
    expect(quota?.windows).toEqual([
      { key: 'five_hour', label: '5h', utilization: 20, resetsAt: null, resetDisplay: 'relative' },
    ])
    expect(quota?.plan).toBeNull()
  })

  it('never throws, even on hostile getters', () => {
    const hostile = { get usages() { throw new Error('boom') } }
    expect(() => parseKimiUsagePayload(hostile, NOW)).not.toThrow()
    expect(parseKimiUsagePayload(hostile, NOW)).toBeNull()
  })
})

describe('region of the usage endpoint', () => {
  it.each([
    ['cn', 'https://api.kimi.com/coding/v1/usages'],
    ['intl', 'https://api.kimi.ai/coding/v1/usages'],
  ] as const)('%s → %s', (region, url) => {
    expect(kimiUsageUrl(region)).toBe(url)
  })
})

describe('getKimiCodingQuotaForProvider', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  beforeEach(() => {
    // Isolated data dir: getApiKeyForProvider may touch config files.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-kimi-quota-'))
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify({ providers: [] }), 'utf-8')
    process.env.DATA_DIR = tmpDir
    resetKimiQuotaState()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function apiKeyProvider(baseUrl: string): ProviderConfig {
    return {
      id: 'kc-key', name: 'Kimi Code', type: 'anthropic-messages', providerType: 'kimi-coding',
      provider: 'kimi-coding', baseUrl, apiKey: 'sk-plan-key', enabledModels: ['k3'], authMethod: 'api-key',
    }
  }

  function oauthProvider(region: 'cn' | 'intl', baseUrl: string): ProviderConfig {
    return {
      id: `kc-oauth-${region}`, name: 'Kimi OAuth', type: 'anthropic-messages', providerType: 'kimi-coding-oauth',
      provider: 'kimi-coding-oauth', baseUrl, apiKey: '', enabledModels: ['k3'], authMethod: 'oauth',
      // Decrypted form, as the quota monitor passes it (loadProvidersDecrypted).
      // Far-future expiry: no refresh request in this test.
      oauthCredentials: { access: `oauth-access-${region}`, refresh: 'r', expires: Date.now() + 3_600_000, extra: JSON.stringify({ region }) },
    }
  }

  it('matches OAuth and API-key Kimi Code providers, nothing else', () => {
    expect(isKimiCodingQuotaProvider(apiKeyProvider('https://api.kimi.com/coding'))).toBe(true)
    expect(isKimiCodingQuotaProvider({ ...apiKeyProvider('https://api.kimi.com/coding'), apiKey: '' })).toBe(false)
    expect(isKimiCodingQuotaProvider({ ...apiKeyProvider('https://api.moonshot.ai/v1'), providerType: 'kimi' })).toBe(false)
    expect(isKimiCodingQuotaProvider(oauthProvider('intl', 'https://api.kimi.ai/coding'))).toBe(true)
    expect(isKimiCodingQuotaProvider({ ...oauthProvider('cn', 'https://api.kimi.com/coding'), oauthCredentials: undefined })).toBe(false)
  })

  it('is registered in the quota registry for both auth methods', () => {
    expect(getQuotaAdapter(apiKeyProvider('https://api.kimi.com/coding'))).toBe(kimiCodingQuotaAdapter)
    expect(getQuotaAdapter(oauthProvider('cn', 'https://api.kimi.com/coding'))).toBe(kimiCodingQuotaAdapter)
  })

  it.each([
    ['cn', 'https://api.kimi.com/coding', 'https://api.kimi.com/coding/v1/usages'],
    ['intl', 'https://api.kimi.ai/coding', 'https://api.kimi.ai/coding/v1/usages'],
  ] as const)('OAuth %s: Bearer request to %s', async (region, baseUrl, url) => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, CLI_SHAPE))
    const result = await getKimiCodingQuotaForProvider(oauthProvider(region, baseUrl), fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe(url)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer oauth-access-${region}`)
    expect(result.quota?.windows).toHaveLength(4)
  })

  it('OAuth: the credential region wins over a diverging base URL', async () => {
    const provider = oauthProvider('intl', 'https://api.kimi.com/coding')
    expect(kimiQuotaRegion(provider)).toBe('intl')
    const fetchImpl = vi.fn(async () => jsonResponse(200, CLI_SHAPE))
    await getKimiCodingQuotaForProvider(provider, fetchImpl as unknown as typeof fetch)
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://api.kimi.ai/coding/v1/usages')
  })

  it.each([401, 403, 404])('API key: %i quietly reports "not available" and backs off', async (status) => {
    let t = NOW.getTime()
    const fetchImpl = vi.fn(async () => jsonResponse(status, { error: 'nope' }))
    const provider = apiKeyProvider('https://api.kimi.ai/coding')
    const first = await getKimiCodingQuotaForProvider(provider, fetchImpl as unknown as typeof fetch, () => t)
    expect(first).toEqual({ quota: null, status, error: KIMI_QUOTA_UNAVAILABLE })
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://api.kimi.ai/coding/v1/usages')
    // Within the back-off window: no new request.
    const second = await getKimiCodingQuotaForProvider(provider, fetchImpl as unknown as typeof fetch, () => t + 1000)
    expect(second.error).toBe(KIMI_QUOTA_UNAVAILABLE)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // After it: tried again.
    t += KIMI_QUOTA_UNSUPPORTED_RETRY_MS + 1
    await getKimiCodingQuotaForProvider(provider, fetchImpl as unknown as typeof fetch, () => t)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('API key: a working endpoint yields a quota (China region)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, CLI_SHAPE))
    const result = await getKimiCodingQuotaForProvider(apiKeyProvider('https://api.kimi.com/coding'), fetchImpl as unknown as typeof fetch)
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://api.kimi.com/coding/v1/usages')
    expect(result.quota?.kind).toBe('kimi-coding')
  })

  it('OAuth 401 is surfaced (not silenced) so a dead sign-in is visible', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, {}))
    const result = await getKimiCodingQuotaForProvider(oauthProvider('cn', 'https://api.kimi.com/coding'), fetchImpl as unknown as typeof fetch)
    expect(result).toMatchObject({ quota: null, status: 401, error: 'HTTP 401' })
  })

  it('429 passes Retry-After through for the monitor back-off', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {}, { 'retry-after': '30' }))
    const result = await getKimiCodingQuotaForProvider(apiKeyProvider('https://api.kimi.com/coding'), fetchImpl as unknown as typeof fetch)
    expect(result).toMatchObject({ quota: null, status: 429, retryAfterMs: 30_000 })
  })

  it('broken bodies, non-JSON and network errors never throw', async () => {
    for (const make of [
      () => jsonResponse(200, 'not json at all'),
      () => jsonResponse(200, { usages: { limit_5h: 'x' } }),
      () => { throw new Error('ECONNRESET') },
    ]) {
      const fetchImpl = vi.fn(async () => make())
      const result = await getKimiCodingQuotaForProvider(oauthProvider('intl', 'https://api.kimi.ai/coding'), fetchImpl as unknown as typeof fetch)
      expect(result.quota).toBeNull()
      expect(typeof result.error).toBe('string')
    }
  })
})
