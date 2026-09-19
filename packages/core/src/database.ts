import BetterSqlite3 from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { initEmailSendLogTable } from './email-send-log.js'
import { initTaskInjectionQueueTable } from './task-injection-queue.js'
import { ensureSessionSummariesTable } from './session-summary-store.js'
import { ensureOfftangentTables } from './offtangent-schema.js'
import { ensureProjectAssignmentTables } from './project-assignment-schema.js'
import { ensureArtifactTables } from './artifact-store.js'
import { ensureMemoryPageEmbeddingTables } from './memory-page-embeddings.js'
import { ensurePersonaTable } from './persona-store.js'

export type Database = BetterSqlite3.Database

let db: Database | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0.0,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT,
  tool_name TEXT NOT NULL,
  input TEXT,
  output TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  telegram_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  source TEXT NOT NULL DEFAULT 'web',
  type TEXT NOT NULL DEFAULT 'interactive' CHECK(type IN ('interactive', 'task', 'heartbeat', 'consolidation', 'loop_detection')),
  parent_session_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  summary_written INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  model_id TEXT,
  model_provider_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  session_id TEXT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'session',
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  embedding BLOB,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT,
  status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'down', 'unconfigured')),
  latency_ms INTEGER,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_token_usage_provider ON token_usage(provider);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- idx_sessions_type and idx_sessions_parent are created post-migration so that
-- existing pre-migration databases (where the columns are added by ALTER) do
-- not crash on first boot.

CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_health_checks_timestamp ON health_checks(timestamp);
CREATE INDEX IF NOT EXISTS idx_health_checks_provider ON health_checks(provider);
CREATE INDEX IF NOT EXISTS idx_health_checks_status ON health_checks(status);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id INTEGER,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'system')),
  content TEXT NOT NULL,
  metadata TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS telegram_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  telegram_display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Fork (auth hardening): server-side store for refresh tokens so a session can
