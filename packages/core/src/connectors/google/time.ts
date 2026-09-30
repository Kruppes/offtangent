/**
 * Date handling for the calendar tool.
 *
 * A local model is asked things like "tomorrow" and answers with a bare date,
 * so `2026-09-28` has to become a real RFC 3339 instant. Which instant depends
 * on the instance timezone, not on the container clock: the offset is therefore
 * resolved through `Intl` for the day in question, which also gets DST right.
 */
import { getDefaultTimezone, loadConfig } from '../../config.js'

/** Instance timezone: the agent setting wins, otherwise the deployment default. */
export function resolveConnectorTimezone(): string {
  try {
    const settings = loadConfig<{ timezone?: string }>('settings.json')
    const configured = settings?.timezone?.trim()
    if (configured) {
      new Intl.DateTimeFormat('en-US', { timeZone: configured })
      return configured
    }
  } catch {
    // Unreadable settings or an invalid zone: fall through to the default.
  }
  return getDefaultTimezone()
}

function zoneParts(timeZone: string, at: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  }).formatToParts(at)
  const out: Record<string, string> = {}
  for (const part of parts) out[part.type] = part.value
  return out
}

/** Offset of `timeZone` at that instant as `+HH:MM`. */
export function zoneOffset(timeZone: string, at: Date): string {
  const name = zoneParts(timeZone, at).timeZoneName ?? 'GMT+00:00'
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name)
  if (!match) return '+00:00'
  const sign = match[1]
  const hours = match[2].padStart(2, '0')
  const minutes = (match[3] ?? '00').padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

/** `2026-09-28 09:00` in the given zone. */
export function formatInZone(at: Date, timeZone: string): string {
  const p = zoneParts(timeZone, at)
  const hour = p.hour === '24' ? '00' : p.hour
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}`
}

/**
 * Offsets that can plausibly apply to a wall-clock time: the one Intl reports
 * when the text is read as UTC, plus the offsets a day before and after. A DST
 * transition never moves more than that.
 */
function candidateOffsets(timeZone: string, wall: string): string[] {
  const asUtc = new Date(`${wall}Z`)
  const day = 26 * 60 * 60 * 1000
  return [...new Set([
    zoneOffset(timeZone, asUtc),
    zoneOffset(timeZone, new Date(asUtc.getTime() - day)),
    zoneOffset(timeZone, new Date(asUtc.getTime() + day)),
  ])]
}

export interface WallClockResolution {
  /** Offset that really applies at that wall-clock time, `+HH:MM`. */
  offset: string
  /** RFC 3339 string of the resolved instant. */
  iso: string
  /** True when the wall-clock time does not exist (spring-forward gap). */
  adjusted: boolean
}

/**
 * Resolve a wall-clock time (`YYYY-MM-DDTHH:MM:SS`, no zone) in `timeZone`.
 *
 * Guessing the offset at noon and using it for midnight is wrong on exactly the
 * two days a year that matter: on 2026-10-25 Europe/Berlin midnight is +02:00
 * while noon is +01:00, so a whole-day range built from the noon offset starts
 * an hour late and loses the first appointment of the day.
 *
 * An offset is only accepted when it reproduces itself at the instant it
 * produces. Two offsets can do that (autumn, the hour exists twice) — the
 * EARLIER instant wins, the usual convention. None can do it inside the spring
 * gap (that local time never happens); then the instant after the gap is used
 * and `adjusted` says so.
 */
export function resolveWallClock(timeZone: string, wall: string): WallClockResolution {
  const instants: Array<{ instant: Date; offset: string }> = []
  const all: Array<{ instant: Date; offset: string }> = []
  for (const offset of candidateOffsets(timeZone, wall)) {
    const instant = new Date(`${wall}${offset}`)
    if (Number.isNaN(instant.getTime())) continue
    all.push({ instant, offset })
    if (zoneOffset(timeZone, instant) === offset) instants.push({ instant, offset })
  }
  if (instants.length > 0) {
    const best = instants.reduce((a, b) => (a.instant.getTime() <= b.instant.getTime() ? a : b))
    return { offset: best.offset, iso: `${wall}${best.offset}`, adjusted: false }
  }
  // Gap: take the latest candidate, i.e. the first valid local time after it.
  const fallback = all.length > 0
    ? all.reduce((a, b) => (a.instant.getTime() >= b.instant.getTime() ? a : b))
    : { offset: '+00:00', instant: new Date(`${wall}Z`) }
  return { offset: fallback.offset, iso: `${wall}${fallback.offset}`, adjusted: true }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i

export class InvalidDateInputError extends Error {
  constructor(readonly value: string) {
    super(`not an ISO date or date-time: "${value}"`)
    this.name = 'InvalidDateInputError'
  }
}

/**
 * Turn user input into an RFC 3339 instant.
 *
 * - `2026-09-28` → start of that day (`edge: 'start'`) or its last second
 *   (`edge: 'end'`) in `timeZone`
 * - `2026-09-28T09:00` → that wall-clock time in `timeZone`
 * - anything already carrying `Z` or an offset → passed through
 */
export function toRfc3339(value: string, edge: 'start' | 'end', timeZone: string): string {
  const raw = value.trim()
  if (!raw) throw new InvalidDateInputError(value)

  if (DATE_ONLY.test(raw)) {
    if (Number.isNaN(new Date(`${raw}T12:00:00Z`).getTime())) throw new InvalidDateInputError(value)
    // Each edge gets the offset of ITS OWN wall-clock time, not one offset for
    // the whole day — on a transition day the two differ.
    const wall = edge === 'start' ? `${raw}T00:00:00` : `${raw}T23:59:59`
    return resolveWallClock(timeZone, wall).iso
  }

  if (HAS_ZONE.test(raw)) {
    const parsed = new Date(raw)
    if (Number.isNaN(parsed.getTime())) throw new InvalidDateInputError(value)
    return parsed.toISOString()
  }

  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const withSeconds = /T\d{2}:\d{2}$/.test(normalized) ? `${normalized}:00` : normalized
  if (Number.isNaN(new Date(`${withSeconds}Z`).getTime())) throw new InvalidDateInputError(value)
  return resolveWallClock(timeZone, withSeconds).iso
}
