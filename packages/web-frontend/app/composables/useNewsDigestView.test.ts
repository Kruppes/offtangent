/**
 * View model of the news board: day navigation over the board revisions, the
 * selected story as route state, the local read state and the three delayed
 * states (progress bar, archive, "digest arrives around 07:00").
 *
 * These run without a DOM — the composable is where the behaviour lives so it
 * can be tested at all; the SSR render spec can only see the first frame.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import {
  formatDayLabel, formatSourceDate, useNewsDigestView,
  NEWS_PROGRESS_DELAY_MS, NEWS_READ_STORAGE_KEY,
  type NewsRevisionEntry, type ReadStateStorage,
} from './useNewsDigestView'
import { storyReadKey } from '~/utils/newsDigest'

const payload = {
  schema_version: 'news_digest.v2',
  date: '2026-09-28',
  generated_at: '2026-09-28T07:04:00+02:00',
  headline: 'Two releases.',
  items: [
    { story_id: 'a', rank: 1, title: 'First story', take: 'Take A', verdict: 'hot', summary: 'S', sources: [{ name: 'X', url: 'https://example.com/a', type: 'primary' }] },
    { story_id: 'b', rank: 2, title: 'Second story', take: 'Take B', verdict: 'watch', summary: 'S', sources: [{ name: 'Y', url: 'https://example.com/b' }] },
    { story_id: 'c', rank: 3, title: 'Third story', take: 'Take C', verdict: 'hot', summary: 'S', sources: [{ name: 'Z', url: 'https://example.com/c' }] },
  ],
}

const revisions: NewsRevisionEntry[] = [
  { revision: 9, asOf: '2026-09-28T05:04:00Z', summary: 'Two releases.' },
  { revision: 8, asOf: '2026-09-27T05:02:00Z', summary: 'A quiet Sunday.' },
  { revision: 7, asOf: '2026-09-27T04:00:00Z', summary: 'Earlier run of the same day.' },
  { revision: 6, asOf: '2026-09-26T05:00:00Z', summary: 'Friday.' },
]

function memoryStorage(initial: Record<string, string> = {}): ReadStateStorage {
  const data = new Map(Object.entries(initial))
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
  }
}

/**
 * Runs the composable inside a scope so watchers and timers are cleaned up —
 * after the body finished, which for an async body means after its promise
 * settles, not when it was created.
 */
function withView<T>(options: Parameters<typeof useNewsDigestView>[0], body: (view: ReturnType<typeof useNewsDigestView>) => T): T {
  const scope = effectScope()
  let result: T
  try {
    result = scope.run(() => body(useNewsDigestView(options)))!
  } catch (error) {
    scope.stop()
    throw error
  }
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    return (result as unknown as Promise<unknown>).finally(() => scope.stop()) as unknown as T
  }
  scope.stop()
  return result
}

describe('day navigation', () => {
  it('lists one day per date, newest first, with the newest revision of that day', () => {
    withView({ payload, revisions, storage: null }, (view) => {
      expect(view.days.value.map(day => day.date)).toEqual(['2026-09-28', '2026-09-27', '2026-09-26'])
      expect(view.days.value[1]!.revision).toBe(8)
      expect(view.days.value[0]!.label).toBe('Mon 28 Sep 2026')
      expect(view.days.value[1]!.headline).toBe('A quiet Sunday.')
    })
  })

  it('points ‹ at the older and › at the next newer day', () => {
    withView({ payload: { ...payload, date: '2026-09-27' }, revisions, storage: null }, (view) => {
      expect(view.currentDate.value).toBe('2026-09-27')
      expect(view.olderDay.value?.date).toBe('2026-09-26')
      expect(view.newerDay.value?.date).toBe('2026-09-28')
      expect(view.isArchive.value).toBe(true)
    })
  })

  it('has no newer day on the newest digest', () => {
    withView({ payload, revisions, storage: null }, (view) => {
      expect(view.newerDay.value).toBeNull()
      expect(view.olderDay.value?.date).toBe('2026-09-27')
      expect(view.isArchive.value).toBe(false)
    })
  })

  it('falls back to the route date and then to the newest revision', () => {
    withView({ payload: { ...payload, date: undefined }, revisions, date: '2026-09-27', storage: null }, (view) => {
      expect(view.currentDate.value).toBe('2026-09-27')
    })
    withView({ payload: { ...payload, date: undefined }, revisions, storage: null }, (view) => {
      expect(view.currentDate.value).toBe('2026-09-28')
    })
  })

  it('survives a board without revisions', () => {
    withView({ payload, storage: null }, (view) => {
      expect(view.days.value).toEqual([])
      expect(view.olderDay.value).toBeNull()
      expect(view.isArchive.value).toBe(false)
      expect(view.currentDayLabel.value).toBe('Mon 28 Sep 2026')
    })
  })
})

