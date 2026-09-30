import type { Capture, Decision, FeedItem, FeedItemKind } from '@axiom/core'

export type { FeedItem, FeedItemKind }

/**
 * The feed contract the web app relies on. `board_update` items (written by
 * the `publish_board` tool), the `notify` flag that lets a board ring the
 * doorbell without a strand, and the `boardKey` back-reference come from
 * `@axiom/core`; these declarations pin them down locally so a drift in the
 * shared types fails the build here instead of silently degrading the UI.
 */
export type BoardFeedKind = Extract<FeedItemKind, 'board_update'>

/** A `board_update` item always carries the board it belongs to. */
export interface BoardUpdateFeedItem extends FeedItem {
  kind: 'board_update'
  boardKey: string
  notify: boolean
}

export function isBoardUpdate(item: FeedItem): item is BoardUpdateFeedItem {
  return item.kind === 'board_update' && typeof item.boardKey === 'string' && item.boardKey.length > 0
}

/** Kinds the feed filter offers, in display order. `board_update` is last. */
export const FEED_FILTER_KINDS: readonly FeedItemKind[] = [
  'task_result', 'task_question', 'cron_report', 'heartbeat', 'reminder', 'system', 'board_update',
]

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
