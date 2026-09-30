/**
 * Boards widen the `kind` CHECK of `feed_items` and add three columns, so the
 * table has to be rebuilt — the migration class that loses data when it is
 * written carelessly (see `database.dismissed-migration.test.ts` for the
 * `captures` version of the same problem).
 *
 * What is proven here:
 *   - a database with the OLD shape accepts `board_update` afterwards
 *   - every row survives, with its id, its values AND its rowid (the feed
 *     cursor is the rowid: a reordering rebuild would break every `since_id`)
 *   - the new columns arrive with their defaults
 *   - the partial unique index on (user_id, dedupe_key) exists and allows
 *     many NULLs but only one value per user
 *   - `idx_feed_user_created` is back (a rebuild drops the indexes with the
 *     table)
 *   - running it again changes nothing (`initDatabase` runs on every boot)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase } from './database.js'

const OLD_FEED_ITEMS = `
  CREATE TABLE feed_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT,
    kind TEXT NOT NULL
      CHECK(kind IN ('task_result','task_question','cron_report','heartbeat','reminder','system')),
    title TEXT NOT NULL,
    body TEXT,
    task_id TEXT,
    strand_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT
  );
  CREATE INDEX idx_feed_user_created ON feed_items(user_id, created_at DESC);
`

describe('feed_items board migration', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-board-feed-migration-'))
    dbPath = path.join(tmpDir, 'axiom.db')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** A pre-migration database with the old shape and `count` feed items. */
  function seedOld(count: number): void {
    const raw = new Database(dbPath)
    raw.exec(OLD_FEED_ITEMS)
    const insert = raw.prepare(
      `INSERT INTO feed_items (id, user_id, agent_id, kind, title, body, task_id, strand_id, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const write = raw.transaction(() => {
      for (let i = 0; i < count; i++) {
        insert.run(
          `item-${i}`,
          String((i % 3) + 1),
          'main',
          i % 2 === 0 ? 'cron_report' : 'task_result',
          `Item ${i}`,
          i % 5 === 0 ? null : `Body ${i}`,
          `task-${i}`,
          i % 4 === 0 ? null : `strand-${i}`,
          '2026-09-20 06:00:00',
          i % 7 === 0 ? '2026-09-20 07:00:00' : null,
        )
      }
    })
    write()
    raw.close()
  }

  it('preserves every row, its id and its rowid, and adds the new shape', () => {
    seedOld(25)
    const before = new Database(dbPath)
    const rowidsBefore = before.prepare('SELECT rowid AS rid, id FROM feed_items ORDER BY rowid').all()
    before.close()

    const db = initDatabase(dbPath)
    try {
      const rowidsAfter = db.prepare('SELECT rowid AS rid, id FROM feed_items ORDER BY rowid').all()
      expect(rowidsAfter).toEqual(rowidsBefore)
      expect(db.prepare('SELECT COUNT(*) AS c FROM feed_items').get()).toEqual({ c: 25 })

      // Values survive unchanged, new columns carry their defaults.
      expect(db.prepare('SELECT * FROM feed_items WHERE id = ?').get('item-1')).toMatchObject({
        id: 'item-1', user_id: '2', agent_id: 'main', kind: 'task_result', title: 'Item 1',
        body: 'Body 1', task_id: 'task-1', strand_id: 'strand-1',
        created_at: '2026-09-20 06:00:00', read_at: null,
        notify: 0, dedupe_key: null, board_key: null,
      })
      expect(db.prepare('SELECT read_at FROM feed_items WHERE id = ?').get('item-0'))
        .toEqual({ read_at: '2026-09-20 07:00:00' })

      // The whole point: the new kind is accepted now.
      db.prepare(
        `INSERT INTO feed_items (id, user_id, kind, title, notify, board_key)
         VALUES ('board-1', '1', 'board_update', 'Portfolio', 1, 'portfolio')`,
      ).run()
      expect(db.prepare('SELECT notify, board_key FROM feed_items WHERE id = ?').get('board-1'))
        .toEqual({ notify: 1, board_key: 'portfolio' })

      // …and an invented kind is still rejected.
      expect(() => db.prepare(
        "INSERT INTO feed_items (id, user_id, kind, title) VALUES ('nope', '1', 'invented', 'X')",
      ).run()).toThrow(/CHECK constraint failed/)

      const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='feed_items'")
        .all() as { name: string }[]).map(r => r.name)
      expect(indexes).toContain('idx_feed_user_created')
      expect(indexes).toContain('idx_feed_dedupe')
    } finally {
      db.close()
    }
  })

  it('is idempotent: a second run keeps rows, ids and rowids identical', () => {
    seedOld(10)
    const first = initDatabase(dbPath)
    first.prepare(
      `INSERT INTO feed_items (id, user_id, kind, title, notify, dedupe_key, board_key)
       VALUES ('board-1', '1', 'board_update', 'Portfolio', 1, 'run-1', 'portfolio')`,
    ).run()
    const snapshot = first.prepare('SELECT rowid AS rid, * FROM feed_items ORDER BY rowid').all()
    const tableSql = first.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='feed_items'").get()
    first.close()

    const second = initDatabase(dbPath)
    try {
      expect(second.prepare('SELECT rowid AS rid, * FROM feed_items ORDER BY rowid').all()).toEqual(snapshot)
      expect(second.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='feed_items'").get())
        .toEqual(tableSql)
      // No leftover scaffolding from the rebuild.
      expect(second.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_migrated'").all()).toEqual([])
    } finally {
      second.close()
    }
  })

  it('lets many items have no dedupe key but only one item per user and key', () => {
    const db = initDatabase(dbPath)
    try {
      const insert = db.prepare(
        `INSERT INTO feed_items (id, user_id, kind, title, dedupe_key) VALUES (?, ?, 'board_update', 'X', ?)`,
      )
      insert.run('a', '1', null)
      insert.run('b', '1', null)
      insert.run('c', '1', 'run-1')
      // Another user may use the same key…
      insert.run('d', '2', 'run-1')
      // …the same user may not.
      expect(() => insert.run('e', '1', 'run-1')).toThrow(/UNIQUE constraint failed/)
      expect(db.prepare('SELECT COUNT(*) AS c FROM feed_items').get()).toEqual({ c: 4 })
    } finally {
      db.close()
    }
  })

  it('refuses to rebuild a table that carries unknown columns instead of dropping them', () => {
    const raw = new Database(dbPath)
    raw.exec(OLD_FEED_ITEMS)
    raw.exec('ALTER TABLE feed_items ADD COLUMN surprise TEXT')
    raw.close()
    expect(() => initDatabase(dbPath)).toThrow(/unknown column\(s\) surprise/)
  })
})
