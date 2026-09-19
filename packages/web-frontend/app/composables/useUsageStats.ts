/**
 * Usage statistics composable.
 *
 * Encapsulates filter state, API calls, and derived data for the usage page.
 * Hides query building, parallel fetching, and data merging behind a small
 * reactive interface — callers only see filters, results, and actions.
 */

interface UsageTotals {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
}

interface UsageRow extends UsageTotals {
  provider?: string
  model?: string
  day?: string
  hour?: string
}

interface UsageStatsResponse {
  groupBy: string[]
  rows: UsageRow[]
  totals: UsageTotals
  availableProviders: string[]
  availableModels: string[]
}

interface UsageSummaryResponse {
  today: UsageTotals
  week: UsageTotals
  month: UsageTotals
  allTime: UsageTotals
}

interface StallStatsResponse {
  total: number
  recovered: number
  aborted: number
  unresolved: number
  averageDurationMs: number
  maxDurationMs: number
  averageRecoveredDurationMs: number
  averageAbortedDurationMs: number
}

function formatDateParam(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

function emptyTotals(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, estimatedCost: 0 }
}

function emptyStallStats(): StallStatsResponse {
  return {
    total: 0,
    recovered: 0,
    aborted: 0,
    unresolved: 0,
    averageDurationMs: 0,
    maxDurationMs: 0,
    averageRecoveredDurationMs: 0,
    averageAbortedDurationMs: 0,
  }
}

export function useUsageStats() {
  const { apiFetch } = useApi()

  // ── State ──────────────────────────────────────────────────
  const loading = ref(false)
  const error = ref<string | null>(null)
  const allTimeTokens = ref(0)

  const filters = reactive({
    dateFrom: '',
    dateTo: '',
    provider: '',
    model: '',
  })

  const daily = ref<UsageStatsResponse>({
    groupBy: ['day'],
    rows: [],
    totals: emptyTotals(),
    availableProviders: [],
    availableModels: [],
  })

  const breakdown = ref<UsageStatsResponse>({
    groupBy: ['provider', 'model'],
    rows: [],
    totals: emptyTotals(),
    availableProviders: [],
    availableModels: [],
  })

  // Main agent vs. task agent daily breakdown
  const dailyMainAgent = ref<UsageStatsResponse>({
    groupBy: ['day'],
    rows: [],
    totals: emptyTotals(),
    availableProviders: [],
    availableModels: [],
  })

  const dailyTaskAgent = ref<UsageStatsResponse>({
    groupBy: ['day'],
    rows: [],
    totals: emptyTotals(),
    availableProviders: [],
    availableModels: [],
  })

  const dailyHeartbeat = ref<UsageStatsResponse>({
    groupBy: ['day'],
    rows: [],
    totals: emptyTotals(),
    availableProviders: [],
    availableModels: [],
  })

  const stalls = ref<StallStatsResponse>(emptyStallStats())

  const availableProviders = ref<string[]>([])
  const availableModels = ref<string[]>([])

  // ── Derived ────────────────────────────────────────────────
  const hasAnyUsage = computed(() => allTimeTokens.value > 0)

  const hasFilteredResults = computed(
    () => breakdown.value.rows.length > 0 || daily.value.rows.some((r) => r.totalTokens > 0),
  )

  const totals = computed(() => breakdown.value.totals)

  // ── Internals ──────────────────────────────────────────────
  function initFilters() {
    const end = new Date()
    const start = new Date(end)
    start.setDate(start.getDate() - 29)
    filters.dateFrom = formatDateParam(start)
    filters.dateTo = formatDateParam(end)
    filters.provider = ''
    filters.model = ''
  }

  function buildDateQuery(): URLSearchParams {
    const params = new URLSearchParams()
    if (filters.dateFrom) params.set('date_from', filters.dateFrom)
    if (filters.dateTo) params.set('date_to', filters.dateTo)
    return params
  }

  function buildQuery(groupBy: string[], sessionType?: string): string {
    const params = new URLSearchParams()
    params.set('group_by', groupBy.join(','))
    if (filters.dateFrom) params.set('date_from', filters.dateFrom)
    if (filters.dateTo) params.set('date_to', filters.dateTo)
    if (filters.provider) params.set('provider', filters.provider)
    if (filters.model) params.set('model', filters.model)
    if (sessionType) params.set('session_type', sessionType)
    return params.toString()
  }

  // ── Actions ────────────────────────────────────────────────
  async function loadStats() {
    loading.value = true
    error.value = null

    try {
      const [summaryData, dailyData, breakdownData, mainAgentData, taskAgentData, heartbeatData, stallData] = await Promise.all([
        apiFetch<UsageSummaryResponse>('/api/stats/summary'),
        apiFetch<UsageStatsResponse>(`/api/stats/usage?${buildQuery(['day'])}`),
        apiFetch<UsageStatsResponse>(`/api/stats/usage?${buildQuery(['provider', 'model'])}`),
        apiFetch<UsageStatsResponse>(`/api/stats/usage?${buildQuery(['day'], 'main')}`),
        apiFetch<UsageStatsResponse>(`/api/stats/usage?${buildQuery(['day'], 'task')}`),
        apiFetch<UsageStatsResponse>(`/api/stats/usage?${buildQuery(['day'], 'heartbeat')}`),
        apiFetch<StallStatsResponse>(`/api/stats/stalls?${buildDateQuery().toString()}`),
      ])

      allTimeTokens.value = summaryData.allTime.totalTokens
      daily.value = dailyData
      breakdown.value = breakdownData
      dailyMainAgent.value = mainAgentData
      dailyTaskAgent.value = taskAgentData
      dailyHeartbeat.value = heartbeatData
      stalls.value = stallData
      availableProviders.value = dailyData.availableProviders
      availableModels.value = dailyData.availableModels
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  function resetFilters() {
    initFilters()
    loadStats()
  }

  // Set default 30-day range
  initFilters()

  return {
    loading,
    error,
    filters,
    daily,
    dailyMainAgent,
    dailyTaskAgent,
    dailyHeartbeat,
    breakdown,
    stalls,
    availableProviders,
    availableModels,
    hasAnyUsage,
    hasFilteredResults,
    totals,
    loadStats,
    resetFilters,
  }
}
