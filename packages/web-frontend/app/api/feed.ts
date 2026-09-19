import type { Capture, Decision, FeedItem, FeedItemKind } from '@axiom/core'

export type { FeedItem, FeedItemKind }
interface FeedQuery {
  sinceId?: string
  limit?: number
  kind?: FeedItemKind
  unreadOnly?: boolean
}

export function useFeedApi() {
  const { apiFetch } = useApi()
  return {
    async list(query: FeedQuery = {}) {
      const params = new URLSearchParams()
      if (query.sinceId) params.set('since_id', query.sinceId)
      if (query.limit) params.set('limit', String(query.limit))
      if (query.kind) params.set('kind', query.kind)
      if (query.unreadOnly) params.set('unread_only', '1')
      const data = await apiFetch<{ items: FeedItem[] }>(`/api/feed${params.size ? `?${params}` : ''}`)
      return data.items
    },
    async unreadCount() {
      return (await apiFetch<{ count: number }>('/api/feed/unread-count')).count
    },
    read(id: string) {
      return apiFetch<void>(`/api/feed/${encodeURIComponent(id)}/read`, { method: 'POST' })
    },
    readAll() {
      return apiFetch<void>('/api/feed/read-all', { method: 'POST' })
    },
    ask(id: string, text?: string) {
      return apiFetch<{ capture: Capture; decision: Decision }>(`/api/feed/${encodeURIComponent(id)}/ask`, {
        method: 'POST', body: JSON.stringify({ text }),
      })
    },
  }
}
