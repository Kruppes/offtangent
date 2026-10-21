/**
 * Strand title provenance (plan strand-titel, Paket 4): `sessions` gains
 * `title_source`, `title_updated_at`, `auto_title_changes`, `previous_title`.
 *
 * What these pin down:
 *   - every title that existed before the migration becomes 'derived' (the
 *     auto-title may replace it), untitled rows stay NULL, nothing else in
 *     the row changes;
 *   - the migration is idempotent: a second boot neither throws nor resets a
 *     source that was set after the first boot (a 'manual' must survive);
 *   - the CHECK rejects unknown sources;
 *   - the columns survive the legacy type-CHECK table rebuild.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'

const TITLE_COLUMNS = ['title_source', 'title_updated_at', 'auto_title_changes', 'previous_title']

describe('sessions title source migration', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-title-source-migration-'))
    dbPath = path.join(tmpDir, 'axiom.db')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function columns(db: Database): Record<string, { type: string; notnull: number; dflt_value: string | null }> {
    const rows = db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null
    }>
    return Object.fromEntries(rows.map(r => [r.name, { type: r.type, notnull: r.notnull, dflt_value: r.dflt_value }]))
  }

  /** A database as it looked before Paket 4: same schema minus the four columns. */
  function preMigrationDatabase(seed: (db: Database) => void): void {
    const db = initDatabase(dbPath)
    for (const column of TITLE_COLUMNS) db.exec(`ALTER TABLE sessions DROP COLUMN ${column}`)
    expect(Object.keys(columns(db))).not.toEqual(expect.arrayContaining(['title_source']))
    seed(db)
    db.close()
  }

  it('adds the four columns with the documented types and defaults', () => {
    const db = initDatabase(dbPath)
    try {
      const cols = columns(db)
      expect(cols.title_source).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
      expect(cols.title_updated_at).toMatchObject({ type: 'TEXT', notnull: 0 })
      expect(cols.auto_title_changes).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' })
      expect(cols.previous_title).toMatchObject({ type: 'TEXT', notnull: 0 })
    } finally {
      db.close()
    }
  })

  it('backfills existing titles as derived and leaves untitled rows and other data alone', () => {
    preMigrationDatabase(db => {
      const insert = db.prepare(
        "INSERT INTO sessions (id, source, type, session_user, agent_id, title, pinned, archived) VALUES (?, 'web', ?, '1', 'main', ?, ?, ?)",
      )
      insert.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'interactive', 'Hausordnung planen', 1, 0)
      insert.run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'interactive', null, 0, 0)
      insert.run('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'interactive', '   ', 0, 1)
      insert.run('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'task', 'Nightly digest', 0, 0)
    })

    const db = initDatabase(dbPath)
    try {
      const rows = db.prepare(
        'SELECT id, title, pinned, archived, title_source, title_updated_at, auto_title_changes, previous_title FROM sessions ORDER BY id',
      ).all()
      expect(rows).toEqual([
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Hausordnung planen', pinned: 1, archived: 0, title_source: 'derived', title_updated_at: null, auto_title_changes: 0, previous_title: null },
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: null, pinned: 0, archived: 0, title_source: null, title_updated_at: null, auto_title_changes: 0, previous_title: null },
        { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: '   ', pinned: 0, archived: 1, title_source: null, title_updated_at: null, auto_title_changes: 0, previous_title: null },
        { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: 'Nightly digest', pinned: 0, archived: 0, title_source: 'derived', title_updated_at: null, auto_title_changes: 0, previous_title: null },
      ])
    } finally {
      db.close()
    }
  })

  it('is idempotent and never resets a source set after the first boot', () => {
    preMigrationDatabase(db => {
      db.prepare("INSERT INTO sessions (id, source, type, session_user, title) VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'web', 'interactive', '1', 'Old title')").run()
    })
    const first = initDatabase(dbPath)
    first.prepare("UPDATE sessions SET title = 'My name', title_source = 'manual' WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'").run()
    first.close()

    const second = initDatabase(dbPath)
    try {
      expect(second.prepare("SELECT title, title_source FROM sessions WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'").get())
        .toEqual({ title: 'My name', title_source: 'manual' })
    } finally {
      second.close()
    }
    initDatabase(dbPath).close()
  })

  it('rejects an unknown title source', () => {
    const db = initDatabase(dbPath)
    try {
      expect(() => db.prepare(
        "INSERT INTO sessions (id, source, type, session_user, title, title_source) VALUES ('99999999-9999-4999-8999-999999999999', 'web', 'interactive', '1', 'T', 'router')",
      ).run()).toThrow(/CHECK/)
    } finally {
      db.close()
    }
  })

  it('survives the legacy type-CHECK table rebuild (columns added after it)', () => {
    const legacy = initDatabase(dbPath)
    legacy.exec(`
      DROP TABLE sessions;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        source TEXT NOT NULL DEFAULT 'web',
        type TEXT NOT NULL DEFAULT 'interactive',
        parent_session_id TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        summary_written INTEGER NOT NULL DEFAULT 0,
        last_activity TEXT,
        session_user TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT NOT NULL DEFAULT 'main'
      );
      INSERT INTO sessions (id, source, type, session_user) VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'web', 'interactive', '1');
    `)
    legacy.close()

    const migrated = initDatabase(dbPath)
    try {
      expect(Object.keys(columns(migrated))).toEqual(expect.arrayContaining(TITLE_COLUMNS))
      expect(migrated.prepare("SELECT title_source, auto_title_changes FROM sessions WHERE id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'").get())
        .toEqual({ title_source: null, auto_title_changes: 0 })
    } finally {
      migrated.close()
    }
  })
})