-- be rotated, revoked and listed. The token itself stays a JWT; only its
-- sha256 hash is persisted here.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_telegram_users_telegram_id ON telegram_users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_telegram_users_status ON telegram_users(status);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
`

function tableExists(db: Database, tableName: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName)
  return !!row
}

export function initDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath ?? path.join(
    process.env.DATA_DIR ?? '/data',
    'db',
    'axiom.db'
  )

  // Ensure directory exists
  const dir = path.dirname(resolvedPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Migration: rename legacy openagent.db → axiom.db if present.
  // Older installs created /data/db/openagent.db; the default path is now
  // axiom.db. Without this, upgraded containers would silently start with
  // an empty database even though the /data volume was preserved.
  if (!fs.existsSync(resolvedPath)) {
    const legacyPath = path.join(dir, 'openagent.db')
    if (fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, resolvedPath)
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(legacyPath + suffix)) {
          fs.renameSync(legacyPath + suffix, resolvedPath + suffix)
        }
      }
      console.log(`[db] Migrated legacy database: openagent.db → ${path.basename(resolvedPath)}`)
    }
  }

  db = new BetterSqlite3(resolvedPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)

  // Migration: add status column to tool_calls if missing
  const cols = db.prepare("PRAGMA table_info(tool_calls)").all() as { name: string }[]
  if (!cols.find(c => c.name === 'status')) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error'))")
  }

  // Migration: add cache token columns to token_usage if missing
  const tokenUsageCols = db.prepare("PRAGMA table_info(token_usage)").all() as { name: string }[]
  if (!tokenUsageCols.find(c => c.name === 'cache_read')) {
    db.exec("ALTER TABLE token_usage ADD COLUMN cache_read INTEGER NOT NULL DEFAULT 0")
  }
  if (!tokenUsageCols.find(c => c.name === 'cache_write')) {
    db.exec("ALTER TABLE token_usage ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0")
  }

  // Migration: add metadata column and tool role to chat_messages if missing
  const chatCols = db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[]
  if (!chatCols.find(c => c.name === 'metadata')) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN metadata TEXT")
  }
  // Recreate table if CHECK constraint doesn't include 'system' role
  // SQLite doesn't support ALTER CHECK, so we test by inserting
  try {
    db.exec("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('__migration_test__', NULL, 'system', 'test')")
    db.exec("DELETE FROM chat_messages WHERE session_id = '__migration_test__'")
  } catch {
    // CHECK constraint failed — need to recreate table with updated roles
    db.exec(`
      ALTER TABLE chat_messages RENAME TO chat_messages_old;
      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id INTEGER,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'system')),
        content TEXT NOT NULL,
        metadata TEXT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT INTO chat_messages (id, session_id, user_id, role, content, metadata, timestamp)
        SELECT id, session_id, user_id, role, content, metadata, timestamp FROM chat_messages_old;
      DROP TABLE chat_messages_old;
    `)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp);
  `)

  const memoriesFtsExists = tableExists(db, 'memories_fts')
  const chatMessagesFtsExists = tableExists(db, 'chat_messages_fts')

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content=memories,
      content_rowid=id,
      tokenize="unicode61 remove_diacritics 2"
    );

    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
      content,
      content=chat_messages,
      content_rowid=id,
      tokenize="unicode61 remove_diacritics 2"
    );

    CREATE TRIGGER IF NOT EXISTS chat_messages_fts_insert AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_messages_fts_delete AFTER DELETE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_messages_fts_update AFTER UPDATE OF content ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `)

  // Backfill external-content FTS indexes only when the virtual table is first
  // created during migration. Rebuilding on every boot rescans the full dataset
  // and can significantly slow startup on larger installations.
  if (!memoriesFtsExists) {
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
  }
  if (!chatMessagesFtsExists) {
    db.exec("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild')")
  }

  // Create tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
      trigger_source_id TEXT,
      provider TEXT,
      model TEXT,
      is_default_model INTEGER,
      max_duration_minutes INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0.0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      result_summary TEXT,
      result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
  `)

  initEmailSendLogTable(db)

  // Durable delivery queue for task-result injections (W4). Lives next to the
  // tasks table because its rows die with the task they belong to.
  initTaskInjectionQueueTable(db)

  // Create scheduled_tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      provider TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      tools_override TEXT,
      skills_override TEXT,
      system_prompt_override TEXT,
      last_run_at TEXT,
      last_run_task_id TEXT,
      last_run_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Migration: add action_type column to scheduled_tasks
  const scheduledCols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as { name: string }[]
  if (!scheduledCols.find(c => c.name === 'action_type')) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN action_type TEXT NOT NULL DEFAULT 'task'")
  }

  // Migration: add attached_skills column to scheduled_tasks (JSON array of skill names)
  if (!scheduledCols.find(c => c.name === 'attached_skills')) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN attached_skills TEXT")
  }

  // Fork: add agent_id column to scheduled_tasks for multi-persona cronjob scoping
  if (!scheduledCols.find(c => c.name === 'agent_id')) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'")
    db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_agent_id ON scheduled_tasks(agent_id)")
  }

  // Fork: add agent_id column to tasks for multi-persona task routing.
  // (Also done in initTasksTable for store-level callers — this covers the
  // initDatabase path used by the app bootstrap and tests.)
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  if (!taskCols.find(c => c.name === 'agent_id')) {
    db.exec("ALTER TABLE tasks ADD COLUMN agent_id TEXT DEFAULT NULL")
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id)")
  }

  // Migration: add 'paused' to tasks status CHECK constraint
  // Test by inserting a paused row — if CHECK fails, recreate the table
  try {
    db.exec("INSERT INTO tasks (id, name, prompt, status, trigger_type) VALUES ('__migration_test_paused__', 'test', 'test', 'paused', 'user')")
    db.exec("DELETE FROM tasks WHERE id = '__migration_test_paused__'")
  } catch {
    db.exec(`
      ALTER TABLE tasks RENAME TO tasks_old;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
        trigger_source_id TEXT,
        provider TEXT,
        model TEXT,
        max_duration_minutes INTEGER,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        session_id TEXT
      );
      INSERT INTO tasks SELECT * FROM tasks_old;
      DROP TABLE tasks_old;
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
    `)
  }

  // Migration: add 'silent' to tasks result_status CHECK constraint
  // Test by inserting a silent row — if CHECK fails, recreate the table
  try {
    db.exec("INSERT INTO tasks (id, name, prompt, status, trigger_type, result_status) VALUES ('__migration_test_silent__', 'test', 'test', 'completed', 'user', 'silent')")
    db.exec("DELETE FROM tasks WHERE id = '__migration_test_silent__'")
  } catch {
    db.exec(`
      ALTER TABLE tasks RENAME TO tasks_old;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
        trigger_source_id TEXT,
        provider TEXT,
        model TEXT,
        max_duration_minutes INTEGER,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        session_id TEXT
      );
      INSERT INTO tasks SELECT * FROM tasks_old;
      DROP TABLE tasks_old;
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
    `)
  }

  // Migration: add 'heartbeat' to tasks trigger_type CHECK constraint
  // Test by inserting a heartbeat row — if CHECK fails, recreate the table
  try {
    db.exec("INSERT INTO tasks (id, name, prompt, status, trigger_type) VALUES ('__migration_test_heartbeat__', 'test', 'test', 'running', 'heartbeat')")
    db.exec("DELETE FROM tasks WHERE id = '__migration_test_heartbeat__'")
  } catch {
    db.exec(`
      ALTER TABLE tasks RENAME TO tasks_old;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
        trigger_source_id TEXT,
        provider TEXT,
        model TEXT,
        max_duration_minutes INTEGER,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        session_id TEXT
      );
      INSERT INTO tasks SELECT * FROM tasks_old;
      DROP TABLE tasks_old;
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
    `)
  }

  // Migration: add 'consolidation' to tasks trigger_type CHECK constraint
  try {
    db.exec("INSERT INTO tasks (id, name, prompt, status, trigger_type) VALUES ('__migration_test_consolidation__', 'test', 'test', 'running', 'consolidation')")
    db.exec("DELETE FROM tasks WHERE id = '__migration_test_consolidation__'")
  } catch {
    db.exec(`
      ALTER TABLE tasks RENAME TO tasks_old;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
        trigger_source_id TEXT,
        provider TEXT,
        model TEXT,
        max_duration_minutes INTEGER,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        session_id TEXT
      );
      INSERT INTO tasks SELECT * FROM tasks_old;
      DROP TABLE tasks_old;
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
    `)
  }

  // Migration: add is_default_model column to tasks table
  // Tracks whether the (provider, model) pair was the configured task default
  // (true) or an explicit user/agent override (false). NULL = unknown (legacy).
  const taskColsForDefaultModel = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  if (!taskColsForDefaultModel.find(c => c.name === 'is_default_model')) {
    db.exec("ALTER TABLE tasks ADD COLUMN is_default_model INTEGER")
  }

  // Migration: add cache token columns to tasks table
  const taskColsForCache = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  if (!taskColsForCache.find(c => c.name === 'cache_read')) {
    db.exec("ALTER TABLE tasks ADD COLUMN cache_read INTEGER NOT NULL DEFAULT 0")
  }
  if (!taskColsForCache.find(c => c.name === 'cache_write')) {
    db.exec("ALTER TABLE tasks ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0")
  }

  // Migration (SPEC 11.6): output contract and context mode for delegations.
  // Also done in initTasksTable for store-level callers.
  if (!taskColsForCache.find(c => c.name === 'output_schema')) {
    db.exec('ALTER TABLE tasks ADD COLUMN output_schema TEXT DEFAULT NULL')
  }
  if (!taskColsForCache.find(c => c.name === 'context_mode')) {
    db.exec('ALTER TABLE tasks ADD COLUMN context_mode TEXT DEFAULT NULL')
  }

  // Migration (W5/P2): handoff state a task leaves behind when its run ends
  // with unfinished work. Also done in initTasksTable for store-level callers.
  if (!taskColsForCache.find(c => c.name === 'handoff')) {
    db.exec('ALTER TABLE tasks ADD COLUMN handoff TEXT DEFAULT NULL')
  }

  // Migration (W5/P3): bookkeeping for outcomes that never reach a strand
  // (cronjob results). Existing rows are backfilled as "already announced",
  // so the deploy that adds the column does not replay a day of cronjobs
  // into the agent's next turn.
  if (!taskColsForCache.find(c => c.name === 'agent_notified_at')) {
    db.exec('ALTER TABLE tasks ADD COLUMN agent_notified_at TEXT DEFAULT NULL')
    db.exec('UPDATE tasks SET agent_notified_at = COALESCE(completed_at, created_at) WHERE agent_notified_at IS NULL')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_agent_notified_at ON tasks(agent_notified_at)')

  // Provider/model task filters can otherwise fall back to a full task scan
  // when the date range is wide or cleared.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_provider_model_created_at ON tasks(provider, model, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_model_created_at ON tasks(model, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_is_default_model_created_at ON tasks(is_default_model, created_at);
  `)

  // Migration: add last_activity, session_user, and token columns to sessions table
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
  if (!sessionCols.find(c => c.name === 'last_activity')) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_activity TEXT")
  }
  if (!sessionCols.find(c => c.name === 'session_user')) {
    db.exec("ALTER TABLE sessions ADD COLUMN session_user TEXT")
  }
  const needsTokenBackfill = !sessionCols.find(c => c.name === 'prompt_tokens')
  if (needsTokenBackfill) {
    db.exec("ALTER TABLE sessions ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0")
  }
  if (!sessionCols.find(c => c.name === 'completion_tokens')) {
    db.exec("ALTER TABLE sessions ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0")
  }
  if (!sessionCols.find(c => c.name === 'cache_read')) {
    db.exec("ALTER TABLE sessions ADD COLUMN cache_read INTEGER NOT NULL DEFAULT 0")
  }
  if (!sessionCols.find(c => c.name === 'cache_write')) {
    db.exec("ALTER TABLE sessions ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0")
  }
  if (!sessionCols.find(c => c.name === 'type')) {
    // Add without CHECK constraint (SQLite ALTER limitation), then enforce by recreating below
    db.exec("ALTER TABLE sessions ADD COLUMN type TEXT NOT NULL DEFAULT 'interactive'")
  }
  if (!sessionCols.find(c => c.name === 'parent_session_id')) {
    db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT")
  }
  // Fork: multi-persona session scoping. Add agent_id BEFORE the type-CHECK
  // recreation probe below so that, if the sessions table is rebuilt, the
  // explicit column copy can carry agent_id forward (no persona data loss).
  if (!sessionCols.find(c => c.name === 'agent_id')) {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'")
  }

  // Ensure CHECK constraint on sessions.type exists. Detect by probing the
  // table with an invalid type value inside a SAVEPOINT that is ALWAYS
  // rolled back — this guarantees no probe row survives a crash or an
  // unexpected error between INSERT and cleanup, which would otherwise
  // wedge the next boot with a spurious PRIMARY KEY violation.
  db.exec("SAVEPOINT sessions_type_probe")
  let needsCheckRecreation = false
  try {
    try {
      db.exec("INSERT INTO sessions (id, type) VALUES ('__migration_test_type__', '__invalid__')")
      // INSERT succeeded → CHECK constraint is missing.
      needsCheckRecreation = true
    } catch (err: unknown) {
      // Only a CHECK-constraint violation means "CHECK is already enforced".
      // Any other error (disk I/O, etc.) indicates a real problem and must
      // not be silently swallowed.
      const code = (err as { code?: string }).code
      if (code !== 'SQLITE_CONSTRAINT_CHECK') throw err
    }
  } finally {
    // Always discard whatever the probe did — success or failure.
    db.exec("ROLLBACK TO sessions_type_probe")
    db.exec("RELEASE sessions_type_probe")
  }

  if (needsCheckRecreation) {
    // Wrap the recreation in a single transaction so a mid-step failure
    // (disk full, FK violation during copy, etc.) rolls back to a consistent
    // state instead of leaving `sessions_old` orphaned without `sessions`.
    const localDb = db
    localDb.transaction(() => {
      localDb.exec(`
        ALTER TABLE sessions RENAME TO sessions_old;
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          user_id INTEGER,
          source TEXT NOT NULL DEFAULT 'web',
          type TEXT NOT NULL DEFAULT 'interactive' CHECK(type IN ('interactive', 'task', 'heartbeat', 'consolidation', 'loop_detection')),
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
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
        );
        INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, ended_at, message_count, summary_written, last_activity, session_user, prompt_tokens, completion_tokens, cache_read, cache_write, agent_id)
          SELECT id, user_id, source, type, parent_session_id, started_at, ended_at, message_count, summary_written, last_activity, session_user, prompt_tokens, completion_tokens, cache_read, cache_write, agent_id FROM sessions_old;
        DROP TABLE sessions_old;
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(type);
        CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
      `)
    })()
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(type);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
  `)

  // Fork (Offtangent Stufe 1 — threads): interactive sessions become named,
  // parallel threads. Deliberately migrated AFTER the type-CHECK recreation
  // above so a table rebuild (which copies an explicit column list) can never
  // drop these columns again. Re-probe the columns for the same reason: the
  // `sessionCols` snapshot was taken before a possible rebuild.
  const threadCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
  if (!threadCols.find(c => c.name === 'title')) {
    db.exec("ALTER TABLE sessions ADD COLUMN title TEXT")
  }
  if (!threadCols.find(c => c.name === 'pinned')) {
    db.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
  }
  if (!threadCols.find(c => c.name === 'archived')) {
    db.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
  }
  // Per-strand model pins. Additive only: the production sessions table is
  // large, so this migration deliberately performs no rebuild or backfill.
  if (!threadCols.find(c => c.name === 'model_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN model_id TEXT')
  }
  if (!threadCols.find(c => c.name === 'model_provider_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN model_provider_id TEXT')
  }
  // Offtangent read state: when the user last opened this strand (ISO-8601
  // UTC). Additive and nullable on purpose — NULL means "never opened", which
  // is exactly the state of every row that existed before the column, so no
  // backfill is needed and the migration is rollback-free (see
  // strand-read-state.ts for how `unread` is derived from it).
  if (!threadCols.find(c => c.name === 'last_read_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN last_read_at TEXT')
  }
  // Thread lists are read per (user, persona) ordered by activity.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_thread_activity
      ON sessions(session_user, agent_id, last_activity);
  `)

  // Fork (Offtangent Stufe 2 — projects light): a flat grouping layer above
  // threads. `projects.user_id` carries the same semantics as
  // `sessions.session_user` (the user id as a string).
  //
  // `sessions.project_id` is added WITHOUT a foreign key on purpose: SQLite
  // cannot add a constraint via ALTER TABLE, and rebuilding `sessions` again
  // just for referential integrity is the riskiest migration in this file.
  // Deleting a project detaches its threads in application code instead
  // (ProjectManager.deleteProject sets project_id = NULL).
  //
  // Migrated AFTER the type-CHECK recreation above for the same reason as the
  // thread columns: a table rebuild copies an explicit column list.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, archived);
  `)
  const projectCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
  if (!projectCols.find(c => c.name === 'project_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
  `)

  // Fork: multi-persona scoping for memories and chat_messages.
  const memoryCols = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]
  if (!memoryCols.find(c => c.name === 'agent_id')) {
    db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'")
  }
  const chatMsgCols = db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[]
  if (!chatMsgCols.find(c => c.name === 'agent_id')) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'")
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_id ON chat_messages(agent_id);
  `)

  // Offtangent (SPEC 11.4): fact provenance, session kind, supersession.
  // Additive; existing rows read as provenance 'agent', status 'active'.
  ensureMemoryProvenanceColumns(db)

  // Offtangent (PROTOCOL chapter 7, push slice 1): the device registry the
  // FCM sender reads. Purely additive, no table is rebuilt: the live database
  // is large and a rebuild is the one migration shape we refuse here.
  ensurePushDeviceTable(db)

  // Fork (Axiom-Companion M1): client-side idempotency key for user messages.
  // A client that retries after a lost ack must not create a second row (and
  // the web backend must not start a second turn). Partial UNIQUE index so
  // rows without a key (every message written before this, Telegram, web UI)
  // stay unaffected.
  if (!chatMsgCols.find(c => c.name === 'client_message_id')) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN client_message_id TEXT")
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client_message_id
      ON chat_messages(user_id, client_message_id) WHERE client_message_id IS NOT NULL;
  `)

  // Migration (PRD #11 Task 2): Legacy prefix-based session IDs -> UUIDs + type backfill
  // + orphan recovery. Idempotent: only acts on rows whose session_id is not already
  // in UUID form. Wrapped in a single transaction for atomicity.
  migrateLegacySessionIds(db)

  // Offtangent (SPEC 11.2): structured session summaries, one row per run.
  // Additive, no backfill: sessions without a row simply have no schema
  // summary yet.
  ensureSessionSummariesTable(db)

  // Offtangent (SPEC 3.2, 3.3): captures, router decisions, tags, now set.
  ensureOfftangentTables(db)

  // Offtangent Stufe 2: the running strand to project assignment. Three new
  // tables (suggestion, dismissal, run bookkeeping), no column on `sessions`,
  // no backfill — see project-assignment-schema.ts.
  ensureProjectAssignmentTables(db)

  // Offtangent (SPEC 7.4b, canvas R2): artifacts per message and strand.
  // Additive; installs without a canvas simply have an empty table.
  ensureArtifactTables(db)

  // Wiki page vectors and the nearest page per fact, both rebuilt on demand.
  ensureMemoryPageEmbeddingTables(db)

  // Offtangent (SPEC 13.2): the persona record — colour, badge, display name,
  // `is_default` and `archived`. Additive; an install that upgrades gets one
  // seeded row for its historical default persona.
  ensurePersonaTable(db)

  // Backfill token counts from token_usage only when the columns are first added
  if (needsTokenBackfill) {
    db.exec(`
      UPDATE sessions SET
        prompt_tokens = COALESCE((
          SELECT SUM(prompt_tokens) FROM token_usage WHERE token_usage.session_id = sessions.id
        ), 0),
        completion_tokens = COALESCE((
          SELECT SUM(completion_tokens) FROM token_usage WHERE token_usage.session_id = sessions.id
        ), 0)
      WHERE EXISTS (SELECT 1 FROM token_usage WHERE token_usage.session_id = sessions.id);
    `)
  }

  return db
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Add the provenance columns to `memories` (SPEC 11.4). Idempotent, never
 * rewrites rows. `status`/`supersession_key` power supersession instead of
 * append; `provenance` and `session_kind` power the write path gates.
 */
export function ensureMemoryProvenanceColumns(db: Database): void {
  const cols = new Set((db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map(c => c.name))
  if (!cols.has('provenance')) {
    db.exec("ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'agent' CHECK(provenance IN ('owner','agent','untrusted','system'))")
  }
  if (!cols.has('session_kind')) {
    db.exec('ALTER TABLE memories ADD COLUMN session_kind TEXT')
  }
  if (!cols.has('observed_at')) {
    db.exec('ALTER TABLE memories ADD COLUMN observed_at TEXT')
  }
  if (!cols.has('supersession_key')) {
    db.exec('ALTER TABLE memories ADD COLUMN supersession_key TEXT')
  }
  if (!cols.has('status')) {
    db.exec("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded'))")
  }
  if (!cols.has('superseded_by')) {
    db.exec('ALTER TABLE memories ADD COLUMN superseded_by INTEGER')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    CREATE INDEX IF NOT EXISTS idx_memories_supersession ON memories(supersession_key, agent_id, user_id, status);
  `)
}

