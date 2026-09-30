/**
 * Boards (plan 2026-09-25): a long-lived, overwritable object with a `kind`
 * that names its renderer contract. An agent publishes a new state, the board
 * keeps ONE current row, the previous states stay available as revisions, and
 * numeric time series live beside it so a client can draw a trend without
 * loading every revision.
 *
 * Storage only. Who may publish, what a payload has to contain and what the
 * feed sees is decided in `board-tool.ts`.
 *
 * Everything is scoped by `user_id`, always as the first key: a board of
 * another user must not be readable, writable or even distinguishable from
 * one that does not exist.
 */
import type { Database } from './database.js'

export interface Board {
  key: string
  kind: string
  title: string
  icon: string | null
  agentId: string | null
  revision: number
  summary: string | null
  /** Parsed payload. Stored as a JSON string, never handed out as one. */
  payload: unknown
  asOf: string
  updatedAt: string
}

/** The list shape: no payload, so a chooser stays cheap. */
export type BoardSummary = Omit<Board, 'payload'>

export interface BoardRevisionMeta {
  revision: number
  asOf: string
  createdAt: string
  summary: string | null
}

/**
 * A historic revision in the full board shape: the revision's own `summary`,
 * `payload`, `asOf` and `revision`, plus the identity of the board it belongs
 * to (`kind`, `title`, `icon`, `agentId`, `updatedAt`). Clients pick their
 * renderer from `kind`, so a revision without it would silently fall back to
 * the generic renderer.
 */
export interface BoardRevision extends Board {
  createdAt: string
}

export interface BoardSeriesPoint {
  day: string
  value: number
  meta?: unknown
}

export interface UpsertBoardInput {
  userId: string
  key: string
  kind: string
  title: string
  icon?: string | null
  agentId?: string | null
  summary?: string | null
  payload: unknown
  asOf: string
}

export interface BoardSeriesInput {
  series: string
  day: string
  value: number
  meta?: unknown
}

/** How many revisions of one board are kept. Older ones are pruned on write. */
export const BOARD_REVISION_RETENTION = 30

/** Upper bound for a series read, so one request cannot scan years. */
export const BOARD_SERIES_MAX_DAYS = 400

/** `YYYY-MM-DD HH:MM:SS` (SQLite) -> ISO 8601, anything else verbatim. */
function toIso(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return `${value.replace(' ', 'T')}Z`
  return value
}

/**
 * A payload that cannot be parsed is not silently turned into null: the row
 * was written as JSON by this module, so broken JSON means the column was
 * tampered with and the caller should see the raw text rather than a lie.
 */
