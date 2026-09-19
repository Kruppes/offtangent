import { useThreadsMock } from '~/api/threads.mock'

/**
 * Threads API client.
 *
 * A thread is an `interactive` session with a name. The backend contract is
 * documented in the Stufe-1 plan: threads are listed sorted by `lastActivity`
 * DESC, created without becoming the active session, and patched partially.
 *
 * The client is intentionally thin: every UI concern (sorting groups, title
 * fallbacks, optimistic updates) lives in `useThreads`, so swapping the mock
 * for the real backend is a single flag.
 */

export interface ThreadLastMessage {
  role: 'user' | 'assistant'
  /** Excerpt, capped at 200 characters by the backend. */
  content: string
  timestamp: string
}

export interface Thread {
  id: string
  agentId: string
  title: string | null
  pinned: boolean
  archived: boolean
  startedAt: string
  lastActivity: string
  endedAt: string | null
  messageCount: number
  lastMessage: ThreadLastMessage | null
  /** True when this thread is the active session in the (user, agent) slot. */
  active: boolean
}

export interface ThreadListQuery {
  agentId?: string
  includeArchived?: boolean
  limit?: number
  offset?: number
}

export interface CreateThreadPayload {
  agentId: string
  title?: string
}

export interface UpdateThreadPayload {
  title?: string | null
  pinned?: boolean
  archived?: boolean
}

export interface ThreadsApi {
  listThreads(query?: ThreadListQuery): Promise<Thread[]>
  createThread(payload: CreateThreadPayload): Promise<Thread>
  updateThread(id: string, patch: UpdateThreadPayload): Promise<Thread>
}

function buildListQuery(query: ThreadListQuery = {}): string {
  const params = new URLSearchParams()
  if (query.agentId) params.set('agent_id', query.agentId)
  params.set('include_archived', query.includeArchived ? '1' : '0')
  params.set('limit', String(query.limit ?? 50))
  params.set('offset', String(query.offset ?? 0))
  return params.toString()
}

function useThreadsHttpApi(): ThreadsApi {
  const { apiFetch } = useApi()

  return {
    async listThreads(query: ThreadListQuery = {}) {
      const data = await apiFetch<{ threads: Thread[] }>(`/api/threads?${buildListQuery(query)}`)
      return data.threads ?? []
    },

    async createThread(payload: CreateThreadPayload) {
      const data = await apiFetch<{ thread: Thread }>('/api/threads', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      return data.thread
    },

    async updateThread(id: string, patch: UpdateThreadPayload) {
      const data = await apiFetch<{ thread: Thread }>(`/api/threads/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      return data.thread
    },
  }
}

/**
 * Returns the real HTTP client, or the in-memory mock when
 * `NUXT_PUBLIC_THREADS_MOCK=1` was set at build/dev time. The flag defaults to
 * off, so a production build never ships mock data.
 */
export function useThreadsApi(): ThreadsApi {
  const config = useRuntimeConfig()
  if (config.public.threadsMock) return useThreadsMock()
  return useThreadsHttpApi()
}
