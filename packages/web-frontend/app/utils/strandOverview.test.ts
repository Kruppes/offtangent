import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERVIEW_STATE, activeFilterCount, clearFilters, filterRows, groupOf, groupRows, mergeOverviewQuery, overviewQueryOf,
  parseOverviewQuery, parseTimestamp, previewLine, relativeParts, serializeOverviewState, sortRows, startOfWeek, type OverviewRow,
} from './strandOverview'

const row = (id: string, extra: Partial<OverviewRow> = {}): OverviewRow => ({ id, title: id, pinned: false, lastActivity: '2026-01-01 00:00:00', ...extra })
const none = () => false

describe('overview query', () => {
  it('parses every key and falls back on junk', () => {
    expect(parseOverviewQuery({})).toEqual(DEFAULT_OVERVIEW_STATE)
    expect(parseOverviewQuery({ q: ' needle ', project_id: 'none', tag: 'x', now: '1', include_archived: 'true', running: 'yes', pinned: '1', sort: 'title' }))
      .toEqual({ q: 'needle', project_id: 'none', tag: 'x', now: true, include_archived: true, running: true, pinned: true, sort: 'title' })
    expect(parseOverviewQuery({ sort: 'size', pinned: '0', running: 'no' })).toEqual(DEFAULT_OVERVIEW_STATE)
    expect(parseOverviewQuery({ sort: ['created', 'title'] }).sort).toBe('created')
  })
  it('serialises without defaults and round-trips', () => {
    expect(serializeOverviewState(DEFAULT_OVERVIEW_STATE)).toEqual({})
    const state = { ...DEFAULT_OVERVIEW_STATE, pinned: true, sort: 'created' as const, project_id: 'p1' }
    expect(serializeOverviewState(state)).toEqual({ project_id: 'p1', pinned: '1', sort: 'created' })
    expect(parseOverviewQuery(serializeOverviewState(state))).toEqual(state)
  })
  it('keeps foreign keys and rewrites its own', () => {
    expect(mergeOverviewQuery({ keep: 'yes', pinned: '1', sort: 'title' }, { ...DEFAULT_OVERVIEW_STATE, running: true }))
      .toEqual({ keep: 'yes', running: '1' })
    expect(overviewQueryOf({ keep: 'yes', q: 'abc', sort: 'activity' })).toEqual({ q: 'abc' })
  })
  it('counts chips, not search or sort, and clears them', () => {
    const state = { ...DEFAULT_OVERVIEW_STATE, q: 'x', sort: 'title' as const, running: true, project_id: 'p', include_archived: true }
    expect(activeFilterCount(state)).toBe(3)
    expect(activeFilterCount(state, true)).toBe(2)
    expect(clearFilters(state)).toEqual({ ...DEFAULT_OVERVIEW_STATE, q: 'x', sort: 'title' })
  })
})