describe('counters and selection', () => {
  it('counts items and hot stories and formats the update time', () => {
    withView({ payload, revisions, storage: null }, (view) => {
      expect(view.items.value).toHaveLength(3)
      expect(view.hotCount.value).toBe(2)
      expect(view.updatedTime.value).toMatch(/^\d{2}:\d{2}$/)
    })
  })

  it('resolves ?story= into the story, its position and its neighbours', () => {
    withView({ payload, revisions, story: 'b', storage: memoryStorage() }, (view) => {
      expect(view.selected.value?.title).toBe('Second story')
      expect(view.selectedPosition.value).toBe(2)
      expect(view.previousStory.value?.storyId).toBe('a')
      expect(view.nextStory.value?.storyId).toBe('c')
    })
  })

  it('has no next story on the last one and no selection for an unknown id', () => {
    withView({ payload, story: 'c', storage: memoryStorage() }, (view) => {
      expect(view.nextStory.value).toBeNull()
      expect(view.previousStory.value?.storyId).toBe('b')
    })
    withView({ payload, story: 'nope', storage: memoryStorage() }, (view) => {
      expect(view.selected.value).toBeNull()
      expect(view.selectedPosition.value).toBe(0)
    })
  })
})

describe('read state', () => {
  /** The read state is keyed by story id plus last change, not by id alone. */
  const storyNew = { storyId: 'a', status: 'new' as const }
  const storyUpdated = { storyId: 'a', status: 'update' as const, delta: 'The licence now allows commercial use.' }
  const storyUpdatedAgain = { storyId: 'a', status: 'update' as const, delta: 'And the price dropped again.' }

  it('marks a story read when it is opened and keeps it in storage', async () => {
    const storage = memoryStorage()
    const story = ref<string | null>(null)
    await withView({ payload, story: () => story.value, storage }, async (view) => {
      expect(view.isRead(storyNew)).toBe(false)
      story.value = 'a'
      await nextTick()
      expect(view.isRead(storyNew)).toBe(true)
      expect(view.isRead({ storyId: 'b', status: 'new' })).toBe(false)
      expect(JSON.parse(storage.getItem(NEWS_READ_STORAGE_KEY)!)).toEqual(['a'])
    })
  })

  it('turns a story unread again when it comes back as an update with a delta', async () => {
    const storage = memoryStorage()
    const updated = { ...payload, items: [{ ...payload.items[0], status: 'update', delta: storyUpdated.delta }, ...payload.items.slice(1)] }
    const story = ref<string | null>(null)
    const source = ref<unknown>(payload)
    await withView({ payload: () => source.value, story: () => story.value, storage }, async (view) => {
      // Read in its `new` state: the title is muted.
      story.value = 'a'
      await nextTick()
      expect(view.isRead(storyNew)).toBe(true)

      // Same story id, but a new state of the story: unread again.
      source.value = updated
      story.value = null
      await nextTick()
      expect(view.isRead(storyUpdated)).toBe(false)
      expect(view.isRead(storyNew)).toBe(true)

      // Opening the update marks that state read, and only that state.
      story.value = 'a'
      await nextTick()
      expect(view.isRead(storyUpdated)).toBe(true)
      expect(view.isRead(storyUpdatedAgain)).toBe(false)
      expect(JSON.parse(storage.getItem(NEWS_READ_STORAGE_KEY)!)).toEqual(['a', storyReadKey(storyUpdated)])
    })
  })

  it('keeps older entries of boards.news.read valid for the unchanged story', () => {
    // Entries written before the key carried the change state are plain story
    // ids, which is exactly the key of the `new` state — no migration step.
    const storage = memoryStorage({ [NEWS_READ_STORAGE_KEY]: JSON.stringify(['a', 'c']) })
    withView({ payload, storage }, (view) => {
      expect(view.isRead(storyNew)).toBe(true)
      expect(view.isRead({ storyId: 'c', status: 'new' })).toBe(true)
      expect(view.isRead({ storyId: 'b', status: 'new' })).toBe(false)
      // The same story as an update is a state the reader has not seen.
      expect(view.isRead(storyUpdated)).toBe(false)
    })
  })

  it('restores the read state of an earlier visit', () => {
    const storage = memoryStorage({ [NEWS_READ_STORAGE_KEY]: JSON.stringify(['c']) })
    withView({ payload, storage }, (view) => {
      expect(view.isRead({ storyId: 'c', status: 'new' })).toBe(true)
      expect(view.isRead(storyNew)).toBe(false)
    })
  })

  it('ignores a corrupt or unavailable storage', () => {
    withView({ payload, storage: memoryStorage({ [NEWS_READ_STORAGE_KEY]: '{oops' }) }, (view) => {
      expect(view.isRead(storyNew)).toBe(false)
      expect(() => view.markRead(storyNew)).not.toThrow()
      expect(view.isRead(storyNew)).toBe(true)
    })
    withView({ payload, storage: null }, (view) => {
      expect(() => view.markRead(storyNew)).not.toThrow()
      expect(view.isRead(storyNew)).toBe(true)
    })
  })
})

