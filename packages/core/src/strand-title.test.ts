import { describe, it, expect } from 'vitest'
import { deriveStrandTitle, DERIVED_TITLE_MAX } from './strand-title.js'

describe('deriveStrandTitle', () => {
  it('keeps a short line verbatim and collapses whitespace', () => {
    expect(deriveStrandTitle('  der dachdecker\nhat   zurueckgerufen ')).toBe('der dachdecker hat zurueckgerufen')
    expect(deriveStrandTitle('')).toBe('')
    expect(deriveStrandTitle('   \n  ')).toBe('')
  })

  it('cuts on a word boundary with exactly one ellipsis and never exceeds the cap', () => {
    const long = 'Die Strand Zuordnung ist immer noch extrem lueckenhaft und haengt an fremden Strands'
    const title = deriveStrandTitle(long)
    expect(title.length).toBeLessThanOrEqual(DERIVED_TITLE_MAX)
    expect(title.endsWith('…')).toBe(true)
    expect(title.match(/…/g)!.length).toBe(1)
    expect(title).not.toContain(' …')
    expect(long.startsWith(title.slice(0, -1))).toBe(true)
  })

  it('falls back to a hard cut when there is no word boundary to cut on', () => {
    const title = deriveStrandTitle('x'.repeat(200))
    expect(title.length).toBe(DERIVED_TITLE_MAX)
    expect(title.endsWith('…')).toBe(true)
  })
})
