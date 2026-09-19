/**
 * Offtangent Stufe 2 (projects light): a `projects` table plus a nullable
 * `sessions.project_id`.
 *
 * Same contract as every other migration in this file's neighbourhood:
 * `initDatabase` runs on EVERY boot against the same file, so an unguarded
 * `ALTER TABLE` ("duplicate column name") would wedge the process on restart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'

describe('projects migration', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-projects-migration-'))
    dbPath = path.join(tmpDir, 'axiom.db')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function columns(db: Database, table: string): Record<string, { type: string; notnull: number; dflt_value: string | null }> {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null
    }>
    return Object.fromEntries(rows.map(r => [r.name, { type: r.type, notnull: r.notnull, dflt_value: r.dflt_value }]))
  }

  function indexNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(r => r.name)
  }

  it('creates the projects table with the documented shape', () => {
    const db = initDatabase(dbPath)
    try {
      const cols = columns(db, 'projects')
      expect(cols.id).toMatchObject({ type: 'TEXT' })
      expect(cols.user_id).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(cols.name).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(cols.color).toMatchObject({ type: 'TEXT', notnull: 0 })
      expect(cols.archived).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' })
      expect(cols.created_at).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(cols.updated_at).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(indexNames(db, 'projects')).toContain('idx_projects_user')
    } finally {
      db.close()
    }
  })

  it('adds sessions.project_id (nullable, no FK) and its index', () => {
    const db = initDatabase(dbPath)
    try {
      expect(columns(db, 'sessions').project_id).toMatchObject({ type: 'TEXT', notnull: 0 })
      expect(indexNames(db, 'sessions')).toContain('idx_sessions_project')
      // Deliberately no foreign key: deleting a project detaches threads in
      // application code, so SQLite must accept an id that is not (yet) known.
      const fks = db.prepare('PRAGMA foreign_key_list(sessions)').all() as Array<{ table: string; from: string }>
      expect(fks.find(fk => fk.from === 'project_id')).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('is idempotent across boots and keeps project data', () => {
    const first = initDatabase(dbPath)
    first.prepare(
      "INSERT INTO projects (id, user_id, name, color, archived) VALUES ('p-1', '1', 'Umzug', '#4f46e5', 0)",
    ).run()
    first.prepare(
      "INSERT INTO sessions (id, source, type, session_user, agent_id, project_id) VALUES ('44444444-4444-4444-8444-444444444444', 'web', 'interactive', '1', 'bob', 'p-1')",
    ).run()
    first.close()

    const second = initDatabase(dbPath)
    try {
      expect(second.prepare('SELECT name, color, archived FROM projects WHERE id = ?').get('p-1'))
        .toEqual({ name: 'Umzug', color: '#4f46e5', archived: 0 })
      expect(second.prepare('SELECT project_id FROM sessions WHERE id = ?').get('44444444-4444-4444-8444-444444444444'))
        .toEqual({ project_id: 'p-1' })
    } finally {
      second.close()
    }

    // Third boot, because boot loops are real.
    const third = initDatabase(dbPath)
    third.close()
  })

  it('defaults existing session rows to project_id NULL', () => {
    const db = initDatabase(dbPath)
    try {
      db.prepare("INSERT INTO sessions (id, source, type, session_user) VALUES ('55555555-5555-4555-8555-555555555555', 'web', 'interactive', '1')").run()
      expect(db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('55555555-5555-4555-8555-555555555555'))
        .toEqual({ project_id: null })
    } finally {
      db.close()
    }
  })

  it('survives the legacy type-CHECK table rebuild (column added after it)', () => {
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
      INSERT INTO sessions (id, source, type, session_user, agent_id) VALUES ('66666666-6666-4666-8666-666666666666', 'web', 'interactive', '1', 'bob');
    `)
    legacy.close()

    const migrated = initDatabase(dbPath)
    try {
      expect(columns(migrated, 'sessions').project_id).toBeDefined()
      expect(migrated.prepare('SELECT agent_id, project_id FROM sessions WHERE id = ?').get('66666666-6666-4666-8666-666666666666'))
        .toEqual({ agent_id: 'bob', project_id: null })
    } finally {
      migrated.close()
    }
  })
})
