export interface Task {
  id: string
  name: string
  prompt: string
  status: 'running' | 'paused' | 'completed' | 'failed'
  triggerType: 'user' | 'agent' | 'cronjob' | 'heartbeat' | 'consolidation'
  triggerSourceId: string | null
  provider: string | null
  model: string | null
  /**
   * `true` when the task ran on the configured Task Default provider/model,
   * `false` when an explicit (provider, model) was passed through
   * `create_task`, a cronjob, etc. `null` for legacy rows that predate this
   * column.
   */
  isDefaultModel: boolean | null
  maxDurationMinutes: number | null
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
  toolCallCount: number
  resultSummary: string | null
  resultStatus: string | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  sessionId: string | null
}

export interface TaskProviderFilterOption {
  provider: string | null
  model: string | null
  isDefaultModel: boolean | null
}

interface TasksResponse {
  tasks: Task[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
  providerOptions?: TaskProviderFilterOption[]
}

interface TaskResponse {
  task: Task
}

export interface TaskInfo {
  promptTokens?: number
  completionTokens?: number
  cacheRead?: number
  cacheWrite?: number
  estimatedCost?: number
  toolCallCount?: number
  id: string
  name: string
  status: string
  triggerType?: 'user' | 'agent' | 'cronjob' | 'heartbeat' | 'consolidation'
  prompt?: string | null
  provider?: string | null
  model?: string | null
  isDefaultModel?: boolean | null
  maxDurationMinutes?: number | null
  resultSummary?: string | null
  errorMessage?: string | null
}

export interface TaskEventItem {
  type: string
  timestamp: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  durationMs?: number
  text?: string
  status?: string
  statusMessage?: string
  // For REST API tool_call events
  input?: string
  output?: string
  // For REST API message events
  role?: string
  content?: string
  metadata?: unknown
  thinking?: string
}

export interface TaskEventsResponse {
  nextSince: string
  events: TaskEventItem[]
  task: TaskInfo
}

interface ListTasksParams {
  page?: number
  limit?: number
  status?: string
  triggerType?: string
  provider?: string
  model?: string
  isDefaultModel?: boolean
  createdFrom?: string
  createdTo?: string
}

export function useTasksApi() {
  const { apiFetch } = useApi()

  async function listTasks(params: ListTasksParams = {}): Promise<TasksResponse> {
    const query = new URLSearchParams()

    if (params.page !== undefined) query.set('page', String(params.page))
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.status) query.set('status', params.status)
    if (params.triggerType) query.set('trigger_type', params.triggerType)
    if (params.provider) query.set('provider', params.provider)
    if (params.model) query.set('model', params.model)
    if (params.isDefaultModel !== undefined) query.set('is_default_model', String(params.isDefaultModel))
    if (params.createdFrom) query.set('created_from', params.createdFrom)
    if (params.createdTo) query.set('created_to', params.createdTo)

    const suffix = query.toString()
    return apiFetch<TasksResponse>(`/api/tasks${suffix ? `?${suffix}` : ''}`)
  }

  async function getTask(taskId: string): Promise<TaskResponse> {
    return apiFetch<TaskResponse>(`/api/tasks/${taskId}`)
  }

  async function getTaskEvents(taskId: string, since?: string): Promise<TaskEventsResponse> {
    return apiFetch<TaskEventsResponse>(`/api/tasks/${encodeURIComponent(taskId)}/events${since ? `?since=${encodeURIComponent(since)}` : ''}`)
  }

  async function killTask(taskId: string): Promise<TaskResponse> {
    return apiFetch<TaskResponse>(`/api/tasks/${taskId}/kill`, { method: 'POST' })
  }

  async function restartTask(
    taskId: string,
    payload: RestartTaskPayload = {},
  ): Promise<TaskResponse> {
    return apiFetch<TaskResponse>(`/api/tasks/${taskId}/restart`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return {
    listTasks,
    getTask,
    getTaskEvents,
    killTask,
    restartTask,
  }
}

/**
 * Payload for `POST /api/tasks/:id/restart`. Any omitted field inherits
 * from the original task. `provider` is the composite `providerId:modelId`
 * (as selected in the UI) or just a provider id / name for legacy values.
 */
interface RestartTaskPayload {
  name?: string
  prompt?: string
  provider?: string
  model?: string
  maxDurationMinutes?: number
}
