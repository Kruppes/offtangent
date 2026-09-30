/**
 * Request parsing for /api/boards. A malformed key is answered like a
 * missing board (404) rather than 400: the caller learns nothing about which
 * keys exist, and a client that builds a bad path sees one error shape.
 */
import { BOARD_KEY_PATTERN, BOARD_SERIES_MAX_DAYS } from '@axiom/core'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string }

const SERIES_NAME_MAX = 64
const SERIES_REQUEST_MAX = 10
const DEFAULT_SERIES_DAYS = 90

export function parseBoardKey(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string' || !BOARD_KEY_PATTERN.test(raw)) {
    return { ok: false, error: 'Board not found', code: 'board_not_found' }
  }
  return { ok: true, value: raw }
}

export function parseRevisionNumber(raw: unknown): ParseResult<number> {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, error: 'Board revision not found', code: 'board_revision_not_found' }
  }
  return { ok: true, value }
}

export interface BoardSeriesQuery {
  series: string[]
  days: number
}

/**
 * `?series=a,b&days=90`. Repeated `series` parameters are accepted too, so
 * both common client styles work; `days` is clamped, never rejected for being
 * too large, because a chart that asks for "everything" should get the
 * maximum window instead of an error.
 */
export function parseBoardSeriesQuery(query: Record<string, unknown>): ParseResult<BoardSeriesQuery> {
  const raw = query.series
  const parts: string[] = []
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return
    for (const name of value.split(',')) {
      const trimmed = name.trim()
      if (trimmed.length > 0) parts.push(trimmed)
    }
  }
  if (Array.isArray(raw)) raw.forEach(push)
  else push(raw)

  if (parts.length === 0) {
    return { ok: false, error: 'series must name at least one series', code: 'invalid_series' }
  }
  if (parts.length > SERIES_REQUEST_MAX) {
    return { ok: false, error: `at most ${SERIES_REQUEST_MAX} series per request`, code: 'invalid_series' }
  }
  if (parts.some(name => name.length > SERIES_NAME_MAX)) {
    return { ok: false, error: 'series name too long', code: 'invalid_series' }
  }

  let days = DEFAULT_SERIES_DAYS
  const rawDays = query.days
  if (rawDays !== undefined && rawDays !== null && rawDays !== '') {
    const value = Number(rawDays)
    if (!Number.isInteger(value) || value < 1) {
      return { ok: false, error: 'days must be a positive integer', code: 'invalid_days' }
    }
    days = Math.min(value, BOARD_SERIES_MAX_DAYS)
  }

  // Duplicates would only produce the same key twice in the response object.
  return { ok: true, value: { series: [...new Set(parts)], days } }
}
