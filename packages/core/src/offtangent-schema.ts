import type { Database } from './database.js'

/**
 * Offtangent tables (SPEC 3.2 and 3.3): captures, router decisions, tags,
 * strand tags, strand links, now set, resurface snoozes and the feed
 * (SPEC 2.9, 3.2). Everything is additive and idempotent; `sessions` gets
 * nothing (now set membership and tags live in their own tables so the hot
 * table is never rebuilt).
 *
 * `feed_items` starts empty on purpose: nothing is backfilled from the
 * system rows that background results used to leave in strands.
 *
 * `chat_messages.capture_id` is the only column addition outside these tables:
 * it is what lets an undo move a message together with its capture (SPEC 4.5).
 * Rows written before captures existed have NULL and are never moved.
 */
/**
 * The `captures` table, written once and used twice: by the initial creation
 * and by the rebuild that widens the status CHECK. Two copies of a CREATE
 * TABLE drift apart, and a rebuild that silently produces a different table
 * than a fresh install is the worst kind of drift — `capturesTableSql.test.ts`
 * asserts both paths end up byte-identical.
 */
export function capturesTableSql(name: string, ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT,
      client_message_id TEXT,
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice','image','file')),
      source TEXT NOT NULL DEFAULT 'web',
      attachments TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','filed','needs_review','unsorted','moved','failed','dismissed')),
      strand_id TEXT,
      message_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      filed_at TEXT,
      metadata TEXT
    )`
}

/** Every column the table has today, in rebuild order. */
const CAPTURE_COLUMNS = [
  'id', 'user_id', 'agent_id', 'client_message_id', 'text', 'kind', 'source',
  'attachments', 'status', 'strand_id', 'message_id', 'created_at', 'filed_at', 'metadata',
]

export function ensureOfftangentTables(db: Database): void {
  db.exec(`
    ${capturesTableSql('captures', true)};
    CREATE UNIQUE INDEX IF NOT EXISTS idx_captures_client_key
      ON captures(user_id, client_message_id) WHERE client_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_captures_status ON captures(user_id, status, created_at);

    CREATE TABLE IF NOT EXISTS router_decisions (
      id TEXT PRIMARY KEY,
      capture_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('append','new_strand','link')),
      target_strand_id TEXT,
      secondary_strand_id TEXT,
      created_strand_id TEXT,
      intent TEXT NOT NULL DEFAULT 'ask' CHECK(intent IN ('note','ask')),
      confidence REAL NOT NULL,
      alternatives TEXT,
      tags TEXT,
      rationale TEXT,
      new_strand_title TEXT,
      new_strand_persona TEXT,
      new_strand_project TEXT,
      project_suggestion TEXT,
      model TEXT,
      latency_ms INTEGER,
      state TEXT NOT NULL DEFAULT 'proposed'
        CHECK(state IN ('proposed','applied','confirmed','undone','superseded')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      applied_at TEXT,
      resolved_at TEXT,
      part_index INTEGER NOT NULL DEFAULT 0,
      part_count INTEGER NOT NULL DEFAULT 1,
      part_text TEXT,
      part_title TEXT,
      sentence_ids TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_router_decisions_capture ON router_decisions(capture_id);

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name ON tags(user_id, name);

    CREATE TABLE IF NOT EXISTS strand_tags (
      strand_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user','router')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (strand_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_strand_tags_tag ON strand_tags(tag_id);

    CREATE TABLE IF NOT EXISTS strand_links (
      id TEXT PRIMARY KEY,
      from_strand TEXT NOT NULL,
      to_strand TEXT NOT NULL,
      capture_id TEXT,
      kind TEXT NOT NULL DEFAULT 'reference' CHECK(kind IN ('reference','moved_from','handover')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_strand_links_from ON strand_links(from_strand);
    CREATE INDEX IF NOT EXISTS idx_strand_links_to ON strand_links(to_strand);

    CREATE TABLE IF NOT EXISTS now_set (
      user_id TEXT NOT NULL,
      strand_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, strand_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_now_set_rank ON now_set(user_id, rank);

    CREATE TABLE IF NOT EXISTS resurface_snoozes (
      user_id TEXT NOT NULL,
      strand_id TEXT NOT NULL,
      snoozed_until TEXT NOT NULL,
      PRIMARY KEY (user_id, strand_id)
    );

    CREATE TABLE IF NOT EXISTS feed_items (
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
    CREATE INDEX IF NOT EXISTS idx_feed_user_created ON feed_items(user_id, created_at DESC);
  `)

  // Persist an optional answer-model choice through deferred filing/restarts.
  // Nullable and additive: old captures continue to inherit their model.
  const captureColumns = db.prepare('PRAGMA table_info(captures)').all() as { name: string }[]
  if (!captureColumns.some(column => column.name === 'metadata')) {
    db.exec('ALTER TABLE captures ADD COLUMN metadata TEXT')
  }

  const decisionCols = db.prepare('PRAGMA table_info(router_decisions)').all() as { name: string }[]
  if (!decisionCols.find(c => c.name === 'new_strand_title')) {
    db.exec('ALTER TABLE router_decisions ADD COLUMN new_strand_title TEXT')
  }
  if (!decisionCols.find(c => c.name === 'new_strand_persona')) {
    db.exec('ALTER TABLE router_decisions ADD COLUMN new_strand_persona TEXT')
  }
  // SPEC 4.2b: the project a `new_strand` decision writes on the strand it
  // creates, and the project proposed for an existing strand (JSON, never
  // applied by the server). Both narrow and nullable; old rows read as null.
  if (!decisionCols.find(c => c.name === 'new_strand_project')) {
    db.exec('ALTER TABLE router_decisions ADD COLUMN new_strand_project TEXT')
  }
  if (!decisionCols.find(c => c.name === 'project_suggestion')) {
    db.exec('ALTER TABLE router_decisions ADD COLUMN project_suggestion TEXT')
  }

  // Split-on-intake (plan 2026-09-24): one decision row per topic part of a
  // capture. Additive and defaulted, so every row written before this reads as
  // the single part it was (`part_index 0`, `part_count 1`, no own text) and
  // every reader that ignores the columns keeps working.
  if (!decisionCols.find(c => c.name === 'part_index')) {
    db.exec('ALTER TABLE router_decisions ADD COLUMN part_index INTEGER NOT NULL DEFAULT 0')
  }
  if (!decisionCols.find(c => c.name === 'part_count')) {
    db.exec('ALTER TABLE router_decisions ADD COLUMN part_count INTEGER NOT NULL DEFAULT 1')
  }
  if (!decisionCols.find(c => c.name === 'part_text')) {
    db.exec('ALTER TABLE router_decisions ADD COLUMN part_text TEXT')
  }
  if (!decisionCols.find(c => c.name === 'part_title')) {
    db.exec('ALTER TABLE router_decisions ADD COLUMN part_title TEXT')
  }
  if (!decisionCols.find(c => c.name === 'sentence_ids')) {
    db.exec('ALTER TABLE router_decisions ADD COLUMN sentence_ids TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_router_decisions_part ON router_decisions(capture_id, part_index)')

  ensureDismissedStatus(db)

  const chatCols = db.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[]
  if (!chatCols.find(c => c.name === 'capture_id')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN capture_id TEXT')
  }
  if (!chatCols.find(c => c.name === 'part_index')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN part_index INTEGER NOT NULL DEFAULT 0')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_capture ON chat_messages(capture_id)')
}

/**
 * `dismissed` (SPEC 4.3): the status a capture gets when the user throws the
 * tray card away. Before it existed there was no way to get rid of an
 * unsorted capture at all, so a bad transcript stayed in the inbox forever.
 *
 * SQLite cannot widen a CHECK constraint, so the table has to be rebuilt.
 * That is cheap here (a few dozen rows) but it is still a DROP TABLE on a
 * production database, so it is written like one:
 *
 * - one `db.transaction(...).immediate()`, never `BEGIN` inside `exec` —
 *   better-sqlite3 does not roll back a failed `exec` and would leave the
 *   connection inside an open transaction,
 * - the indexes are replayed from `sqlite_master`, not from a hardcoded list,
 *   so an index nobody remembers survives the rebuild,
 * - the row count is compared before and after; a mismatch throws and the
 *   transaction rolls back rather than booting on a truncated table,
 * - a column the old table has and the new one does not throws instead of
 *   being dropped silently.
 *
 * Nothing REFERENCES `captures` (`chat_messages.capture_id` and
 * `router_decisions.capture_id` are plain columns without foreign keys), and
 * the table carries no triggers or views — both verified against the live
 * database before this shipped, and both re-checked here at runtime, because
 * "there are none" is exactly the assumption that rots.
 */
function ensureDismissedStatus(db: Database): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'captures'")
    .get() as { sql: string | null } | undefined
  if (!table?.sql || statusCheckAllows(table.sql, 'dismissed')) return

  // Objects that a DROP TABLE would take with it, or that would make the
  // RENAME fail. A rebuild that silently drops an FTS sync trigger is worse
  // than a rebuild that refuses to run.
  const attached = db.prepare(
    "SELECT type, name FROM sqlite_master WHERE tbl_name = 'captures' AND type IN ('trigger', 'view')",
  ).all() as { type: string; name: string }[]
  if (attached.length > 0) {
    throw new Error(`captures rebuild aborted: unexpected ${attached.map(o => `${o.type} ${o.name}`).join(', ')}`)
  }
  const referencing = db.prepare(
    "SELECT name FROM sqlite_master WHERE sql LIKE '%REFERENCES captures%' OR sql LIKE '%REFERENCES \"captures\"%'",
  ).all() as { name: string }[]
  if (referencing.length > 0) {
    throw new Error(`captures rebuild aborted: foreign keys from ${referencing.map(r => r.name).join(', ')}`)
  }

  const existing = (db.prepare('PRAGMA table_info(captures)').all() as { name: string }[]).map(c => c.name)
  const lost = existing.filter(name => !CAPTURE_COLUMNS.includes(name))
  if (lost.length > 0) throw new Error(`captures rebuild aborted: unknown column(s) ${lost.join(', ')}`)
  // Copy what the old table actually has: a database that predates `metadata`
  // must not lose its rows to a column list written for today.
  const shared = CAPTURE_COLUMNS.filter(name => existing.includes(name)).map(name => `"${name}"`).join(', ')
  const indexes = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'captures' AND sql IS NOT NULL",
  ).all() as { sql: string }[]).map(r => r.sql)

  const before = (db.prepare('SELECT COUNT(*) AS c FROM captures').get() as { c: number }).c
  db.transaction(() => {
    db.exec(capturesTableSql('captures_migrated'))
    db.exec(`INSERT INTO captures_migrated (${shared}) SELECT ${shared} FROM captures`)
    const copied = (db.prepare('SELECT COUNT(*) AS c FROM captures_migrated').get() as { c: number }).c
    if (copied !== before) throw new Error(`captures rebuild aborted: copied ${copied} of ${before} rows`)
    db.exec('DROP TABLE captures')
    db.exec('ALTER TABLE captures_migrated RENAME TO captures')
    for (const sql of indexes) db.exec(sql)
  }).immediate()
}

/**
 * True when the status CHECK constraint already lists `value`. Scoped to that
 * constraint on purpose: a plain `sql.includes("'dismissed'")` would also be
 * satisfied by a default, a comment or another column, and then the rebuild
 * never runs while every insert keeps failing against the old CHECK.
 */
function statusCheckAllows(sql: string, value: string): boolean {
  const check = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i.exec(sql)
  if (!check) return false
  return check[1]!.split(',').map(part => part.trim().replace(/^'|'$/g, '')).includes(value)
}
