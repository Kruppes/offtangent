/**
 * Renders the REAL `layouts/default.vue` (script and template) with Vue's SSR
 * renderer. Only the surroundings are stubbed: Nuxt runtime globals, the
 * shell child components and the email/shortcut helpers. The quota chain is
 * real end to end: layout script -> useTopBarQuota -> resolveTopBarQuota ->
 * topBarBalanceOf / useQuotaFormat -> quota block markup. So a layout that
 * reads the global quota directly, or couples the balance to it, renders the
 * wrong provider here and fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import { quotaByProvider, type ActiveStrandProvider } from '~/utils/topBarQuota'
import { useQuotaFormat } from '~/composables/useQuotaFormat'
import { installTopBarQuotaGlobals } from '~/test-support/topBarQuotaHarness'
import en from '~/i18n/locales/en.json'

vi.mock('~/api/models', () => ({ useModelsApi: () => ({ listModels: () => new Promise(() => {}) }) }))
vi.mock('~/api/email', () => ({ useEmailApi: () => ({ isConfigured: async () => ({ configured: false }) }) }))
vi.mock('~/composables/useShortcuts', () => ({ onShortcut: () => {} }))
vi.mock('~/composables/useShellLayout', () => ({
  useShellLayout: () => ({
    effectiveMode: ref('full'), sidebarMode: ref('full'), toggleSidebarCompact: () => {}, toggleSidebarHidden: () => {},
  }),
}))
vi.mock('@vueuse/core', () => ({ useMediaQuery: () => ref(false) }))
vi.mock('~/components/shell/AppVersionLabel.vue', () => ({ default: defineComponent({ render: () => null }) }))
vi.mock('~/components/shell/SidebarStateIcon.vue', () => ({ default: defineComponent({ render: () => null }) }))

const Layout = (await import('./default.vue')).default

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
const GLOBAL = {
  anthropic: { globalProviderName: 'Anthropic', globalQuota: anthropicQuota },
  moonshot: { globalProviderName: 'Moonshot_API', globalQuota: moonshotQuota },
}

function translate(key: string, params?: Record<string, unknown>): string {
  if (key === 'providers.quota.balance') return en.providers.quota.balance.replace('{amount}', String(params?.amount))
  return key
}

/** Pass-through stub for the auto-imported UI components: renders their default slot only. */
const Passthrough = defineComponent({ setup: (_props, { slots }) => () => h('div', slots.default?.()) })
const AUTO_COMPONENTS = [
  'AppIcon', 'AppLogo', 'CommandPalette', 'DropdownMenu', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuLabel',
  'DropdownMenuSeparator', 'DropdownMenuSub', 'DropdownMenuSubContent', 'DropdownMenuSubTrigger', 'DropdownMenuTrigger',
  'PageHeader', 'ShellNavigation', 'ShortcutHelp', 'Tooltip', 'TooltipContent', 'TooltipTrigger', 'NuxtLink',
]

async function renderLayout(input: {
  role?: 'admin' | 'user'
  /** Strand open in the route; defaults to the strand of `strand`. */
  routeStrandId?: string | null
  strand: ActiveStrandProvider | null
  global: { globalProviderName: string, globalQuota: ProviderQuotaContract }
}): Promise<string> {
  const routeStrandId = input.routeStrandId !== undefined ? input.routeStrandId : input.strand?.strandId ?? null
  installTopBarQuotaGlobals({
    role: input.role ?? 'admin',
    path: routeStrandId ? `/strands/${routeStrandId}` : '/',
    params: routeStrandId ? { id: routeStrandId } : {},
    activeStrand: input.strand,
    strandQuotas,
    ...input.global,
  })
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { appVersion: '0.0.0', buildSha: '' } }))
  vi.stubGlobal('useTheme', () => ({ isDark: ref(false), toggle: () => {} }))
  vi.stubGlobal('useUserAvatar', () => ({ userAvatarUrl: ref(null), avatarFailed: ref(false), userInitial: ref('A'), onAvatarError: () => {} }))
  vi.stubGlobal('useI18n', () => ({ t: translate, locale: ref('en'), locales: ref([]), setLocale: async () => {} }))
  vi.stubGlobal('useQuotaFormat', useQuotaFormat)
  const app = createSSRApp(Layout)
  app.config.globalProperties.$t = translate as unknown as typeof app.config.globalProperties.$t
  for (const name of AUTO_COMPONENTS) app.component(name, Passthrough)
  return await renderToString(app)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('layouts/default.vue top-bar quota (real layout)', () => {
  it('strand on a Moonshot API key: its balance with its label, not the global Anthropic windows', async () => {
    const html = await renderLayout({ strand: { strandId: 's1', providerId: 'moonshot' }, global: GLOBAL.anthropic })
    expect(html).toContain('data-testid="topbar-quota"')
    expect(html).toMatch(/data-testid="topbar-quota-balance"[^>]*>Balance \$13\.51</)
    expect(html).toContain('Moonshot_API')
    expect(html).not.toContain('5h:')
    expect(html).not.toContain('7d:')
    expect(html).not.toContain('Anthropic')
  })

  it('strand on Anthropic: its windows, never the global Moonshot balance', async () => {
    const html = await renderLayout({ strand: { strandId: 's1', providerId: 'anthropic' }, global: GLOBAL.moonshot })
    expect(html).toContain('5h: 40%')
    expect(html).toContain('7d: 10%')
    expect(html).not.toContain('topbar-quota-balance')
    expect(html).not.toContain('Balance')
    expect(html).not.toContain('Moonshot_API')
  })

  it('strand provider without quota: no block at all, not the global balance', async () => {
    const html = await renderLayout({ strand: { strandId: 's1', providerId: 'openrouter' }, global: GLOBAL.moonshot })
    expect(html).not.toContain('topbar-quota')
    expect(html).not.toContain('Balance')
  })

  it('strand whose provider is not resolved yet, or a stale entry of another strand: nothing, not the global quota', async () => {
    const pending = await renderLayout({ routeStrandId: 's1', strand: null, global: GLOBAL.moonshot })
    expect(pending).not.toContain('topbar-quota')
    vi.unstubAllGlobals()
    const stale = await renderLayout({ routeStrandId: 's2', strand: { strandId: 's1', providerId: 'moonshot' }, global: GLOBAL.anthropic })
    expect(stale).not.toContain('topbar-quota')
  })

  it('outside a strand: the global default stays (balance and windows)', async () => {
    const moonshot = await renderLayout({ strand: null, global: GLOBAL.moonshot })
    expect(moonshot).toContain('Balance $13.51')
    expect(moonshot).toContain('Moonshot_API')
    vi.unstubAllGlobals()
    const anthropic = await renderLayout({ strand: null, global: GLOBAL.anthropic })
    expect(anthropic).toContain('5h: 40%')
    expect(anthropic).not.toContain('Balance')
  })

  it('members never see the quota block', async () => {
    const onStrand = await renderLayout({ role: 'user', strand: { strandId: 's1', providerId: 'moonshot' }, global: GLOBAL.anthropic })
    expect(onStrand).not.toContain('topbar-quota')
    vi.unstubAllGlobals()
    const outside = await renderLayout({ role: 'user', strand: null, global: GLOBAL.moonshot })
    expect(outside).not.toContain('topbar-quota')
    expect(outside).not.toContain('Balance')
  })
})
