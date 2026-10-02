import { describe, expect, it } from 'vitest'
import { EXTERNAL_SHORTCUT_HINTS, RESERVED_BROWSER_COMBOS, SHORTCUT_BINDINGS, displayKeys, helpSections, isEditableElement, isMacPlatform, resolveShortcut, stepIndex, type KeyLike } from './shortcuts'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
const idle = { editable: false, overlayOpen: false }
const typing = { editable: true, overlayOpen: false }
const overlay = { editable: false, overlayOpen: true }

describe('resolveShortcut', () => {
  it('maps plain keys outside of fields', () => {
    expect(resolveShortcut(key('j'), idle)?.id).toBe('list.next')
    expect(resolveShortcut(key('k'), idle)?.id).toBe('list.previous')
    expect(resolveShortcut(key('/'), idle)?.id).toBe('search.focus')
    expect(resolveShortcut(key('?', { shiftKey: true }), idle)?.id).toBe('help.open')
  })
  it('never fires plain keys while typing', () => {
    for (const k of ['j', 'k', '/', '?']) expect(resolveShortcut(key(k, { shiftKey: k === '?' }), typing)).toBeNull()
  })
  it('accepts Ctrl and Cmd for the palette, also inside fields and overlays', () => {
    expect(resolveShortcut(key('k', { ctrlKey: true }), idle)?.id).toBe('palette.toggle')
    expect(resolveShortcut(key('K', { metaKey: true }), typing)?.id).toBe('palette.toggle')
    expect(resolveShortcut(key('k', { ctrlKey: true }), overlay)?.id).toBe('palette.toggle')
  })
  it('sidebar: Ctrl+B outside fields, Ctrl+\\ everywhere', () => {
    expect(resolveShortcut(key('b', { ctrlKey: true }), idle)?.id).toBe('sidebar.toggle')
    expect(resolveShortcut(key('b', { ctrlKey: true }), typing)).toBeNull()
    expect(resolveShortcut(key('\\', { ctrlKey: true }), typing)?.id).toBe('sidebar.toggle')
  })
  it('mutes plain keys while an overlay is open', () => {
    expect(resolveShortcut(key('j'), overlay)).toBeNull()
    expect(resolveShortcut(key('?', { shiftKey: true }), overlay)).toBeNull()
  })
  it('ignores Alt combinations, extra Shift, modifiers on plain keys and IME composition', () => {
    expect(resolveShortcut(key('j', { altKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('/', { ctrlKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('J', { shiftKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('k', { ctrlKey: true, shiftKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('j', { isComposing: true }), idle)).toBeNull()
  })
  it('leaves Ctrl+M (dictation, bound in the composer) alone', () => {
    expect(resolveShortcut(key('m', { ctrlKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('m', { ctrlKey: true }), typing)).toBeNull()
  })
  it('never takes over browser standards', () => {
    for (const combo of RESERVED_BROWSER_COMBOS) {
      for (const mods of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
        expect(resolveShortcut(key(combo, mods), idle)).toBeNull()
        expect(resolveShortcut(key(combo, mods), typing)).toBeNull()
      }
    }
    for (const binding of SHORTCUT_BINDINGS) if (binding.mod) expect(RESERVED_BROWSER_COMBOS).not.toContain(binding.key as never)
  })
})

describe('isEditableElement', () => {
  it('treats text entry as editable, toggles and buttons not', () => {
    expect(isEditableElement({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditableElement({ tagName: 'INPUT', type: 'search' })).toBe(true)
    expect(isEditableElement({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableElement({ tagName: 'SELECT' })).toBe(true)
    expect(isEditableElement({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableElement({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isEditableElement({ tagName: 'BUTTON' })).toBe(false)
    expect(isEditableElement({ tagName: 'A' })).toBe(false)
    expect(isEditableElement(null)).toBe(false)
  })
})

describe('helpers', () => {
  it('shows Cmd on macOS', () => {
    expect(displayKeys(['Ctrl', 'K'], true)).toEqual(['⌘', 'K'])
    expect(displayKeys(['Ctrl', 'K'], false)).toEqual(['Ctrl', 'K'])
  })
  it('steps through rows and clamps at the ends', () => {
    expect(stepIndex(-1, 0, 1)).toBe(-1)
    expect(stepIndex(-1, 5, 1)).toBe(0)
    expect(stepIndex(-1, 5, -1)).toBe(4)
    expect(stepIndex(-1, 5, 1, 2)).toBe(2)
    expect(stepIndex(2, 5, 1)).toBe(3)
    expect(stepIndex(4, 5, 1)).toBe(4)
    expect(stepIndex(0, 5, -1)).toBe(0)
  })
})

describe('help overlay sections', () => {
  it('lists every binding and hint once per id, alternatives merged', () => {
    const sections = helpSections()
    const ids = sections.flatMap(section => section.rows.map(row => row.id))
    for (const binding of SHORTCUT_BINDINGS) expect(ids).toContain(binding.id)
    for (const hint of EXTERNAL_SHORTCUT_HINTS) expect(ids).toContain(hint.id)
    expect(new Set(ids).size).toBe(ids.length)
    const sidebar = sections.flatMap(section => section.rows).find(row => row.id === 'sidebar.toggle')
    expect(sidebar?.combos).toEqual([['Ctrl', 'B'], ['Ctrl', '\\']])
    expect(sections.map(section => section.group)).toEqual(['general', 'navigation', 'strand'])
  })

  it('detects macOS for the ⌘ display', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false)
    expect(isMacPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe(true)
    expect(isMacPlatform(undefined)).toBe(false)
  })
})
