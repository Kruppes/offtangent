import { afterEach, describe, expect, it, vi } from 'vitest'
import { ecoSavedPercent, mapEcoStatus, useStrandEcoApi } from './strandEco'

afterEach(() => vi.unstubAllGlobals())

describe('strand eco contract', () => {
  it('reads the status from the context report and writes a strict boolean PATCH', async () => {
    const eco = { enabled: true, inputBudgetTokens: 28000, outputReserveTokens: 4096, contextFallback: false, last: null }
    const apiFetch = vi.fn().mockResolvedValue({ eco })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const api = useStrandEcoApi()
    expect(await api.get('a/b')).toEqual(eco)
    expect(await api.set('a/b', false)).toEqual(eco)
    expect(apiFetch.mock.calls).toEqual([
      ['/api/strands/a%2Fb/context'],
      ['/api/strands/a%2Fb/eco', { method: 'PATCH', body: '{"enabled":false}' }],
    ])
  })

  it('treats a missing or malformed eco block as unavailable, not as off', () => {
    expect(mapEcoStatus(undefined)).toBeNull()
    expect(mapEcoStatus({ enabled: 'yes' })).toBeNull()
    expect(mapEcoStatus({ enabled: false })).toMatchObject({ enabled: false, inputBudgetTokens: null, last: null })
  })

  it('derives the saved share only from estimates it has', () => {
    const base = { inputBudgetTokens: 1, compactedResults: 0, droppedMessages: 0, degraded: false, at: null }
    expect(ecoSavedPercent(null)).toBeNull()
    expect(ecoSavedPercent({ ...base, estimatedTokensBefore: null, estimatedTokensAfter: 5 })).toBeNull()
    expect(ecoSavedPercent({ ...base, estimatedTokensBefore: 1000, estimatedTokensAfter: 400 })).toBe(60)
    expect(ecoSavedPercent({ ...base, estimatedTokensBefore: 1000, estimatedTokensAfter: 1200 })).toBe(0)
  })
})
