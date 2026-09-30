/**
 * Global connection & provider health status.
 *
 * Polls /api/health periodically and exposes a combined status
 * for the header status indicator:
 *   - 'offline'   → backend unreachable (grey dot)
 *   - 'degraded'  → backend OK but provider degraded (orange dot)
 *   - 'healthy'   → backend OK and provider healthy (green dot)
 */

import type { ProviderQuotaContract } from '@axiom/core/contracts'

export type GlobalStatus = 'offline' | 'degraded' | 'healthy'
type OperatingMode = 'normal' | 'fallback'

interface HealthSnapshot {
  enabled?: boolean
  operatingMode?: OperatingMode
  provider: {
    name: string
    status: string
  } | null
  fallbackProvider?: {
    name: string
    model: string
  } | null
  quota?: ProviderQuotaContract | null
}

const POLL_INTERVAL_MS = 30_000

export function useConnectionStatus() {
  const { apiFetch } = useApi()
  const { isAuthenticated, user } = useAuth()

  const status = useState<GlobalStatus>('global_connection_status', () => 'offline')
  const providerName = useState<string | null>('global_provider_name', () => null)
  const operatingMode = useState<OperatingMode>('global_operating_mode', () => 'normal')
  const fallbackProviderName = useState<string | null>('global_fallback_provider_name', () => null)
  const healthMonitorEnabled = useState<boolean>('global_health_monitor_enabled', () => true)
  const quota = useState<ProviderQuotaContract | null>('global_quota', () => null)

  let timer: ReturnType<typeof setInterval> | null = null
  let polling = false

  async function poll() {
    // Provider health is an admin-only endpoint; do not poll it for members.
    if (!isAuthenticated.value || user.value?.role !== 'admin') {
      healthMonitorEnabled.value = false
      status.value = 'offline'
      providerName.value = null
      operatingMode.value = 'normal'
      fallbackProviderName.value = null
      quota.value = null
      return
    }

    try {
      const data = await apiFetch<HealthSnapshot>('/api/health')

      healthMonitorEnabled.value = data.enabled ?? true
      operatingMode.value = data.operatingMode ?? 'normal'
      fallbackProviderName.value = data.fallbackProvider?.name ?? null
      quota.value = data.quota ?? null

      if (!data.provider) {
        // Backend reachable but no provider configured
        status.value = 'healthy'
        providerName.value = null
      } else {
        providerName.value = data.provider.name
        switch (data.provider.status) {
          case 'healthy':
            status.value = 'healthy'
            break
          case 'degraded':
            status.value = 'degraded'
            break
          case 'down':
          case 'unconfigured':
          default:
            status.value = 'degraded'
            break
        }
      }
    } catch {
      status.value = 'offline'
      providerName.value = null
      operatingMode.value = 'normal'
      fallbackProviderName.value = null
      quota.value = null
    }
  }

  function start() {
    if (polling) return
    polling = true
    poll()
    timer = setInterval(poll, POLL_INTERVAL_MS)
  }

  function stop() {
    polling = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    status: readonly(status),
    providerName: readonly(providerName),
    operatingMode: readonly(operatingMode),
    fallbackProviderName: readonly(fallbackProviderName),
    healthMonitorEnabled: readonly(healthMonitorEnabled),
    quota: readonly(quota),
    start,
    stop,
    poll,
  }
}
