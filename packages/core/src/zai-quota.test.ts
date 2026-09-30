import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchZaiQuota, getZaiQuotaForProvider, isZaiQuotaProvider } from './zai-quota.js'
import type { ProviderConfig } from './provider-config.js'

function mockResponse(init: {
  ok: boolean
  status: number
  json?: unknown
  headers?: Record<string, string>
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    headers: { get: (name: string) => init.headers?.[name.toLowerCase()] ?? null },
    json: async () => init.json ?? {},
  } as unknown as Response
}

const provider: ProviderConfig = {
  id: 'zai-coding-1',
  name: 'z.ai Coding',
  type: 'openai-completions',
  providerType: 'zai-coding',
  provider: 'zai',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  apiKey: 'zai-coding-key',
  enabledModels: ['glm-4.7'],
  authMethod: 'api-key',
}

describe('isZaiQuotaProvider', () => {
  it('matches a zai-coding provider that has an API key', () => {
    expect(isZaiQuotaProvider(provider)).toBe(true)
  })

  it('does not match the pay-per-token zai provider', () => {
    expect(isZaiQuotaProvider({ ...provider, providerType: 'zai' })).toBe(false)
  })

  it('does not match without an API key', () => {
    expect(isZaiQuotaProvider({ ...provider, apiKey: '' })).toBe(false)
  })
})

describe('fetchZaiQuota', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a bearer-authenticated request and normalizes the 5h + weekly windows', async () => {
    const fiveHourReset = Date.parse('2026-06-20T15:00:00.000Z')
    const weeklyReset = Date.parse('2026-06-25T00:00:00.000Z')
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        ok: true,
        status: 200,
        json: {
          code: 200,
          data: {
            level: 'max',
            limits: [
              { type: 'TOKENS_LIMIT', unit: 3, percentage: 12, nextResetTime: fiveHourReset },
              { type: 'TOKENS_LIMIT', unit: 6, percentage: 32, nextResetTime: weeklyReset },
              { type: 'TIME_LIMIT', unit: 5, percentage: 5, nextResetTime: weeklyReset },
            ],
          },
        },
      }),
    )

    const result = await fetchZaiQuota('zai-coding-key', fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer zai-coding-key' }),
      }),
    )
    expect(result.status).toBe(200)
    expect(result.error).toBeUndefined()
    expect(result.quota).toEqual({
      kind: 'zai',
      plan: 'Max',
      fetchedAt: '2026-06-20T12:00:00.000Z',
      windows: [
        {
          key: 'five_hour',
          label: '5h',
          utilization: 12,
          resetsAt: '2026-06-20T15:00:00.000Z',
          resetDisplay: 'relative',
        },
        {
          key: 'weekly',
          label: '7d',
          utilization: 32,
          resetsAt: '2026-06-25T00:00:00.000Z',
          resetDisplay: 'absolute',
        },
      ],
    })
  })

  it('surfaces an HTTP error with retry-after metadata', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ ok: false, status: 429, headers: { 'retry-after': '30' } }),
    )

    const result = await fetchZaiQuota('key', fetchImpl as unknown as typeof fetch)

    expect(result.quota).toBeNull()
    expect(result.status).toBe(429)
    expect(result.retryAfterMs).toBe(30_000)
    expect(result.error).toBe('HTTP 429')
  })

  it('reports an API error when the response code is not 200', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ ok: true, status: 200, json: { code: 401, data: null } }),
    )

    const result = await fetchZaiQuota('key', fetchImpl as unknown as typeof fetch)

    expect(result.quota).toBeNull()
    expect(result.error).toMatch(/code 401/)
  })

  it('reports a parse failure when no recognized windows are present', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ ok: true, status: 200, json: { code: 200, data: { level: 'lite', limits: [{ unit: 5, percentage: 0 }] } } }),
    )

    const result = await fetchZaiQuota('key', fetchImpl as unknown as typeof fetch)

    expect(result.quota).toBeNull()
    expect(result.error).toMatch(/no usable windows/i)
  })

  it('returns a network error message when the request throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up')
    })

    const result = await fetchZaiQuota('key', fetchImpl as unknown as typeof fetch)

    expect(result.quota).toBeNull()
    expect(result.error).toBe('socket hang up')
  })
})

describe('getZaiQuotaForProvider', () => {
  it('rejects providers that are not z.ai GLM Coding Plan subscribers', async () => {
    const result = await getZaiQuotaForProvider({ ...provider, providerType: 'zai' })
    expect(result.quota).toBeNull()
    expect(result.error).toMatch(/not a z\.ai GLM Coding Plan/i)
  })

  it('fetches quota using the provider API key', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        ok: true,
        status: 200,
        json: { code: 200, data: { level: 'pro', limits: [{ unit: 3, percentage: 4, nextResetTime: Date.now() + 3_600_000 }] } },
      }),
    )

    const result = await getZaiQuotaForProvider(provider, fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer zai-coding-key' }) }),
    )
    expect(result.quota?.kind).toBe('zai')
    expect(result.quota?.plan).toBe('Pro')
  })
})
