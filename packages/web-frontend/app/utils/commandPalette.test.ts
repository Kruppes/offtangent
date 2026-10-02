import { describe, expect, it } from 'vitest'
import {
  PALETTE_STRAND_LIMIT, buildPaletteList, createLatestRequest, filterEntries, groupPaletteList, keepCursor,
  moveCursor, normalizeText, paletteSearchTerm, scoreEntry, type PaletteEntry,
} from './commandPalette'

const page = (id: string, label: string, keywords?: string[]): PaletteEntry => ({ id: `page:${id}`, group: 'pages', label, icon: 'file', keywords })
const action = (id: string, label: string): PaletteEntry => ({ id: `action:${id}`, group: 'actions', label, icon: 'zap' })
const strand = (n: number): PaletteEntry => ({ id: `strand:${n}`, group: 'strands', label: `Synthetic strand ${n}`, icon: 'chat' })

describe('palette matching', () => {
  it('normalizes case, accents and spaces', () => {
    expect(normalizeText('  Über   Café ')).toBe('uber cafe')
    expect(paletteSearchTerm('  two\n words ')).toBe('two words')
    expect(paletteSearchTerm('x'.repeat(500))).toHaveLength(200)
  })

  it('needs every query word and ranks label prefix > word start > anywhere', () => {
    expect(scoreEntry({ label: 'Settings' }, '')).toBe(0)
    expect(scoreEntry({ label: 'Settings' }, 'set')).toBe(3)
    expect(scoreEntry({ label: 'Toggle sidebar' }, 'side')).toBe(2)
    expect(scoreEntry({ label: 'Cronjobs' }, 'job')).toBe(1)
    expect(scoreEntry({ label: 'Feed' }, 'boards')).toBe(-1)
    expect(scoreEntry({ label: 'Toggle sidebar' }, 'sidebar toggle')).toBe(1)
    expect(scoreEntry({ label: 'Toggle sidebar', keywords: ['Leiste'] }, 'leiste')).toBe(1)
  })

  it('filters and keeps the original order for equal scores', () => {
    const pages = [page('feed', 'Feed'), page('boards', 'Boards'), page('settings', 'Settings'), page('usage', 'Usage')]
    expect(filterEntries(pages, '').map(p => p.label)).toEqual(['Feed', 'Boards', 'Settings', 'Usage'])
    expect(filterEntries(pages, 's').map(p => p.label)).toEqual(['Settings', 'Boards', 'Usage'])
    expect(filterEntries(pages, 'zzz')).toEqual([])
  })

  it('builds strands (server order, capped), then pages, then actions', () => {
    const strands = Array.from({ length: 12 }, (_, i) => strand(i))
    const list = buildPaletteList({ strands, pages: [page('feed', 'Feed'), page('boards', 'Boards')], actions: [action('theme', 'Toggle theme'), action('new', 'New strand')], query: 'e' })
    expect(list.filter(e => e.group === 'strands')).toHaveLength(PALETTE_STRAND_LIMIT)
    expect(list.map(e => e.group)).toEqual([...Array(PALETTE_STRAND_LIMIT).fill('strands'), 'pages', 'actions', 'actions'])
    // strands are not re-filtered locally: the server matched them (titles AND messages)
    expect(buildPaletteList({ strands: [strand(1)], pages: [], actions: [], query: 'nomatch' })).toHaveLength(1)
    const sections = groupPaletteList(list)
    expect(sections.map(s => s.group)).toEqual(['strands', 'pages', 'actions'])
    expect(sections[1]!.items[0]!.index).toBe(PALETTE_STRAND_LIMIT)
  })
})

describe('palette cursor', () => {
  it('wraps with arrows and jumps with Home/End/Page keys', () => {
    expect(moveCursor(-1, 0, 'ArrowDown')).toBe(-1)
    expect(moveCursor(-1, 4, 'ArrowDown')).toBe(0)
    expect(moveCursor(-1, 4, 'ArrowUp')).toBe(3)
    expect(moveCursor(3, 4, 'ArrowDown')).toBe(0)
    expect(moveCursor(0, 4, 'ArrowUp')).toBe(3)
    expect(moveCursor(2, 4, 'Home')).toBe(0)
    expect(moveCursor(0, 4, 'End')).toBe(3)
    expect(moveCursor(1, 20, 'PageDown')).toBe(6)
    expect(moveCursor(18, 20, 'PageDown')).toBe(19)
    expect(moveCursor(3, 20, 'PageUp')).toBe(0)
    expect(moveCursor(9, 4, 'ArrowDown')).toBe(0)
  })

  it('keeps the selected entry across list updates', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(keepCursor('b', list)).toBe(1)
    expect(keepCursor('gone', list)).toBe(0)
    expect(keepCursor(null, list)).toBe(0)
    expect(keepCursor('a', [])).toBe(-1)
  })
})

describe('latest request', () => {
  it('aborts the previous request and marks late answers stale', () => {
    const latest = createLatestRequest()
    const first = latest.start()
    const second = latest.start()
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(latest.isCurrent(first.id)).toBe(false)
    expect(latest.isCurrent(second.id)).toBe(true)
    latest.cancel()
    expect(second.signal.aborted).toBe(true)
    expect(latest.isCurrent(second.id)).toBe(false)
  })
})
