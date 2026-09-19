/**
 * One answer to "what does this timestamp mean".
 *
 * Every datetime column in this database is written by SQLite's
 * `datetime('now')` and therefore looks like `2026-09-15 06:15:53`: UTC, second
 * resolution, and — the expensive part — without any zone marker. Handed to
 * `new Date(...)` in JS (and to most other client parsers) such a string is
 * read as LOCAL time, so a browser in Europe/Berlin renders a message two hours
 * before it happened and sorts it against locally created ISO timestamps
 * completely wrong. That is the "my messages slide under yours" bug.
 *
 * Rule for the wire: nothing leaves the backend in the naked form. Everything a
 * client sees is ISO-8601 with an explicit `Z`.
 *
 * Note on ORDERING: normalizing the wire does NOT make `ORDER BY timestamp`
 * safe — the column has second resolution, and several rows per second are
 * normal. `id` is the insertion order and the only exact tiebreaker, so every
 * query that orders `chat_messages` chronologically carries `id` as well.
 */

/** Is this string already unambiguous (has `Z` or a numeric UTC offset)? */
function hasExplicitZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
}

/**
 * Normalize a stored datetime to ISO-8601 UTC (`2026-09-15T06:15:53.000Z`).
 *
 * Accepts the naked SQLite form, an ISO string with `Z`, and an ISO string with
 * a numeric offset. Anything unparseable is handed back untouched: a weird
 * timestamp must never cost the caller the row.
 */
export function toIsoUtc(value: string): string {
  const trimmed = value?.trim?.() ?? value
  if (!trimmed) return value
  const normalized = hasExplicitZone(trimmed) ? trimmed : `${trimmed.replace(' ', 'T')}Z`
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

/** {@link toIsoUtc} for nullable columns. `null`/`undefined`/'' stay nullish. */
export function toIsoUtcOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  return toIsoUtc(value)
}

/**
 * Sortable epoch value for a stored or normalized datetime.
 *
 * Needed wherever rows of different tables are merged in memory (task
 * timelines merge `chat_messages` with `tool_calls`): once one side is ISO and
 * the other is still the naked SQLite form, a string compare puts every ISO
 * row after every naked row, because `'T' > ' '`. Comparing instants avoids
 * that trap entirely.
 *
 * Unparseable or missing values sort last (`Number.MAX_SAFE_INTEGER`) so a
 * broken row cannot silently jump to the top of a timeline.
 */
export function timestampSortKey(value: string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER
  const ms = new Date(toIsoUtc(value)).getTime()
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms
}
