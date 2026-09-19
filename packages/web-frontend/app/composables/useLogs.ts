export interface LogEntry {
  id: number
  timestamp: string
  sessionId: string
  toolName: string
  input: string
  output: string
  durationMs: number
  status: 'success' | 'error'
  /** Joined from `sessions.type` — drives source badge rendering. */
  sessionType?: string | null
  /** Joined from `sessions.source`. */
  sessionSource?: string | null
}

interface LogsResponse {
  logs: LogEntry[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

interface LogDetailResponse {
  log: LogEntry
}

interface ToolNamesResponse {
  toolNames: string[]
}

export function useLogs() {
  const { apiFetch } = useApi()
  const { getAccessToken } = useAuth()
  const config = useRuntimeConfig()

  const logs = useState<LogEntry[]>('logs_entries', () => [])
  const pagination = useState('logs_pagination', () => ({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  }))
  const toolNames = useState<string[]>('logs_tool_names', () => [])
  const loading = useState<boolean>('logs_loading', () => false)
  const liveMode = useState<boolean>('logs_live_mode', () => true)
  const paused = useState<boolean>('logs_paused', () => false)

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  async function fetchLogs(options: {
    page?: number
    limit?: number
    sessionId?: string
    toolName?: string
    search?: string
    dateFrom?: string
    dateTo?: string
    sessionType?: 'main' | 'task' | ''
    /** @deprecated use `sessionType`. */
    sourceFilter?: 'main' | 'task' | ''
  } = {}) {
    loading.value = true
    try {
      const params = new URLSearchParams()
      if (options.page) params.set('page', String(options.page))
      if (options.limit) params.set('limit', String(options.limit))
      if (options.sessionId) params.set('session_id', options.sessionId)
      if (options.toolName) params.set('tool_name', options.toolName)
      if (options.search) params.set('search', options.search)
      const sessionType = options.sessionType ?? options.sourceFilter
      if (sessionType) params.set('session_type', sessionType)
      if (options.dateFrom) {
        // Convert local date to UTC start-of-day: "2026-03-28" → "2026-03-27 23:00:00" (for UTC+1)
        const fromLocal = new Date(`${options.dateFrom}T00:00:00`)
        params.set('date_from', fromLocal.toISOString().replace('T', ' ').slice(0, 19))
      }
      if (options.dateTo) {
        // Convert local date to UTC end-of-day: "2026-03-28" → "2026-03-28 22:59:59" (for UTC+1)
        const toLocal = new Date(`${options.dateTo}T23:59:59`)
        params.set('date_to', toLocal.toISOString().replace('T', ' ').slice(0, 19))
      }

      const qs = params.toString()
      const data = await apiFetch<LogsResponse>(`/api/logs${qs ? `?${qs}` : ''}`)
      logs.value = data.logs
      pagination.value = data.pagination
    } finally {
      loading.value = false
    }
  }

  async function fetchLogDetail(id: number): Promise<LogEntry> {
    const data = await apiFetch<LogDetailResponse>(`/api/logs/${id}`)
    return data.log
  }

  async function fetchToolNames() {
    const data = await apiFetch<ToolNamesResponse>('/api/logs/tool-names')
    toolNames.value = data.toolNames
  }

  function connectLive() {
    const token = getAccessToken()
    if (!token) return

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    const apiBase = config.public.apiBase as string
    const wsBase = apiBase.replace(/^http/, 'ws')
    ws = new WebSocket(`${wsBase}/ws/logs?token=${encodeURIComponent(token)}`)

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { type: string; data?: LogEntry }
        if (msg.type === 'log_entry' && msg.data && !paused.value) {
          // Prepend new entry to the top of the list
          logs.value = [msg.data, ...logs.value].slice(0, 200)
        }
      } catch {
        // ignore
      }
    }

    ws.onclose = () => {
      ws = null
      if (liveMode.value) {
        reconnectTimer = setTimeout(() => connectLive(), 3000)
      }
    }

    ws.onerror = () => {
      // onclose fires after
    }
  }

  function disconnectLive() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.close()
      ws = null
    }
  }

  function togglePause() {
    paused.value = !paused.value
  }

  function setLiveMode(enabled: boolean) {
    liveMode.value = enabled
    if (enabled) {
      connectLive()
    } else {
      disconnectLive()
    }
  }

  return {
    logs,
    pagination,
    toolNames,
    loading,
    liveMode,
    paused,
    fetchLogs,
    fetchLogDetail,
    fetchToolNames,
    connectLive,
    disconnectLive,
    togglePause,
    setLiveMode,
  }
}
