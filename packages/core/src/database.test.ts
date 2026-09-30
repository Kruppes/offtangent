import { describe, it, expect, afterEach, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { initDatabase, isValidUsername, validateUsername } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('database', () => {
  const tmpFiles: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${f}${suffix}`) } catch { /* ignore */ }
      }
    }
    tmpFiles.length = 0
  })

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  function createLegacyDatabase(dbPath: string): void {
    const legacyDb = new BetterSqlite3(dbPath)
    legacyDb.pragma('foreign_keys = ON')
    legacyDb.exec(`
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
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        summary_written INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id INTEGER,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `)

    legacyDb.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ).run('legacy-user', 'hash')

    legacyDb.prepare(
      'INSERT INTO sessions (id, user_id, source, started_at, message_count, summary_written) VALUES (?, ?, ?, datetime(\'now\'), ?, ?)'
    ).run('legacy-session', 1, 'web', 2, 0)

    legacyDb.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)'
    ).run('legacy-session', 1, 'user', 'Legacy Übersicht message')

    legacyDb.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)'
    ).run('legacy-session', 1, 'assistant', 'Second legacy reply')

    legacyDb.close()
  }

  it('creates database with new schema, virtual tables, triggers, and indexes', () => {
    const db = initDatabase(tmpDbPath())

    const objects = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).all() as { type: string, name: string }[]

    const objectNames = new Set(objects.map(obj => `${obj.type}:${obj.name}`))
    expect(objectNames).toContain('table:token_usage')
    expect(objectNames).toContain('table:tool_calls')
    expect(objectNames).toContain('table:users')
    expect(objectNames).toContain('table:sessions')
    expect(objectNames).toContain('table:memories')
    expect(objectNames).toContain('table:memories_fts')
    expect(objectNames).toContain('table:chat_messages')
    expect(objectNames).toContain('table:chat_messages_fts')
    expect(objectNames).toContain('table:health_checks')
    expect(objectNames).toContain('index:idx_memories_user')
    expect(objectNames).toContain('index:idx_memories_timestamp')
    expect(objectNames).toContain('index:idx_memories_session')
    expect(objectNames).toContain('trigger:memories_fts_insert')
    expect(objectNames).toContain('trigger:memories_fts_delete')
    expect(objectNames).toContain('trigger:memories_fts_update')
    expect(objectNames).toContain('trigger:chat_messages_fts_insert')
    expect(objectNames).toContain('trigger:chat_messages_fts_delete')
    expect(objectNames).toContain('trigger:chat_messages_fts_update')

    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    expect(sessionCols.map(col => col.name)).toContain('prompt_tokens')
    expect(sessionCols.map(col => col.name)).toContain('completion_tokens')
    expect(sessionCols.map(col => col.name)).toContain('cache_read')
    expect(sessionCols.map(col => col.name)).toContain('cache_write')
    expect(sessionCols.map(col => col.name)).toContain('model_id')
    expect(sessionCols.map(col => col.name)).toContain('model_provider_id')

    const tokenUsageCols = db.prepare('PRAGMA table_info(token_usage)').all() as { name: string }[]
    expect(tokenUsageCols.map(col => col.name)).toContain('cache_read')
    expect(tokenUsageCols.map(col => col.name)).toContain('cache_write')

    db.prepare(
      'INSERT INTO sessions (id, source) VALUES (?, ?)'
    ).run('fresh-session', 'web')

    const session = db.prepare(
      'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
    ).get('fresh-session') as { prompt_tokens: number, completion_tokens: number }
    expect(session.prompt_tokens).toBe(0)
    expect(session.completion_tokens).toBe(0)

    db.close()
  })

  it('migrates an existing database and backfills chat_messages_fts idempotently', () => {
    const dbPath = tmpDbPath()
    createLegacyDatabase(dbPath)

    let db = initDatabase(dbPath)

    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    expect(sessionCols.map(col => col.name)).toContain('prompt_tokens')
    expect(sessionCols.map(col => col.name)).toContain('completion_tokens')
    expect(sessionCols.map(col => col.name)).toContain('cache_read')
    expect(sessionCols.map(col => col.name)).toContain('cache_write')
    expect(sessionCols.map(col => col.name)).toContain('model_id')
    expect(sessionCols.map(col => col.name)).toContain('model_provider_id')

    const tokenUsageCols = db.prepare('PRAGMA table_info(token_usage)').all() as { name: string }[]
    expect(tokenUsageCols.map(col => col.name)).toContain('cache_read')
    expect(tokenUsageCols.map(col => col.name)).toContain('cache_write')

    // After PRD #11 Task 2 migration, the legacy session id is remapped to a UUID.
    const migratedSessions = db.prepare(
      'SELECT id, prompt_tokens, completion_tokens FROM sessions'
    ).all() as Array<{ id: string, prompt_tokens: number, completion_tokens: number }>
    expect(migratedSessions).toHaveLength(1)
    expect(migratedSessions[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(migratedSessions[0].prompt_tokens).toBe(0)
    expect(migratedSessions[0].completion_tokens).toBe(0)
    // chat_messages FK must have been remapped to the new UUID.
    const remappedChatSessions = db.prepare(
      'SELECT DISTINCT session_id FROM chat_messages'
    ).all() as Array<{ session_id: string }>
    expect(remappedChatSessions).toHaveLength(1)
    expect(remappedChatSessions[0].session_id).toBe(migratedSessions[0].id)

    const migratedObjects = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name IN ('memories', 'memories_fts', 'chat_messages_fts', 'chat_messages_fts_insert', 'chat_messages_fts_delete', 'chat_messages_fts_update') ORDER BY type, name"
    ).all() as { type: string, name: string }[]
    expect(migratedObjects).toEqual([
      { type: 'table', name: 'chat_messages_fts' },
      { type: 'table', name: 'memories' },
      { type: 'table', name: 'memories_fts' },
      { type: 'trigger', name: 'chat_messages_fts_delete' },
      { type: 'trigger', name: 'chat_messages_fts_insert' },
      { type: 'trigger', name: 'chat_messages_fts_update' },
    ])

    const backfilledRows = db.prepare(
      'SELECT rowid, content FROM chat_messages_fts ORDER BY rowid'
    ).all() as { rowid: number, content: string }[]
    expect(backfilledRows).toHaveLength(2)
    expect(backfilledRows[0].content).toBe('Legacy Übersicht message')
    expect(backfilledRows[1].content).toBe('Second legacy reply')

    db.close()

    db = initDatabase(dbPath)
    const backfilledCount = db.prepare('SELECT COUNT(*) as count FROM chat_messages_fts').get() as { count: number }
    expect(backfilledCount.count).toBe(2)

    const legacyMatches = db.prepare(
      "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'ubersicht'"
    ).all() as { rowid: number }[]
    expect(legacyMatches.map(row => row.rowid)).toEqual([1])

    db.close()
  })

  it('rebuilds FTS indexes only when the virtual tables are first created', () => {
    const execSpy = vi.spyOn(BetterSqlite3.prototype, 'exec')
    const dbPath = tmpDbPath()

    let db = initDatabase(dbPath)
    db.prepare(
      'INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)'
    ).run('session-fts', 'user', 'hello world')
    db.prepare(
      'INSERT INTO memories (session_id, content) VALUES (?, ?)'
    ).run('session-fts', 'remember this')
    db.close()

    const firstMemoriesRebuildCount = execSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
    ).length
    const firstChatMessagesRebuildCount = execSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild')")
    ).length

    db = initDatabase(dbPath)

    const totalMemoriesRebuildCount = execSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
    ).length
    const totalChatMessagesRebuildCount = execSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild')")
    ).length

    expect(firstMemoriesRebuildCount).toBe(1)
    expect(firstChatMessagesRebuildCount).toBe(1)
    expect(totalMemoriesRebuildCount).toBe(1)
    expect(totalChatMessagesRebuildCount).toBe(1)

    const chatMatch = db.prepare(
      "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'hello'"
    ).all() as { rowid: number }[]
    expect(chatMatch).toHaveLength(1)

    const memoryMatch = db.prepare(
      "SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'remember'"
    ).all() as { rowid: number }[]
    expect(memoryMatch).toHaveLength(1)

    db.close()
    execSpy.mockRestore()
  })

  it('backfills session token counters from existing token_usage rows', () => {
    const dbPath = tmpDbPath()
    const legacyDb = new BetterSqlite3(dbPath)
    legacyDb.pragma('foreign_keys = ON')
    legacyDb.exec(`
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
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        summary_written INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        session_id TEXT
      );
    `)

    legacyDb.prepare(
      'INSERT INTO sessions (id, source) VALUES (?, ?)'
    ).run('legacy-with-usage', 'web')
    legacyDb.prepare(
      'INSERT INTO sessions (id, source) VALUES (?, ?)'
    ).run('legacy-without-usage', 'web')

    legacyDb.prepare(
      'INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('openai', 'gpt-4o', 100, 40, 0.001, 'legacy-with-usage')
    legacyDb.prepare(
      'INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('openai', 'gpt-4o-mini', 25, 10, 0.0002, 'legacy-with-usage')
    legacyDb.prepare(
      'INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES (?, ?, ?, ?, ?)'
    ).run('anthropic', 'claude-3-5-sonnet-20241022', 50, 20, 0.002)

    legacyDb.close()

    let db = initDatabase(dbPath)

    // After PRD #11 Task 2 migration the ids are remapped to UUIDs. Resolve the
    // new id for 'legacy-with-usage' via the token_usage FK, which is also remapped.
    const withUsageSessionId = (db.prepare(
      "SELECT session_id FROM token_usage WHERE provider = 'openai' AND model = 'gpt-4o' LIMIT 1"
    ).get() as { session_id: string }).session_id
    expect(withUsageSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    const backfilledSession = db.prepare(
      'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
    ).get(withUsageSessionId) as { prompt_tokens: number, completion_tokens: number }
    expect(backfilledSession.prompt_tokens).toBe(125)
    expect(backfilledSession.completion_tokens).toBe(50)

    // There must be a second session remapped from 'legacy-without-usage' with zero tokens.
    const allSessions = db.prepare(
      'SELECT id, prompt_tokens, completion_tokens FROM sessions ORDER BY id'
    ).all() as Array<{ id: string, prompt_tokens: number, completion_tokens: number }>
    expect(allSessions).toHaveLength(2)
    const untouchedSession = allSessions.find(s => s.id !== withUsageSessionId)!
    expect(untouchedSession.prompt_tokens).toBe(0)
    expect(untouchedSession.completion_tokens).toBe(0)

    db.close()

    db = initDatabase(dbPath)
    const idempotentSession = db.prepare(
      'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
    ).get(withUsageSessionId) as { prompt_tokens: number, completion_tokens: number }
    expect(idempotentSession.prompt_tokens).toBe(125)
    expect(idempotentSession.completion_tokens).toBe(50)

    db.close()
  })

  it('can insert and query token_usage', () => {
    const db = initDatabase(tmpDbPath())

    db.prepare(
      'INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?)'
    ).run('openai', 'gpt-4', 100, 50)

    const rows = db.prepare('SELECT * FROM token_usage').all() as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0].provider).toBe('openai')
    expect(rows[0].prompt_tokens).toBe(100)

    db.close()
  })

  it('keeps chat_messages_fts in sync on insert, update, and delete', () => {
    const db = initDatabase(tmpDbPath())

    const insertResult = db.prepare(
      "INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)"
    ).run('session-fts', 'user', 'Initial message')
    const messageId = Number(insertResult.lastInsertRowid)

    let ftsRow = db.prepare(
      'SELECT rowid, content FROM chat_messages_fts WHERE rowid = ?'
    ).get(messageId) as { rowid: number, content: string } | undefined
    expect(ftsRow).toEqual({ rowid: messageId, content: 'Initial message' })

    db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run('Updated Übersicht', messageId)

    ftsRow = db.prepare(
      'SELECT rowid, content FROM chat_messages_fts WHERE rowid = ?'
    ).get(messageId) as { rowid: number, content: string } | undefined
    expect(ftsRow).toEqual({ rowid: messageId, content: 'Updated Übersicht' })

    const matches = db.prepare(
      "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'ubersicht'"
    ).all() as { rowid: number }[]
    expect(matches.map(row => row.rowid)).toEqual([messageId])

    const prefixMatches = db.prepare(
      "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'über*'"
    ).all() as { rowid: number }[]
    expect(prefixMatches.map(row => row.rowid)).toEqual([messageId])

    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(messageId)

    const deletedRow = db.prepare(
      'SELECT rowid FROM chat_messages_fts WHERE rowid = ?'
    ).get(messageId)
    expect(deletedRow).toBeUndefined()

    db.close()
  })

  it('keeps memories_fts in sync on insert, update, and delete', () => {
    const db = initDatabase(tmpDbPath())

    const insertResult = db.prepare(
      'INSERT INTO memories (session_id, content) VALUES (?, ?)'
    ).run('memory-session', 'Remember this detail')
    const memoryId = Number(insertResult.lastInsertRowid)

    let ftsRow = db.prepare(
      'SELECT rowid, content FROM memories_fts WHERE rowid = ?'
    ).get(memoryId) as { rowid: number, content: string } | undefined
    expect(ftsRow).toEqual({ rowid: memoryId, content: 'Remember this detail' })

    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('Updated memory detail', memoryId)
    ftsRow = db.prepare(
      'SELECT rowid, content FROM memories_fts WHERE rowid = ?'
    ).get(memoryId) as { rowid: number, content: string } | undefined
    expect(ftsRow).toEqual({ rowid: memoryId, content: 'Updated memory detail' })

    const matches = db.prepare(
      "SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'updated'"
    ).all() as { rowid: number }[]
    expect(matches.map(row => row.rowid)).toEqual([memoryId])

    db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId)
    const deletedRow = db.prepare(
      'SELECT rowid FROM memories_fts WHERE rowid = ?'
    ).get(memoryId)
    expect(deletedRow).toBeUndefined()

    db.close()
  })

  it('can insert and query users', () => {
    const db = initDatabase(tmpDbPath())

    db.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).run('admin', 'hash123', 'admin')

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get('admin') as Record<string, unknown>
    expect(user.username).toBe('admin')
    expect(user.role).toBe('admin')

    db.close()
  })

  describe('username validation', () => {
    it('accepts valid alphanumeric usernames', () => {
      expect(isValidUsername('stefan')).toBe(true)
      expect(isValidUsername('Stefan')).toBe(true)
      expect(isValidUsername('admin123')).toBe(true)
      expect(isValidUsername('ABC')).toBe(true)
      expect(isValidUsername('user42')).toBe(true)
    })

    it('rejects usernames with spaces', () => {
      expect(isValidUsername('stefan müller')).toBe(false)
      expect(isValidUsername('john doe')).toBe(false)
    })

    it('rejects usernames with umlauts', () => {
      expect(isValidUsername('müller')).toBe(false)
      expect(isValidUsername('schön')).toBe(false)
      expect(isValidUsername('über')).toBe(false)
    })

    it('rejects usernames with special characters', () => {
      expect(isValidUsername('user@name')).toBe(false)
      expect(isValidUsername('user-name')).toBe(false)
      expect(isValidUsername('user_name')).toBe(false)
      expect(isValidUsername('user.name')).toBe(false)
      expect(isValidUsername('user!')).toBe(false)
    })

    it('rejects empty usernames', () => {
      expect(isValidUsername('')).toBe(false)
    })

    it('validateUsername throws for invalid usernames', () => {
      expect(() => validateUsername('stefan')).not.toThrow()
      expect(() => validateUsername('invalid user')).toThrow(/only alphanumeric/)
      expect(() => validateUsername('müller')).toThrow(/only alphanumeric/)
    })
  })

  it('enforces foreign key on sessions', () => {
    const db = initDatabase(tmpDbPath())

    // Insert user first
    db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ).run('testuser', 'hash')

    // Insert valid session
    db.prepare(
      "INSERT INTO sessions (id, user_id, source) VALUES (?, ?, ?)"
    ).run('session-1', 1, 'telegram')

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('session-1') as Record<string, unknown>
    expect(session.source).toBe('telegram')

    db.close()
  })

  describe('PRD #11 Task 2 — legacy session id → UUID migration', () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    function seedLegacySessions(dbPath: string, rows: Array<{
      id: string
      source?: string
      userId?: number | null
      parent?: string | null
      withChatMessage?: boolean
      withTokenUsage?: boolean
      withToolCall?: boolean
      withTask?: boolean
      withMemory?: boolean
    }>): void {
      const seed = new BetterSqlite3(dbPath)
      seed.pragma('foreign_keys = OFF')
      seed.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          user_id INTEGER,
          source TEXT NOT NULL DEFAULT 'web',
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          summary_written INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, user_id INTEGER, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')), content TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (datetime('now')), provider TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0.0, session_id TEXT);
        CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (datetime('now')), session_id TEXT, tool_name TEXT NOT NULL, input TEXT, output TEXT, duration_ms INTEGER);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed')), trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user','agent','cronjob','heartbeat','consolidation')), trigger_source_id TEXT, provider TEXT, model TEXT, max_duration_minutes INTEGER, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0.0, tool_call_count INTEGER NOT NULL DEFAULT 0, result_summary TEXT, result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed','failed','question','silent')), error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT, session_id TEXT);
        CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, session_id TEXT, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'session', timestamp TEXT NOT NULL DEFAULT (datetime('now')));
      `)
      seed.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('alice', 'hash')
      for (const row of rows) {
        seed.prepare(
          "INSERT INTO sessions (id, user_id, source, started_at, message_count, summary_written) VALUES (?, ?, ?, datetime('now'), 0, 0)"
        ).run(row.id, row.userId !== undefined ? row.userId : 1, row.source ?? 'web')
        if (row.withChatMessage) {
          seed.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'hi')").run(row.id)
        }
        if (row.withTokenUsage) {
          seed.prepare("INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, session_id) VALUES ('openai','gpt-4',10,5,?)").run(row.id)
        }
        if (row.withToolCall) {
          seed.prepare("INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms) VALUES (?, 'test', '{}', 'ok', 1)").run(row.id)
        }
        if (row.withTask) {
          seed.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, session_id) VALUES (?, 'n', 'p', 'running', 'user', ?)").run('task-row-' + row.id, row.id)
        }
        if (row.withMemory) {
          seed.prepare("INSERT INTO memories (user_id, session_id, content) VALUES (1, ?, 'mem')").run(row.id)
        }
      }
      seed.close()
    }

    it('remaps existing legacy session ids to UUIDs and backfills type from prefix', () => {
      const dbPath = tmpDbPath()
      seedLegacySessions(dbPath, [
        { id: 'session-alice-123', withChatMessage: true, withTokenUsage: true },
        { id: 'web-alice-456', withChatMessage: true },
        { id: 'task-abc', withToolCall: true, withTask: true },
        { id: 'task-result-xyz', withToolCall: true },
        { id: 'task-injection-xyz', withChatMessage: true },
        { id: 'cronjob-nightly-1', withToolCall: true },
        { id: 'agent-heartbeat-789', withTokenUsage: true },
        { id: 'nightly-consolidation-2025-01-01', withTokenUsage: true },
        { id: 'loop-detection-abc', withTokenUsage: true },
      ])

      const db = initDatabase(dbPath)

      const sessions = db.prepare('SELECT id, type, source FROM sessions').all() as Array<{ id: string, type: string, source: string }>
      expect(sessions).toHaveLength(9)
      for (const s of sessions) {
        expect(s.id).toMatch(UUID_RE)
      }
      // Every child-table session_id must now also be a UUID.
      for (const table of ['chat_messages', 'token_usage', 'tool_calls', 'tasks', 'memories']) {
        const rows = db.prepare(`SELECT DISTINCT session_id FROM ${table} WHERE session_id IS NOT NULL`).all() as Array<{ session_id: string }>
        for (const r of rows) {
          expect(r.session_id).toMatch(UUID_RE)
        }
      }
      // Type distribution must match prefix inference rules.
      const typeCounts = db.prepare('SELECT type, COUNT(*) as c FROM sessions GROUP BY type').all() as Array<{ type: string, c: number }>
      const countByType = Object.fromEntries(typeCounts.map(r => [r.type, r.c]))
      expect(countByType['interactive']).toBe(4) // session-, web-, task-result-, task-injection-
      expect(countByType['task']).toBe(2)        // task-abc, cronjob-nightly-1
      expect(countByType['heartbeat']).toBe(1)
      expect(countByType['consolidation']).toBe(1)
      expect(countByType['loop_detection']).toBe(1)

      db.close()
    })

    it('backfills session_user from legacy interactive IDs when user_id/session_user are NULL', () => {
      const dbPath = tmpDbPath()
      seedLegacySessions(dbPath, [
        {
          id: 'session-alice-1234567890123-abc123',
          userId: null,
          withChatMessage: true,
        },
      ])

      const db = initDatabase(dbPath)
      const row = db.prepare('SELECT id, user_id, session_user FROM sessions LIMIT 1').get() as {
        id: string
        user_id: number | null
        session_user: string | null
      }

      expect(row.id).toMatch(UUID_RE)
      expect(row.user_id).toBeNull()
      expect(row.session_user).toBe('alice')

      db.close()
    })

    it('recovers orphaned session ids found only in child tables', () => {
      const dbPath = tmpDbPath()
      // Seed with NO entry in sessions, only FK references.
      const seed = new BetterSqlite3(dbPath)
      seed.pragma('foreign_keys = OFF')
      seed.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
        CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, source TEXT NOT NULL DEFAULT 'web', started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT, message_count INTEGER NOT NULL DEFAULT 0, summary_written INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, user_id INTEGER, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')), content TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (datetime('now')), provider TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0.0, session_id TEXT);
        CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (datetime('now')), session_id TEXT, tool_name TEXT NOT NULL, input TEXT, output TEXT, duration_ms INTEGER);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed')), trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user','agent','cronjob','heartbeat','consolidation')), trigger_source_id TEXT, provider TEXT, model TEXT, max_duration_minutes INTEGER, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0.0, tool_call_count INTEGER NOT NULL DEFAULT 0, result_summary TEXT, result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed','failed','question','silent')), error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT, session_id TEXT);
        CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, session_id TEXT, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'session', timestamp TEXT NOT NULL DEFAULT (datetime('now')));
      `)
      seed.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('bob', 'hash')
      // Orphan interactive session referenced from chat_messages only.
      seed.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, timestamp) VALUES (?, 1, 'user', 'hi', '2024-01-01T00:00:00')").run('web-bob-1')
      seed.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, timestamp) VALUES (?, 1, 'assistant', 'hi', '2024-01-02T00:00:00')").run('web-bob-1')
      // Orphan task referenced only from tool_calls.
      seed.prepare("INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, timestamp) VALUES (?, 'test', '{}', 'ok', 1, '2024-02-01T00:00:00')").run('task-orphan')
      // Orphan heartbeat referenced only from token_usage.
      seed.prepare("INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, session_id, timestamp) VALUES ('x','m',1,1,?,'2024-03-01T00:00:00')").run('agent-heartbeat-orphan')
      // Orphan referenced only from memories.
      seed.prepare("INSERT INTO memories (user_id, session_id, content, timestamp) VALUES (1, ?, 'm', '2024-04-01T00:00:00')").run('session-mem-orphan')
      // Orphan referenced only from tasks.
      seed.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, session_id, created_at) VALUES ('t-orphan','n','p','running','user',?, '2024-05-01T00:00:00')").run('cronjob-orphan')
      seed.close()

      const db = initDatabase(dbPath)

      const sessions = db.prepare('SELECT id, type, source, started_at, user_id, session_user FROM sessions ORDER BY started_at').all() as Array<{ id: string, type: string, source: string, started_at: string, user_id: number | null, session_user: string | null }>
      expect(sessions).toHaveLength(5)
      for (const s of sessions) {
        expect(s.id).toMatch(UUID_RE)
      }
      const typesAndSources = sessions.map(s => ({ type: s.type, source: s.source }))
      expect(typesAndSources).toEqual(expect.arrayContaining([
        { type: 'interactive', source: 'web' },
        { type: 'task', source: 'task' },
        { type: 'heartbeat', source: 'system' },
        { type: 'interactive', source: 'web' },
        { type: 'task', source: 'task' },
      ]))
      // Earliest timestamp of orphan chat_messages should be used.
      const webSession = sessions.find(s => s.type === 'interactive' && s.started_at.startsWith('2024-01-01'))
      expect(webSession).toBeDefined()
      // user_id + session_user should be populated from child rows when available.
      expect(webSession!.user_id).toBe(1)
      expect(webSession!.session_user).toBe('1')

      db.close()
    })

    it('is idempotent on mixed UUID + legacy datasets and leaves UUIDs untouched', () => {
      const dbPath = tmpDbPath()
      const existingUuid = '11111111-2222-3333-4444-555555555555'
      seedLegacySessions(dbPath, [
        { id: 'session-legacy-mix', withChatMessage: true },
        { id: existingUuid, source: 'telegram', withChatMessage: true },
      ])

      let db = initDatabase(dbPath)

      const afterFirst = db.prepare('SELECT id, source FROM sessions ORDER BY id').all() as Array<{ id: string, source: string }>
      expect(afterFirst).toHaveLength(2)
      // The pre-existing UUID id must still be present unchanged.
      expect(afterFirst.some(r => r.id === existingUuid)).toBe(true)
      // The legacy id must have been replaced with a UUID.
      expect(afterFirst.some(r => r.id !== existingUuid && UUID_RE.test(r.id))).toBe(true)

      // Re-running init is a no-op for IDs.
      db.close()
      db = initDatabase(dbPath)
      const afterSecond = db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>
      expect(afterSecond.map(r => r.id).sort()).toEqual(afterFirst.map(r => r.id).sort())
      // No duplicate recovered sessions on rerun.
      expect(afterSecond).toHaveLength(2)
      db.close()
    })

    it('remaps parent_session_id through the same old→new mapping', () => {
      const dbPath = tmpDbPath()
      // Seed legacy DB with parent linkage. The legacy schema (pre-migration)
      // did not have parent_session_id; the migration path adds the column
      // then expects us to populate it. Seed directly post-ALTER by creating
      // the DB once (triggers migration & adds the column), then inserting
      // legacy rows with parent_session_id set, then rerunning initDatabase.
      //
      // Simpler: create the DB once to get the new schema, then insert legacy-
      // shaped rows (legacy ids but using the current schema), then re-init.
      {
        const init = initDatabase(dbPath)
        init.prepare("INSERT INTO users (username, password_hash) VALUES ('carol', 'h')").run()
        init.prepare(
          "INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, message_count, summary_written) VALUES (?, 1, 'web', 'interactive', NULL, datetime('now'), 0, 0)"
        ).run('session-parent-1')
        init.prepare(
          "INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, message_count, summary_written) VALUES (?, 1, 'task', 'task', ?, datetime('now'), 0, 0)"
        ).run('task-child-1', 'session-parent-1')
        init.close()
      }

      const db = initDatabase(dbPath)
      const parent = db.prepare("SELECT id FROM sessions WHERE type = 'interactive'").get() as { id: string }
      const child = db.prepare("SELECT id, parent_session_id FROM sessions WHERE type = 'task'").get() as { id: string, parent_session_id: string }
      expect(parent.id).toMatch(UUID_RE)
      expect(child.id).toMatch(UUID_RE)
      expect(child.parent_session_id).toBe(parent.id)
      db.close()
    })

    it('backfills cronjob-* and task-injection-* prefixes correctly', () => {
      const dbPath = tmpDbPath()
      seedLegacySessions(dbPath, [
        { id: 'cronjob-daily-42', withToolCall: true },
        { id: 'task-injection-abc', withChatMessage: true },
      ])
      const db = initDatabase(dbPath)
      const sessions = db.prepare('SELECT id, type, source FROM sessions ORDER BY type').all() as Array<{ id: string, type: string, source: string }>
      expect(sessions).toHaveLength(2)
      for (const s of sessions) {
        expect(s.id).toMatch(UUID_RE)
      }
      const byType = Object.fromEntries(sessions.map(s => [s.type, s]))
      // cronjob-* legacy ids must be typed as 'task'.
      expect(byType['task']).toBeDefined()
      // task-injection-* legacy ids must be typed as 'interactive'.
      expect(byType['interactive']).toBeDefined()
      db.close()
    })

    it('recovers orphans whose child rows reference a deleted user without failing FK at commit', () => {
      // Pre-existing DB corruption: a tool_calls row references an orphan
      // session whose child rows in turn reference user 999 who was deleted
      // (possible via FK=OFF sessions or manual cleanup). The migration
      // must not crash with a deferred-FK violation at COMMIT; it must
      // instead drop the dangling user_id on the recovered session row
      // while keeping the canonical identity in session_user so the row
      // is still attributable.
      //
      // Seed with the modern chat_messages CHECK so we don't also trip the
      // pre-existing `chat_messages` CHECK-recreation path (which has its
      // own FK-enforcement behaviour unrelated to this fix).
      const dbPath = tmpDbPath()
      const seed = new BetterSqlite3(dbPath)
      seed.pragma('foreign_keys = OFF')
      seed.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
        CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, source TEXT NOT NULL DEFAULT 'web', started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT, message_count INTEGER NOT NULL DEFAULT 0, summary_written INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, user_id INTEGER, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')), content TEXT NOT NULL, metadata TEXT, timestamp TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id));
        CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (datetime('now')), provider TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0.0, session_id TEXT);
        CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (datetime('now')), session_id TEXT, tool_name TEXT NOT NULL, input TEXT, output TEXT, duration_ms INTEGER);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed')), trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user','agent','cronjob','heartbeat','consolidation')), trigger_source_id TEXT, provider TEXT, model TEXT, max_duration_minutes INTEGER, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0.0, tool_call_count INTEGER NOT NULL DEFAULT 0, result_summary TEXT, result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed','failed','question','silent')), error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT, session_id TEXT);
        CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, session_id TEXT, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'session', timestamp TEXT NOT NULL DEFAULT (datetime('now')));
      `)
      // The orphan ghost session is referenced only from memories, whose
      // user_id column points at user 999 which does NOT exist. The
      // migration will try to recover the session with user_id=999 and
      // trip the deferred users FK unless the recovery path checks
      // existence first.
      seed.prepare("INSERT INTO memories (user_id, session_id, content, timestamp) VALUES (999, ?, 'm', '2024-06-01T00:00:00')").run('session-ghost-1')
      seed.close()

      // Must not throw (previously would fail the deferred users FK at COMMIT).
      const db = initDatabase(dbPath)

      const row = db.prepare('SELECT id, user_id, session_user FROM sessions').get() as {
        id: string
        user_id: number | null
        session_user: string | null
      }
      expect(row.id).toMatch(UUID_RE)
      // Deleted-user reference is dropped so the FK check passes …
      expect(row.user_id).toBeNull()
      // … while the canonical identity is preserved on session_user.
      expect(row.session_user).toBe('999')

      db.close()
    })
  })
})
