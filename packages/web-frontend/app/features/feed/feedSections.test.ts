import { describe, expect, it } from 'vitest'
import type { FeedItem } from '~/api/feed'
import { feedBodyVisible, feedDays, feedExpandable, feedPersonas, filterFeed, personaInitials, personaKey } from './feedSections'

const item = (id: string, createdAt: string, extra: Partial<FeedItem> = {}): FeedItem => ({ id, kind: 'task_result', title: `Item ${id}`, body: 'Body text', agentId: null, taskId: null, strandId: null, createdAt, readAt: null, notify: false, boardKey: null, ...extra })
const NOW = Date.parse('2026-01-07T12:00:00Z')

describe('feedDays', () => {
  it('groups newest-first items by local day with today and yesterday labels', () => {
    const groups = feedDays([
      item('a', '2026-01-07T09:00:00Z'), item('b', '2026-01-07T01:00:00Z'),
      item('c', '2026-01-06T20:00:00Z'), item('d', '2026-01-02T08:00:00Z'),
    ], NOW, 'UTC')
    expect(groups.map(g => [g.key, g.label.kind, g.items.length])).toEqual([
      ['2026-01-07', 'today', 2], ['2026-01-06', 'yesterday', 1], ['2026-01-02', 'date', 1],
    ])
  })
  it('respects the time zone at midnight and tolerates broken dates', () => {
    const groups = feedDays([item('late', '2026-01-06T23:30:00Z'), item('bad', 'nope')], NOW, 'Europe/Berlin')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.label.kind).toBe('today')
    expect(groups[0]!.items.map(i => i.id)).toEqual(['late', 'bad'])
    expect(feedDays([], NOW, 'UTC')).toEqual([])
  })
})

describe('personas and filter', () => {
  const items = [item('a', '2026-01-07T09:00:00Z', { agentId: 'helper' }), item('b', '2026-01-07T08:00:00Z', { readAt: '2026-01-07T08:30:00Z' }), item('c', '2026-01-07T07:00:00Z', { agentId: 'helper', kind: 'reminder' })]
  it('lists distinct personas, the default one as empty key', () => {
    expect(personaKey({ agentId: '  ' })).toBe('')
    expect(feedPersonas(items)).toEqual(['helper', ''])
  })
  it('combines unread, kind and persona', () => {
    expect(filterFeed(items, { unreadOnly: true, kind: '', persona: null }).map(i => i.id)).toEqual(['a', 'c'])
    expect(filterFeed(items, { unreadOnly: false, kind: 'reminder', persona: null }).map(i => i.id)).toEqual(['c'])
    expect(filterFeed(items, { unreadOnly: false, kind: '', persona: '' }).map(i => i.id)).toEqual(['b'])
  })
})

describe('body visibility', () => {
  it('shows bodies when expanded, board updates always, blank never', () => {
    expect(feedBodyVisible({ kind: 'task_result', body: 'x' }, false)).toBe(false)
    expect(feedBodyVisible({ kind: 'task_result', body: 'x' }, true)).toBe(true)
    expect(feedBodyVisible({ kind: 'board_update', body: 'x' }, false)).toBe(true)
    expect(feedBodyVisible({ kind: 'task_result', body: '  ' }, true)).toBe(false)
    expect(feedExpandable({ kind: 'board_update', body: 'x' })).toBe(false)
    expect(feedExpandable({ kind: 'cron_report', body: 'x' })).toBe(true)
  })
  it('builds persona initials', () => {
    expect(personaInitials('Research helper')).toBe('RH')
    expect(personaInitials('coder')).toBe('CO')
    expect(personaInitials('')).toBe('?')
  })
})
