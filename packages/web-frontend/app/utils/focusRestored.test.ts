import { describe, expect, it } from 'vitest'
import { focusRestored } from './focusRestored'

// No DOM environment in this repo's vitest setup: minimal element doubles.
interface Fake { dataset: Record<string, string>; focused: boolean; visible: boolean; attrs: Record<string, string> }
function el(ackId: string | null, visible = true): Fake { return { dataset: ackId ? { ackId } : {}, focused: false, visible, attrs: {} } }
function asEl(f: Fake, children: Fake[] = []): HTMLElement {
  return {
    dataset: f.dataset,
    getClientRects: () => (f.visible ? [{}] : []),
    focus: () => { f.focused = true },
    hasAttribute: (n: string) => n in f.attrs,
    setAttribute: (n: string, v: string) => { f.attrs[n] = v },
    querySelectorAll: () => children.map(c => asEl(c)),
  } as unknown as HTMLElement
}

describe('focusRestored', () => {
  it('focuses the visible dismiss button of the first restored entry', () => {
    const a = el('a'), hidden = el('b', false), shown = el('b')
    const list = el(null)
    focusRestored(asEl(list, [a, hidden, shown]), ['b'])
    expect(shown.focused).toBe(true)
    expect(hidden.focused).toBe(false)
    expect(a.focused).toBe(false)
    expect(list.focused).toBe(false)
  })

  it('falls back to the list itself (made focusable) instead of <body>', () => {
    const list = el(null)
    focusRestored(asEl(list, [el('x')]), ['gone'])
    expect(list.focused).toBe(true)
    expect(list.attrs.tabindex).toBe('-1')
  })

  it('keeps an existing tabindex on the list', () => {
    const list = el(null); list.attrs.tabindex = '0'
    focusRestored(asEl(list), ['gone'])
    expect(list.attrs.tabindex).toBe('0')
    expect(list.focused).toBe(true)
  })

  it('does nothing without a container', () => {
    expect(focusRestored(null, ['a'])).toBeNull()
  })
})
