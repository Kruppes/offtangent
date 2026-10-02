/**
 * Pure state of the strand overview (W4d): the filter chips, the sort order
 * and the time groups, plus how all of it is read from and written to the
 * URL query so a filtered overview can be shared, reloaded and restored by
 * the browser's back button.
 *
 * Query keys (all optional, defaults are omitted from the URL):
 *   q                search text (server side, title and messages)
 *   project_id       a project id, or `none` for unsorted strands (server side)
 *   tag              a tag name (server side)
 *   now=1            only the now set (server side)
 *   include_archived=1  archived strands too (server side)
 *   running=1        only strands with a running or queued turn (client side)
 *   pinned=1         only pinned strands (client side)
 *   sort=title|created  default is the latest activity
 */

export type StrandSort = 'activity' | 'title' | 'created'
export const STRAND_SORTS: readonly StrandSort[] = ['activity', 'title', 'created']

export interface OverviewState {
  q: string
  project_id: string
  tag: string
  now: boolean
  include_archived: boolean
  running: boolean
  pinned: boolean
  sort: StrandSort
}

/** Every query key the overview owns; anything else in the URL is kept as is. */
export const OVERVIEW_QUERY_KEYS = ['q', 'project_id', 'tag', 'now', 'include_archived', 'running', 'pinned', 'sort'] as const

export const DEFAULT_OVERVIEW_STATE: OverviewState = {
  q: '', project_id: '', tag: '', now: false, include_archived: false, running: false, pinned: false, sort: 'activity',
}

type QueryLike = Record<string, unknown>

function str(query: QueryLike, key: string): string {
  const value = query[key]
  if (typeof value === 'string') return value
  // Vue Router gives repeated keys as arrays; the first value wins.
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}

function flag(query: QueryLike, key: string): boolean {
  return ['1', 'true', 'yes'].includes(str(query, key).toLowerCase())
}

/**
 * Reads the overview state from a route query. Unknown sort values fall back
 * to the default; `q` is NOT normalised here (the list owns its bounds).
 */
export function parseOverviewQuery(query: QueryLike): OverviewState {
  const sort = str(query, 'sort')
  return {
    q: str(query, 'q').trim(),
    project_id: str(query, 'project_id').trim(),
    tag: str(query, 'tag').trim(),
    now: flag(query, 'now'),
    include_archived: flag(query, 'include_archived'),
    running: flag(query, 'running'),
    pinned: flag(query, 'pinned'),
    sort: (STRAND_SORTS as readonly string[]).includes(sort) ? sort as StrandSort : 'activity',
  }
}

/** The query keys of a state, defaults left out (stable key order). */
export function serializeOverviewState(state: OverviewState): Record<string, string> {
  const out: Record<string, string> = {}
  if (state.q) out.q = state.q
  if (state.project_id) out.project_id = state.project_id
  if (state.tag) out.tag = state.tag
  if (state.now) out.now = '1'
  if (state.include_archived) out.include_archived = '1'
  if (state.running) out.running = '1'
  if (state.pinned) out.pinned = '1'
  if (state.sort !== 'activity') out.sort = state.sort
  return out
}

/**
 * The next route query after a change of the overview state: foreign keys of
 * the current query stay, the overview's own keys are rewritten.
 */
export function mergeOverviewQuery<T>(current: Record<string, T>, state: OverviewState): Record<string, T | string> {
  const next: Record<string, T | string> = {}
  for (const [key, value] of Object.entries(current)) {
    if (!(OVERVIEW_QUERY_KEYS as readonly string[]).includes(key)) next[key] = value
  }
  return { ...next, ...serializeOverviewState(state) }
}

/** Only the overview's own keys of a query (what a strand link carries along). */
export function overviewQueryOf(query: QueryLike): Record<string, string> {
  return serializeOverviewState(parseOverviewQuery(query))
}

/** The number of active filter chips (search and sort do not count). */
export function activeFilterCount(state: OverviewState, fixedProject = false): number {
  return [
    state.project_id && !fixedProject, state.tag, state.now, state.include_archived, state.running, state.pinned,
  ].filter(Boolean).length
}

export function hasActiveFilters(state: OverviewState, fixedProject = false): boolean {
  return activeFilterCount(state, fixedProject) > 0
}

/** A state with every filter chip off; search and sort stay. */
export function clearFilters(state: OverviewState): OverviewState {
  return { ...DEFAULT_OVERVIEW_STATE, q: state.q, sort: state.sort }
}

// ── Rows: client side filters, sort, groups ───────────────────────────

export interface OverviewRow {
  id: string
  title: string | null
  pinned: boolean
  archived?: boolean
  startedAt?: string
  lastActivity: string
  nowRank?: number | null
}

