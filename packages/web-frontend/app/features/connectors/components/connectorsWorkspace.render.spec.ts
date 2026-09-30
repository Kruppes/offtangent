import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import type { Connector } from '~/api/connectors'
import ConnectorsWorkspace from './ConnectorsWorkspace.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const state = vi.hoisted(() => ({
  connectors: [] as unknown[],
  loading: false,
  error: null as string | null,
  baseUrl: 'https://instance.example',
}))

vi.mock('../composables/useConnectors', () => ({
  useConnectors: () => ({
    connectors: ref(state.connectors),
    baseUrl: ref(state.baseUrl),
    loading: ref(state.loading),
    loaded: ref(true),
    error: ref(state.error),
    busyId: ref(null),
    fetchConnectors: vi.fn(),
    saveClient: vi.fn(),
    connect: vi.fn(),
    testConnector: vi.fn(),
    disconnect: vi.fn(),
  }),
}))

export function makeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'sample',
    name: 'Sample service',
    description: 'Synthetic connector for tests.',
    auth: 'oauth2',
    scopes: ['sample.read'],
    dataClass: 'local_only',
    status: 'not_configured',
    clientId: '',
    clientSecretSet: false,
    clientSecretMasked: '',
    hasTest: true,
    scopesGranted: [],
    lastError: '',
    connectedAt: '',
    updatedAt: '',
    expiresAt: '',
    redirectUri: 'https://instance.example/api/connectors/sample/callback',
    setupSteps: [],
    ...overrides,
  }
}

const SETUP_STEPS = [
  { id: 'project', url: 'https://console.invalid/projectcreate', copy: '' as const },
  { id: 'scopes', url: 'https://console.invalid/scopes', copy: 'scopes' as const },
  { id: 'client', url: 'https://console.invalid/clients', copy: 'redirectUri' as const },
  { id: 'credentials', url: '', copy: '' as const },
]

async function render(): Promise<string> {
  const app = createSSRApp(ConnectorsWorkspace)
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  app.component('AppIcon', defineComponent({ setup: () => () => h('i') }))
  app.component('PageHeader', defineComponent({ props: ['title', 'subtitle'], setup: props => () => h('header', [props.title, props.subtitle]) }))
  app.config.globalProperties.$t = ((key: string) => key) as never
  return renderToString(app)
}

describe('connectors workspace', () => {
  it('shows the loading state before the first list arrives', async () => {
    state.connectors = []
    state.loading = true
    const html = await render()
    expect(html).toContain('connectors.loading')
    expect(html).toContain('role="status"')
  })

  it('shows the empty state when the registry is empty', async () => {
    state.connectors = []
    state.loading = false
    const html = await render()
    expect(html).toContain('connectors.empty')
  })

  it('offers a recovery action on error', async () => {
    state.error = 'Network request failed'
    const html = await render()
    expect(html).toContain('Network request failed')
    expect(html).toContain('common.retry')
    state.error = null
  })

  it('renders status and "local only" badges plus the redirect uri', async () => {
    state.connectors = [makeConnector()]
    const html = await render()
    expect(html).toContain('connectors.status.not_configured')
    expect(html).toContain('connectors.localOnly')
    expect(html).toContain('https://instance.example/api/connectors/sample/callback')
    expect(html).toContain('connectors.actions.connect')
    expect(html).toContain('connectors.actions.saveClient')
  })

  it('labels every input and marks the redirect uri read-only', async () => {
    state.connectors = [makeConnector()]
    const html = await render()
    for (const id of ['client-id-sample', 'client-secret-sample', 'redirect-uri-sample']) {
      expect(html).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).toMatch(/id="redirect-uri-sample"[^>]*readonly/)
  })

  it('never renders a client secret, only its mask', async () => {
    state.connectors = [makeConnector({
      status: 'connected',
      clientId: 'client-id-1',
      clientSecretSet: true,
      clientSecretMasked: 'clie••••••••6789',
    })]
    const html = await render()
    expect(html).toContain('clie••••••••6789')
    expect(html).toContain('connectors.status.connected')
    expect(html).toContain('type="password"')
    expect(html).toContain('connectors.actions.reconnect')
  })

  it('opens the setup checklist of a not_configured connector', async () => {
    state.connectors = [makeConnector({ setupSteps: SETUP_STEPS })]
    const html = await render()
    expect(html).toContain('connectors.setup.heading')
    expect(html).toContain('aria-controls="setup-steps-sample"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toMatch(/<ol[^>]*id="setup-steps-sample"/)
    expect(html).not.toMatch(/id="setup-steps-sample"[^>]*display:none/)
    for (const step of SETUP_STEPS) {
      expect(html).toContain(`connectors.setup.sample.${step.id}.title`)
      expect(html).toContain(`connectors.setup.sample.${step.id}.body`)
    }
  })

  it('links every step target in a new tab without giving it window access', async () => {
    state.connectors = [makeConnector({ setupSteps: SETUP_STEPS })]
    const html = await render()
    const links = [...html.matchAll(/<a [^>]*href="(https:\/\/console\.invalid[^"]*)"[^>]*>/g)]
    expect(links).toHaveLength(3)
    for (const [tag] of links) {
      expect(tag).toContain('target="_blank"')
      expect(tag).toContain('rel="noopener noreferrer"')
      expect(tag).toContain('min-h-11')
    }
  })

  it('offers a copy button per step that carries a value', async () => {
    state.connectors = [makeConnector({ setupSteps: SETUP_STEPS })]
    const html = await render()
    expect(html).toContain('connectors.setup.copyScopes')
    expect(html).toContain('connectors.setup.copyRedirectUri')
  })

  it('keeps the setup checklist collapsed for a connected connector', async () => {
    state.connectors = [makeConnector({
      status: 'connected',
      clientId: 'client-id-1',
      clientSecretSet: true,
      setupSteps: SETUP_STEPS,
    })]
    const html = await render()
    expect(html).toContain('connectors.setup.heading')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/id="setup-steps-sample"[^>]*style="display:none;?"/)
  })

  it('replaces the redirect uri copy button with the configuration hint when there is no base url', async () => {
    state.connectors = [makeConnector({ redirectUri: '', setupSteps: SETUP_STEPS })]
    const html = await render()
    expect(html).toContain('data-testid="setup-redirect-uri-missing"')
    expect(html).not.toContain('connectors.setup.copyRedirectUri')
    expect(html).toContain('connectors.setup.copyScopes')
  })

  it('renders no setup block for a connector without a checklist', async () => {
    state.connectors = [makeConnector()]
    const html = await render()
    expect(html).not.toContain('connectors.setup.heading')
    expect(html).not.toContain('setup-steps-sample')
  })

  it('explains a reauth_required connector', async () => {
    state.connectors = [makeConnector({ status: 'reauth_required', clientSecretSet: true, clientId: 'client-id-1' })]
    const html = await render()
    expect(html).toContain('connectors.status.reauth_required')
    expect(html).toContain('connectors.reauthHint')
  })

  it('shows the mapped reason of an errored connector', async () => {
    state.connectors = [makeConnector({ status: 'error', lastError: 'refresh_failed', clientSecretSet: true })]
    const html = await render()
    expect(html).toContain('connectors.status.error')
    expect(html).toContain('connectors.errorReason.refresh_failed')
  })
})
