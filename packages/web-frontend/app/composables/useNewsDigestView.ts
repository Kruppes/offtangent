/**
 * View model of a news digest board (renderer for `news_digest.v2`, older
 * revisions in `news_digest.v1`). Everything the divided list and the detail
 * view need that is not markup: the parsed digest, the day navigation derived
 * from the board revisions, the selected story with its neighbours, the local
 * read state, and the three delayed/derived UI states (progress bar after
 * 300 ms, "digest arrives around 07:00", archive).
 *
 * It lives outside the component so all of it can be tested without a DOM: the
 * repo's render specs are server-side (`renderToString`), which can show the
 * initial markup but never a click.
 */
import { computed, onScopeDispose, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import { parseNewsDigest, storyReadKey, type NewsDigest, type NewsStory } from '~/utils/newsDigest'

/** What the read state needs of a story: its id and its last change. */
export type ReadableStory = Pick<NewsStory, 'storyId' | 'status' | 'delta'>

/** One revision as the boards API delivers it (`GET /api/boards/:key/revisions`). */
export interface NewsRevisionEntry {
  revision: number
  asOf: string
  createdAt?: string
  summary?: string | null
}

/** One selectable day of the board: the newest revision published for that date. */
export interface NewsDigestDay {
  revision: number
  /** `YYYY-MM-DD`. */
  date: string
  /** "Mon 28 Sep 2026" — tabular figures, UI language English. */
  label: string
  /** Headline of that day, as far as the revision list carries it. */
  headline: string | null
}

/** Minimal storage contract, so tests can pass a plain object. */
export interface ReadStateStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export interface NewsDigestViewOptions {
  payload: MaybeRefOrGetter<unknown>
  /** Revisions of this board, newest first or in any order. */
  revisions?: MaybeRefOrGetter<NewsRevisionEntry[] | undefined>
  /** `?story=` from the route; null/undefined = list view. */
  story?: MaybeRefOrGetter<string | null | undefined>
  /** `?date=` from the route, used before the payload of that day arrived. */
  date?: MaybeRefOrGetter<string | null | undefined>
  loading?: MaybeRefOrGetter<boolean>
  /** Injectable clock and storage, both defaulted for the browser. */
  now?: () => Date
  storage?: ReadStateStorage | null
}

export const NEWS_READ_STORAGE_KEY = 'boards.news.read'
/** Cap of remembered story ids, oldest dropped first. */
export const NEWS_READ_MAX = 500
/** A spinner that appears immediately flickers; 300 ms is the design value. */
export const NEWS_PROGRESS_DELAY_MS = 300
/** The digest is published around 07:00 local time. */
export const NEWS_DIGEST_HOUR = 7

export interface NewsDigestView {
  digest: ComputedRef<NewsDigest | null>
  /** Every day that can be opened, newest first. */
  days: ComputedRef<NewsDigestDay[]>
  newestDay: ComputedRef<NewsDigestDay | null>
  /** The day currently on screen, from the payload or the route. */
  currentDate: ComputedRef<string | null>
  currentDayLabel: ComputedRef<string | null>
  /** Older day (‹) and newer day (›); null disables the arrow. */
  olderDay: ComputedRef<NewsDigestDay | null>
  newerDay: ComputedRef<NewsDigestDay | null>
  isArchive: ComputedRef<boolean>
  /** "Today's digest arrives around 07:00." — newest day is yesterday, before 07:00. */
  awaitingToday: ComputedRef<boolean>
  items: ComputedRef<NewsStory[]>
  hotCount: ComputedRef<number>
  /** `generated_at` as "07:04" local, null when absent or unparsable. */
  updatedTime: ComputedRef<string | null>
  /** The story of `?story=`, or null for the list. */
  selected: ComputedRef<NewsStory | null>
  /** 1-based position of the selected story, 0 when none. */
  selectedPosition: ComputedRef<number>
  previousStory: ComputedRef<NewsStory | null>
  nextStory: ComputedRef<NewsStory | null>
  /**
   * Read state per story *and* last change: an update with a new delta is
   * unread again (`storyReadKey`).
   */
  isRead: (story: ReadableStory) => boolean
  markRead: (story: ReadableStory) => void
  /** True once loading has lasted longer than 300 ms. */
  showProgress: Ref<boolean>
  /** Footer disclosure with the names of the sources that failed. */
  failedOpen: Ref<boolean>
  sourcesFailed: ComputedRef<string[]>
}

function dayOf(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1]! : null
}

// Fixed English abbreviations instead of Intl: the UI language of the board is
// English regardless of the reader's locale, and ICU spells September "Sept"
// in en-GB but "Sep" in en-US — the spec wants one of them, always.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Mon 28 Sep 2026". */
export function formatDayLabel(date: string | null): string | null {
  if (!date) return null
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return `${WEEKDAYS[parsed.getDay()]} ${String(parsed.getDate()).padStart(2, '0')} ${MONTHS[parsed.getMonth()]} ${parsed.getFullYear()}`
}

