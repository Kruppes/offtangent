/**
 * Dashboard data composable.
 *
 * Owns every API call the dashboard page needs and exposes derived,
 * ready-to-render computed values. The page stays a thin orchestrator.
 */

// ── Shared types ────────────────────────────────────────────────
export type OperatingMode = 'normal' | 'fallback'

export interface HealthSnapshot {
  agent: { status: 'running' | 'stopped' }
  enabled?: boolean
  operatingMode?: OperatingMode
  provider: {
    id: string
    name: string
    type: string
    model: string
    status: ProviderStatus
  } | null
  primaryProvider?: {
    id: string
    name: string
    type: string
    model: string
    lastHealthStatus: ProviderStatus | null
  } | null
  fallbackProvider?: {
    id: string
    name: string
    type: string
    model: string
  } | null
  lastCheck: {
    checkedAt: string
    providerId: string | null
    providerName: string | null
    providerType: string | null
    model: string | null
    status: ProviderStatus
    latencyMs: number | null
    errorMessage: string | null
  } | null
  queueDepth: number
  activity: {
    messagesToday: number
    sessionsToday: number
  }
  intervalMinutes: number
}

export interface HealthHistoryEntry {
  id: number
  timestamp: string
  provider: string | null
  status: ProviderStatus
  latencyMs: number | null
  errorMessage: string | null
}

export type ProviderStatus = 'healthy' | 'degraded' | 'down' | 'unconfigured'

interface UsageTotals {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimatedCost: number
}

// ── Composable ──────────────────────────────────────────────────
export function useDashboard() {
  const { apiFetch } = useApi()

  const loading = ref(false)
  const error = ref<string | null>(null)

  const health = ref<HealthSnapshot>({
    agent: { status: 'stopped' },
    enabled: true,
    operatingMode: 'normal',
    provider: null,
    primaryProvider: null,
    fallbackProvider: null,
    lastCheck: null,
    queueDepth: 0,
    activity: { messagesToday: 0, sessionsToday: 0 },
    intervalMinutes: 5,
  })

  const healthHistory = ref<HealthHistoryEntry[]>([])
  const providersCount = ref(0)
  const usageToday = ref<UsageTotals>({
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
  })

  // Task counts for dashboard card
  const activeTaskCount = ref(0)
  const scheduledTaskCount = ref(0)

  // ── Derived state ─────────────────────────────────────────────
  const providerName = computed(() => health.value.provider?.name ?? null)
  const providerType = computed(() => health.value.provider?.type ?? null)
  const providerModel = computed(() => health.value.provider?.model ?? null)
  const providerStatus = computed((): ProviderStatus => health.value.provider?.status ?? 'unconfigured')
  const agentStatus = computed(() => health.value.agent.status)
  const healthMonitorEnabled = computed((): boolean => health.value.enabled ?? true)
  const operatingMode = computed((): OperatingMode => health.value.operatingMode ?? 'normal')
  const primaryProvider = computed(() => health.value.primaryProvider ?? null)
  const fallbackProviderInfo = computed(() => health.value.fallbackProvider ?? null)

  const lastCheckTime = computed(() => health.value.lastCheck?.checkedAt ?? null)
  const lastCheckLatency = computed(() => health.value.lastCheck?.latencyMs ?? null)
  const lastCheckError = computed(() => health.value.lastCheck?.errorMessage ?? null)

  // ── Data fetching ─────────────────────────────────────────────
  async function load() {
    loading.value = true
    error.value = null

    try {
      const [healthData, historyData, providersData, summaryData, runningTasksData, cronjobsData] = await Promise.all([
        apiFetch<HealthSnapshot>('/api/health'),
        apiFetch<{ history: HealthHistoryEntry[] }>('/api/health/history?limit=5'),
        apiFetch<{ providers: Array<{ id: string }> }>('/api/providers'),
        apiFetch<{ today: UsageTotals; allTime: UsageTotals }>('/api/stats/summary'),
        apiFetch<{ tasks: unknown[]; pagination: { total: number } }>('/api/tasks?status=running&limit=1').catch(() => ({ tasks: [], pagination: { total: 0 } })),
        apiFetch<{ cronjobs: Array<{ enabled: number }> }>('/api/cronjobs').catch(() => ({ cronjobs: [] })),
      ])

      health.value = healthData
      healthHistory.value = historyData.history
      providersCount.value = providersData.providers.length
      usageToday.value = summaryData.today
      activeTaskCount.value = runningTasksData.pagination.total
      scheduledTaskCount.value = cronjobsData.cronjobs.filter((c: { enabled: number }) => c.enabled).length
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  return {
    // state
    loading: readonly(loading),
    error,
    health: readonly(health),
    healthHistory: readonly(healthHistory),
    providersCount: readonly(providersCount),
    usageToday: readonly(usageToday),
    activeTaskCount: readonly(activeTaskCount),
    scheduledTaskCount: readonly(scheduledTaskCount),

    // derived
    providerName,
    providerType,
    providerModel,
    providerStatus,
    agentStatus,
    healthMonitorEnabled,
    operatingMode,
    primaryProvider,
    fallbackProviderInfo,
    lastCheckTime,
    lastCheckLatency,
    lastCheckError,

    // actions
    load,
  }
}