function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function parseMeta(raw: string | null): unknown {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

interface BoardRow {
  key: string
  kind: string
  title: string
  icon: string | null
  agent_id: string | null
  revision: number
  summary: string | null
  payload: string
  as_of: string
  updated_at: string
}

function toBoardSummary(row: Omit<BoardRow, 'payload'>): BoardSummary {
  return {
    key: row.key,
    kind: row.kind,
    title: row.title,
    icon: row.icon ?? null,
    agentId: row.agent_id ?? null,
    revision: row.revision,
    summary: row.summary ?? null,
    asOf: toIso(row.as_of),
    updatedAt: toIso(row.updated_at),
  }
}

const BOARD_COLUMNS = 'key, kind, title, icon, agent_id, revision, summary, payload, as_of, updated_at'
const BOARD_LIST_COLUMNS = 'key, kind, title, icon, agent_id, revision, summary, as_of, updated_at'

/**
 * Write the new state of a board and archive it as a revision.
 *
 * The revision number is derived inside the transaction from the row that is
 * there (`revision + 1`, starting at 1), never from the caller: two publishes
 * racing for the same board must not produce two revision 4s.
 */
export function upsertBoard(db: Database, input: UpsertBoardInput): Board {
  const payload = JSON.stringify(input.payload ?? {})
  const summary = input.summary ?? null

  const write = db.transaction(() => {
    const current = db.prepare('SELECT revision FROM boards WHERE user_id = ? AND key = ?')
      .get(input.userId, input.key) as { revision: number } | undefined
    const revision = (current?.revision ?? 0) + 1

    db.prepare(
      `INSERT INTO boards (key, user_id, kind, title, icon, agent_id, revision, summary, payload, as_of, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, key) DO UPDATE SET
         kind = excluded.kind,
         title = excluded.title,
         icon = excluded.icon,
         agent_id = excluded.agent_id,
         revision = excluded.revision,
         summary = excluded.summary,
         payload = excluded.payload,
         as_of = excluded.as_of,
         updated_at = excluded.updated_at`,
    ).run(
      input.key,
      input.userId,
      input.kind,
      input.title,
      input.icon ?? null,
      input.agentId ?? null,
      revision,
      summary,
      payload,
      input.asOf,
    )

    db.prepare(
      `INSERT INTO board_revisions (user_id, key, revision, summary, payload, as_of)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.userId, input.key, revision, summary, payload, input.asOf)

    db.prepare(
      `DELETE FROM board_revisions
       WHERE user_id = ? AND key = ? AND revision <= ?`,
    ).run(input.userId, input.key, revision - BOARD_REVISION_RETENTION)

    return revision
  })

  write.immediate()
  return getBoard(db, input.userId, input.key)!
}

/** Last write of a day wins, per series. */
export function upsertBoardSeries(
  db: Database,
  userId: string,
  key: string,
  points: readonly BoardSeriesInput[],
): number {
  if (points.length === 0) return 0
  const statement = db.prepare(
    `INSERT INTO board_series (user_id, key, series, day, value, meta)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key, series, day) DO UPDATE SET
       value = excluded.value,
       meta = excluded.meta`,
  )
  const write = db.transaction(() => {
    for (const point of points) {
      statement.run(
        userId,
        key,
        point.series,
        point.day,
        point.value,
        point.meta === undefined ? null : JSON.stringify(point.meta),
      )
    }
  })
  write.immediate()
  return points.length
}

export function listBoards(db: Database, userId: string): BoardSummary[] {
  const rows = db.prepare(
    `SELECT ${BOARD_LIST_COLUMNS} FROM boards WHERE user_id = ? ORDER BY updated_at DESC, key ASC`,
  ).all(userId) as Omit<BoardRow, 'payload'>[]
  return rows.map(toBoardSummary)
}

export function getBoard(db: Database, userId: string, key: string): Board | null {
  const row = db.prepare(`SELECT ${BOARD_COLUMNS} FROM boards WHERE user_id = ? AND key = ?`)
    .get(userId, key) as BoardRow | undefined
  if (!row) return null
  return { ...toBoardSummary(row), payload: parsePayload(row.payload) }
}

export function listBoardRevisions(db: Database, userId: string, key: string): BoardRevisionMeta[] {
  const rows = db.prepare(
    `SELECT revision, as_of, created_at, summary FROM board_revisions
     WHERE user_id = ? AND key = ? ORDER BY revision DESC`,
  ).all(userId, key) as { revision: number; as_of: string; created_at: string; summary: string | null }[]
  return rows.map(row => ({
    revision: row.revision,
    asOf: toIso(row.as_of),
    createdAt: toIso(row.created_at),
    summary: row.summary ?? null,
  }))
}

export function getBoardRevision(
  db: Database,
  userId: string,
  key: string,
  revision: number,
): BoardRevision | null {
  const row = db.prepare(
    `SELECT revision, summary, payload, as_of, created_at FROM board_revisions
     WHERE user_id = ? AND key = ? AND revision = ?`,
  ).get(userId, key, revision) as
    { revision: number; summary: string | null; payload: string; as_of: string; created_at: string } | undefined
  if (!row) return null
  const board = getBoard(db, userId, key)
  if (!board) return null
  return {
    key,
    kind: board.kind,
    title: board.title,
    icon: board.icon,
    agentId: board.agentId,
    updatedAt: board.updatedAt,
    revision: row.revision,
    summary: row.summary ?? null,
    payload: parsePayload(row.payload),
    asOf: toIso(row.as_of),
    createdAt: toIso(row.created_at),
  }
}

/**
 * The requested series, oldest point first, limited to the last `days` days
 * counted from today (UTC). A series nobody wrote comes back as an empty
 * array rather than being dropped, so a client can tell "no data yet" from
 * "this series does not exist in my request".
 */
export function getBoardSeries(
  db: Database,
  userId: string,
  key: string,
  series: readonly string[],
  days: number,
): Record<string, BoardSeriesPoint[]> {
  const result: Record<string, BoardSeriesPoint[]> = {}
  if (series.length === 0) return result
  const window = Math.min(BOARD_SERIES_MAX_DAYS, Math.max(1, Math.trunc(days)))
  const from = new Date(Date.now() - (window - 1) * 86_400_000).toISOString().slice(0, 10)
  const statement = db.prepare(
    `SELECT day, value, meta FROM board_series
     WHERE user_id = ? AND key = ? AND series = ? AND day >= ?
     ORDER BY day ASC`,
  )
  for (const name of series) {
    const rows = statement.all(userId, key, name, from) as
      { day: string; value: number; meta: string | null }[]
    result[name] = rows.map(row => {
      const meta = parseMeta(row.meta)
      return meta === undefined
        ? { day: row.day, value: row.value }
        : { day: row.day, value: row.value, meta }
    })
  }
  return result
}

/** Board, revisions and series in one transaction. False when there was none. */
export function deleteBoard(db: Database, userId: string, key: string): boolean {
  const remove = db.transaction(() => {
    const deleted = db.prepare('DELETE FROM boards WHERE user_id = ? AND key = ?').run(userId, key).changes
    db.prepare('DELETE FROM board_revisions WHERE user_id = ? AND key = ?').run(userId, key)
    db.prepare('DELETE FROM board_series WHERE user_id = ? AND key = ?').run(userId, key)
    return deleted > 0
  })
  return remove.immediate()
}
