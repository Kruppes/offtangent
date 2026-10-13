/**
 * Render check of the top-bar quota block of `layouts/default.vue`.
 *
 * The full layout needs the whole Nuxt runtime, so only its quota block (the
 * real template markup between "Subscriber quota" and "Spacer") is compiled
 * and rendered with Vue's SSR renderer. Its data come from the same pure
 * helpers the layout script uses (resolveTopBarQuota, quotaWindowParts,
 * topBarBalanceOf, formatBalanceAmount); the wiring test in
 * utils/topBarQuota.test.ts pins that the layout reads them from the
 * strand-aware source.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Vue from 'vue'
import { createSSRApp, computed, defineComponent, type RenderFunction } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compile } from '@vue/compiler-dom'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import { quotaByProvider, resolveTopBarQuota, topBarBalanceOf, type ActiveStrandProvider, type TopBarQuotaSource } from '~/utils/topBarQuota'
import { useQuotaFormat } from '~/composables/useQuotaFormat'
import en from '~/i18n/locales/en.json'

const layout = readFileSync(path.resolve(__dirname, 'default.vue'), 'utf8')
const start = layout.indexOf('<!-- Subscriber quota')
const end = layout.indexOf('<!-- Spacer -->', start)
const quotaBlock = layout.slice(start, end)
const render = new Function('Vue', compile(quotaBlock, { mode: 'function', prefixIdentifiers: true }).code)(Vue) as RenderFunction

const anthropicQuota: ProviderQuotaContract = {
  kind: 'anthropic',
  windows: [
    { key: 'five_hour', label: '5h', utilization: 40, resetsAt: null, resetDisplay: 'relative' },
    { key: 'seven_day', label: '7d', utilization: 10, resetsAt: null, resetDisplay: 'absolute' },
  ],
  fetchedAt: '2026-01-01T10:00:00.000Z',
}
const moonshotQuota: ProviderQuotaContract = {
  kind: 'moonshot',
  windows: [],
  balance: { amount: 13.505731, currency: 'USD', cash: 13.505731, voucher: 0 },
  fetchedAt: '2026-01-01T10:00:00.000Z',
}
const strandQuotas = quotaByProvider([
  { providerId: 'moonshot', providerName: 'Moonshot_API', quota: moonshotQuota },
  { providerId: 'anthropic', providerName: 'Anthropic', quota: anthropicQuota },
  { providerId: 'openrouter', providerName: 'OpenRouter', quota: null },
])

function t(key: string, params: Record<string, string>): string {
  expect(key).toBe('providers.quota.balance')
  return en.providers.quota.balance.replace('{amount}', params.amount!)
}

async function renderTopBar(input: { routeStrandId: string | null, activeStrand: ActiveStrandProvider | null, global: TopBarQuotaSource }): Promise<string> {
  const { quotaWindowParts, formatBalanceAmount } = useQuotaFormat()
  const Block = defineComponent({
    setup() {
      // Same derivation as layouts/default.vue.
      const quotaTopBarSource = computed(() => resolveTopBarQuota({ ...input, strandQuotas }))
      const quotaTopBarParts = computed(() => {
        const q = quotaTopBarSource.value?.quota
        if (!q || q.error) return []
        return quotaWindowParts(q)
      })
      const quotaTopBarProvider = computed(() => quotaTopBarSource.value?.providerName ?? '')
      const quotaTopBarBalance = computed(() => {
        const amount = formatBalanceAmount(topBarBalanceOf(quotaTopBarSource.value), 'en')
        return amount ? t('providers.quota.balance', { amount }) : ''
      })
      return { quotaTopBarParts, quotaTopBarProvider, quotaTopBarBalance }
    },
    render,
  })
  return renderToString(createSSRApp(Block))
}

const globalAnthropic: TopBarQuotaSource = { providerId: null, providerName: 'Anthropic', quota: anthropicQuota }
const globalMoonshot: TopBarQuotaSource = { providerId: null, providerName: 'Moonshot_API', quota: moonshotQuota }
const onStrand = (providerId: string) => ({ routeStrandId: 's1', activeStrand: { strandId: 's1', providerId } })

describe('top-bar quota block', () => {
  it('compiles the real quota block of the layout', () => {
    expect(quotaBlock).toContain('data-testid="topbar-quota"')
    expect(quotaBlock).toContain('quotaTopBarBalance')
  })

  it('strand on a Moonshot API key: shows its balance, no Anthropic windows', async () => {
    const html = await renderTopBar({ ...onStrand('moonshot'), global: globalAnthropic })
    expect(html).toContain('data-testid="topbar-quota"')
    expect(html).toContain('Moonshot_API')
    expect(html).toMatch(/data-testid="topbar-quota-balance"[^>]*>Balance \$13\.51</)
    expect(html).not.toContain('Anthropic')
    expect(html).not.toContain('5h:')
    expect(html).not.toContain('7d:')
  })

  it('strand on Anthropic: shows the Anthropic windows, no Moonshot balance', async () => {
    const html = await renderTopBar({ ...onStrand('anthropic'), global: globalMoonshot })
    expect(html).toContain('Anthropic')
    expect(html).toContain('5h: 40%')
    expect(html).toContain('7d: 10%')
    expect(html).not.toContain('Balance')
    expect(html).not.toContain('Moonshot_API')
    expect(html).not.toContain('topbar-quota-balance')
  })

  it('strand provider without quota: renders nothing, not the global balance', async () => {
    const html = await renderTopBar({ ...onStrand('openrouter'), global: globalMoonshot })
    expect(html).not.toContain('topbar-quota')
    expect(html).not.toContain('Balance')
    expect(html).not.toContain('Moonshot_API')
  })

  it('outside a strand: the global default balance stays', async () => {
    const html = await renderTopBar({ routeStrandId: null, activeStrand: null, global: globalMoonshot })
    expect(html).toContain('Moonshot_API')
    expect(html).toContain('Balance $13.51')
  })
})
