import { isFeedItemKind, type FeedItemKind } from '@axiom/core'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string }

const ID_MAX = 64
const ASK_TEXT_MAX = 4000

export interface ListFeedQuery {
  sinceId: string | null
  limit: number
  kind?: FeedItemKind
  unreadOnly: boolean
}

function parseFlag(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const value = raw.toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export function parseListFeedQuery(query: Record<string, unknown>): ParseResult<ListFeedQuery> {
  const rawSince = query.since_id ?? query.sinceId
  let sinceId: string | null = null
  if (rawSince !== undefined && rawSince !== null && rawSince !== '') {
    if (typeof rawSince !== 'string' || rawSince.length > ID_MAX) {
      return { ok: false, error: 'since_id must be a feed item id', code: 'invalid_since_id' }
    }
    sinceId = rawSince
  }

  let limit = 50
  const rawLimit = query.limit
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    const value = Number(rawLimit)
    if (!Number.isInteger(value) || value < 1) {
      return { ok: false, error: 'limit must be a positive integer', code: 'invalid_limit' }
    }
    limit = Math.min(value, 200)
  }

  let kind: FeedItemKind | undefined
  const rawKind = query.kind
  if (rawKind !== undefined && rawKind !== null && rawKind !== '') {
    if (!isFeedItemKind(rawKind)) {
      return { ok: false, error: 'Unknown kind', code: 'invalid_kind' }
    }
    kind = rawKind
  }

  return {
    ok: true,
    value: { sinceId, limit, ...(kind ? { kind } : {}), unreadOnly: parseFlag(query.unread_only ?? query.unreadOnly) },
  }
}

export interface AskFeedBody {
  text: string | null
}

/**
 * `POST /api/feed/:id/ask { text? }`. Without a text the capture is built
 * from the feed item alone ("tell me more about this"), so the body is
 * optional by design.
 */
export function parseAskFeedBody(body: unknown): ParseResult<AskFeedBody> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (b.text === undefined || b.text === null) return { ok: true, value: { text: null } }
  if (typeof b.text !== 'string') return { ok: false, error: 'text must be a string', code: 'invalid_text' }
  const trimmed = b.text.trim()
  if (trimmed.length === 0) return { ok: true, value: { text: null } }
  if (trimmed.length > ASK_TEXT_MAX) {
    return { ok: false, error: `text must be at most ${ASK_TEXT_MAX} characters`, code: 'invalid_text' }
  }
  return { ok: true, value: { text: trimmed } }
}

export function parseFeedItemId(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > ID_MAX) {
    return { ok: false, error: 'Unknown feed item', code: 'feed_item_not_found' }
  }
  return { ok: true, value: raw }
}
