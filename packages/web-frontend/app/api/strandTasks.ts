/**
 * Strand task tree client: `GET /api/strands/:id/tasks?include=active|all`.
 *
 * This is the catch-up read of the strand activity view. A client that opens
 * the page while a wave runs — or that missed a `task_started` frame because
 * the socket was down — gets the complete tree here, sub-tasks included.
 */
export type StrandTaskStatus = 'running' | 'paused' | 'completed' | 'failed'

/**
 * One node of the strand's task tree, exactly as the backend sends it
 * (`GET /api/strands/:id/tasks`). The same shape is produced by the live
 * `task_started` / `task_progress` / `task_finished` frames, so the view can
 * merge both without a translation step.
 */
export interface StrandTaskNode {
  id: string
  name: string
  status: StrandTaskStatus
  resultStatus: string | null
  triggerType: string
  agentId: string | null
  /** The task that delegated this one, null for a task the strand started. */
  parentTaskId: string | null
  /** 0 for a direct task, +1 per delegation level (server hint). */
  depth: number
  hasChildren: boolean
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
  promptTokens?: number
  completionTokens?: number
  cacheRead?: number
  cacheWrite?: number
  estimatedCost?: number
  toolCallCount: number
  /** The task's own session, never the strand. */
  sessionId: string | null
}

export interface StrandTaskTreeResponse {
  strandId: string
  include: 'active' | 'all'
  tasks: StrandTaskNode[]
  activeCount: number
  truncated: boolean
  maxDepth: number
  generatedAt: string
}

export interface StrandTasksApi {
  getStrandTasks(strandId: string, include?: 'active' | 'all'): Promise<StrandTaskTreeResponse>
}

export function useStrandTasksApi(): StrandTasksApi {
  const { apiFetch } = useApi()

  return {
    async getStrandTasks(strandId: string, include: 'active' | 'all' = 'active') {
      return await apiFetch<StrandTaskTreeResponse>(
        `/api/strands/${encodeURIComponent(strandId)}/tasks?include=${include}`,
      )
    },
  }
}
