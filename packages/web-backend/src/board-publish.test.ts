/**
 * Announcing a board update: one feed card, two websocket frames, and a
 * doorbell ONLY when the publisher asked for one.
 *
 * The doorbell rule is the sensitive part. Feed-only items never ring
 * (`task-outcome.ts`); boards are the single exception, and only with
 * `notify: true`. A regression here means either silent boards or a feed that
 * buzzes for everything.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, listFeedItems } from '@axiom/core'
import type { Database } from '@axiom/core'
import { ChatEventBus } from './chat-event-bus.js'
import type { ChatEvent } from './chat-event-bus.js'
import { publishBoardUpdate } from './board-publish.js'
import type { PushDoorbell, PushSender } from './push/sender.js'

let db: Database
let bus: ChatEventBus
let frames: ChatEvent[]
let doorbells: PushDoorbell[]

function fakeSender(): PushSender {
  return { sendDetached: (doorbell: PushDoorbell) => { doorbells.push(doorbell) } } as unknown as PushSender
}

function deps(sender: PushSender | null = fakeSender()) {
  return { db, chatEventBus: bus, getPushSender: () => sender }
}

const publication = {
  userId: 1,
  agentId: 'main',
  key: 'portfolio',
  kind: 'portfolio_digest.v1',
  title: 'Portfolio',
  summary: 'Up 1.0% today.',
  revision: 3,
  asOf: '2026-09-25T20:00:00Z',
  notify: false,
  dedupeKey: null as string | null,
}

beforeEach(() => {
  db = initDatabase(':memory:')
  bus = new ChatEventBus()
  frames = []
  doorbells = []
  bus.subscribe(event => { frames.push(event) })
})

afterEach(() => {
  db.close()
})

describe('publishBoardUpdate', () => {
  it('writes one feed item and emits feed_item plus board_update', () => {
    const result = publishBoardUpdate(deps(), publication)

    const items = listFeedItems(db, '1', { limit: 10 })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'board_update', title: 'Portfolio', body: 'Up 1.0% today.',
      boardKey: 'portfolio', notify: false, agentId: 'main',
    })
    expect(result).toEqual({ feedItemId: items[0]!.id, deduped: false, notified: false })

    expect(frames.map(f => f.type)).toEqual(['feed_item', 'board_update'])
    expect(frames[1]!.board).toEqual({ key: 'portfolio', revision: 3, asOf: '2026-09-25T20:00:00Z' })
    expect(frames[0]!.feedItem).toMatchObject({ kind: 'board_update', boardKey: 'portfolio' })
  })

  it('does not ring the doorbell for a silent update', () => {
    publishBoardUpdate(deps(), publication)
    expect(doorbells).toEqual([])
  })

  it('rings the doorbell with the documented FCM data when notify is set', () => {
    const result = publishBoardUpdate(deps(), { ...publication, notify: true })

    expect(doorbells).toHaveLength(1)
    expect(doorbells[0]).toMatchObject({
      userId: 1,
      kind: 'feed_item',
      strandId: null,
      agentId: 'main',
      title: 'Portfolio',
      feed: { feedItemId: result.feedItemId, itemKind: 'board_update', boardKey: 'portfolio' },
    })
    expect(listFeedItems(db, '1', { limit: 10 })[0]!.notify).toBe(true)
  })

  it('stays silent when push is not configured at all', () => {
    expect(() => publishBoardUpdate(deps(null), { ...publication, notify: true })).not.toThrow()
    expect(doorbells).toEqual([])
    expect(listFeedItems(db, '1', { limit: 10 })).toHaveLength(1)
  })

  it('writes no second card, frame or doorbell for a repeated dedupe_key', () => {
    const first = publishBoardUpdate(deps(), { ...publication, notify: true, dedupeKey: 'run-1' })
    frames.length = 0
    doorbells.length = 0
    const second = publishBoardUpdate(deps(), {
      ...publication, notify: true, dedupeKey: 'run-1', revision: 4, summary: 'Corrected.',
    })

    expect(second).toEqual({ feedItemId: first.feedItemId, deduped: true, notified: false })
    expect(listFeedItems(db, '1', { limit: 10 })).toHaveLength(1)
    expect(doorbells).toEqual([])
    // The board still moved, so the board frame is still sent.
    expect(frames.map(f => f.type)).toEqual(['board_update'])
    expect(frames[0]!.board).toEqual({ key: 'portfolio', revision: 4, asOf: '2026-09-25T20:00:00Z' })
  })

  it('scopes the dedupe key to the board so a shared run id still cards both', () => {
    const first = publishBoardUpdate(deps(), { ...publication, dedupeKey: 'run-1' })
    const other = publishBoardUpdate(deps(), {
      ...publication, key: 'site-health', title: 'Site health', dedupeKey: 'run-1',
    })
    const repeat = publishBoardUpdate(deps(), { ...publication, dedupeKey: 'run-1', revision: 4 })

    expect(other.deduped).toBe(false)
    expect(other.feedItemId).not.toBe(first.feedItemId)
    expect(repeat).toMatchObject({ feedItemId: first.feedItemId, deduped: true })

    const items = listFeedItems(db, '1', { limit: 10 })
    expect(items).toHaveLength(2)
    expect(items.map(i => i.boardKey).sort()).toEqual(['portfolio', 'site-health'])
    expect(db.prepare('SELECT dedupe_key FROM feed_items ORDER BY dedupe_key').all())
      .toEqual([{ dedupe_key: 'portfolio:run-1' }, { dedupe_key: 'site-health:run-1' }])
  })

  it('reports notified only when a doorbell was handed to a sender', () => {
    expect(publishBoardUpdate(deps(), { ...publication, notify: true }).notified).toBe(true)
    expect(publishBoardUpdate(deps(null), {
      ...publication, key: 'b', notify: true,
    }).notified).toBe(false)
    expect(publishBoardUpdate(deps(), { ...publication, key: 'c', notify: false }).notified).toBe(false)
  })

  it('keeps the feed of another user out of it', () => {
    publishBoardUpdate(deps(), publication)
    publishBoardUpdate(deps(), { ...publication, userId: 2, dedupeKey: 'run-1' })
    expect(listFeedItems(db, '1', { limit: 10 })).toHaveLength(1)
    expect(listFeedItems(db, '2', { limit: 10 })).toHaveLength(1)
    expect(listFeedItems(db, '3', { limit: 10 })).toHaveLength(0)
  })
})
