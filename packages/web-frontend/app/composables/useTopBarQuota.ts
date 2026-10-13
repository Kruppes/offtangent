/**
 * Subscriber quota for the top bar, following the open strand.
 *
 * The strand owns its model (pin, else persona/global default), so on
 * `/strands/:id` the bar shows the quota of THAT strand's provider. The strand
 * header publishes the provider it resolved (`useActiveStrandProvider`); the
 * per-provider quota comes from `/api/models`, which already carries the quota
 * monitor snapshot per provider. Outside a strand the global default
 * provider's quota from `/api/health` stays in place.
 */
import { useModelsApi } from '~/api/models'
import {
  quotaByProvider,
  resolveTopBarQuota,
  strandIdOfRoute,
  type ActiveStrandProvider,
  type TopBarQuotaSource,
} from '~/utils/topBarQuota'

const STRAND_QUOTA_POLL_MS = 60_000

function activeStrandState() {
  return useState<ActiveStrandProvider | null>('active_strand_provider', () => null)
}

/**
 * Used by the strand header (call in setup): `publish` whenever the model it
 * shows changes, `release` when it goes away. `release` leaves a newer
 * strand's entry alone.
 */
export function useActiveStrandProvider() {
  const state = activeStrandState()
  return {
    publish(strandId: string, providerId: string | null) {
      state.value = providerId ? { strandId, providerId } : null
    },
    release(strandId: string) {
      if (state.value?.strandId === strandId) state.value = null
    },
  }
}

export function useTopBarQuota() {
  const route = useRoute()
  const { user } = useAuth()
  const modelsApi = useModelsApi()
  const { providerName: globalProviderName, quota: globalQuota } = useConnectionStatus()
  const activeStrand = activeStrandState()
  const strandQuotas = useState<Record<string, TopBarQuotaSource>>('strand_provider_quotas', () => ({}))

  const routeStrandId = computed(() => strandIdOfRoute(route.path, route.params as Record<string, unknown>))
  /** Same audience as the global indicator, which only admins ever saw. */
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function refresh() {
    if (!isAdmin.value || !routeStrandId.value) return
    try { strandQuotas.value = quotaByProvider(await modelsApi.listModels()) }
    catch { /* keep the last snapshot; a failed poll must not blank or swap the bar */ }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  function start() {
    if (timer) return
    timer = setInterval(() => { void refresh() }, STRAND_QUOTA_POLL_MS)
  }
  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }
  // Re-read when the strand or its provider changes (e.g. a new pin).
  watch(
    () => [routeStrandId.value, activeStrand.value?.providerId, isAdmin.value] as const,
    ([strandId, , admin]) => {
      if (strandId && admin) { void refresh(); start() }
      else stop()
    },
    { immediate: true },
  )
  onUnmounted(stop)

  const source = computed(() => {
    if (!isAdmin.value) return null
    return resolveTopBarQuota({
      routeStrandId: routeStrandId.value,
      activeStrand: activeStrand.value,
      strandQuotas: strandQuotas.value,
      global: { providerId: null, providerName: globalProviderName.value, quota: globalQuota.value as TopBarQuotaSource['quota'] },
    })
  })

  return { source }
}
