/**
 * Calendar days in a named time zone, without a date library. A day is the
 * `YYYY-MM-DD` string the zone shows for an instant; arithmetic on days runs
 * on UTC midnights so daylight saving never shifts a day.
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  let found = formatters.get(key)
  if (!found) {
    found = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(key, found)
  }
  return found
}

/** `YYYY-MM-DD` of an instant in `timeZone` (the runtime zone when omitted). */
export function dayKey(ms: number, timeZone?: string): string {
  const parts = formatter(timeZone).formatToParts(new Date(ms))
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Parse an ISO timestamp; SQLite style `YYYY-MM-DD HH:MM:SS` counts as UTC. */
export function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}

function utcOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1)
}

/** `day` moved by `count` days. */
export function addDays(day: string, count: number): string {
  return new Date(utcOf(day) + count * 86_400_000).toISOString().slice(0, 10)
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(day: string): number {
  return (new Date(utcOf(day)).getUTCDay() + 6) % 7
}

/** ISO 8601 week number and week-based year of a day. */
export function isoWeek(day: string): { year: number; week: number } {
  const thursday = addDays(day, 3 - weekdayIndex(day))
  const year = Number(thursday.slice(0, 4))
  const week = Math.floor((utcOf(thursday) - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1
  return { year, week }
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / 86_400_000)
}