describe('overview rows', () => {
  it('filters pinned and running on the client', () => {
    const rows = [row('a', { pinned: true }), row('b'), row('c', { pinned: true })]
    expect(filterRows(rows, { ...DEFAULT_OVERVIEW_STATE, pinned: true }, none).map(r => r.id)).toEqual(['a', 'c'])
    expect(filterRows(rows, { ...DEFAULT_OVERVIEW_STATE, running: true }, id => id === 'b').map(r => r.id)).toEqual(['b'])
    expect(filterRows(rows, { ...DEFAULT_OVERVIEW_STATE, running: true, pinned: true }, id => id === 'b')).toEqual([])
  })
  it('sorts by activity, creation and title', () => {
    const rows = [
      row('old', { title: 'beta', lastActivity: '2026-01-01 10:00:00', startedAt: '2026-01-03 00:00:00' }),
      row('new', { title: 'Alpha', lastActivity: '2026-01-05 10:00:00', startedAt: '2025-12-01 00:00:00' }),
      row('none', { title: null, lastActivity: '2026-01-02 10:00:00', startedAt: '2026-01-04 00:00:00' }),
      row('num', { title: 'item 10', lastActivity: '2026-01-03 10:00:00' }),
      row('num2', { title: 'item 9', lastActivity: '2026-01-03 10:00:00' }),
    ]
    expect(sortRows(rows, 'activity').map(r => r.id)).toEqual(['new', 'num', 'num2', 'none', 'old'])
    expect(sortRows(rows, 'created').map(r => r.id)).toEqual(['none', 'old', 'new', 'num', 'num2'])
    expect(sortRows(rows, 'title').map(r => r.id)).toEqual(['new', 'old', 'num2', 'num', 'none'])
    expect(rows[0]!.id).toBe('old')
  })
  it('groups into now, today, this week and older', () => {
    // Thursday 2026-01-08, 15:00 local time.
    const now = new Date(2026, 0, 8, 15, 0, 0)
    const iso = (d: Date) => d.toISOString()
    expect(new Date(startOfWeek(now)).getDay()).toBe(1)
    expect(groupOf(row('live', { lastActivity: '2020-01-01 00:00:00' }), now, id => id === 'live')).toBe('now')
    expect(groupOf(row('set', { nowRank: 2, lastActivity: '2020-01-01 00:00:00' }), now, none)).toBe('now')
    expect(groupOf(row('t', { lastActivity: iso(new Date(2026, 0, 8, 0, 30)) }), now, none)).toBe('today')
    expect(groupOf(row('w', { lastActivity: iso(new Date(2026, 0, 5, 9, 0)) }), now, none)).toBe('week')
    expect(groupOf(row('o', { lastActivity: iso(new Date(2026, 0, 4, 23, 0)) }), now, none)).toBe('older')
    expect(groupOf(row('bad', { lastActivity: 'not a date' }), now, none)).toBe('older')
    const rows = [row('t', { lastActivity: iso(new Date(2026, 0, 8, 9)) }), row('o', { lastActivity: iso(new Date(2025, 0, 1)) }), row('live')]
    expect(groupRows(rows, 'activity', now, id => id === 'live').map(g => [g.key, g.rows.map(r => r.id)]))
      .toEqual([['now', ['live']], ['today', ['t']], ['older', ['o']]])
    expect(groupRows(rows, 'title', now, none)).toEqual([{ key: 'all', rows }])
    expect(groupRows([], 'title', now, none)).toEqual([])
  })
})

describe('row text', () => {
  it('reads backend and ISO timestamps', () => {
    expect(parseTimestamp('2026-01-01 10:00:00')).toBe(Date.UTC(2026, 0, 1, 10))
    expect(parseTimestamp('2026-01-01T10:00:00.000Z')).toBe(Date.UTC(2026, 0, 1, 10))
    expect(parseTimestamp('')).toBeNull()
    expect(parseTimestamp('nope')).toBeNull()
  })
  it('gives relative time parts', () => {
    const now = new Date(Date.UTC(2026, 0, 10, 12))
    expect(relativeParts('2026-01-10 11:59:30', now)).toEqual({ value: 0, unit: 'minute' })
    expect(relativeParts('2026-01-10 11:15:00', now)).toEqual({ value: -45, unit: 'minute' })
    expect(relativeParts('2026-01-10 07:00:00', now)).toEqual({ value: -5, unit: 'hour' })
    expect(relativeParts('2026-01-08 12:00:00', now)).toEqual({ value: -2, unit: 'day' })
    expect(relativeParts('2025-12-20 12:00:00', now)).toEqual({ value: -3, unit: 'week' })
    expect(relativeParts('2025-08-10 12:00:00', now)).toEqual({ value: -5, unit: 'month' })
    expect(relativeParts('2023-01-10 12:00:00', now)).toEqual({ value: -3, unit: 'year' })
    expect(relativeParts('x', now)).toBeNull()
  })
  it('makes one plain preview line', () => {
    expect(previewLine('## Title\n\nSome **bold** and [a link](https://example.test)\n```js\ncode\n```  end')).toBe('Title Some bold and a link end')
    expect(previewLine(null)).toBe('')
    expect(previewLine('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})
