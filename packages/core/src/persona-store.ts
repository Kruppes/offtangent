/**
 * persona-store.ts: the persona record (SPEC 13.2, 13.5).
 *
 * Until now a persona was a directory of markdown files and nothing else. That
 * made two things impossible: a client could not render a persona it did not
 * ship a colour for (the app hardcodes four ids and paints everything else
 * grey), and "the default persona" was the string literal `'main'` in a few
 * dozen places, so a fresh install could never call its generalist anything
 * else.
 *
 * This table holds exactly the metadata that must survive a restart and be
 * servable to a client: display name, colour, badge, the `is_default` flag and
 * `archived`. The behaviour of a persona stays in its markdown files — the
 * record is deliberately not a second source of truth for the prompt.
 *
 * The id is the primary key and immutable by contract (SPEC 13.5): it appears
 * in sessions, facts, tasks and file paths, so renaming changes the display
 * name only.
 */
import type { Database } from './database.js'

/** The persistent metadata of one persona. */
export interface PersonaRecord {
  id: string
  displayName: string | null
  color: string | null
  badge: string | null
  isDefault: boolean
  archived: boolean
  createdAt: string
  updatedAt: string
}

/** Writable parts of a record. Absent keys stay unchanged. */
export interface PersonaRecordPatch {
  displayName?: string | null
  color?: string | null
  badge?: string | null
  archived?: boolean
  isDefault?: boolean
}

/**
 * What a hard delete of this persona would take with it (SPEC 13.5). Counted,
 * never guessed: the preview is the only thing standing between a user and an
 * irreversible loss of history.
 */
export interface PersonaDeletePreview {
  personaId: string
  strands: number
  messages: number
  tasks: number
  cronjobs: number
  facts: number
  captures: number
}

interface PersonaRow {
  id: string
  display_name: string | null
  color: string | null
  badge: string | null
  is_default: number
  archived: number
  created_at: string
  updated_at: string
}

/**
 * The id used to seed `is_default` on a database that has never seen this
 * table. It is the historical literal and appears here ONCE, as a migration
 * seed — every read path asks {@link getDefaultPersonaId} instead.
 */
export const LEGACY_DEFAULT_PERSONA_ID = 'main'

/**
 * Idempotent migration. Additive only: a `CREATE TABLE IF NOT EXISTS` plus
 * column guards, never a table rebuild (the live database is large and a
 * rebuild is the one migration shape this repo refuses).
 *
 * The partial unique index is what makes "exactly one default" a database
 * invariant rather than a convention.
 */
