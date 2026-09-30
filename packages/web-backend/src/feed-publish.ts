/**
 * Writing to the feed (SPEC 2.9, 6.6). One entry point so every producer
 * persists first and only then emits the `feed_item` frame: a client that
 * reconnects and re-reads `GET /api/feed` must see exactly what a client
 * that stayed online was told.
 *
 * A failure to persist is reported, never swallowed — a lost feed item is a
 * lost background result, which is the very thing this table exists to stop.
 */
import {
  insertFeedItem,
  insertFeedItemDeduped,
  type Database,
  type FeedItem,
  type InsertFeedItemInput,
} from '@axiom/core'
import type { ChatEventBus } from './chat-event-bus.js'

export interface FeedPublishDeps {
  db: Database
  chatEventBus?: ChatEventBus | null
  logger?: { warn: (msg: string, ...args: unknown[]) => void }
}

/**
 * Persist a feed item for `userId` and broadcast it. Returns the stored item,
 * or null when the write failed (already logged).
 */
export function publishFeedItem(
  deps: FeedPublishDeps,
  userId: number,
  input: Omit<InsertFeedItemInput, 'userId'>,
): FeedItem | null {
  let item: FeedItem
  try {
    item = insertFeedItem(deps.db, { ...input, userId: String(userId) })
  } catch (err) {
    const log = deps.logger ?? console
    log.warn(`[feed] Failed to write a ${input.kind} item for user ${userId}:`, err)
    return null
  }
  broadcast(deps, userId, item)
  return item
}

/**
 * Same as {@link publishFeedItem}, but idempotent through
 * `input.dedupeKey`: a producer that runs twice keeps updating its object
 * while the feed shows exactly one card. A deduped item is NOT broadcast
 * again — the clients already have it.
 */
export function publishFeedItemDeduped(
  deps: FeedPublishDeps,
  userId: number,
  input: Omit<InsertFeedItemInput, 'userId'>,
): { item: FeedItem; deduped: boolean } | null {
  let result: { item: FeedItem; deduped: boolean }
  try {
    result = insertFeedItemDeduped(deps.db, { ...input, userId: String(userId) })
  } catch (err) {
    const log = deps.logger ?? console
    log.warn(`[feed] Failed to write a ${input.kind} item for user ${userId}:`, err)
    return null
  }
  if (!result.deduped) broadcast(deps, userId, result.item)
  return result
}

function broadcast(deps: FeedPublishDeps, userId: number, item: FeedItem): void {
  try {
    deps.chatEventBus?.broadcast({ type: 'feed_item', userId, source: 'task', feedItem: item })
  } catch (err) {
    const log = deps.logger ?? console
    log.warn(`[feed] Failed to broadcast feed item ${item.id}:`, err)
  }
}
