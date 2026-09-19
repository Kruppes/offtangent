import type { Database } from './database.js'

/**
 * Migration `strand-project-assignment` (Offtangent Stufe 2, running
 * assignment). Three new tables, nothing else: no column is added to
 * `sessions`, no existing column changes meaning, no row is rewritten. The
 * live database holds thousands of sessions and a rebuild of that table is
 * the one migration shape this project refuses, so the whole feature is
 * carried by tables of its own.
 *
 *  * `strand_project_suggestions` — at most ONE open suggestion per strand
 *    (the strand id is the primary key). Written when the classifier lands in
 *    the suggestion band, deleted when the suggestion is accepted, dismissed
 *    or superseded.
 *  * `strand_project_dismissals` — every (strand, project) pair the user has
 *    thrown away. This is the memory that makes "dismissed stays dismissed"
 *    survive a restart: the pair is never suggested again AND never assigned
 *    automatically, whatever confidence a later run produces.
 *  * `strand_project_runs` — one row per evaluated strand, the bookkeeping of
 *    the rate limit (last run, message count at that run, outcome). Without it
 *    every message would pay for a classification.
 */
export function ensureProjectAssignmentTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strand_project_suggestions (
      strand_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_strand_project_suggestions_user
      ON strand_project_suggestions(user_id, created_at);

    CREATE TABLE IF NOT EXISTS strand_project_dismissals (
      strand_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (strand_id, project_id)
    );

    CREATE TABLE IF NOT EXISTS strand_project_runs (
      strand_id TEXT PRIMARY KEY,
      last_run_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_message_count INTEGER NOT NULL DEFAULT 0,
      runs INTEGER NOT NULL DEFAULT 0,
      last_outcome TEXT,
      last_confidence REAL,
      last_model TEXT
    );
  `)
}
