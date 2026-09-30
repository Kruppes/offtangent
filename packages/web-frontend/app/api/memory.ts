export interface MemoryTreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  modifiedAt?: string
  children?: MemoryTreeNode[]
}

export interface MemoryFact {
  id: number
  userId: number | null
  sessionId: string | null
  content: string
  source: string
  timestamp: string
}

export interface MemoryFactsQuery {
  query?: string
  userId?: number
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}

interface MemoryFactsResponse {
  facts: MemoryFact[]
  total: number
}

export interface MemoryFileReadStat {
  path: string
  count: number
  lastReadAt: string
}

export interface MemorySearchStat {
  id: number
  timestamp: string
  query: string
  resultCount: number
  facts: { content: string; timestamp: string; source: string }[]
}

export interface MemoryUsageStats {
  fileReads: MemoryFileReadStat[]
  searches: MemorySearchStat[]
}

export function useMemoryApi() {
  const { apiFetch } = useApi()

  const listFiles = () => apiFetch<{ files: MemoryTreeNode[] }>('/api/memory/files')
  const getFile = (path: string) => apiFetch<{ content: string }>(`/api/memory/file?path=${encodeURIComponent(path)}`)
  const updateFile = (path: string, content: string) => apiFetch(`/api/memory/file?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  const deleteFile = (path: string) => apiFetch(`/api/memory/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })

  const getAgentRules = () => apiFetch<{ content: string }>('/api/memory/agents')
  const updateAgentRules = (content: string) => apiFetch('/api/memory/agents', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  const getDefaultAgentRules = () => apiFetch<{ content: string }>('/api/memory/agents/default')

  const getHeartbeat = () => apiFetch<{ content: string }>('/api/memory/heartbeat')
  const updateHeartbeat = (content: string) => apiFetch('/api/memory/heartbeat', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  const getDefaultHeartbeat = () => apiFetch<{ content: string }>('/api/memory/heartbeat/default')

  const getConsolidationRules = () => apiFetch<{ content: string }>('/api/memory/consolidation-rules')
  const updateConsolidationRules = (content: string) => apiFetch('/api/memory/consolidation-rules', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  const getDefaultConsolidationRules = () => apiFetch<{ content: string }>('/api/memory/consolidation-rules/default')

  const getTasksGuidelines = () => apiFetch<{ content: string }>('/api/memory/tasks-guidelines')
  const updateTasksGuidelines = (content: string) => apiFetch('/api/memory/tasks-guidelines', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  const getDefaultTasksGuidelines = () => apiFetch<{ content: string }>('/api/memory/tasks-guidelines/default')

  const listFacts = (queryOptions: MemoryFactsQuery = {}) => {
    const params = new URLSearchParams()

    if (queryOptions.query?.trim()) params.set('query', queryOptions.query.trim())
    if (queryOptions.userId !== undefined) params.set('userId', String(queryOptions.userId))
    if (queryOptions.dateFrom) params.set('dateFrom', queryOptions.dateFrom)
    if (queryOptions.dateTo) params.set('dateTo', queryOptions.dateTo)
    if (queryOptions.limit !== undefined) params.set('limit', String(queryOptions.limit))
    if (queryOptions.offset !== undefined) params.set('offset', String(queryOptions.offset))

    const query = params.toString()
    return apiFetch<MemoryFactsResponse>(`/api/memory/facts${query ? `?${query}` : ''}`)
  }

  const updateFact = (id: number, content: string) => apiFetch(`/api/memory/facts/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

  const deleteFact = (id: number) => apiFetch(`/api/memory/facts/${id}`, {
    method: 'DELETE',
  })

  const getUsageStats = (days: number) => apiFetch<MemoryUsageStats>(`/api/memory/usage-stats?days=${days}`)

  return {
    listFiles,
    getFile,
    updateFile,
    deleteFile,
    getAgentRules,
    updateAgentRules,
    getDefaultAgentRules,
    getHeartbeat,
    updateHeartbeat,
    getDefaultHeartbeat,
    getConsolidationRules,
    updateConsolidationRules,
    getDefaultConsolidationRules,
    getTasksGuidelines,
    updateTasksGuidelines,
    getDefaultTasksGuidelines,
    listFacts,
    updateFact,
    deleteFact,
    getUsageStats,
  }
}
