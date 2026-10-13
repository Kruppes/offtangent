import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import { quotaByProvider, resolveTopBarQuota, strandIdOfRoute, topBarBalanceOf, type TopBarQuotaSource } from './topBarQuota'
import { useQuotaFormat } from '~/composables/useQuotaFormat'

const anthropicQuota: ProviderQuotaContract = {
  kind: 'anthropic',
  windows: [
    { key: 'five_hour', label: '5h', utilization: 40, resetsAt: null, resetDisplay: 'relative' },
    { key: 'seven_day', label: '7d', utilization: 10, resetsAt: null, resetDisplay: 'absolute' },
  ],
  fetchedAt: '2026-01-01T10:00:00.000Z',
}

/** Shape of the Kimi subscription quota: 5h + month + month (code). */
const kimiQuota: ProviderQuotaContract = {
  kind: 'kimi-coding',
  windows: [
    { key: 'five_hour', label: '5h', utilization: 12, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), resetDisplay: 'relative' },
    { key: 'month_total', label: 'Month', utilization: 75, resetsAt: new Date(Date.now() + 20 * 86400_000).toISOString(), resetDisplay: 'absolute' },
    { key: 'month_code', label: 'Month (code)', utilization: 93, resetsAt: new Date(Date.now() + 20 * 86400_000).toISOString(), resetDisplay: 'absolute' },
  ],
  fetchedAt: '2026-01-01T10:00:00.000Z',
}

const global: TopBarQuotaSource = { providerId: null, providerName: 'Anthropic', quota: anthropicQuota }
const strandQuotas = quotaByProvider([
  { providerId: 'kimi', providerName: 'Kimi_Subscription', quota: kimiQuota },
  { providerId: 'kimi', providerName: 'Kimi_Subscription', quota: null },
  { providerId: 'anthropic', providerName: 'Anthropic', quota: anthropicQuota },
  { providerId: 'openrouter', providerName: 'OpenRouter', quota: null },
  { providerId: 'broken', providerName: 'Broken', quota: { ...kimiQuota, windows: [], error: 'rate limited' } },
])

describe('strandIdOfRoute', () => {
  it('recognises only the strand detail route', () => {
    expect(strandIdOfRoute('/strands/s1', { id: 's1' })).toBe('s1')
    expect(strandIdOfRoute('/strands', {})).toBeNull()
    expect(strandIdOfRoute('/providers', {})).toBeNull()
    expect(strandIdOfRoute('/chat/x', { id: 'x' })).toBeNull()
  })
})

describe('quotaByProvider', () => {
  it('keeps one entry per provider (first model wins)', () => {
    expect(Object.keys(strandQuotas).sort()).toEqual(['anthropic', 'broken', 'kimi', 'openrouter'])
    expect(strandQuotas.kimi).toEqual({ providerId: 'kimi', providerName: 'Kimi_Subscription', quota: kimiQuota })
  })
})

describe('resolveTopBarQuota', () => {
  it('shows the global default provider outside a strand', () => {
    expect(resolveTopBarQuota({ routeStrandId: null, activeStrand: null, strandQuotas, global })).toBe(global)
    // A stale strand entry from a strand that was just left does not leak out.
    expect(resolveTopBarQuota({ routeStrandId: null, activeStrand: { strandId: 's1', providerId: 'kimi' }, strandQuotas, global })).toBe(global)
  })

  it('shows the quota of the strand provider, not the global one', () => {
    const shown = resolveTopBarQuota({ routeStrandId: 's1', activeStrand: { strandId: 's1', providerId: 'kimi' }, strandQuotas, global })
    expect(shown?.providerName).toBe('Kimi_Subscription')
    expect(shown?.quota).toBe(kimiQuota)
  })

  it('shows nothing when the strand provider has no subscriber quota', () => {
    expect(resolveTopBarQuota({ routeStrandId: 's1', activeStrand: { strandId: 's1', providerId: 'openrouter' }, strandQuotas, global })).toBeNull()
    expect(resolveTopBarQuota({ routeStrandId: 's1', activeStrand: { strandId: 's1', providerId: 'unknown' }, strandQuotas, global })).toBeNull()
  })

  it('never falls back to the global quota when the strand provider quota is empty', () => {
    const shown = resolveTopBarQuota({ routeStrandId: 's1', activeStrand: { strandId: 's1', providerId: 'empty' }, strandQuotas: { ...strandQuotas, empty: { providerId: 'empty', providerName: 'Empty', quota: { ...kimiQuota, windows: [] } } }, global })
    expect(shown?.providerName).toBe('Empty')
    expect(useQuotaFormat().quotaWindowParts(shown!.quota!)).toEqual([])
  })

  it('shows nothing when the strand provider quota failed', () => {
    expect(resolveTopBarQuota({ routeStrandId: 's1', activeStrand: { strandId: 's1', providerId: 'broken' }, strandQuotas, global })).toBeNull()
  })

  it('shows nothing while the strand provider is not resolved yet or belongs to another strand', () => {
    expect(resolveTopBarQuota({ routeStrandId: 's1', activeStrand: null, strandQuotas, global })).toBeNull()
    expect(resolveTopBarQuota({ routeStrandId: 's2', activeStrand: { strandId: 's1', providerId: 'kimi' }, strandQuotas, global })).toBeNull()
  })

  it('hides a global quota with an error, as before', () => {
    expect(resolveTopBarQuota({ routeStrandId: null, activeStrand: null, strandQuotas, global: { ...global, quota: { ...anthropicQuota, error: 'x' } } })).toBeNull()
    expect(resolveTopBarQuota({ routeStrandId: null, activeStrand: null, strandQuotas, global: { ...global, quota: null } })).toBeNull()
  })

  it('renders all three Kimi windows (5h, month, month code)', () => {
    const shown = resolveTopBarQuota({ routeStrandId: 's1', activeStrand: { strandId: 's1', providerId: 'kimi' }, strandQuotas, global })
    const parts = useQuotaFormat().quotaWindowParts(shown!.quota!)
    expect(parts.map(p => [p.key, p.label, p.utilization, p.colorClass])).toEqual([
      ['five_hour', '5h', 12, 'text-success'],
      ['month_total', 'Month', 75, 'text-warning'],
      ['month_code', 'Month (code)', 93, 'text-destructive'],
    ])
    expect(parts[0]!.reset).toMatch(/^\dh \d+m$/)
    expect(parts[1]!.reset).not.toBe('')
    expect(parts[2]!.reset).not.toBe('')
  })
})

