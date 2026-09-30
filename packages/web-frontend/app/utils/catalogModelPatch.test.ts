import { describe, expect, it } from 'vitest'
import { buildCatalogModelPatch } from './catalogModelPatch'

describe('buildCatalogModelPatch', () => {
  it('maps name, context window and cost from a live catalog entry', () => {
    expect(buildCatalogModelPatch({
      id: 'qwen/qwen3.8-flash',
      name: 'Qwen: Qwen3.8 Flash',
      contextWindow: 1_000_000,
      cost: { input: 0.15, output: 0.47 },
    })).toEqual({
      name: 'Qwen: Qwen3.8 Flash',
      contextWindow: 1_000_000,
      cost: { input: 0.15, output: 0.47 },
    })
  })

  it('omits a name that merely repeats the id', () => {
    expect(buildCatalogModelPatch({ id: 'x/y', name: 'x/y', cost: { input: 1, output: 2 } })).toEqual({
      cost: { input: 1, output: 2 },
    })
  })

  it('returns null when nothing is worth persisting', () => {
    expect(buildCatalogModelPatch({ id: 'x/y', name: 'x/y' })).toBeNull()
  })
})
