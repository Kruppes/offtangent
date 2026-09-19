import { describe, expect, it } from 'vitest'
import { formatTaskDuration } from './taskFormat'

/**
 * Task timestamps arrive in two shapes: SQLite's naked `2026-09-15 06:15:53`
 * (UTC, no marker) and ISO-8601 with `Z`. Both have to produce the same
 * duration; the old parser appended a second `Z` to the ISO form and returned
 * NaN.
 */
describe('formatTaskDuration', () => {
  it('handles naked SQLite timestamps', () => {
    expect(formatTaskDuration({
      startedAt: '2026-09-15 06:15:53',
      completedAt: '2026-09-15 06:17:23',
    })).toBe('1m 30s')
  })

  it('handles ISO-8601 timestamps with an explicit UTC marker', () => {
    expect(formatTaskDuration({
      startedAt: '2026-09-15T06:15:53.000Z',
      completedAt: '2026-09-15T06:17:23.000Z',
    })).toBe('1m 30s')
  })

  it('reads both shapes as the same instant', () => {
    const naked = formatTaskDuration({ startedAt: '2026-09-15 06:15:53', completedAt: '2026-09-15 06:15:58' })
    const iso = formatTaskDuration({ startedAt: '2026-09-15T06:15:53.000Z', completedAt: '2026-09-15T06:15:58.000Z' })
    expect(iso).toBe(naked)
    expect(naked).toBe('5s')
  })

  it('shows a dash instead of NaN for an unparseable value', () => {
    expect(formatTaskDuration({ startedAt: 'kaputt', completedAt: null })).toBe('—')
    expect(formatTaskDuration({ startedAt: '2026-09-15 06:15:53', completedAt: 'kaputt' })).toBe('—')
    expect(formatTaskDuration({ startedAt: null, completedAt: null })).toBe('—')
  })
})