describe('prepaid balance follows the strand provider (Moonshot API key)', () => {
  /** Balance-only quota of a Moonshot platform API key: no usage windows. */
  const moonshotQuota: ProviderQuotaContract = {
    kind: 'moonshot',
    windows: [],
    balance: { amount: 13.505731, currency: 'USD', cash: 13.505731, voucher: 0 },
    fetchedAt: '2026-01-01T10:00:00.000Z',
  }
  const quotas = quotaByProvider([
    { providerId: 'moonshot', providerName: 'Moonshot_API', quota: moonshotQuota },
    { providerId: 'anthropic', providerName: 'Anthropic', quota: anthropicQuota },
    { providerId: 'openrouter', providerName: 'OpenRouter', quota: null },
  ])
  const globalMoonshot: TopBarQuotaSource = { providerId: null, providerName: 'Moonshot_API', quota: moonshotQuota }
  const strand = (providerId: string, globalSource: TopBarQuotaSource = global) =>
    resolveTopBarQuota({ routeStrandId: 's1', activeStrand: { strandId: 's1', providerId }, strandQuotas: quotas, global: globalSource })

  it('a strand on the Moonshot key shows its balance, even though the global default is Anthropic', () => {
    const shown = strand('moonshot')
    expect(shown?.providerName).toBe('Moonshot_API')
    expect(topBarBalanceOf(shown)).toEqual(moonshotQuota.balance)
    expect(useQuotaFormat().quotaWindowParts(shown!.quota!)).toEqual([])
    expect(useQuotaFormat().formatBalanceAmount(topBarBalanceOf(shown), 'en')).toBe('$13.51')
  })

  it('a strand on Anthropic shows the Anthropic windows and no balance, even though the global default is Moonshot', () => {
    const shown = strand('anthropic', globalMoonshot)
    expect(shown?.providerName).toBe('Anthropic')
    expect(topBarBalanceOf(shown)).toBeNull()
    expect(useQuotaFormat().quotaWindowParts(shown!.quota!).map(p => p.key)).toEqual(['five_hour', 'seven_day'])
  })

  it('a strand provider without quota shows neither its own nor the global balance', () => {
    expect(strand('openrouter', globalMoonshot)).toBeNull()
    expect(topBarBalanceOf(strand('openrouter', globalMoonshot))).toBeNull()
  })

  it('outside a strand the global default balance stays', () => {
    const shown = resolveTopBarQuota({ routeStrandId: null, activeStrand: { strandId: 's1', providerId: 'anthropic' }, strandQuotas: quotas, global: globalMoonshot })
    expect(topBarBalanceOf(shown)).toEqual(moonshotQuota.balance)
  })

  it('shows windows, not a balance, when a quota carries both; nothing for a failed one', () => {
    expect(topBarBalanceOf({ providerId: 'x', providerName: 'X', quota: { ...anthropicQuota, balance: moonshotQuota.balance } })).toBeNull()
    expect(topBarBalanceOf({ providerId: 'x', providerName: 'X', quota: { ...moonshotQuota, error: 'rate limited' } })).toBeNull()
    expect(topBarBalanceOf(null)).toBeNull()
  })
})

describe('wiring', () => {
  const app = path.resolve(__dirname, '..')
  const layout = readFileSync(path.join(app, 'layouts/default.vue'), 'utf8')
  const header = readFileSync(path.join(app, 'features/strands/StrandDetailHeader.vue'), 'utf8')

  it('the top bar reads the strand-aware source, not the global quota directly', () => {
    expect(layout).toContain('useTopBarQuota()')
    expect(layout).not.toMatch(/globalQuota/)
    expect(layout).toContain('quotaTopBarProvider')
  })

  it('the balance reads the same strand-aware source', () => {
    expect(layout).toMatch(/topBarBalanceOf\(quotaTopBarSource\.value\)/)
  })

  it('the strand header publishes the provider of the model it shows', () => {
    expect(header).toMatch(/topBarProvider\.publish\(props\.strandId, providerId\)/)
    expect(header).toMatch(/displayedModel\.value\?\.providerId/)
    expect(header).toMatch(/topBarProvider\.release\(props\.strandId\)/)
  })
})
