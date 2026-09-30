import type { Database } from './database.js'
import type { SessionSummary, SessionSummaryDelta } from './session-summary-schema.js'

/**
 * session_summaries: one row per summary run, additive (SPEC 11.2). The
 * latest version per session is what the app and the strand turn read.
 * Created by `ensureSessionSummariesTable`, called from initDatabase.
 */
export function ensureSessionSummariesTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      schema_json TEXT NOT NULL,
      delta_json TEXT,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id, version);
  `)
}

export interface SessionSummaryRow {
  id: number
  sessionId: string
  version: number
  summary: SessionSummary
  delta: SessionSummaryDelta | null
  model: string | null
  createdAt: string
}

interface RawRow {
  id: number
  session_id: string
  version: number
  schema_json: string
  delta_json: string | null
  model: string | null
  created_at: string
}

function toRow(r: RawRow): SessionSummaryRow | null {
  try {
    return {
      id: r.id,
      sessionId: r.session_id,
      version: r.version,
      summary: JSON.parse(r.schema_json) as SessionSummary,
      delta: r.delta_json ? JSON.parse(r.delta_json) as SessionSummaryDelta : null,
      model: r.model,
      createdAt: r.created_at,
    }
  } catch {
    return null
  }
}

export function getLatestSessionSummary(db: Database, sessionId: string): SessionSummaryRow | null {
  try {
    const r = db.prepare(
      'SELECT id, session_id, version, schema_json, delta_json, model, created_at FROM session_summaries WHERE session_id = ? ORDER BY version DESC LIMIT 1',
    ).get(sessionId) as RawRow | undefined
    return r ? toRow(r) : null
  } catch {
    return null
  }
}

export function insertSessionSummary(
  db: Database,
  sessionId: string,
  summary: SessionSummary,
  delta: SessionSummaryDelta | null,
  model: string | null,
): SessionSummaryRow {
  const insert = db.transaction(() => {
    const prev = db.prepare('SELECT MAX(version) AS v FROM session_summaries WHERE session_id = ?').get(sessionId) as { v: number | null }
    const version = (prev.v ?? 0) + 1
    const info = db.prepare(
      'INSERT INTO session_summaries (session_id, version, schema_json, delta_json, model) VALUES (?, ?, ?, ?, ?)',
    ).run(sessionId, version, JSON.stringify(summary), delta ? JSON.stringify(delta) : null, model)
    return { id: Number(info.lastInsertRowid), version }
  })
  const { id, version } = insert()
  const row = db.prepare(
    'SELECT id, session_id, version, schema_json, delta_json, model, created_at FROM session_summaries WHERE id = ?',
  ).get(id) as RawRow
  return { ...(toRow(row) as SessionSummaryRow), version }
}

export function listSessionSummaries(db: Database, sessionId: string): SessionSummaryRow[] {
  const rows = db.prepare(
    'SELECT id, session_id, version, schema_json, delta_json, model, created_at FROM session_summaries WHERE session_id = ? ORDER BY version ASC',
  ).all(sessionId) as RawRow[]
  return rows.map(toRow).filter((r): r is SessionSummaryRow => r !== null)
}
