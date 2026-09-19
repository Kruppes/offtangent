/**
 * The wire contract for timestamps: nothing leaves the backend in SQLite's
 * naked `YYYY-MM-DD HH:MM:SS` form, and anything merged in memory is compared
 * as an instant, never as a string.
 */
import { describe, it, expect } from 'vitest'
import { toIsoUtc, toIsoUtcOrNull, timestampSortKey } from './timestamps.js'

describe('toIsoUtc', () => {
  it('reads the naked SQLite form as UTC, not as local time', () => {
    // The process runs in Europe/Berlin in CI and on the box; a local reading
    // would land two hours off.
    expect(toIsoUtc('2026-09-15 06:15:53')).toBe('2026-09-15T06:15:53.000Z')
  })

  it('leaves a value that already carries a zone alone', () => {
    expect(toIsoUtc('2026-09-15T06:15:53.000Z')).toBe('2026-09-15T06:15:53.000Z')
    expect(toIsoUtc('2026-09-15T06:15:53Z')).toBe('2026-09-15T06:15:53.000Z')
  })

  it('converts a numeric offset to UTC', () => {
    expect(toIsoUtc('2026-09-15T08:15:53+02:00')).toBe('2026-09-15T06:15:53.000Z')
  })

  it('hands back garbage untouched instead of inventing a date', () => {
    expect(toIsoUtc('not a date')).toBe('not a date')
    expect(toIsoUtc('')).toBe('')
  })

  it('is idempotent', () => {
    const once = toIsoUtc('2026-09-15 06:15:53')
    expect(toIsoUtc(once)).toBe(once)
  })
})

describe('toIsoUtcOrNull', () => {
  it('keeps nullish values nullish', () => {
    expect(toIsoUtcOrNull(null)).toBeNull()
    expect(toIsoUtcOrNull(undefined)).toBeNull()
    expect(toIsoUtcOrNull('')).toBeNull()
  })

  it('normalizes a present value', () => {
    expect(toIsoUtcOrNull('2026-09-15 06:15:53')).toBe('2026-09-15T06:15:53.000Z')
  })
})

describe('timestampSortKey', () => {
  it('orders a normalized and a naked timestamp by their instant', () => {
    // The trap: `'2026-09-15T06:00:00.000Z'.localeCompare('2026-09-15 07:00:00')`
    // is > 0 because 'T' > ' ', so a string sort claims 06:00 is the later one.
    const iso = '2026-09-15T06:00:00.000Z'
    const naked = '2026-09-15 07:00:00'
    expect(iso.localeCompare(naked)).toBeGreaterThan(0)
    expect(timestampSortKey(iso)).toBeLessThan(timestampSortKey(naked))
  })

  it('sorts a mixed-format timeline chronologically', () => {
    const events = [
      { at: '2026-09-15 06:20:00', name: 'tool-late' },
      { at: '2026-09-15T06:10:00.000Z', name: 'message-early' },
      { at: '2026-09-15 06:00:00', name: 'tool-first' },
    ]
    const sorted = [...events].sort((a, b) => timestampSortKey(a.at) - timestampSortKey(b.at))
    expect(sorted.map(e => e.name)).toEqual(['tool-first', 'message-early', 'tool-late'])
  })

  it('pushes missing and unparseable values to the end', () => {
    expect(timestampSortKey(null)).toBe(Number.MAX_SAFE_INTEGER)
    expect(timestampSortKey(undefined)).toBe(Number.MAX_SAFE_INTEGER)
    expect(timestampSortKey('kaputt')).toBe(Number.MAX_SAFE_INTEGER)
  })
})
