/**
 * Regression test for the sessions-table rebuild during the upstream 0.27.0
 * merge (conflict database.ts §4.3).
 *
 * Risk: the CHECK-constraint recreation of `sessions` copies columns explicitly
 * via `INSERT INTO sessions (...) SELECT ... FROM sessions_old`. The fork adds
 * `agent_id`; upstream 0.27.0 adds `cache_read`/`cache_write`. A naive merge of
 * that INSERT would silently DROP one side's column (and its data) because the
 * rebuild is destructive (DROP TABLE sessions_old).
 *
 * This test builds a legacy DB whose `sessions.type` column has NO CHECK
 * constraint (so initDatabase MUST rebuild the table) and pre-seeds a row with
 * a non-'main' agent_id plus cache counters, then asserts:
 *   - all three columns exist after migration, and
 *   - the persona attribution AND the cache counters survived the rebuild.
 *
 * Against the buggy merge (agent_id dropped from the rebuild INSERT) the
 * agent_id assertion fails: the column is recreated with its DEFAULT 'main',
 * losing the persona attribution of every historical session.
 */
import { describe, it, expect, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { initDatabase } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('database sessions rebuild — persona + cache column preservation', () => {
  const tmpFiles: string[] = []
  afterEach(() => {
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${f}${suffix}`) } catch { /* ignore */ }
      }
    }
    tmpFiles.length = 0
  })

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-persona-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  it('preserves agent_id AND cache_read/cache_write when the sessions table is rebuilt', () => {
    const dbPath = tmpDbPath()
    const legacy = new BetterSqlite3(dbPath)
    legacy.pragma('foreign_keys = ON')
    // A sessions table that already carries agent_id + cache columns but whose
    // `type` column has NO CHECK constraint → forces the recreation path.
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user'
      );
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
        agent_id TEXT NOT NULL DEFAULT 'main',
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `)
    // UUID id so the legacy-id remap does not rewrite it.
    const sid = '11111111-2222-4333-8444-555555555555'
    legacy.prepare(
      `INSERT INTO sessions (id, source, type, prompt_tokens, completion_tokens, cache_read, cache_write, agent_id)
       VALUES (?, 'telegram', 'interactive', 10, 5, 111, 222, 'bob')`,
    ).run(sid)
    legacy.close()

    const db = initDatabase(dbPath)

    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('agent_id')
    expect(cols).toContain('cache_read')
    expect(cols).toContain('cache_write')

    const row = db.prepare(
      'SELECT agent_id, cache_read, cache_write, prompt_tokens, completion_tokens FROM sessions WHERE id = ?',
    ).get(sid) as {
      agent_id: string; cache_read: number; cache_write: number
      prompt_tokens: number; completion_tokens: number
    }
    // Persona attribution survived the destructive rebuild.
    expect(row.agent_id).toBe('bob')
    // Cache counters survived too.
    expect(row.cache_read).toBe(111)
    expect(row.cache_write).toBe(222)
    expect(row.prompt_tokens).toBe(10)
    expect(row.completion_tokens).toBe(5)

    db.close()
  })

  // Axiom-Companion M1: client_message_id is an idempotency key, unique per
  // user but only when present (legacy/Telegram/web-UI rows have none).
  it('adds chat_messages.client_message_id with a partial UNIQUE index per user', () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'a', 'x')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'b', 'x')
    const cols = (db.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('client_message_id')

    const insert = db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, client_message_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    insert.run('s', 1, 'user', 'one', 'bob', 'cm-1')
    // Same key, other user: allowed (key is scoped per user).
    insert.run('s', 2, 'user', 'one', 'bob', 'cm-1')
    // Rows without a key never collide.
    insert.run('s', 1, 'user', 'two', 'main', null)
    insert.run('s', 1, 'user', 'three', 'main', null)
    // Same user + same key: rejected.
    expect(() => insert.run('s', 1, 'user', 'dup', 'bob', 'cm-1')).toThrow(/UNIQUE/)

    db.close()
  })

  it('applies the client_message_id migration to a database created before it existed', () => {
    const db = initDatabase(':memory:')
    // Simulate an older schema: drop the column + index, then re-run migrations.
    db.exec('DROP INDEX IF EXISTS idx_chat_messages_client_message_id')
    db.exec('ALTER TABLE chat_messages DROP COLUMN client_message_id')
    let cols = (db.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[]).map(c => c.name)
    expect(cols).not.toContain('client_message_id')
    db.close()

    // initDatabase on the same file path is what production does on boot; for
    // :memory: we re-run the migration function through a fresh init on disk.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-cmid-'))
    const file = path.join(dir, 'axiom.db')
    const first = initDatabase(file)
    first.exec('DROP INDEX IF EXISTS idx_chat_messages_client_message_id')
    first.exec('ALTER TABLE chat_messages DROP COLUMN client_message_id')
    first.close()
    const second = initDatabase(file)
    cols = (second.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('client_message_id')
    const idx = second.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chat_messages_client_message_id'").get()
    expect(idx).toBeTruthy()
    second.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
