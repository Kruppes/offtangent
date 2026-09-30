import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBoardsApi } from './boards'

afterEach(() => vi.unstubAllGlobals())

describe('boards transport', () => {
  it('unwraps the list and revision envelopes', async () => {
    const apiFetch = vi.fn()
      .mockResolvedValueOnce({ boards: [{ key: 'depot' }] })
      .mockResolvedValueOnce({ revisions: [{ revision: 2 }] })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const api = useBoardsApi()
    expect(await api.list()).toEqual([{ key: 'depot' }])
    expect(await api.revisions('depot')).toEqual([{ revision: 2 }])
    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/boards')
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/boards/depot/revisions')
  })

  it('encodes keys and revision numbers in every path', async () => {
    const apiFetch = vi.fn().mockResolvedValue({})
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const api = useBoardsApi()
    await api.get('a/b c')
    await api.revision('a/b c', 7)
    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/boards/a%2Fb%20c')
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/boards/a%2Fb%20c/revisions/7')
  })

  it('requests series by name with a day window and unwraps unknown series as empty', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ series: { total_eur: [{ day: '2026-09-25', value: 1 }], nope: [] } })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const series = await useBoardsApi().series('depot', ['total_eur', 'nope'], 90)
    expect(apiFetch).toHaveBeenCalledWith('/api/boards/depot/series?series=total_eur%2Cnope&days=90')
    expect(series.total_eur).toHaveLength(1)
    expect(series.nope).toEqual([])
  })
})
