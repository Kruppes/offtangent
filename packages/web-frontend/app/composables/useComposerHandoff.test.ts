import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPOSER_HANDOFF_KEY, COMPOSER_HANDOFF_MAX, setComposerHandoff, takeComposerHandoff } from './useComposerHandoff'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    size: () => map.size,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('useComposerHandoff', () => {
  it('hands one text over exactly once', () => {
    const store = fakeStorage()
    vi.stubGlobal('window', { sessionStorage: store })
    expect(setComposerHandoff('article snapshot')).toBe(true)
    expect(JSON.parse(store.getItem(COMPOSER_HANDOFF_KEY)!)).toEqual({ text: 'article snapshot', newStrand: false, title: null })
    expect(takeComposerHandoff()).toEqual({ text: 'article snapshot', newStrand: false, title: null })
    expect(takeComposerHandoff()).toBeNull()
    expect(store.size()).toBe(0)
  })

  it('ignores an empty handoff', () => {
    vi.stubGlobal('window', { sessionStorage: fakeStorage() })
    expect(setComposerHandoff('   ')).toBe(false)
    expect(takeComposerHandoff()).toBeNull()
  })

  it('caps the stored text', () => {
    const store = fakeStorage()
    vi.stubGlobal('window', { sessionStorage: store })
    setComposerHandoff('x'.repeat(COMPOSER_HANDOFF_MAX + 500))
    expect(JSON.parse(store.getItem(COMPOSER_HANDOFF_KEY)!).text).toHaveLength(COMPOSER_HANDOFF_MAX)
  })

  it('a second handoff replaces the first', () => {
    vi.stubGlobal('window', { sessionStorage: fakeStorage() })
    setComposerHandoff('first')
    setComposerHandoff('second')
    expect(takeComposerHandoff()?.text).toBe('second')
    expect(takeComposerHandoff()).toBeNull()
  })

  it('carries the promise of a new strand and a title, both trimmed', () => {
    vi.stubGlobal('window', { sessionStorage: fakeStorage() })
    setComposerHandoff('snapshot', { newStrand: true, title: `  spaced   ${'t'.repeat(80)}  ` })
    const handoff = takeComposerHandoff()
    expect(handoff?.newStrand).toBe(true)
    expect(handoff?.title).toHaveLength(60)
    expect(handoff?.title?.startsWith('spaced t')).toBe(true)
  })

  it('still accepts a bare string written by an older tab', () => {
    const store = fakeStorage()
    vi.stubGlobal('window', { sessionStorage: store })
    store.setItem(COMPOSER_HANDOFF_KEY, 'plain article snapshot')
    expect(takeComposerHandoff()).toEqual({ text: 'plain article snapshot', newStrand: false, title: null })
  })

  it('survives a denied or missing storage', () => {
    vi.stubGlobal('window', {
      get sessionStorage(): Storage { throw new Error('denied') },
    })
    expect(setComposerHandoff('article')).toBe(false)
    expect(takeComposerHandoff()).toBeNull()
    vi.stubGlobal('window', undefined)
    expect(setComposerHandoff('article')).toBe(false)
    expect(takeComposerHandoff()).toBeNull()
  })

  it('reports a storage that refuses to write', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => null,
        setItem: () => { throw new Error('quota') },
        removeItem: () => {},
      },
    })
    expect(setComposerHandoff('article')).toBe(false)
  })
})
