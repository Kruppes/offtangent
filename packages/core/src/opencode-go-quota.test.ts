import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchOpenCodeGoQuota,
  isOpenCodeGoQuotaProvider,
  parseOpenCodeGoQuotaHtml,
  resolveOpenCodeGoQuotaCredentials,
} from './opencode-go-quota.js'
import type { ProviderConfig } from './provider-config.js'

function mockResponse(init: {
  ok: boolean
  status: number
  text?: string
  headers?: Record<string, string>
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    headers: { get: (name: string) => init.headers?.[name.toLowerCase()] ?? null },
    text: async () => init.text ?? '',
  } as unknown as Response
}

const provider: ProviderConfig = {
  id: 'opencode-go-1',
  name: 'OpenCode Go',
  type: 'openai-completions',
  providerType: 'opencode-go',
  provider: 'opencode-go',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  apiKey: 'oc-go-key',
  enabledModels: ['kimi-k2.7-code'],
  authMethod: 'api-key',
}

const providerWithQuota: ProviderConfig = {
  ...provider,
  extraFields: { workspaceId: 'workspace-1', authCookie: 'cookie-1' },
}

describe('OpenCode Go quota credentials', () => {
  it('resolves the workspace id and auth cookie from the provider extra fields', () => {
    expect(
      resolveOpenCodeGoQuotaCredentials({
        ...provider,
        extraFields: { workspaceId: ' workspace-1 ', authCookie: ' cookie-1 ' },
      }),
    ).toEqual({ workspaceId: 'workspace-1', authCookie: 'cookie-1' })
  })

  it('returns null when either credential is missing', () => {
    expect(resolveOpenCodeGoQuotaCredentials({ ...provider, extraFields: { workspaceId: 'workspace-1' } })).toBeNull()
    expect(resolveOpenCodeGoQuotaCredentials({ ...provider, extraFields: { authCookie: 'cookie-1' } })).toBeNull()
    expect(resolveOpenCodeGoQuotaCredentials(provider)).toBeNull()
  })
})

describe('isOpenCodeGoQuotaProvider', () => {
  it('matches OpenCode Go providers when dashboard credentials are configured', () => {
    expect(isOpenCodeGoQuotaProvider(providerWithQuota)).toBe(true)
    expect(isOpenCodeGoQuotaProvider({ ...providerWithQuota, providerType: 'openai' })).toBe(false)
  })

  it('does not enable quota for OpenCode Go without credentials', () => {
    expect(isOpenCodeGoQuotaProvider(provider)).toBe(false)
  })
})

describe('parseOpenCodeGoQuotaHtml', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('normalizes SolidJS hydration usage windows', () => {
    const windows = parseOpenCodeGoQuotaHtml(`
      rollingUsage:$R[1]={usagePercent:42.6,resetInSec:3600}
      weeklyUsage:$R[2]={resetInSec:172800,usagePercent:88}
      monthlyUsage:$R[3]={usagePercent:101,resetInSec:2592000}
    `)

    expect(windows).toEqual([
      {
        key: 'rolling',
        label: '5h',
        utilization: 43,
        resetsAt: '2026-06-16T13:00:00.000Z',
        resetDisplay: 'relative',
      },
      {
        key: 'weekly',
        label: '7d',
        utilization: 88,
        resetsAt: '2026-06-18T12:00:00.000Z',
        resetDisplay: 'absolute',
      },
      {
        key: 'monthly',
        label: '30d',
        utilization: 100,
        resetsAt: '2026-07-16T12:00:00.000Z',
        resetDisplay: 'absolute',
      },
    ])
  })

  it('falls back to data-slot dashboard markup', () => {
    const windows = parseOpenCodeGoQuotaHtml(`
      <div data-slot="usage-item">
        <span data-slot="usage-label">Rolling Usage</span>
        <span data-slot="usage-value">7%</span>
        <span data-slot="reset-time">Resets in 1 hour 30 minutes</span>
      </div>
      <div data-slot="usage-item">
        <span data-slot="usage-label">Weekly Usage</span>
        <span data-slot="usage-value">12%</span>
        <span data-slot="reset-now">Reset now</span>
      </div>
    `)

    expect(windows).toEqual([
      expect.objectContaining({ key: 'rolling', utilization: 7, resetsAt: '2026-06-16T13:30:00.000Z' }),
      expect.objectContaining({ key: 'weekly', utilization: 12, resetsAt: '2026-06-16T12:00:00.000Z' }),
    ])
  })
})


describe('fetchOpenCodeGoQuota', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('scrapes the authenticated workspace dashboard and normalizes windows', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        ok: true,
        status: 200,
        text: 'rollingUsage:$R[1]={usagePercent:25,resetInSec:3600}',
      }),
    )

    const result = await fetchOpenCodeGoQuota('workspace-1', 'cookie-1', fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://opencode.ai/workspace/workspace-1/go',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Cookie: 'auth=cookie-1' }),
      }),
    )
    expect(result.status).toBe(200)
    expect(result.error).toBeUndefined()
    expect(result.quota).toEqual({
      kind: 'opencode-go',
      plan: 'Go',
      fetchedAt: '2026-06-16T12:00:00.000Z',
      windows: [
        {
          key: 'rolling',
          label: '5h',
          utilization: 25,
          resetsAt: '2026-06-16T13:00:00.000Z',
          resetDisplay: 'relative',
        },
      ],
    })
  })

  it('passes through a pre-formatted auth cookie unchanged', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ ok: true, status: 200, text: 'rollingUsage:$R[1]={usagePercent:1,resetInSec:60}' }),
    )

    await fetchOpenCodeGoQuota('ws', 'auth=already-set; other=1', fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'auth=already-set; other=1' }) }),
    )
  })

  it('surfaces an HTTP error with retry-after metadata', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ ok: false, status: 429, headers: { 'retry-after': '30' } }),
    )

    const result = await fetchOpenCodeGoQuota('ws', 'cookie', fetchImpl as unknown as typeof fetch)

    expect(result.quota).toBeNull()
    expect(result.status).toBe(429)
    expect(result.retryAfterMs).toBe(30_000)
    expect(result.error).toBe('HTTP 429')
  })

  it('reports a parse failure when the dashboard markup yields no windows', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: true, status: 200, text: '<html>no usage here</html>' }))

    const result = await fetchOpenCodeGoQuota('ws', 'cookie', fetchImpl as unknown as typeof fetch)

    expect(result.quota).toBeNull()
    expect(result.status).toBe(200)
    expect(result.error).toMatch(/could not parse/i)
  })

  it('returns a network error message when the request throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up')
    })

    const result = await fetchOpenCodeGoQuota('ws', 'cookie', fetchImpl as unknown as typeof fetch)

    expect(result.quota).toBeNull()
    expect(result.error).toBe('socket hang up')
  })
})
