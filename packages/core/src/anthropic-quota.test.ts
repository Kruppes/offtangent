import { describe, expect, it, vi } from 'vitest'
import { fetchAnthropicQuota, isAnthropicOAuthProvider } from './anthropic-quota.js'
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
    json: async () => init.json,
  } as unknown as Response
}

const anthropicProvider: ProviderConfig = {
  id: 'anthropic-1',
  name: 'Claude',
  type: 'anthropic-messages',
  providerType: 'anthropic-oauth',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: '',
  enabledModels: ['claude-sonnet-4'],
  authMethod: 'oauth',
  oauthCredentials: { refresh: 'r', access: 'a', expires: Date.now() + 60_000 },
}

describe('isAnthropicOAuthProvider', () => {
  it('matches only anthropic-oauth providers with credentials', () => {
    expect(isAnthropicOAuthProvider(anthropicProvider)).toBe(true)
    expect(isAnthropicOAuthProvider({ ...anthropicProvider, oauthCredentials: undefined })).toBe(false)
    expect(isAnthropicOAuthProvider({ ...anthropicProvider, providerType: 'anthropic' })).toBe(false)
  })
})

describe('fetchAnthropicQuota', () => {
  it('normalizes all usage windows including the Sonnet bucket', async () => {
    const resetsAt = '2026-01-01T00:00:00.000Z'
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: {
          five_hour: { utilization: 12.4, resets_at: resetsAt },
          seven_day: { utilization: 30, resets_at: resetsAt },
          seven_day_opus: { utilization: 50, resets_at: resetsAt },
          seven_day_sonnet: { utilization: 70, resets_at: resetsAt },
        },
      }),
    )

    const result = await fetchAnthropicQuota('token', fetchImpl as unknown as typeof fetch)

    expect(result.quota?.kind).toBe('anthropic')
    expect(result.quota?.windows).toEqual([
      expect.objectContaining({ key: 'five_hour', label: '5h', utilization: 12, resetDisplay: 'relative' }),
      expect.objectContaining({ key: 'seven_day', label: '7d', utilization: 30, resetDisplay: 'absolute' }),
      expect.objectContaining({ key: 'seven_day_opus', label: 'Opus', utilization: 50, resetDisplay: 'absolute' }),
      expect.objectContaining({
        key: 'seven_day_sonnet',
        label: 'Sonnet',
        utilization: 70,
        resetDisplay: 'absolute',
        resetsAt,
      }),
    ])
  })

  it('hides Opus/Sonnet at 0% but always keeps 5h and 7d', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: {
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: 0, resets_at: null },
          seven_day_opus: { utilization: 0, resets_at: null },
          // Rounds to 0% — should be hidden like an exact zero.
          seven_day_sonnet: { utilization: 0.4, resets_at: null },
        },
      }),
    )

    const result = await fetchAnthropicQuota('token', fetchImpl as unknown as typeof fetch)
    expect(result.quota?.windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day'])
  })

  it('keeps Opus/Sonnet when they carry real usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: {
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: 0, resets_at: null },
          seven_day_opus: { utilization: 5, resets_at: null },
          seven_day_sonnet: { utilization: 1, resets_at: null },
        },
      }),
    )

    const result = await fetchAnthropicQuota('token', fetchImpl as unknown as typeof fetch)
    expect(result.quota?.windows.map((w) => w.key)).toEqual([
      'five_hour',
      'seven_day',
      'seven_day_opus',
      'seven_day_sonnet',
    ])
  })

  it('omits windows the API does not return', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: {
          five_hour: { utilization: 5, resets_at: null },
          seven_day: { utilization: 10, resets_at: null },
        },
      }),
    )

    const result = await fetchAnthropicQuota('token', fetchImpl as unknown as typeof fetch)
    expect(result.quota?.windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day'])
  })

  it('surfaces status and retry-after on rate limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 429, headers: { 'retry-after': '90' } }),
    )

    const result = await fetchAnthropicQuota('token', fetchImpl as unknown as typeof fetch)
    expect(result.quota).toBeNull()
    expect(result.status).toBe(429)
    expect(result.retryAfterMs).toBe(90_000)
  })
})
