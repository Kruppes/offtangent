/**
 * The `dismissed` capture status needs the one thing SQLite cannot do in
 * place: a wider CHECK constraint. So `captures` is rebuilt, and a rebuild is
 * the migration class that loses data when it is written carelessly.
 *
 * What is proven here:
 *   - a database with the OLD constraint accepts `dismissed` afterwards
 *   - every row survives the rebuild, including its metadata
 *   - a database that predates the `metadata` column survives too
 *   - the indexes are back (a rebuild drops them with the table)
 *   - running it again changes nothing (`initDatabase` runs on every boot)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase } from './database.js'

const OLD_CAPTURES = `
  CREATE TABLE captures (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT,
    client_message_id TEXT,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice','image','file')),
    source TEXT NOT NULL DEFAULT 'web',
    attachments TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','filed','needs_review','unsorted','moved','failed')),
    strand_id TEXT,
    message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    filed_at TEXT
  );
`

describe('dismissed status migration', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-dismissed-migration-'))
    dbPath = path.join(tmpDir, 'axiom.db')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** A pre-migration database with the old constraint and `count` captures. */
  function seedOld(count: number, withMetadata: boolean): void {
    const raw = new Database(dbPath)
    raw.exec(OLD_CAPTURES)
    if (withMetadata) raw.exec('ALTER TABLE captures ADD COLUMN metadata TEXT')
    const insert = raw.prepare(
      `INSERT INTO captures (id, user_id, text, kind, source, status, created_at${withMetadata ? ', metadata' : ''})
       VALUES (?, '1', ?, 'voice', 'puck', 'unsorted', ?${withMetadata ? ', ?' : ''})`,
    )
    for (let i = 0; i < count; i += 1) {
      const args: unknown[] = [`c${i}`, `* Musik * ${i}`, `2026-09-1${i % 9} 10:00:00`]
      if (withMetadata) args.push(JSON.stringify({ modelId: 'x' }))
      insert.run(...args)
    }
    raw.close()
  }

  it('widens the constraint and keeps every row', () => {
    seedOld(3, true)
    const db = initDatabase(dbPath)
    const rows = db.prepare('SELECT id, text, status, metadata FROM captures ORDER BY id').all() as Array<{ id: string; text: string; status: string; metadata: string | null }>
    expect(rows.length).toBe(3)
    expect(rows[0].text).toBe('* Musik * 0')
    expect(rows[0].metadata).toBe(JSON.stringify({ modelId: 'x' }))
    db.prepare("UPDATE captures SET status = 'dismissed' WHERE id = 'c0'").run()
    expect((db.prepare("SELECT status FROM captures WHERE id = 'c0'").get() as { status: string }).status).toBe('dismissed')
    db.close()
  })

  it('migrates a database that predates the metadata column', () => {
    seedOld(2, false)
    const db = initDatabase(dbPath)
    const cols = (db.prepare('PRAGMA table_info(captures)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('metadata')
    expect((db.prepare('SELECT COUNT(*) AS c FROM captures').get() as { c: number }).c).toBe(2)
    db.prepare("UPDATE captures SET status = 'dismissed'").run()
    db.close()
  })

  it('restores the indexes the rebuild dropped', () => {
    seedOld(1, true)
    const db = initDatabase(dbPath)
    const names = (db.prepare('PRAGMA index_list(captures)').all() as Array<{ name: string }>).map(r => r.name)
    expect(names).toContain('idx_captures_client_key')
    expect(names).toContain('idx_captures_status')
    db.close()
  })

  it('is a no-op on the second boot', () => {
    seedOld(2, true)
    let db = initDatabase(dbPath)
    const sqlAfterFirst = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'captures'").get() as { sql: string }).sql
    db.close()
    db = initDatabase(dbPath)
    const sqlAfterSecond = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'captures'").get() as { sql: string }).sql
    expect(sqlAfterSecond).toBe(sqlAfterFirst)
    expect((db.prepare('SELECT COUNT(*) AS c FROM captures').get() as { c: number }).c).toBe(2)
    db.close()
  })

  it('keeps an index nobody remembered', () => {
    // The rebuild replays what is in sqlite_master instead of a hardcoded
    // list, so an index added by hand (or by a later migration) survives.
    seedOld(1, true)
    const raw = new Database(dbPath)
    raw.exec('CREATE INDEX idx_captures_forgotten ON captures(created_at)')
    raw.close()
    const db = initDatabase(dbPath)
    expect((db.prepare('PRAGMA index_list(captures)').all() as Array<{ name: string }>).map(r => r.name))
      .toContain('idx_captures_forgotten')
    db.close()
  })

  it('produces the same table a fresh install gets', () => {
    // Drift between the two paths is the failure nobody notices until a
    // constraint differs between a migrated and a new database.
    seedOld(1, true)
    const migrated = initDatabase(dbPath)
    const migratedSql = (migrated.prepare("SELECT sql FROM sqlite_master WHERE name = 'captures'").get() as { sql: string }).sql
    migrated.close()
    const fresh = initDatabase(path.join(tmpDir, 'fresh.db'))
    const freshSql = (fresh.prepare("SELECT sql FROM sqlite_master WHERE name = 'captures'").get() as { sql: string }).sql
    fresh.close()
    // SQLite quotes the table name when a RENAME produces it (`CREATE TABLE
    // "captures"`), so the comparison normalises whitespace and that one pair
    // of quotes. Everything else — columns, defaults, the status CHECK — has
    // to match character for character.
    const normalise = (sql: string) => sql.replace(/\s+/g, ' ').replace('"captures"', 'captures')
    expect(normalise(migratedSql)).toBe(normalise(freshSql))
  })

  it('refuses to rebuild a table it would silently change', () => {
    // A column this code does not know about would be dropped by the copy,
    // and a trigger would be dropped with the table. Both must stop the boot
    // instead of losing something quietly.
    seedOld(1, true)
    const raw = new Database(dbPath)
    raw.exec('ALTER TABLE captures ADD COLUMN local_audio_path TEXT')
    raw.close()
    expect(() => initDatabase(dbPath)).toThrow(/unknown column/)

    const second = path.join(tmpDir, 'trigger.db')
    const withTrigger = new Database(second)
    withTrigger.exec(OLD_CAPTURES)
    withTrigger.exec("CREATE TRIGGER captures_audit AFTER INSERT ON captures BEGIN SELECT 1; END")
    withTrigger.close()
    expect(() => initDatabase(second)).toThrow(/unexpected trigger/)
  })

  it('rejects a status that is still not allowed', () => {
    seedOld(1, true)
    const db = initDatabase(dbPath)
    expect(() => db.prepare("UPDATE captures SET status = 'nonsense'").run()).toThrow()
    db.close()
  })
})
