import { describe, expect, it } from 'vitest'
import type { Thread } from '../../api/threads'
import {
  formatRelativeTime,
  groupThreads,
  sortThreads,
  threadExcerpt,
  threadFallbackTitle,
  truncate,
} from './threadDisplay'

function thread(overrides: Partial<Thread> & Pick<Thread, 'id'>): Thread {
  return {
    agentId: 'bob',
    title: null,
    pinned: false,
    archived: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    messageCount: 1,
    lastMessage: null,
    active: false,
    ...overrides,
  }
}

describe('sortThreads', () => {
  it('puts pinned threads first, then the most recent activity', () => {
    const list = [
      thread({ id: 'old', lastActivity: '2026-01-01T10:00:00.000Z' }),
      thread({ id: 'pinned-old', pinned: true, lastActivity: '2026-01-01T08:00:00.000Z' }),
      thread({ id: 'fresh', lastActivity: '2026-01-01T12:00:00.000Z' }),
      thread({ id: 'pinned-fresh', pinned: true, lastActivity: '2026-01-01T09:00:00.000Z' }),
    ]

    expect(sortThreads(list).map(t => t.id)).toEqual(['pinned-fresh', 'pinned-old', 'fresh', 'old'])
  })

  it('does not mutate the input', () => {
    const list = [thread({ id: 'a' }), thread({ id: 'b', pinned: true })]
    sortThreads(list)
    expect(list.map(t => t.id)).toEqual(['a', 'b'])
  })
})

describe('groupThreads', () => {
  it('splits into pinned and recent, dropping empty groups', () => {
    const groups = groupThreads([
      thread({ id: 'a' }),
      thread({ id: 'b', pinned: true }),
    ])
    expect(groups.map(g => g.key)).toEqual(['pinned', 'recent'])

    expect(groupThreads([thread({ id: 'a' })]).map(g => g.key)).toEqual(['recent'])
    expect(groupThreads([])).toEqual([])
  })
})

describe('truncate', () => {
  it('collapses whitespace and cuts long text', () => {
    expect(truncate('  hello   world ', 40)).toBe('hello world')
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })
})

describe('threadFallbackTitle / threadExcerpt', () => {
  it('uses the last message as the title fallback', () => {
    const entry = thread({
      id: 'a',
      lastMessage: { role: 'user', content: 'Compare the two roof offers', timestamp: '2026-01-01T00:00:00.000Z' },
    })
    expect(threadFallbackTitle(entry)).toBe('Compare the two roof offers')
    expect(threadExcerpt(entry)).toBe('Compare the two roof offers')
  })

  it('returns null when the thread has no message yet', () => {
    expect(threadFallbackTitle(thread({ id: 'a' }))).toBeNull()
    expect(threadExcerpt(thread({ id: 'a' }))).toBeNull()
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-01-10T12:00:00.000Z')

  it('renders compact relative labels', () => {
    expect(formatRelativeTime('2026-01-10T11:59:40.000Z', now)).toBe('now')
    expect(formatRelativeTime('2026-01-10T11:45:00.000Z', now)).toBe('15m')
    expect(formatRelativeTime('2026-01-10T07:00:00.000Z', now)).toBe('5h')
    expect(formatRelativeTime('2026-01-08T12:00:00.000Z', now)).toBe('2d')
  })

  it('falls back to an absolute date beyond a week', () => {
    expect(formatRelativeTime('2026-01-01T12:00:00.000Z', now)).toBe('Jan 1')
  })

  it('handles naked SQLite UTC timestamps and empty input', () => {
    expect(formatRelativeTime('2026-01-10 11:00:00', now)).toBe('1h')
    expect(formatRelativeTime('', now)).toBe('')
  })
})
