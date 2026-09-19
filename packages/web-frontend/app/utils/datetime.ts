/**
 * Backend timestamps come from SQLite's `datetime('now')`, which returns
 * a UTC instant formatted as `YYYY-MM-DD HH:MM:SS` with no timezone marker.
 * Passing such a string directly to `new Date(...)` makes the JS engine
 * interpret it as **local** time, which shifts every rendered timestamp by
 * the user's UTC offset (e.g. a message sent at 13:07 UTC shows as 13:07
 * local instead of 15:07 in Europe/Vienna during CEST).
 *
 * This helper normalises both shapes — ISO strings with explicit offset
 * and SQLite-style naked UTC strings — into a `Date` that represents the
 * correct instant. Callers then use `toLocaleString` / `toLocaleTimeString`
 * to render in the browser's local timezone.
 */
export function parseBackendTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null

  const trimmed = value.trim()
  if (!trimmed) return null

  const hasExplicitZone = /Z$|[+-]\d{2}:?\d{2}$/.test(trimmed)
  const normalised = hasExplicitZone ? trimmed : `${trimmed.replace(' ', 'T')}Z`

  const date = new Date(normalised)
  return Number.isNaN(date.getTime()) ? null : date
}
