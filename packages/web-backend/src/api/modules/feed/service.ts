/**
 * Feed service (SPEC 2.9, 6.4). Reads the feed of ONE user, owns the read
 * state, and turns a feed item into a capture ("ask about this") that goes
 * through the ordinary router path.
 *
 * The service never writes feed items: those are produced by background
 * components (see `feed-publish.ts` and the task wiring in
 * `bootstrap/runtime-composition.ts`).
 */
import {
  countUnreadFeedItems,
  getFeedItem,
  isUnknownFeedCursorError,
  listFeedItems,
  markAllFeedItemsRead,
  markFeedItemRead,
  type Capture,
  type Database,
  type Decision,
  type FeedItem,
} from '@axiom/core'
import type { CreateCaptureBody } from '../captures/schema.js'
import type { AskFeedBody, ListFeedQuery } from './schema.js'

export class FeedServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'FeedServiceError'
  }
}

/** Only the capture creation of the captures service is needed here. */
export interface FeedCaptureCreator {
  createCapture: (userId: number, body: CreateCaptureBody) => Promise<{ capture: Capture; decision: Decision }>
}

export interface FeedServiceOptions {
  db: Database
  /** The captures service; `ask` routes through it so the router path stays single. */
  getCaptureCreator?: () => FeedCaptureCreator | null
}

/** How much of a feed item body travels into the capture as context. */
export const ASK_CONTEXT_BODY_MAX = 1500

/**
 * The capture text for "ask about this feed item". The user's own words come
 * first (that is what the router should weigh), the item follows as quoted
 * context so the strand shows what the question is about.
 */
export function buildAskCaptureText(item: FeedItem, text: string | null): string {
  const body = (item.body ?? '').trim()
  const shortened = body.length > ASK_CONTEXT_BODY_MAX
    ? `${body.slice(0, ASK_CONTEXT_BODY_MAX)}…`
    : body
  const context = [`Feed item (${item.kind}): ${item.title}`, shortened].filter(Boolean).join('\n')
  const question = text ?? `About this feed item: ${item.title}`
  return `${question}\n\n---\n${context}`
}

export function createFeedService(options: FeedServiceOptions) {
  const { db } = options

  function requireItem(userId: number, id: string): FeedItem {
    const item = getFeedItem(db, String(userId), id)
    if (!item) throw new FeedServiceError(404, 'feed_item_not_found', 'Feed item not found')
    return item
  }

  function list(userId: number, query: ListFeedQuery): { items: FeedItem[] } {
    try {
      return {
        items: listFeedItems(db, String(userId), {
          sinceId: query.sinceId,
          limit: query.limit,
          kind: query.kind,
          unreadOnly: query.unreadOnly,
        }),
      }
    } catch (err) {
      if (isUnknownFeedCursorError(err)) {
        throw new FeedServiceError(400, 'invalid_since_id', 'Unknown since_id')
      }
      throw err
    }
  }

  /** Idempotent: a second call on a read item is still a 204. */
  function markRead(userId: number, id: string): void {
    if (!markFeedItemRead(db, String(userId), id)) {
      throw new FeedServiceError(404, 'feed_item_not_found', 'Feed item not found')
    }
  }

  function markAllRead(userId: number): void {
    markAllFeedItemsRead(db, String(userId))
  }

  function unreadCount(userId: number): { count: number } {
    return { count: countUnreadFeedItems(db, String(userId)) }
  }

  /**
   * Turn a feed item into a capture. The feed item is NOT pinned to a strand
   * here even when it carries one: the router decides where the question
   * belongs, exactly as for a capture typed into the box.
   */
  async function ask(userId: number, id: string, body: AskFeedBody): Promise<{ capture: Capture; decision: Decision }> {
    const item = requireItem(userId, id)
    const creator = options.getCaptureCreator?.()
    if (!creator) throw new FeedServiceError(503, 'captures_unavailable', 'Capture service not available')
    const result = await creator.createCapture(userId, {
      text: buildAskCaptureText(item, body.text),
      clientMessageId: null,
      agentId: item.agentId,
      strandId: null,
      kind: 'text',
      source: 'feed',
      attachments: [],
      intent: 'ask',
      // A feed question goes through the router like a typed one; the quick
      // mode belongs to devices that cannot show a strand picker.
      mode: 'work',
    })
    // Asking about an item is a stronger signal than opening it.
    markFeedItemRead(db, String(userId), id)
    return result
  }

  return { list, markRead, markAllRead, unreadCount, ask }
}

export type FeedService = ReturnType<typeof createFeedService>