/** "01 Sep" for a source line; the raw value when it cannot be parsed. */
export function formatSourceDate(value: string | undefined): string | null {
  if (!value) return null
  const stamp = Date.parse(value)
  if (Number.isNaN(stamp)) return value
  const parsed = new Date(stamp)
  // No-break space: "28" and "Sep" must never split at the end of a narrow line.
  return `${String(parsed.getDate()).padStart(2, '0')}\u00a0${MONTHS[parsed.getMonth()]}`
}

function defaultStorage(): ReadStateStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Safari in private mode throws on access alone.
    return null
  }
}

export function useNewsDigestView(options: NewsDigestViewOptions): NewsDigestView {
  const now = options.now ?? (() => new Date())
  const storage = options.storage === undefined ? defaultStorage() : options.storage
  const digest = computed(() => parseNewsDigest(toValue(options.payload)))
  const items = computed(() => digest.value?.items ?? [])

  const days = computed<NewsDigestDay[]>(() => {
    const entries = toValue(options.revisions) ?? []
    const byDate = new Map<string, NewsDigestDay>()
    for (const entry of entries) {
      const date = dayOf(entry.asOf) ?? dayOf(entry.createdAt)
      if (!date) continue
      const known = byDate.get(date)
      // One entry per day: the newest revision of that day wins.
      if (known && known.revision >= entry.revision) continue
      byDate.set(date, {
        revision: entry.revision,
        date,
        label: formatDayLabel(date) ?? date,
        headline: entry.summary ?? null,
      })
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  })

  const newestDay = computed(() => days.value[0] ?? null)
  const currentDate = computed(() => dayOf(digest.value?.date) ?? dayOf(toValue(options.date)) ?? newestDay.value?.date ?? null)
  const olderDay = computed(() => {
    const current = currentDate.value
    if (!current) return null
    return days.value.find(day => day.date < current) ?? null
  })
  const newerDay = computed(() => {
    const current = currentDate.value
    if (!current) return null
    const newer = days.value.filter(day => day.date > current)
    return newer.length ? newer[newer.length - 1]! : null
  })

  const awaitingToday = computed(() => {
    const newest = newestDay.value?.date
    if (!newest) return false
    const clock = now()
    if (clock.getHours() >= NEWS_DIGEST_HOUR) return false
    const yesterday = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate() - 1)
    const expected = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
    return newest === expected
  })

  const selected = computed(() => {
    const id = toValue(options.story)
    if (!id) return null
    return items.value.find(item => item.storyId === id) ?? null
  })
  const selectedIndex = computed(() => {
    const story = selected.value
    return story ? items.value.indexOf(story) : -1
  })

  const read = ref<string[]>(loadRead())
  function loadRead(): string[] {
    if (!storage) return []
    try {
      const raw = storage.getItem(NEWS_READ_STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  function markRead(story: ReadableStory) {
    if (!story.storyId) return
    const key = storyReadKey(story)
    if (read.value.includes(key)) return
    const next = [...read.value, key].slice(-NEWS_READ_MAX)
    read.value = next
    try {
      storage?.setItem(NEWS_READ_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // A full or blocked storage must not break the board.
    }
  }

  // Opening a story is what marks it read — the same rule on both clients.
  watch(selected, (story) => { if (story) markRead(story) }, { immediate: true })

  const showProgress = ref(false)
  let progressTimer: ReturnType<typeof setTimeout> | null = null
  function clearProgress() {
    if (progressTimer !== null) clearTimeout(progressTimer)
    progressTimer = null
  }
  watch(() => toValue(options.loading) === true, (loading) => {
    clearProgress()
    if (!loading) { showProgress.value = false; return }
    progressTimer = setTimeout(() => { showProgress.value = true }, NEWS_PROGRESS_DELAY_MS)
  }, { immediate: true })
  onScopeDispose(clearProgress)

  return {
    digest,
    days,
    newestDay,
    currentDate,
    currentDayLabel: computed(() => formatDayLabel(currentDate.value)),
    olderDay,
    newerDay,
    isArchive: computed(() => {
      const newest = newestDay.value?.date
      return Boolean(newest && currentDate.value && currentDate.value !== newest)
    }),
    awaitingToday,
    items,
    hotCount: computed(() => digest.value?.hotCount ?? 0),
    updatedTime: computed(() => {
      const raw = digest.value?.generatedAt
      if (!raw) return null
      const stamp = Date.parse(raw)
      if (Number.isNaN(stamp)) return null
      const time = new Date(stamp)
      return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
    }),
    selected,
    selectedPosition: computed(() => selectedIndex.value + 1),
    previousStory: computed(() => (selectedIndex.value > 0 ? items.value[selectedIndex.value - 1]! : null)),
    nextStory: computed(() => {
      const index = selectedIndex.value
      return index >= 0 && index + 1 < items.value.length ? items.value[index + 1]! : null
    }),
    isRead: (story: ReadableStory) => read.value.includes(storyReadKey(story)),
    markRead,
    showProgress,
    failedOpen: ref(false),
    sourcesFailed: computed(() => digest.value?.sourcesFailed ?? []),
  }
}
