import { describe, expect, it } from 'vitest'
import { STRAND_TRANSITION_MS, morphingStrandId, strandIdOfPath, strandTransition, transitionDirection } from './strandTransition'

const base = { supported: true, reducedMotion: false, viewport: 1440, fromPath: '/strands', toPath: '/strands/abc' }

describe('strand transition', () => {
  it('reads the strand id of a path', () => {
    expect(strandIdOfPath('/strands')).toBeNull()
    expect(strandIdOfPath('/strands/')).toBeNull()
    expect(strandIdOfPath('/strands?q=x')).toBeNull()
    expect(strandIdOfPath('/strands/a%20b')).toBe('a b')
    expect(strandIdOfPath('/strands/a%zz')).toBe('a%zz')
    expect(strandIdOfPath('/projects/x')).toBeUndefined()
    expect(strandIdOfPath('/strands/a/b')).toBeUndefined()
  })
  it('animates only overview <-> strand', () => {
    expect(transitionDirection('/strands', '/strands/abc')).toBe('open')
    expect(transitionDirection('/strands/abc', '/strands?sort=title')).toBe('close')
    expect(transitionDirection('/strands/abc', '/strands/def')).toBeNull()
    expect(transitionDirection('/feed', '/strands/abc')).toBeNull()
    expect(transitionDirection('/strands', '/strands')).toBeNull()
  })
  it('is instant without the API, with reduced motion and on phones', () => {
    expect(strandTransition(base)).toBe('open')
    expect(strandTransition({ ...base, supported: false })).toBeNull()
    expect(strandTransition({ ...base, reducedMotion: true })).toBeNull()
    expect(strandTransition({ ...base, viewport: 767 })).toBeNull()
    expect(strandTransition({ ...base, viewport: 768 })).toBe('open')
    expect(strandTransition({ ...base, fromPath: '/strands/abc', toPath: '/strands' })).toBe('close')
  })
  it('morphs the opened row and, on the way back, the row that was open', () => {
    expect(morphingStrandId('/strands', '/strands/abc')).toBe('abc')
    expect(morphingStrandId('/strands/abc', '/strands')).toBe('abc')
    expect(morphingStrandId('/strands/abc', '/strands/def')).toBeNull()
  })
  it('stays inside the 220-280 ms of the brief', () => {
    expect(STRAND_TRANSITION_MS).toBeGreaterThanOrEqual(220)
    expect(STRAND_TRANSITION_MS).toBeLessThanOrEqual(280)
  })
})
