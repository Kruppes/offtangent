import { afterEach, describe, expect, it, vi } from 'vitest'
import { COLOR_MODE_STORAGE_KEY, initializeTheme, readColorMode } from './useTheme'

const legacyKey = 'axiom-color-mode'
function storage(values: Record<string, string> = {}) {
  const data = new Map(Object.entries(values))
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
    removeItem: vi.fn((key: string) => { data.delete(key) }),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('theme preference migration', () => {
  it.each(['light', 'dark', 'auto'])('migrates %s once', preference => {
    const local = storage({ [legacyKey]: preference })
    expect(readColorMode(local)).toBe(preference)
    expect(local.getItem(COLOR_MODE_STORAGE_KEY)).toBe(preference)
    expect(local.getItem(legacyKey)).toBeNull()
    expect(readColorMode(local)).toBe(preference)
    expect(local.setItem).toHaveBeenCalledTimes(1)
  })

  it('preserves the new preference over the old preference', () => {
    const local = storage({ [legacyKey]: 'dark', [COLOR_MODE_STORAGE_KEY]: 'light' })
    expect(readColorMode(local)).toBe('light')
    expect(local.setItem).not.toHaveBeenCalled()
    expect(local.getItem(legacyKey)).toBeNull()
  })

  it('defaults missing or invalid preferences to the system', () => {
    expect(readColorMode(storage())).toBe('auto')
    expect(readColorMode(storage({ [legacyKey]: 'invalid' }))).toBe('auto')
    expect(readColorMode(storage({ [COLOR_MODE_STORAGE_KEY]: 'invalid', [legacyKey]: 'dark' }))).toBe('auto')
  })

  it('preserves the legacy preference when writing the replacement fails', () => {
    const local = storage({ [legacyKey]: 'dark' })
    local.setItem.mockImplementation(() => { throw new Error('quota') })
    expect(readColorMode(local)).toBe('dark')
    expect(local.getItem(legacyKey)).toBe('dark')
  })

  it('tolerates blocked storage reads', () => {
    const local = storage()
    local.getItem.mockImplementation(() => { throw new Error('blocked') })
    expect(readColorMode(local)).toBe('auto')
  })
})

describe('early theme class', () => {
  it.each([
    ['light', true, false], ['dark', false, true], ['auto', true, true], ['auto', false, false],
  ] as const)('resolves %s with system dark=%s before rendering', (preference, systemDark, dark) => {
    const local = storage({ [legacyKey]: preference })
    const toggle = vi.fn()
    vi.stubGlobal('window', { localStorage: local, matchMedia: () => ({ matches: systemDark }) })
    vi.stubGlobal('document', { documentElement: { classList: { toggle } } })
    expect(initializeTheme()).toBe(preference)
    expect(toggle).toHaveBeenCalledWith('dark', dark)
    expect(toggle).toHaveBeenCalledWith('light', !dark)
    expect(local.getItem(COLOR_MODE_STORAGE_KEY)).toBe(preference)
  })

  it('uses the system when access to localStorage itself throws', () => {
    const toggle = vi.fn()
    vi.stubGlobal('window', {
      get localStorage() { throw new Error('blocked') },
      matchMedia: () => ({ matches: true }),
    })
    vi.stubGlobal('document', { documentElement: { classList: { toggle } } })
    expect(initializeTheme()).toBe('auto')
    expect(toggle).toHaveBeenCalledWith('dark', true)
  })

  it('is safe outside the browser', () => {
    expect(initializeTheme()).toBe('auto')
  })
})
