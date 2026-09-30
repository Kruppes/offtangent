import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createProviderQuotaTool } from './quota-tool.js'
import type { QuotaServiceLike } from './quota-tool.js'
import type { ProviderQuotaContract } from './contracts/providers.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'

function makeQuota(overrides: Partial<ProviderQuotaContract> = {}): ProviderQuotaContract {
  return {
    kind: 'anthropic',
    windows: [
      { key: 'sonnet_daily', label: 'Claude Sonnet (Daily)', utilization: 45, resetsAt: '2026-06-20T22:00:00Z', resetDisplay: 'relative' },
      { key: 'opus_weekly', label: 'Claude Opus (Weekly)', utilization: 12, resetsAt: '2026-06-23T00:00:00Z', resetDisplay: 'absolute' },
    ],
    plan: 'Max',
    fetchedAt: '2026-06-20T19:30:00Z',
    ...overrides,
  }
}

function makeService(snapshot: Record<string, ProviderQuotaContract> = {}): QuotaServiceLike {
  return {
    getSnapshot: vi.fn(() => snapshot),
    refreshProvider: vi.fn(async () => null),
  }
}

function getText(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  if (!result || !('content' in result)) return ''
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}

function getDetails(result: Awaited<ReturnType<AgentTool['execute']>>): Record<string, unknown> {
  if (!result || !('details' in result)) return {}
  return (result as { details: Record<string, unknown> }).details
}

describe('createProviderQuotaTool', () => {
  it('creates a tool with correct metadata', () => {
    const tool = createProviderQuotaTool({ quotaService: makeService() })
    expect(tool.name).toBe('provider_quota')
    expect(tool.label).toBe('Provider Quota')
    expect(tool.description).toContain('quota')
    expect(tool.execute).toBeInstanceOf(Function)
  })

  it('has optional providerId and refresh parameters', () => {
    const tool = createProviderQuotaTool({ quotaService: makeService() })
    const schema = tool.parameters as { properties: Record<string, unknown> }
    expect(schema.properties.providerId).toBeDefined()
    expect(schema.properties.refresh).toBeDefined()
  })
})