/**
 * `push_devices`: one row per (user, FCM token). A token addresses exactly one
 * device, so it is UNIQUE; when the same device signs in as another user the
 * row is re-pointed instead of duplicated (see the registry's upsert).
 *
 * `disabled_at` is set when FCM says the token is gone (UNREGISTERED,
 * INVALID_ARGUMENT). A disabled row is kept rather than deleted so the next
 * registration of the same token can revive it and so the failure history
 * stays readable.
 */
function ensurePushDeviceTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_devices (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL DEFAULT 'android',
      app_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_success_at TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      disabled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id, disabled_at);
  `)
  // Additive column guard for installs created by an earlier build of this
  // table. ALTER only, never a rebuild.
  const pushCols = db.prepare('PRAGMA table_info(push_devices)').all() as { name: string }[]
  const addColumn = (name: string, ddl: string): void => {
    if (!pushCols.find(c => c.name === name)) db.exec(`ALTER TABLE push_devices ADD COLUMN ${ddl}`)
  }
  addColumn('platform', "platform TEXT NOT NULL DEFAULT 'android'")
  addColumn('app_version', 'app_version TEXT')
  addColumn('last_success_at', 'last_success_at TEXT')
  addColumn('failure_count', 'failure_count INTEGER NOT NULL DEFAULT 0')
  addColumn('disabled_at', 'disabled_at TEXT')
}

function isLegacySessionId(id: string | null | undefined): boolean {
  if (!id) return false
  return !UUID_REGEX.test(id)
}

function inferSessionTypeFromLegacyId(id: string): string {
  // Order matters: check longer/more specific prefixes first
  if (id.startsWith('agent-heartbeat-')) return 'heartbeat'
  if (id.startsWith('nightly-consolidation-')) return 'consolidation'
  if (id.startsWith('loop-detection-')) return 'loop_detection'
  if (id.startsWith('task-result-')) return 'interactive'
  if (id.startsWith('task-injection-')) return 'interactive'
  if (id.startsWith('cronjob-')) return 'task'
  if (id.startsWith('task-')) return 'task'
  if (id.startsWith('session-')) return 'interactive'
  if (id.startsWith('web-')) return 'interactive'
  if (id.startsWith('telegram-')) return 'interactive'
  // Safe default for any other legacy format
  return 'interactive'
}

function inferSessionSourceFromLegacyId(id: string): string {
  if (id.startsWith('web-')) return 'web'
  if (id.startsWith('telegram-group-')) return 'telegram-group'
  if (id.startsWith('telegram-')) return 'telegram'
  if (id.startsWith('session-')) return 'web'
  if (id.startsWith('task-injection-')) return 'system'
  if (id.startsWith('task-result-')) return 'system'
  if (id.startsWith('cronjob-')) return 'task'
  if (id.startsWith('task-')) return 'task'
  if (id.startsWith('agent-heartbeat-')) return 'system'
  if (id.startsWith('nightly-consolidation-')) return 'system'
  if (id.startsWith('loop-detection-')) return 'system'
  return 'web'
}

/**
 * Best-effort recovery of the user key stored by legacy interactive session IDs.
 *
 * Legacy interactive IDs encoded the user in the prefix form
 * `session-<user>-<timestamp>-...` (and in a few historical paths as
 * `web-<user>-<timestamp>-...`). We backfill this into `session_user` before
 * remapping the ID to UUID so orphan restoration can still attach the session
 * to the correct in-memory user after a restart.
 */
function inferSessionUserFromLegacyId(id: string): string | null {
  const patterns = [
    /^session-(.+?)-\d+(?:-|$)/,
    /^web-(.+?)-\d+(?:-|$)/,
    /^telegram-group-(.+?)-\d+(?:-|$)/,
    /^telegram-(.+?)-\d+(?:-|$)/,
  ]

  for (const pattern of patterns) {
    const match = id.match(pattern)
    if (match?.[1]) return match[1]
  }

  return null
}

/**
 * One-time migration: convert prefix-based legacy session IDs to UUIDs,
 * backfill `sessions.type`, remap FK references across child tables, and
 * recover orphaned session IDs (IDs referenced by child rows but missing
 * from the `sessions` table).
 *
 * Safe to run repeatedly: rows whose IDs are already UUIDs are untouched.
 */
function migrateLegacySessionIds(db: Database): void {
  // Collect every legacy session ID still present anywhere in the DB.
  const childTables: Array<{ table: string, userCol?: string, timeCol?: string }> = [
    { table: 'chat_messages', userCol: 'user_id', timeCol: 'timestamp' },
    { table: 'token_usage', timeCol: 'timestamp' },
    { table: 'tool_calls', timeCol: 'timestamp' },
    { table: 'tasks', timeCol: 'created_at' },
    { table: 'memories', userCol: 'user_id', timeCol: 'timestamp' }
  ]

  // Step 1: Find all legacy session IDs in sessions table.
  const legacySessionRows = db.prepare(
    "SELECT id, source, user_id, session_user, started_at, parent_session_id FROM sessions"
  ).all() as Array<{
    id: string
    source: string | null
    user_id: number | null
    session_user: string | null
    started_at: string | null
    parent_session_id: string | null
  }>

  const legacyInSessions = legacySessionRows.filter(r => isLegacySessionId(r.id))

  // Step 2: Find legacy IDs orphaned in child tables.
  // Build the union of session_ids across child tables, excluding UUIDs and
  // excluding ones already present in sessions.
  const knownSessionIds = new Set(legacySessionRows.map(r => r.id))
  const orphanIds = new Set<string>()

  for (const { table } of childTables) {
    const rows = db.prepare(
      `SELECT DISTINCT session_id FROM ${table} WHERE session_id IS NOT NULL`
    ).all() as Array<{ session_id: string }>
    for (const row of rows) {
      if (!row.session_id) continue
      if (knownSessionIds.has(row.session_id)) continue
      if (!isLegacySessionId(row.session_id)) continue
      orphanIds.add(row.session_id)
    }
  }

  // Early exit: nothing to migrate.
  if (legacyInSessions.length === 0 && orphanIds.size === 0) {
    return
  }

  const runMigration = db.transaction(() => {
    // Defer FK checks so we can rewrite sessions.id without tripping the
    // parent_session_id self-FK (which has no ON UPDATE CASCADE).
    db.pragma('defer_foreign_keys = ON')

    // Build old->new UUID mapping for all legacy IDs (both existing sessions
    // and orphans). Already-UUID IDs are never remapped.
    const idMap = new Map<string, string>()
    for (const row of legacyInSessions) {
      idMap.set(row.id, randomUUID())
    }
    for (const orphanId of orphanIds) {
      idMap.set(orphanId, randomUUID())
    }

    // Step A: Backfill type + remap id for existing legacy sessions.
    const updateSessionStmt = db.prepare(
      "UPDATE sessions SET id = ?, type = ?, session_user = ? WHERE id = ?"
    )
    for (const row of legacyInSessions) {
      const newId = idMap.get(row.id)!
      const newType = inferSessionTypeFromLegacyId(row.id)
      const recoveredSessionUser = row.session_user
        ?? (row.user_id != null ? String(row.user_id) : inferSessionUserFromLegacyId(row.id))
      updateSessionStmt.run(newId, newType, recoveredSessionUser, row.id)
    }

    // Step B: Remap parent_session_id references through the map. Do this
    // AFTER id remap so every possible target UUID already exists.
    const parentRows = db.prepare(
      "SELECT id, parent_session_id FROM sessions WHERE parent_session_id IS NOT NULL"
    ).all() as Array<{ id: string, parent_session_id: string }>
    const updateParentStmt = db.prepare(
      "UPDATE sessions SET parent_session_id = ? WHERE id = ?"
    )
    for (const row of parentRows) {
      const mapped = idMap.get(row.parent_session_id)
      if (mapped) {
        updateParentStmt.run(mapped, row.id)
      }
    }

    // Step C: Recover orphaned sessions. For each orphan ID, gather earliest
    // timestamp and any available user_id from child tables, then insert.
    //
    // Precedence of the reconstructed user_id is determined by the iteration
    // order of `childTables` above: `chat_messages` -> `token_usage` ->
    // `tool_calls` -> `tasks` -> `memories`. The first table that yields a
    // non-null `user_id` wins. Reorder `childTables` deliberately if this
    // precedence needs to change.
    const insertOrphanStmt = db.prepare(
      `INSERT INTO sessions (id, user_id, session_user, source, type, started_at, message_count, summary_written)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0)`
    )
    for (const orphanId of orphanIds) {
      const newId = idMap.get(orphanId)!
      const type = inferSessionTypeFromLegacyId(orphanId)
      const source = inferSessionSourceFromLegacyId(orphanId)

      // Earliest timestamp + first available user_id across child tables.
      // Use two explicit queries per table so we never rely on SQLite's
      // "bare column paired with MIN()" extension to keep the results
      // coherent — a bare column combined with an aggregate in the same
      // SELECT returns an arbitrary row otherwise.
      let earliest: string | null = null
      let userId: number | null = null
      let sessionUser: string | null = null
      for (const { table, userCol, timeCol } of childTables) {
        if (timeCol) {
          const timeRow = db.prepare(
            `SELECT MIN(${timeCol}) AS t FROM ${table} WHERE session_id = ?`
          ).get(orphanId) as { t: string | null } | undefined
          if (timeRow?.t && (!earliest || timeRow.t < earliest)) {
            earliest = timeRow.t
          }
        }
        if (userCol && userId == null) {
          const userRow = db.prepare(
            `SELECT ${userCol} AS u FROM ${table} WHERE session_id = ? AND ${userCol} IS NOT NULL LIMIT 1`
          ).get(orphanId) as { u: number | null } | undefined
          if (userRow?.u != null) {
            userId = userRow.u
          }
        }
      }
      // Verify the reconstructed user_id actually exists in `users` before
      // inserting. If a child row references a deleted user (possible on
      // DBs that ran with `foreign_keys = OFF` at any point, or across
      // historical manual cleanups), leaving the dangling id on the new
      // session row would fail the deferred users FK at COMMIT and abort
      // the entire migration — blocking boot. Keep the canonical identity
      // in `session_user` even when we drop `user_id`, so runtime code
      // can still attribute the row.
      if (userId != null) {
        const userExists = db.prepare('SELECT 1 AS present FROM users WHERE id = ?')
          .get(userId) as { present: number } | undefined
        sessionUser = String(userId)
        if (!userExists) {
          userId = null
        }
      }

      insertOrphanStmt.run(
        newId,
        userId,
        sessionUser,
        source,
        type,
        earliest ?? new Date().toISOString()
      )
    }

    // Step D: Remap FK columns in child tables. One prepared UPDATE per
    // (table, oldId) pair — simple and correct. For large DBs this is O(N)
    // in the number of distinct legacy IDs, not in the number of child rows.
    for (const { table } of childTables) {
      const stmt = db.prepare(
        `UPDATE ${table} SET session_id = ? WHERE session_id = ?`
      )
      for (const [oldId, newId] of idMap) {
        stmt.run(newId, oldId)
      }
    }
  })

  runMigration()
}

/**
 * Validate a username: must be alphanumeric only (a-zA-Z0-9).
 * Returns true if valid, false otherwise.
 */
export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(username)
}

/**
 * Validate a username and throw an error if invalid.
 */
export function validateUsername(username: string): void {
  if (!isValidUsername(username)) {
    throw new Error(`Invalid username "${username}": only alphanumeric characters (a-zA-Z0-9) are allowed, no spaces, umlauts, or special characters.`)
  }
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}
