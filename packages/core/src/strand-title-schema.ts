import type { Database } from './database.js'

/**
 * Migration of the strand auto-title (plan strand-titel, Paket 5): the run
 * bookkeeping of the throttle, one row per strand. Kept apart from
 * strand-auto-title.ts so database.ts does not import the model layer.
 * Additive, idempotent, no backfill (no row = never evaluated).
 * `retry_pending`: the last run failed without a model answer and has not
 * been retried yet (exactly one early retry, see planStrandAutoTitle).
 */
export function ensureStrandTitleTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strand_title_runs (
      strand_id TEXT PRIMARY KEY,
      last_run_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_turn_count INTEGER NOT NULL DEFAULT 0,
      last_summary_version INTEGER NOT NULL DEFAULT 0,
      runs INTEGER NOT NULL DEFAULT 0,
      last_outcome TEXT,
      last_model TEXT,
      retry_pending INTEGER NOT NULL DEFAULT 0
    );
  `)
  const columns = db.prepare('PRAGMA table_info(strand_title_runs)').all() as { name: string }[]
  if (!columns.some(c => c.name === 'retry_pending')) {
    db.exec('ALTER TABLE strand_title_runs ADD COLUMN retry_pending INTEGER NOT NULL DEFAULT 0')
  }
}

