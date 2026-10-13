/**
 * Test harness for the top-bar quota: stands in for the Nuxt runtime pieces
 * `useTopBarQuota` and `layouts/default.vue` read (route, auth, useState,
 * connection status, Vue auto-imports) so the REAL composable and the REAL
 * layout can run in vitest without booting Nuxt. Test-only; nothing in the
 * app imports it.
 */
import { vi } from 'vitest'
import * as Vue from 'vue'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import type { ActiveStrandProvider, TopBarQuotaSource } from '~/utils/topBarQuota'

export interface QuotaHarnessInput {
  role: 'admin' | 'user' | null
  path: string
  params?: Record<string, unknown>
  globalProviderName?: string | null
  globalQuota?: ProviderQuotaContract | null
  activeStrand?: ActiveStrandProvider | null
  strandQuotas?: Record<string, TopBarQuotaSource>
}

/** Installs the globals; returns the live state the test can drive. */
export function installTopBarQuotaGlobals(input: QuotaHarnessInput) {
  const store = new Map<string, Vue.Ref<unknown>>()
  const useState = <T>(key: string, init?: () => T): Vue.Ref<T> => {
    if (!store.has(key)) store.set(key, Vue.ref(init ? init() : null))
    return store.get(key) as Vue.Ref<T>
  }
  if (input.activeStrand !== undefined) useState('active_strand_provider', () => input.activeStrand)
  if (input.strandQuotas !== undefined) useState('strand_provider_quotas', () => input.strandQuotas)

  const route = Vue.reactive({ path: input.path, params: input.params ?? {} as Record<string, unknown> })
  const user = Vue.ref(input.role ? { id: 1, username: input.role, role: input.role } : null)
  const globalProviderName = useState<string | null>('global_provider_name', () => input.globalProviderName ?? null)
  const globalQuota = useState<ProviderQuotaContract | null>('global_quota', () => input.globalQuota ?? null)

  for (const name of ['ref', 'computed', 'reactive', 'watch', 'watchEffect', 'onMounted', 'onUnmounted', 'onBeforeUnmount', 'nextTick'] as const) {
    vi.stubGlobal(name, Vue[name])
  }
  vi.stubGlobal('useState', useState)
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useAuth', () => ({ user, isAuthenticated: Vue.computed(() => !!user.value), logout: async () => {} }))
  vi.stubGlobal('useConnectionStatus', () => ({
    status: Vue.ref('healthy'),
    providerName: globalProviderName,
    operatingMode: Vue.ref('normal'),
    fallbackProviderName: Vue.ref(null),
    healthMonitorEnabled: Vue.ref(true),
    quota: globalQuota,
    start: () => {},
    stop: () => {},
  }))

  return { route, user, store, useState, globalProviderName, globalQuota }
}

/**
 * A minimal non-DOM renderer, so a component can really mount and unmount
 * (lifecycle hooks run) in the node test environment.
 */
export function createHeadlessApp(component: Vue.Component) {
  interface Node { children: Node[] }
  const renderer = Vue.createRenderer<Node, Node>({
    createElement: () => ({ children: [] }),
    createText: () => ({ children: [] }),
    createComment: () => ({ children: [] }),
    insert: () => {},
    remove: () => {},
    setText: () => {},
    setElementText: () => {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp: () => {},
  })
  const app = renderer.createApp(component)
  return {
    mount: () => app.mount({ children: [] }),
    unmount: () => app.unmount(),
  }
}
