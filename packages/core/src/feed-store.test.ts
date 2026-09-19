import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { ensureOfftangentTables } from './offtangent-schema.js'
import {
  countUnreadFeedItems,
  getFeedItem,
  insertFeedItem,
  isUnknownFeedCursorError,
  listFeedItems,
  markAllFeedItemsRead,
  markFeedItemRead,
} from './feed-store.js'

let db: Database

beforeEach(() => {
  db = initDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

function add(userId: string, over: Partial<Parameters<typeof insertFeedItem>[1]> = {}) {
  return insertFeedItem(db, {
    userId,
    kind: 'task_result',
    title: 'Nightly run',
    body: 'All green',
    taskId: 't-1',
    agentId: 'main',
    ...over,
  })
}

describe('feed schema', () => {
  it('creates feed_items with the spec CHECK and the user/created index', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map(r => r.name)
    expect(tables).toContain('feed_items')
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
      .map(r => r.name)
    expect(indexes).toContain('idx_feed_user_created')
    expect(() => db.prepare(
      "INSERT INTO feed_items (id, user_id, kind, title) VALUES ('x', '1', 'nonsense', 'T')",
    ).run()).toThrow(/CHECK constraint failed/)
  })

  it('is idempotent: re-running the real migration keeps rows, schema and index', () => {
    const item = add('1')
    const ddlBefore = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'feed_items'").get() as { sql: string }
    // The same function `initDatabase` calls (database.ts). Running it again is
    // what every boot does.
    expect(() => ensureOfftangentTables(db)).not.toThrow()
    expect(() => ensureOfftangentTables(db)).not.toThrow()
    expect(listFeedItems(db, '1').map(i => i.id)).toEqual([item.id])
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'feed_items'").get() as { sql: string }).sql)
      .toBe(ddlBefore.sql)
    expect(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'idx_feed_user_created'").get())
      .toEqual({ c: 1 })
  })

  it('the migration creates the table on a database that predates the feed', () => {
    db.exec('DROP INDEX IF EXISTS idx_feed_user_created; DROP TABLE feed_items;')
    expect(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'feed_items'").get()).toEqual({ c: 0 })
    ensureOfftangentTables(db)
    expect(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'feed_items'").get()).toEqual({ c: 1 })
    expect(add('1').title).toBe('Nightly run')
  })
})

describe('insert and read back', () => {
  it('round-trips every field and defaults read_at to null', () => {
    const item = add('1', { strandId: 's-1', kind: 'cron_report' })
    expect(item).toMatchObject({
      kind: 'cron_report',
      title: 'Nightly run',
      body: 'All green',
      agentId: 'main',
      taskId: 't-1',
      strandId: 's-1',
      readAt: null,
    })
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(getFeedItem(db, '1', item.id)).toEqual(item)
  })

  it('never hands a foreign item out', () => {
    const mine = add('1')
    expect(getFeedItem(db, '2', mine.id)).toBeNull()
    expect(listFeedItems(db, '2')).toEqual([])
  })

  it('falls back to a placeholder title rather than writing a blank card', () => {
    expect(add('1', { title: '   ' }).title).toBe('Untitled')
  })
})

describe('listing', () => {
  it('returns the newest first without a cursor and respects the limit', () => {
    const a = add('1', { title: 'one' })
    const b = add('1', { title: 'two' })
    const c = add('1', { title: 'three' })
    expect(listFeedItems(db, '1').map(i => i.id)).toEqual([c.id, b.id, a.id])
    expect(listFeedItems(db, '1', { limit: 2 }).map(i => i.id)).toEqual([c.id, b.id])
  })

  it('pages forward over since_id, oldest first', () => {
    const a = add('1', { title: 'one' })
    const b = add('1', { title: 'two' })
    const c = add('1', { title: 'three' })
    expect(listFeedItems(db, '1', { sinceId: a.id }).map(i => i.id)).toEqual([b.id, c.id])
    const page1 = listFeedItems(db, '1', { sinceId: a.id, limit: 1 })
    expect(page1.map(i => i.id)).toEqual([b.id])
    expect(listFeedItems(db, '1', { sinceId: page1[0].id, limit: 1 }).map(i => i.id)).toEqual([c.id])
    expect(listFeedItems(db, '1', { sinceId: c.id })).toEqual([])
  })

  it('refuses a cursor that is not the user\'s own item', () => {
    const foreign = add('2')
    expect(() => listFeedItems(db, '1', { sinceId: foreign.id })).toThrow()
    try {
      listFeedItems(db, '1', { sinceId: 'nope' })
    } catch (err) {
      expect(isUnknownFeedCursorError(err)).toBe(true)
    }
  })

  it('filters by kind and by unread', () => {
    add('1', { kind: 'cron_report', title: 'cron' })
    const task = add('1', { kind: 'task_result', title: 'task' })
    expect(listFeedItems(db, '1', { kind: 'cron_report' }).map(i => i.title)).toEqual(['cron'])
    markFeedItemRead(db, '1', task.id)
    expect(listFeedItems(db, '1', { unreadOnly: true }).map(i => i.title)).toEqual(['cron'])
    expect(listFeedItems(db, '1', { kind: 'task_result', unreadOnly: true })).toEqual([])
  })
})

describe('read state', () => {
  it('is idempotent and keeps the first read_at', async () => {
    const item = add('1')
    expect(countUnreadFeedItems(db, '1')).toBe(1)
    expect(markFeedItemRead(db, '1', item.id)).toBe(true)
    const first = getFeedItem(db, '1', item.id)!.readAt
    expect(first).not.toBeNull()
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(markFeedItemRead(db, '1', item.id)).toBe(true)
    expect(getFeedItem(db, '1', item.id)!.readAt).toBe(first)
    expect(countUnreadFeedItems(db, '1')).toBe(0)
  })

  it('reports a missing item instead of silently succeeding, and never reads a foreign one', () => {
    const mine = add('1')
    expect(markFeedItemRead(db, '1', 'missing')).toBe(false)
    expect(markFeedItemRead(db, '2', mine.id)).toBe(false)
    expect(getFeedItem(db, '1', mine.id)!.readAt).toBeNull()
  })

  it('read-all only touches the calling user', () => {
    add('1'); add('1'); add('2')
    expect(markAllFeedItemsRead(db, '1')).toBe(2)
    expect(countUnreadFeedItems(db, '1')).toBe(0)
    expect(countUnreadFeedItems(db, '2')).toBe(1)
    expect(markAllFeedItemsRead(db, '1')).toBe(0)
  })
})