export function ensurePersonaTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      color TEXT,
      badge TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_default ON personas(is_default) WHERE is_default = 1;
    CREATE INDEX IF NOT EXISTS idx_personas_archived ON personas(archived);
  `)

  const cols = db.prepare('PRAGMA table_info(personas)').all() as { name: string }[]
  const addColumn = (name: string, ddl: string): void => {
    if (!cols.find(c => c.name === name)) db.exec(`ALTER TABLE personas ADD COLUMN ${ddl}`)
  }
  addColumn('display_name', 'display_name TEXT')
  addColumn('color', 'color TEXT')
  addColumn('badge', 'badge TEXT')
  addColumn('is_default', 'is_default INTEGER NOT NULL DEFAULT 0')
  addColumn('archived', 'archived INTEGER NOT NULL DEFAULT 0')

  // Seed: an install that upgrades into this table must keep answering the
  // same way it did yesterday, so the historical default becomes the flagged
  // one. Only ever runs while no persona carries the flag.
  const hasDefault = db.prepare('SELECT 1 AS c FROM personas WHERE is_default = 1 LIMIT 1').get() as { c: number } | undefined
  if (!hasDefault) {
    db.prepare(`
      INSERT INTO personas (id, is_default) VALUES (?, 1)
      ON CONFLICT(id) DO UPDATE SET is_default = 1, updated_at = datetime('now')
    `).run(LEGACY_DEFAULT_PERSONA_ID)
  }
}

function toRecord(row: PersonaRow): PersonaRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    color: row.color,
    badge: row.badge,
    isDefault: row.is_default === 1,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The flagged default persona, or the historical literal if none is flagged. */
export function getDefaultPersonaId(db: Database): string {
  const row = db.prepare('SELECT id FROM personas WHERE is_default = 1 LIMIT 1').get() as { id: string } | undefined
  return row?.id ?? LEGACY_DEFAULT_PERSONA_ID
}

export function getPersonaRecord(db: Database, id: string): PersonaRecord | null {
  const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as PersonaRow | undefined
  return row ? toRecord(row) : null
}

export function listPersonaRecords(db: Database): PersonaRecord[] {
  const rows = db.prepare('SELECT * FROM personas ORDER BY id').all() as PersonaRow[]
  return rows.map(toRecord)
}

/** Create the row for a persona if it has none. Never clobbers an existing one. */
export function ensurePersonaRecord(db: Database, id: string): PersonaRecord {
  db.prepare('INSERT OR IGNORE INTO personas (id) VALUES (?)').run(id)
  return getPersonaRecord(db, id) as PersonaRecord
}

/**
 * Update the record. `isDefault: true` moves the flag atomically — the partial
 * unique index would otherwise reject the second row, so the old default is
 * cleared inside the same transaction.
 */
export function updatePersonaRecord(db: Database, id: string, patch: PersonaRecordPatch): PersonaRecord {
  ensurePersonaRecord(db, id)

  const apply = db.transaction(() => {
    if (patch.isDefault === true) {
      db.prepare("UPDATE personas SET is_default = 0, updated_at = datetime('now') WHERE is_default = 1 AND id != ?").run(id)
      // A default persona that is archived would leave the fallback target
      // invisible, so promoting one un-archives it.
      db.prepare("UPDATE personas SET is_default = 1, archived = 0, updated_at = datetime('now') WHERE id = ?").run(id)
    }

    const sets: string[] = []
    const params: unknown[] = []
    if ('displayName' in patch) { sets.push('display_name = ?'); params.push(patch.displayName ?? null) }
    if ('color' in patch) { sets.push('color = ?'); params.push(patch.color ?? null) }
    if ('badge' in patch) { sets.push('badge = ?'); params.push(patch.badge ?? null) }
    if ('archived' in patch && patch.isDefault !== true) { sets.push('archived = ?'); params.push(patch.archived ? 1 : 0) }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')")
      params.push(id)
      db.prepare(`UPDATE personas SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }
  })
  apply()

  return getPersonaRecord(db, id) as PersonaRecord
}

export function deletePersonaRecord(db: Database, id: string): void {
  db.prepare('DELETE FROM personas WHERE id = ?').run(id)
}

/* ── Runtime hazards and cascade ── */

/**
 * True while a delegated task of this persona is running or waiting for an
 * answer. Mirrors `hasLiveTaskForStrand` (SPEC 7.5b) one level up: the unit
 * that must not vanish under a running job is the persona here, not a strand.
 */
export function hasLiveTaskForPersona(db: Database, personaId: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS c FROM tasks WHERE agent_id = ? AND status IN ('running', 'paused') LIMIT 1",
  ).get(personaId) as { c: number } | undefined
  return !!row
}

function count(db: Database, sql: string, ...params: unknown[]): number {
  try {
    const row = db.prepare(sql).get(...params) as { c: number } | undefined
    return row ? row.c : 0
  } catch {
    // A table that does not exist in this install counts as zero rather than
    // failing the whole preview — the preview is a safety net, not a report.
    return 0
  }
}

/**
 * What a hard delete would remove. Counts only; nothing is written here, and
 * the caller shows this to the user before asking for confirmation.
 */
export function previewPersonaDelete(db: Database, personaId: string): PersonaDeletePreview {
  return {
    personaId,
    strands: count(db, "SELECT COUNT(*) AS c FROM sessions WHERE agent_id = ? AND type = 'interactive'", personaId),
    messages: count(db, 'SELECT COUNT(*) AS c FROM chat_messages WHERE agent_id = ?', personaId),
    tasks: count(db, 'SELECT COUNT(*) AS c FROM tasks WHERE agent_id = ?', personaId),
    cronjobs: count(db, 'SELECT COUNT(*) AS c FROM scheduled_tasks WHERE agent_id = ?', personaId),
    facts: count(db, 'SELECT COUNT(*) AS c FROM memories WHERE agent_id = ?', personaId),
    captures: count(db, 'SELECT COUNT(*) AS c FROM captures WHERE agent_id = ?', personaId),
  }
}
