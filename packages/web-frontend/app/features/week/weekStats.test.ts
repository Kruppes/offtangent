import { describe, expect, it } from 'vitest'
import type { Capture, Decision } from '@axiom/core'
import { barHeights, currentDecision, userDecided, weekClaim, weekStats } from './weekStats'
import { addDays, dayKey, isoWeek, parseInstant, weekdayIndex } from '~/utils/localDay'

const cap = (id: string, createdAt: string, status: Capture['status'], strandId: string | null = 's1') => ({ id, text: 'synthetic', kind: 'note', source: 'web', agentId: null, strandId, messageId: null, status, createdAt, filedAt: null, attachments: [], clientMessageId: null }) as unknown as Capture
const dec = (captureId: string, extra: Partial<Decision> = {}) => ({ id: `d-${captureId}`, captureId, state: 'applied', model: 'router', partIndex: 0, createdAt: '2026-01-07T00:00:00Z', ...extra }) as unknown as Decision

// Wednesday 2026-01-07, noon UTC.
const NOW = Date.parse('2026-01-07T12:00:00Z')

describe('localDay', () => {
  it('computes day keys in a zone, weekdays, ISO weeks and day arithmetic', () => {
    expect(dayKey(Date.parse('2026-01-06T23:30:00Z'), 'UTC')).toBe('2026-01-06')
    expect(dayKey(Date.parse('2026-01-06T23:30:00Z'), 'Europe/Berlin')).toBe('2026-01-07')
    expect(weekdayIndex('2026-01-05')).toBe(0)
    expect(weekdayIndex('2026-01-11')).toBe(6)
    expect(isoWeek('2026-01-01')).toEqual({ year: 2026, week: 1 })
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 })
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
    expect(parseInstant('2026-01-07 10:00:00')).toBe(Date.parse('2026-01-07T10:00:00Z'))
    expect(parseInstant('garbage')).toBeNull()
  })
})

describe('weekStats', () => {
  it('counts only this week, per weekday, Monday first', () => {
    const stats = weekStats([
      cap('a', '2026-01-05T08:00:00Z', 'filed'),
      cap('b', '2026-01-07T08:00:00Z', 'filed', 's2'),
      cap('c', '2026-01-07T09:00:00Z', 'unsorted', null),
      cap('old', '2026-01-04T23:00:00Z', 'filed'),
    ], [dec('a'), dec('b')], NOW, 'UTC')
    expect(stats.weekStart).toBe('2026-01-05')
    expect(stats.weekEnd).toBe('2026-01-11')
    expect(stats.captures).toBe(3)
    expect(stats.perDay).toEqual([1, 0, 2, 0, 0, 0, 0])
    expect(stats.todayIndex).toBe(2)
    expect(stats.strandsTouched).toBe(2)
    expect(stats.strandIds).toEqual(['s2', 's1'])
    expect(stats.week).toBe(2)
  })
  it('splits filed without asking from reviewed and counts undone', () => {
    const stats = weekStats([
      cap('auto', '2026-01-06T08:00:00Z', 'filed'),
      cap('manual', '2026-01-06T09:00:00Z', 'filed'),
      cap('review', '2026-01-06T10:00:00Z', 'needs_review'),
      cap('moved', '2026-01-06T11:00:00Z', 'moved'),
      cap('back', '2026-01-06T12:00:00Z', 'unsorted', null),
    ], [dec('auto'), dec('manual', { model: 'user' }), dec('review'), dec('moved'), dec('back', { state: 'undone' })], NOW, 'UTC')
    expect(stats.filedWithoutAsking).toBe(1)
    expect(stats.reviewed).toBe(3)
    expect(stats.undone).toBe(2)
    expect(stats.filedWithoutAskingPercent).toBe(25)
  })
  it('is all zero for an empty week', () => {
    const stats = weekStats([], [], NOW, 'UTC')
    expect(stats.captures).toBe(0)
    expect(stats.filedWithoutAskingPercent).toBe(0)
    expect(weekClaim(stats)).toBe('none')
  })
  it('honours the time zone at the week border', () => {
    // Sunday 23:30 UTC is already Monday in Berlin: next week there.
    const stats = weekStats([cap('edge', '2026-01-04T23:30:00Z', 'filed')], [], NOW, 'Europe/Berlin')
    expect(stats.captures).toBe(1)
    expect(stats.perDay[0]).toBe(1)
  })
})

describe('currentDecision / userDecided', () => {
  it('prefers part 0 of the newest live round', () => {
    const list = [dec('x', { id: 'old', createdAt: '2026-01-01' }), dec('x', { id: 'new', createdAt: '2026-01-02' }), dec('x', { id: 'p1', partIndex: 1, createdAt: '2026-01-03' }), dec('x', { id: 'gone', state: 'superseded', createdAt: '2026-01-05' })]
    expect(currentDecision('x', list)?.id).toBe('new')
    expect(currentDecision('none', list)).toBeNull()
    expect(userDecided(dec('x', { state: 'confirmed' }))).toBe(true)
    expect(userDecided(null)).toBe(false)
  })
})

describe('weekClaim / barHeights', () => {
  it('maps counts to claims and scales bars with a visible stub', () => {
    expect(weekClaim({ captures: 1 })).toBe('dayOneSingle')
    expect(weekClaim({ captures: 2 })).toBe('dayOne')
    expect(weekClaim({ captures: 9 })).toBe('many')
    expect(barHeights([0, 2, 4, 0, 0, 0, 1])).toEqual([6, 50, 100, 6, 6, 6, 25])
  })
})