describe('delayed and derived states', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows the progress bar only after 300 ms of loading', async () => {
    const loading = ref(true)
    await withView({ payload, loading: () => loading.value, storage: null }, async (view) => {
      expect(view.showProgress.value).toBe(false)
      vi.advanceTimersByTime(NEWS_PROGRESS_DELAY_MS - 1)
      expect(view.showProgress.value).toBe(false)
      vi.advanceTimersByTime(2)
      expect(view.showProgress.value).toBe(true)
      loading.value = false
      await nextTick()
      expect(view.showProgress.value).toBe(false)
    })
  })

  it('never shows the bar for a load that finishes quickly', async () => {
    const loading = ref(true)
    await withView({ payload, loading: () => loading.value, storage: null }, async (view) => {
      vi.advanceTimersByTime(120)
      loading.value = false
      await nextTick()
      vi.advanceTimersByTime(500)
      expect(view.showProgress.value).toBe(false)
    })
  })

  it('announces the missing digest only before 07:00 and only for yesterday', () => {
    const before = () => new Date('2026-09-29T06:30:00')
    const after = () => new Date('2026-09-29T08:30:00')
    withView({ payload, revisions, now: before, storage: null }, (view) => {
      expect(view.awaitingToday.value).toBe(true)
    })
    withView({ payload, revisions, now: after, storage: null }, (view) => {
      expect(view.awaitingToday.value).toBe(false)
    })
    // Newest digest is two days old: that is not "arrives around 07:00".
    withView({ payload, revisions, now: () => new Date('2026-09-30T06:30:00'), storage: null }, (view) => {
      expect(view.awaitingToday.value).toBe(false)
    })
  })
})

describe('formatting', () => {
  it('formats a day and a source date in fixed English', () => {
    expect(formatDayLabel('2026-09-28')).toBe('Mon 28 Sep 2026')
    expect(formatDayLabel('2026-01-01')).toBe('Thu 01 Jan 2026')
    expect(formatDayLabel(null)).toBeNull()
    expect(formatDayLabel('not-a-date')).toBe('not-a-date')
    // A no-break space keeps day and month on one line in a narrow column.
    expect(formatSourceDate('2026-09-01T10:00:00Z')).toBe('01\u00a0Sep')
    expect(formatSourceDate('yesterday')).toBe('yesterday')
    expect(formatSourceDate(undefined)).toBeNull()
  })
})
