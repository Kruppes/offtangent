import { describe, expect, it, vi } from 'vitest'
import {
  extractCodexAccountId,
  fetchOpenAiCodexQuota,
  isOpenAiCodexOAuthProvider,
} from './openai-codex-quota.js'
import type { ProviderConfig } from './provider-config.js'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

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

const codexProvider: ProviderConfig = {
  id: 'codex-1',
  name: 'ChatGPT',
  type: 'openai-codex-responses',
  providerType: 'openai-codex',
  provider: 'openai-codex',
  baseUrl: '',
  apiKey: '',
  enabledModels: ['gpt-5-codex'],
  authMethod: 'oauth',
  oauthCredentials: { refresh: 'r', access: 'a', expires: Date.now() + 60_000 },
}

describe('extractCodexAccountId', () => {
  it('reads the chatgpt account id from the JWT auth claim', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-abc-123' },
    })
    expect(extractCodexAccountId(token)).toBe('acc-abc-123')
  })

  it('returns null for a malformed token', () => {
    expect(extractCodexAccountId('not-a-jwt')).toBeNull()
    expect(extractCodexAccountId(makeJwt({ foo: 'bar' }))).toBeNull()
  })
})

describe('isOpenAiCodexOAuthProvider', () => {
  it('matches only openai-codex OAuth providers with credentials', () => {
    expect(isOpenAiCodexOAuthProvider(codexProvider)).toBe(true)
    expect(isOpenAiCodexOAuthProvider({ ...codexProvider, oauthCredentials: undefined })).toBe(false)
    expect(isOpenAiCodexOAuthProvider({ ...codexProvider, providerType: 'openai' })).toBe(false)
  })
})

describe('fetchOpenAiCodexQuota', () => {
  it('normalizes primary/secondary windows and plan', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 3600
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: {
          plan_type: 'plus',
          rate_limit: {
            primary_window: {
              used_percent: 42.6,
              limit_window_seconds: 18_000,
              reset_after_seconds: 3600,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 604_800,
              reset_at: resetAt,
            },
          },
        },
      }),
    )

    const result = await fetchOpenAiCodexQuota('token', 'acc-1', fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
          'ChatGPT-Account-Id': 'acc-1',
        }),
      }),
    )
    expect(result.quota?.kind).toBe('openai-codex')
    expect(result.quota?.plan).toBe('Plus')
    expect(result.quota?.windows).toEqual([
      expect.objectContaining({ key: 'primary', label: '5h', utilization: 43, resetDisplay: 'relative' }),
      expect.objectContaining({
        key: 'secondary',
        label: '7d',
        utilization: 10,
        resetDisplay: 'absolute',
        resetsAt: new Date(resetAt * 1000).toISOString(),
      }),
    ])
  })

  it('surfaces status and retry-after on rate limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 429, headers: { 'retry-after': '120' } }),
    )

    const result = await fetchOpenAiCodexQuota('token', 'acc-1', fetchImpl as unknown as typeof fetch)

    expect(result.quota).toBeNull()
    expect(result.status).toBe(429)
    expect(result.retryAfterMs).toBe(120_000)
  })

  it('returns an error result when the network call throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'))
    const result = await fetchOpenAiCodexQuota('token', 'acc-1', fetchImpl as unknown as typeof fetch)
    expect(result.quota).toBeNull()
    expect(result.error).toBe('boom')
  })
})
