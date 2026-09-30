/**
 * strand-read-state.ts: server side read state of a strand (Offtangent
 * cutover, plan 2026-09-18).
 *
 * Until now "unread" only existed in the app's local storage, so a second
 * device — or a fresh install — showed everything as new. The marker lives in
 * `sessions.last_read_at` (nullable ISO string, additive migration in
 * `database.ts`): `null` means "never opened", which is exactly the state of
 * every row that existed before the column.
 *
 * Two derived fields ride on every strand the API returns:
 *
 *   - `lastActivityAt` — the timestamp of the newest NON-USER message in the
 *     strand (assistant answers, system rows such as task result cards or
 *     interaction blocks). Deliberately not `sessions.last_activity`: that
 *     column also moves when the user types, and a strand must not become
 *     unread because the user wrote in it.
 *   - `unread` — there is such a message and it is newer than `last_read_at`.
 *     A fresh strand that the user opened and typed into, with no answer yet,
 *     is therefore NOT unread.
 *
 * Everything is read in ONE query for a whole list of strands (the list
 * endpoint returns up to 200): a per-strand read would be an N+1 over the
 * biggest table in the database.
 */
import type { Database } from './database.js'
import { timestampSortKey, toIsoUtcOrNull } from './timestamps.js'

export interface StrandReadState {
  /** Newest non-user message in the strand, ISO-8601 UTC, `null` when none. */
  lastActivityAt: string | null
  /** Non-user activity newer than the read marker. */
  unread: boolean
}

/** Neutral state for a strand nothing is known about (no row, no messages). */
export const EMPTY_STRAND_READ_STATE: StrandReadState = { lastActivityAt: null, unread: false }

interface ReadStateRow {
  id: string
  last_read_at: string | null
  last_activity_at: string | null
}

/**
 * How many ids go into one `IN (...)`. SQLite's default parameter limit is
 * 999; the chunk keeps a wide margin and bounds the statement cache.
 */
const ID_CHUNK = 400

/**
 * Read state for many strands at once. One query per (at most 400) ids, no
 * N+1. Ids that do not exist are simply absent from the result — callers
 * fall back to {@link EMPTY_STRAND_READ_STATE}.
 */
export function getStrandReadStates(db: Database, strandIds: string[]): Map<string, StrandReadState> {
  const states = new Map<string, StrandReadState>()
  if (strandIds.length === 0) return states

  for (let offset = 0; offset < strandIds.length; offset += ID_CHUNK) {
    const chunk = strandIds.slice(offset, offset + ID_CHUNK)
    const rows = db.prepare(
      `SELECT s.id AS id,
              s.last_read_at AS last_read_at,
              (SELECT MAX(m.timestamp) FROM chat_messages m
                WHERE m.session_id = s.id AND m.role != 'user') AS last_activity_at
         FROM sessions s
        WHERE s.id IN (${chunk.map(() => '?').join(', ')})`,
    ).all(...chunk) as ReadStateRow[]

    for (const row of rows) {
      states.set(row.id, toReadState(row.last_activity_at, row.last_read_at))
    }
  }

  return states
}

/** Read state of a single strand. Thin wrapper over {@link getStrandReadStates}. */
export function getStrandReadState(db: Database, strandId: string): StrandReadState {
  return getStrandReadStates(db, [strandId]).get(strandId) ?? EMPTY_STRAND_READ_STATE
}

/**
 * Mark a strand as read. Idempotent: the marker is simply moved to `now`, a
 * second call in the same second is a no-op in effect. Returns true when a
 * row was touched (false for an unknown id — the caller has already checked
 * ownership).
 */
export function markStrandRead(db: Database, strandId: string, at: Date = new Date()): boolean {
  const result = db.prepare('UPDATE sessions SET last_read_at = ? WHERE id = ?')
    .run(at.toISOString(), strandId)
  return result.changes > 0
}

/**
 * Compare two timestamps that may be stored in different shapes: message rows
 * carry SQLite's naked `YYYY-MM-DD HH:MM:SS`, the read marker is ISO with `Z`.
 * A string compare would put every ISO value after every naked one.
 */
function toReadState(lastActivityRaw: string | null, lastReadRaw: string | null): StrandReadState {
  const lastActivityAt = toIsoUtcOrNull(lastActivityRaw)
  if (!lastActivityAt) return { lastActivityAt: null, unread: false }
  if (!lastReadRaw) return { lastActivityAt, unread: true }
  return {
    lastActivityAt,
    unread: timestampSortKey(lastActivityAt) > timestampSortKey(lastReadRaw),
  }
}
