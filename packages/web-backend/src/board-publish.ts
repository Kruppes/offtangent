/**
 * Announcing a board update (plan 2026-09-25). The board itself is already
 * written by `board-store.ts` when this runs; here the world learns about it:
 *
 *  1. one feed item of kind `board_update` (deduped by the producer's
 *     `dedupe_key`, so a retried run does not leave two cards behind),
 *  2. a `board_updated` websocket frame in ADDITION to the `feed_item` frame,
 *     so a client that has the board open refreshes without watching the feed,
 *  3. a doorbell — but only for `notify: true`. This is the single feed-only
 *     path that rings; every other feed-only item stays silent
 *     (`task-outcome.ts`, `push/triggers.ts`).
 *
 * A deduped publish still emits the `board_updated` frame — the board did
 * move — but writes no second card and rings no doorbell.
 */
import type { BoardPublication, BoardPublicationResult, Database } from '@axiom/core'
import type { ChatEventBus } from './chat-event-bus.js'
import { publishFeedItemDeduped } from './feed-publish.js'
import type { PushSender } from './push/sender.js'
import { sendFeedDoorbell } from './push/triggers.js'

export interface BoardPublishDeps {
  db: Database
  chatEventBus?: ChatEventBus | null
  getPushSender?: () => PushSender | null
  logger?: { warn: (msg: string, ...args: unknown[]) => void }
}

/** Fallback body of the feed card when the producer sent no summary. */
function feedBody(publication: BoardPublication): string | null {
  return publication.summary ?? null
}

/**
 * `dedupe_key` is unique per user across the whole feed, so the producer's
 * run id is namespaced with the board key here: two boards updated by the
 * same run must each get their own feed card, and a retry of one board must
 * still collapse onto its own first card.
 */
function namespacedDedupeKey(publication: BoardPublication): string | null {
  const key = publication.dedupeKey?.trim()
  return key ? `${publication.key}:${key}` : null
}

export function publishBoardUpdate(
  deps: BoardPublishDeps,
  publication: BoardPublication,
): BoardPublicationResult {
  const result = publishFeedItemDeduped(
    { db: deps.db, chatEventBus: deps.chatEventBus, logger: deps.logger },
    publication.userId,
    {
      kind: 'board_update',
      title: publication.title,
      body: feedBody(publication),
      agentId: publication.agentId,
      notify: publication.notify,
      dedupeKey: namespacedDedupeKey(publication),
      boardKey: publication.key,
    },
  )

  // The board is the state; the frame says it moved. Sent even when the feed
  // write failed, because the object HAS changed and an open board screen
  // showing a stale revision is the worse failure.
  try {
    deps.chatEventBus?.broadcast({
      type: 'board_update',
      userId: publication.userId,
      source: 'task',
      board: { key: publication.key, revision: publication.revision, asOf: publication.asOf },
    })
  } catch (err) {
    const log = deps.logger ?? console
    log.warn(`[boards] Failed to broadcast board_updated for ${publication.key}:`, err)
  }

  if (!result) return { feedItemId: null, deduped: false, notified: false }
  if (result.deduped) return { feedItemId: result.item.id, deduped: true, notified: false }

  let notified = false
  if (publication.notify) {
    const sender = deps.getPushSender?.() ?? null
    if (sender) {
      notified = true
      sendFeedDoorbell(sender, {
        userId: publication.userId,
        agentId: publication.agentId ?? 'main',
        feedItemId: result.item.id,
        itemKind: 'board_update',
        boardKey: publication.key,
        title: publication.title,
        body: publication.summary ?? undefined,
      })
    }
  }

  return { feedItemId: result.item.id, deduped: false, notified }
}
