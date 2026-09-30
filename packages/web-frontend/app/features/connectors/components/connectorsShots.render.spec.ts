/**
 * Not a gate: renders the four documented states of `/connectors` to static
 * HTML in `SHOT_DIR` so the screenshot script can style and photograph them.
 * Skipped unless SHOT_DIR is set, so a normal `vitest run` ignores it.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import fs from 'node:fs'
import path from 'node:path'
import en from '~/i18n/locales/en.json'
import de from '~/i18n/locales/de.json'
import type { Connector } from '~/api/connectors'
import ConnectorsWorkspace from './ConnectorsWorkspace.vue'

const shotDir = process.env.SHOT_DIR ?? ''

const state = vi.hoisted(() => ({
  connectors: [] as unknown[],
  loading: false,
  error: null as string | null,
  baseUrl: 'https://instance.example',
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
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

/** Mirrors `GOOGLE_SETUP_STEPS` of the core manifest as the server projects it. */
const GOOGLE_SETUP_STEPS: Connector['setupSteps'] = [
  { id: 'project', url: 'https://console.cloud.google.com/projectcreate', copy: '' },
  { id: 'enable-gmail', url: 'https://console.cloud.google.com/apis/enableflow;apiid=gmail.googleapis.com', copy: '' },
  { id: 'enable-calendar', url: 'https://console.cloud.google.com/apis/enableflow;apiid=calendar-json.googleapis.com', copy: '' },
  { id: 'branding', url: 'https://console.cloud.google.com/auth/branding', copy: '' },
  { id: 'audience', url: 'https://console.cloud.google.com/auth/audience', copy: '' },
  { id: 'scopes', url: 'https://console.cloud.google.com/auth/scopes', copy: 'scopes' },
  { id: 'client', url: 'https://console.cloud.google.com/auth/clients', copy: 'redirectUri' },
  { id: 'credentials', url: '', copy: '' },
]

/**
 * The shots use the registered `google` connector: only then do the setup steps
 * resolve to their real sentences from the locale files instead of raw keys.
 */
function connector(overrides: Partial<Connector>): Connector {
  return {
    id: 'google',
    name: 'Google (Mail & Calendar)',
    description: 'Read-only access to mail and calendar of one Google account, for the local sub-agent.',
    auth: 'oauth2',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
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
    redirectUri: 'https://instance.example/api/connectors/google/callback',
    setupSteps: GOOGLE_SETUP_STEPS,
    ...overrides,
  }
}

const dictionaries: Record<string, Record<string, unknown>> = { en, de }

/** Resolves an i18n key against the real locale files, so the shots read like the app. */
function translate(locale: string, key: string): string {
  const parts = key.split('.')
  let current: unknown = dictionaries[locale]
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return key
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current === 'string' ? current : key
}

async function render(locale: string): Promise<string> {
  const app = createSSRApp(ConnectorsWorkspace)
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  app.component('AppIcon', defineComponent({ props: ['name'], setup: () => () => h('span', { class: 'inline-block h-4 w-4 rounded-sm bg-current opacity-60' }) }))
  app.component('PageHeader', defineComponent({
    props: ['title', 'subtitle'],
    setup: props => () => h('header', { class: 'border-b border-border bg-card px-4 py-4 md:px-6' }, [
      h('h1', { class: 'text-lg font-semibold text-foreground' }, props.title),
      h('p', { class: 'mt-1 text-sm text-muted-foreground' }, props.subtitle),
    ]),
  }))
  app.config.globalProperties.$t = ((key: string) => translate(locale, key)) as never
  return renderToString(app)
}

const scenarios: { name: string; apply: () => void }[] = [
  {
    name: 'not-configured',
    apply: () => {
      state.loading = false
      state.error = null
      state.connectors = [connector({})]
    },
  },
  {
    name: 'connected',
    apply: () => {
      state.error = null
      state.connectors = [connector({
        status: 'connected',
        clientId: 'client-id-from-the-provider',
        clientSecretSet: true,
        clientSecretMasked: 'clie••••••••6789',
        scopesGranted: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
        connectedAt: '2026-09-26T20:15:00.000Z',
      })]
    },
  },
  {
    name: 'reauth-required',
    apply: () => {
      state.error = null
      state.connectors = [connector({
        status: 'reauth_required',
        clientId: 'client-id-from-the-provider',
        clientSecretSet: true,
        clientSecretMasked: 'clie••••••••6789',
        lastError: 'reauth_required',
      })]
    },
  },
  {
    name: 'error',
    apply: () => {
      state.error = 'The connections could not be loaded (HTTP 503).'
      state.connectors = [connector({
        status: 'error',
        clientId: 'client-id-from-the-provider',
        clientSecretSet: true,
        clientSecretMasked: 'clie••••••••6789',
        lastError: 'refresh_failed',
      })]
    },
  },
]

describe.skipIf(!shotDir)('connectors screenshot fixtures', () => {
  for (const scenario of scenarios) {
    it(`renders ${scenario.name}`, async () => {
      scenario.apply()
      for (const locale of ['de', 'en']) {
        const html = await render(locale)
        expect(html).toContain('connector-google-name')
        fs.mkdirSync(shotDir, { recursive: true })
        fs.writeFileSync(path.join(shotDir, `${scenario.name}.${locale}.html`), html)
      }
    })
  }
})