/** Parses a backend timestamp (`YYYY-MM-DD HH:MM:SS` is UTC) or ISO string. */
export function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/**
 * The two client side chips. `running` needs the live turn state of the
 * chat socket; both only see the rows loaded so far (the backend lists
 * pinned strands first and running strands are recent, so the first page
 * already carries them in practice).
 */
export function filterRows<T extends OverviewRow>(rows: readonly T[], state: OverviewState, isLive: (id: string) => boolean): T[] {
  return rows.filter(row => (!state.pinned || row.pinned) && (!state.running || isLive(row.id)))
}

/**
 * Sorts a copy. `activity` = newest activity first, `created` = newest
 * strand first, `title` = alphabetical (untitled strands last). Ties keep
 * the backend order (stable sort).
 */
export function sortRows<T extends OverviewRow>(rows: readonly T[], sort: StrandSort, locale = 'en'): T[] {
  const copy = [...rows]
  if (sort === 'title') {
    const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true })
    return copy.sort((a, b) => {
      const ta = a.title?.trim() ?? ''
      const tb = b.title?.trim() ?? ''
      if (!ta || !tb) return ta ? -1 : tb ? 1 : 0
      return collator.compare(ta, tb)
    })
  }
  const key = (row: T) => parseTimestamp(sort === 'created' ? row.startedAt : row.lastActivity) ?? 0
  return copy.sort((a, b) => key(b) - key(a))
}

export type OverviewGroupKey = 'now' | 'today' | 'week' | 'older'
export const OVERVIEW_GROUPS: readonly OverviewGroupKey[] = ['now', 'today', 'week', 'older']

/** Local midnight of the day `now` falls on. */
export function startOfDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/** Local Monday 00:00 of the week `now` falls on (ISO week, Monday first). */
export function startOfWeek(now: Date): number {
  const day = (now.getDay() + 6) % 7
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - day).getTime()
}

/**
 * The time group of one row. `now` = a turn runs or queues right now, or the
 * strand is in the now set; then today, this calendar week, older.
 */
export function groupOf(row: OverviewRow, now: Date, isLive: (id: string) => boolean): OverviewGroupKey {
  if (isLive(row.id) || row.nowRank != null) return 'now'
  const at = parseTimestamp(row.lastActivity)
  if (at === null) return 'older'
  if (at >= startOfDay(now)) return 'today'
  if (at >= startOfWeek(now)) return 'week'
  return 'older'
}

/**
 * Groups rows that are already sorted by activity; empty groups are left
 * out. Other sort orders are shown as one flat list (a group per letter or
 * creation week would only add noise), returned as a single `all` group.
 */
export function groupRows<T extends OverviewRow>(rows: readonly T[], sort: StrandSort, now: Date, isLive: (id: string) => boolean):
Array<{ key: OverviewGroupKey | 'all'; rows: T[] }> {
  if (sort !== 'activity') return rows.length ? [{ key: 'all', rows: [...rows] }] : []
  const buckets = new Map<OverviewGroupKey, T[]>(OVERVIEW_GROUPS.map(key => [key, []]))
  for (const row of rows) buckets.get(groupOf(row, now, isLive))!.push(row)
  return OVERVIEW_GROUPS.flatMap(key => (buckets.get(key)!.length ? [{ key, rows: buckets.get(key)! }] : []))
}

/**
 * Relative time of the last activity as an `Intl.RelativeTimeFormat` pair,
 * or null when the timestamp is unreadable. Under a minute is `0 minute`
 * ("now" with numeric: 'auto').
 */
export function relativeParts(value: string, now: Date): { value: number; unit: Intl.RelativeTimeFormatUnit } | null {
  const at = parseTimestamp(value)
  if (at === null) return null
  const seconds = Math.round((at - now.getTime()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return { value: 0, unit: 'minute' }
  if (abs < 3600) return { value: Math.round(seconds / 60), unit: 'minute' }
  if (abs < 86_400) return { value: Math.round(seconds / 3600), unit: 'hour' }
  if (abs < 7 * 86_400) return { value: Math.round(seconds / 86_400), unit: 'day' }
  if (abs < 30 * 86_400) return { value: Math.round(seconds / (7 * 86_400)), unit: 'week' }
  if (abs < 365 * 86_400) return { value: Math.round(seconds / (30 * 86_400)), unit: 'month' }
  return { value: Math.round(seconds / (365 * 86_400)), unit: 'year' }
}

/** One line of the last message: whitespace collapsed, markdown marks stripped. */
export function previewLine(content: string | null | undefined, max = 160): string {
  if (!content) return ''
  const line = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}