describe('provider_quota execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all providers from cached snapshot', async () => {
    const service = makeService({
      anthropic: makeQuota(),
      'zai': makeQuota({ kind: 'zai', plan: 'Pro' }),
    })
    const tool = createProviderQuotaTool({ quotaService: service })

    const result = await tool.execute('call-1', {})
    const text = getText(result)

    expect(text).toContain('anthropic')
    expect(text).toContain('zai')
    expect(text).toContain('45%')
    expect(getDetails(result).count).toBe(2)
    expect(getDetails(result).refreshed).toBe(false)
  })

  it('filters to a single provider when providerId is given', async () => {
    const service = makeService({
      anthropic: makeQuota(),
      'zai': makeQuota({ kind: 'zai' }),
    })
    const tool = createProviderQuotaTool({ quotaService: service })

    const result = await tool.execute('call-1', { providerId: 'anthropic' })
    const text = getText(result)

    expect(text).toContain('anthropic')
    expect(text).not.toContain('**zai**')
    expect(getDetails(result).count).toBe(1)
  })

  it('returns message when no quota data is available', async () => {
    const tool = createProviderQuotaTool({ quotaService: makeService() })
    const result = await tool.execute('call-1', {})
    expect(getText(result)).toContain('No quota data available')
    expect(getDetails(result).count).toBe(0)
  })

  it('returns message when specific providerId has no quota', async () => {
    const service = makeService({ anthropic: makeQuota() })
    const tool = createProviderQuotaTool({ quotaService: service })

    const result = await tool.execute('call-1', { providerId: 'nonexistent' })
    expect(getText(result)).toContain('No quota data available')
    expect(getText(result)).toContain('nonexistent')
  })

  it('forces live refresh when refresh=true', async () => {
    const service: QuotaServiceLike = {
      getSnapshot: vi.fn(() => ({ anthropic: makeQuota() })),
      refreshProvider: vi.fn(async (id: string) => {
        expect(id).toBe('anthropic')
        return makeQuota({ fetchedAt: '2026-06-20T19:35:00Z' })
      }),
    }
    const tool = createProviderQuotaTool({ quotaService: service })

    const result = await tool.execute('call-1', { providerId: 'anthropic', refresh: true })
    const text = getText(result)

    expect(text).toContain('19:35:00Z')
    expect(getDetails(result).refreshed).toBe(true)
    expect(service.refreshProvider).toHaveBeenCalledWith('anthropic')
  })

  it('refreshes every known provider when providerId is omitted', async () => {
    const service: QuotaServiceLike = {
      getSnapshot: vi.fn(() => ({ anthropic: makeQuota(), zai: makeQuota({ kind: 'zai' }) })),
      refreshProvider: vi.fn(async () => makeQuota({ fetchedAt: '2026-06-20T19:40:00Z' })),
    }
    const tool = createProviderQuotaTool({ quotaService: service })

    const result = await tool.execute('call-1', { refresh: true })

    expect(service.refreshProvider).toHaveBeenCalledWith('anthropic')
    expect(service.refreshProvider).toHaveBeenCalledWith('zai')
    expect(getDetails(result).refreshed).toBe(true)
    expect(getDetails(result).count).toBe(2)
  })

  it('throttles repeated live refreshes of the same provider', async () => {
    let clock = 1_000
    const service = makeService({ anthropic: makeQuota() })
    service.refreshProvider = vi.fn(async () => makeQuota({ fetchedAt: '2026-06-20T19:45:00Z' }))
    const tool = createProviderQuotaTool({ quotaService: service, now: () => clock })

    await tool.execute('call-1', { providerId: 'anthropic', refresh: true })
    clock += 30_000
    const throttledResult = await tool.execute('call-2', { providerId: 'anthropic', refresh: true })

    expect(service.refreshProvider).toHaveBeenCalledTimes(1)
    expect(getText(throttledResult)).toContain('live refresh skipped')
    expect(getDetails(throttledResult).throttled).toEqual(['anthropic'])
    expect(getDetails(throttledResult).refreshed).toBe(false)

    clock += 31_000
    await tool.execute('call-3', { providerId: 'anthropic', refresh: true })
    expect(service.refreshProvider).toHaveBeenCalledTimes(2)
  })

  it('includes the plan label in the formatted output', async () => {
    const tool = createProviderQuotaTool({ quotaService: makeService({ anthropic: makeQuota({ plan: 'Max' }) }) })

    expect(getText(await tool.execute('call-1', {}))).toContain('plan: Max')
  })

  it('refuses to answer when the caller is not authorized', async () => {
    const service = makeService({ anthropic: makeQuota() })
    const tool = createProviderQuotaTool({ quotaService: service, isAuthorized: () => false })

    const result = await tool.execute('call-1', {})

    expect(getText(result)).toContain('admin users')
    expect(getDetails(result).forbidden).toBe(true)
    expect(service.getSnapshot).not.toHaveBeenCalled()
  })

  it('handles refresh returning null', async () => {
    const service = makeService({})
    const tool = createProviderQuotaTool({ quotaService: service })

    const result = await tool.execute('call-1', { providerId: 'gone', refresh: true })
    expect(getText(result)).toContain('No quota data available')
    expect(getDetails(result).error).toBe(true)
  })

  it('formats error state in quota', async () => {
    const service = makeService({
      anthropic: makeQuota({ error: 'Token expired', windows: [] }),
    })
    const tool = createProviderQuotaTool({ quotaService: service })

    const result = await tool.execute('call-1', {})
    expect(getText(result)).toContain('Error: Token expired')
  })

  it('catches unexpected errors from the service', async () => {
    const service: QuotaServiceLike = {
      getSnapshot: vi.fn(() => { throw new Error('DB connection lost') }),
      refreshProvider: vi.fn(),
    }
    const tool = createProviderQuotaTool({ quotaService: service })

    const result = await tool.execute('call-1', {})
    expect(getText(result)).toContain('Error fetching quota data')
    expect(getText(result)).toContain('DB connection lost')
    expect(getDetails(result).error).toBe(true)
  })
})
