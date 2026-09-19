/**
 * Offtangent Stufe 1 (threads): `sessions` gains `title`, `pinned`,
 * `archived`.
 *
 * The migration must be idempotent — `initDatabase` runs on EVERY boot against
 * the same file. A non-guarded `ALTER TABLE` would throw "duplicate column
 * name" on the second start and take the whole process down, and a rebuild of
 * the table (type-CHECK recreation path) must not silently drop the columns
 * or the rows' thread metadata.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'

describe('sessions thread columns migration', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-threads-migration-'))
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

  it('adds title/pinned/archived with the documented defaults', () => {
    const db = initDatabase(dbPath)
    try {
      const cols = columns(db)
      expect(cols.title).toMatchObject({ type: 'TEXT' })
      expect(cols.pinned).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' })
      expect(cols.archived).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' })
    } finally {
      db.close()
    }
  })

  it('is idempotent on an already-migrated database and keeps the data', () => {
    const first = initDatabase(dbPath)
    first.prepare(
      "INSERT INTO sessions (id, source, type, session_user, agent_id, title, pinned, archived) VALUES ('11111111-1111-4111-8111-111111111111', 'web', 'interactive', '1', 'bob', 'Deploy notes', 1, 0)",
    ).run()
    first.close()

    // Second boot against the same file: must not throw.
    const second = initDatabase(dbPath)
    try {
      const row = second.prepare('SELECT title, pinned, archived FROM sessions WHERE id = ?').get('11111111-1111-4111-8111-111111111111') as
        { title: string; pinned: number; archived: number }
      expect(row).toEqual({ title: 'Deploy notes', pinned: 1, archived: 0 })
      expect(Object.keys(columns(second))).toEqual(expect.arrayContaining(['title', 'pinned', 'archived']))
    } finally {
      second.close()
    }

    // And a third time, for good measure (boot loops are real).
    const third = initDatabase(dbPath)
    third.close()
  })

  it('defaults existing rows to unpinned/unarchived/untitled', () => {
    const db = initDatabase(dbPath)
    try {
      db.prepare("INSERT INTO sessions (id, source, type, session_user) VALUES ('22222222-2222-4222-8222-222222222222', 'web', 'interactive', '1')").run()
      const row = db.prepare('SELECT title, pinned, archived FROM sessions WHERE id = ?').get('22222222-2222-4222-8222-222222222222') as
        { title: string | null; pinned: number; archived: number }
      expect(row).toEqual({ title: null, pinned: 0, archived: 0 })
    } finally {
      db.close()
    }
  })

  it('survives the legacy type-CHECK table rebuild (columns added after it)', () => {
    // Simulate a pre-CHECK database: sessions without the type CHECK
    // constraint, which makes initDatabase rebuild the table.
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
      INSERT INTO sessions (id, source, type, session_user, agent_id) VALUES ('33333333-3333-4333-8333-333333333333', 'web', 'interactive', '1', 'bob');
    `)
    legacy.close()

    const migrated = initDatabase(dbPath)
    try {
      const cols = columns(migrated)
      expect(cols.title).toBeDefined()
      expect(cols.pinned).toBeDefined()
      expect(cols.archived).toBeDefined()
      const row = migrated.prepare('SELECT agent_id, pinned, archived FROM sessions WHERE id = ?').get('33333333-3333-4333-8333-333333333333') as
        { agent_id: string; pinned: number; archived: number }
      expect(row).toEqual({ agent_id: 'bob', pinned: 0, archived: 0 })
    } finally {
      migrated.close()
    }
  })
})
