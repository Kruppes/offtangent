/**
 * Pure model of the command palette (W3): which entries show for a query, in
 * which order, and where the keyboard cursor goes. The component only renders
 * this list and runs the chosen entry.
 *
 * Strands come from the backend search (`GET /api/strands?q=`), already
 * filtered and ranked there; pages and actions are filtered here.
 */

export type PaletteGroup = 'strands' | 'pages' | 'actions'
export const PALETTE_GROUPS: readonly PaletteGroup[] = ['strands', 'pages', 'actions']

export interface PaletteEntry {
  /** Unique across all groups, used as DOM id suffix. */
  id: string
  group: PaletteGroup
  label: string
  /** Secondary text: a shortcut, a date or the system section. */
  hint?: string
  icon: string
  /** Extra words that should find this entry (e.g. the English and German name). */
  keywords?: readonly string[]
}

/** Debounce of the strand search while typing. */
export const PALETTE_SEARCH_DEBOUNCE_MS = 180
/** Strands shown at once; the full search lives in the strand list. */
export const PALETTE_STRAND_LIMIT = 8
/** Server-side cap of the strand search term (mirrors the strand list). */
export const PALETTE_QUERY_MAX = 200

export function normalizeText(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Term sent to the backend: trimmed, single spaces, capped. Empty means "recent strands". */
export function paletteSearchTerm(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, PALETTE_QUERY_MAX)
}

/**
 * Match score of an entry for a query, or -1 when it does not match. Every
 * word of the query must occur in the label or the keywords; a label that
 * starts with the query ranks first, then a word start, then anything else.
 */
export function scoreEntry(entry: Pick<PaletteEntry, 'label' | 'keywords'>, query: string): number {
  const q = normalizeText(query)
  if (!q) return 0
  const label = normalizeText(entry.label)
  const haystack = [label, ...(entry.keywords ?? []).map(normalizeText)].join(' ')
  if (!q.split(' ').every(word => haystack.includes(word))) return -1
  if (label.startsWith(q)) return 3
  if (label.split(/[\s/–-]+/).some(word => word.startsWith(q))) return 2
  return 1
}

export function filterEntries<T extends PaletteEntry>(entries: readonly T[], query: string): T[] {
  return entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(entry, query) }))
    .filter(row => row.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(row => row.entry)
}

/**
 * The flat, ordered list the palette shows: strands (as returned by the
 * server, capped), then matching pages, then matching actions.
 */
export function buildPaletteList<T extends PaletteEntry>(input: { strands: readonly T[]; pages: readonly T[]; actions: readonly T[]; query: string }): T[] {
  return [
    ...input.strands.slice(0, PALETTE_STRAND_LIMIT),
    ...filterEntries(input.pages, input.query),
    ...filterEntries(input.actions, input.query),
  ]
}

/** Groups in display order, each with its entries and their index in the flat list. */
export function groupPaletteList<T extends PaletteEntry>(list: readonly T[]): Array<{ group: PaletteGroup; items: Array<{ entry: T; index: number }> }> {
  return PALETTE_GROUPS
    .map(group => ({ group, items: list.map((entry, index) => ({ entry, index })).filter(row => row.entry.group === group) }))
    .filter(section => section.items.length > 0)
}

export type PaletteKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'PageDown' | 'PageUp'

/** Keyboard cursor: arrows wrap around, Home/End jump, PageUp/Down move by five. */
export function moveCursor(current: number, count: number, key: PaletteKey): number {
  if (count <= 0) return -1
  const from = current < 0 || current >= count ? -1 : current
  switch (key) {
    case 'ArrowDown': return from < 0 ? 0 : (from + 1) % count
    case 'ArrowUp': return from < 0 ? count - 1 : (from - 1 + count) % count
    case 'Home': return 0
    case 'End': return count - 1
    case 'PageDown': return Math.min(count - 1, Math.max(0, from) + 5)
    case 'PageUp': return Math.max(0, (from < 0 ? 0 : from) - 5)
  }
}

/** Cursor after the list changed: keep the same entry when it is still there, else the first. */
export function keepCursor(previousId: string | null, list: readonly Pick<PaletteEntry, 'id'>[]): number {
  if (!list.length) return -1
  const index = previousId ? list.findIndex(entry => entry.id === previousId) : -1
  return index >= 0 ? index : 0
}

/**
 * Only the newest request may write its result: starting a request aborts
 * the one before it, and `isCurrent` tells a late answer it is stale.
 */
export function createLatestRequest() {
  let controller: AbortController | null = null
  let seq = 0
  return {
    start(): { id: number; signal: AbortSignal } {
      controller?.abort()
      controller = new AbortController()
      seq += 1
      return { id: seq, signal: controller.signal }
    },
    isCurrent(id: number): boolean {
      return id === seq
    },
    cancel(): void {
      controller?.abort()
      controller = null
      seq += 1
    },
  }
}
