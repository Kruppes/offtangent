import { describe, it, expect, vi } from 'vitest'
import type { Thread } from '@axiom/core'
import { readFilters, filterQuery, highlightParts, normalizeSearch, useStrandPagination } from './pagination'
const rows = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: String(start + i) }) as Thread)
describe('server strand pagination', () => {
  it('crosses the 100 boundary and stops on the short page', async () => {
    const fetch = vi.fn(async (offset: number) => rows(offset, offset < 200 ? 100 : 13))
    const state = useStrandPagination(fetch)
    await state.reset(); expect(state.rows.value).toHaveLength(100)
    await state.next(); await state.next(); await state.next()
    expect(state.rows.value).toHaveLength(213)
    expect(fetch.mock.calls).toEqual([[0], [100], [200]])
    expect(state.ended.value).toBe(true)
  })
  it('caps requests and exposes a visible truncation state', async () => {
    const fetch = vi.fn(async (offset: number) => rows(offset, 100))
    const state = useStrandPagination(fetch, 2)
    await state.reset(); await state.next(); await state.next()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(state.truncated.value).toBe(true)
  })
  it('preserves earlier pages on error and retries the same offset', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(rows(0, 100)).mockRejectedValueOnce(Error()).mockResolvedValueOnce(rows(100, 3))
    const state = useStrandPagination(fetch)
    await state.reset(); await state.next()
    expect(state.error.value).toBe(true); expect(state.rows.value).toHaveLength(100)
    await state.next(); expect(state.rows.value).toHaveLength(103)
    expect(fetch.mock.calls).toEqual([[0], [100], [100]])
  })
  it('ignores stale requests after filter reset', async () => {
    let finish!: (value: Thread[]) => void
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce(rows(200, 1))
    const state = useStrandPagination(fetch)
    const first = state.reset(); await state.reset(); finish(rows(0, 100)); await first
    expect(state.rows.value.map(r => r.id)).toEqual(['200'])
  })
  it('round trips supported filters through URL, including no project', () => {
    const filters = readFilters({ project_id: 'none', tag: 'test', now: 'true', include_archived: '1' })
    expect(filterQuery(filters)).toEqual({ project_id: 'none', tag: 'test', now: '1', include_archived: '1' })
    expect(readFilters(filterQuery(filters))).toEqual(filters)
    expect(readFilters({}, 'project-fixed').project_id).toBe('project-fixed')
    expect(filterQuery(readFilters({}))).toEqual({})
  })
  it('round trips the search and drops a too short one', () => {
    expect(readFilters({ q: '  needle  ' }).q).toBe('needle')
    expect(filterQuery(readFilters({ q: 'needle', tag: 't' }))).toEqual({ tag: 't', q: 'needle' })
    expect(readFilters({ q: 'x' }).q).toBe('')
    expect(filterQuery(readFilters({ q: ' x ' }))).toEqual({})
    expect(readFilters({ q: ['a', 'b'] }).q).toBe('')
  })
})
describe('search helpers', () => {
  it('normalizes the search text to the backend bounds', () => {
    expect(normalizeSearch('ab')).toBe('ab')
    expect(normalizeSearch(' a ')).toBe('')
    expect(normalizeSearch(42)).toBe('')
    expect(normalizeSearch('y'.repeat(250))).toHaveLength(200)
  })
  it('splits text into highlighted parts, case-insensitively and per word', () => {
    expect(highlightParts('Alpha beta ALPHA', 'alpha')).toEqual([
      { text: 'Alpha', match: true }, { text: ' beta ', match: false }, { text: 'ALPHA', match: true },
    ])
    expect(highlightParts('one two three', 'three one')).toEqual([
      { text: 'one', match: true }, { text: ' two ', match: false }, { text: 'three', match: true },
    ])
  })
  it('treats regex and HTML characters in the query and text as plain text', () => {
    expect(highlightParts('cost 50% (a+b) <b>x</b>', '50% (a+b)')).toEqual([
      { text: 'cost ', match: false }, { text: '50%', match: true }, { text: ' ', match: false }, { text: '(a+b)', match: true }, { text: ' <b>x</b>', match: false },
    ])
    expect(highlightParts('a.c abc', 'a.c')).toEqual([{ text: 'a.c', match: true }, { text: ' abc', match: false }])
  })
  it('returns the whole text unmarked for an empty query and nothing for empty text', () => {
    expect(highlightParts('plain', '  ')).toEqual([{ text: 'plain', match: false }])
    expect(highlightParts('', 'x')).toEqual([])
  })
})
