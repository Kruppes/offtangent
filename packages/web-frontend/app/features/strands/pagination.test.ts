import { describe, it, expect, vi } from 'vitest'
import type { Thread } from '@axiom/core'
import { readFilters, filterQuery, useStrandPagination } from './pagination'
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
})
