/**
 * useMessageAnchor: the jump to `#msg-<id>` happens once, after the strand's
 * history is in place, never against a transcript that is still loading.
 * The DOM is a minimal synthetic stub (node environment).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useMessageAnchor } from './useMessageAnchor'

interface FakeRow {
  id: string
  attrs: Map<string, string>
  scrolled: number
  focused: number
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  scrollIntoView(): void
  focus(): void
}

function row(id: string): FakeRow {
  return {
    id,
    attrs: new Map(),
    scrolled: 0,
    focused: 0,
    setAttribute(name, value) { this.attrs.set(name, value) },
    removeAttribute(name) { this.attrs.delete(name) },
    getAttribute(name) { return this.attrs.get(name) ?? null },
    scrollIntoView() { this.scrolled++ },
    focus() { this.focused++ },
  }
}

const globals = globalThis as unknown as Record<string, unknown>
let rows: Map<string, FakeRow>
let lookups: number

beforeEach(() => {
  vi.useFakeTimers()
  rows = new Map()
  lookups = 0
  globals.document = { getElementById: (id: string) => { lookups++; return rows.get(id) ?? null } }
  globals.window = { matchMedia: () => ({ matches: true }) }
  globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 16)
})
afterEach(() => {
  vi.useRealTimers()
  delete globals.document
  delete globals.window
  delete globals.requestAnimationFrame
})

async function settle() {
  await nextTick()
  await vi.advanceTimersByTimeAsync(20)
}

describe('useMessageAnchor', () => {
  it('waits for the strand history and then anchors exactly once', async () => {
    const hash = ref('#msg-1')
    const strand = ref('strand-parent')
    const ready = ref(false)
    // A row with the same id is still in the DOM (stale transcript) while the
    // other strand's history loads: it must not be anchored.
    const stale = row('msg-1')
    rows.set('msg-1', stale)
    const scope = effectScope()
    scope.run(() => useMessageAnchor(() => hash.value, () => strand.value, () => ready.value))
    await settle()
    expect(stale.getAttribute('data-anchored')).toBeNull()
    expect(stale.focused).toBe(0)

    // History loaded: the real row replaced the stale one.
    const loaded = row('msg-1')
    rows.set('msg-1', loaded)
    ready.value = true
    await settle()
    expect(loaded.getAttribute('data-anchored')).toBe('true')
    expect(loaded.scrolled).toBe(1)
    expect(loaded.focused).toBe(1)
    expect(stale.focused).toBe(0)
    scope.stop()
  })

  it('does not poll: a row missing after the load is not searched again', async () => {
    const ready = ref(true)
    const scope = effectScope()
    scope.run(() => useMessageAnchor(() => '#msg-7', () => 'strand-a', () => ready.value))
    await settle()
    const after = lookups
    expect(after).toBe(1)
    rows.set('msg-7', row('msg-7'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(lookups).toBe(after)
    expect(rows.get('msg-7')!.focused).toBe(0)
    scope.stop()
  })

  it('jumps again inside a loaded strand when only the hash changes', async () => {
    const hash = ref('#msg-1')
    rows.set('msg-1', row('msg-1'))
    rows.set('msg-2', row('msg-2'))
    const scope = effectScope()
    scope.run(() => useMessageAnchor(() => hash.value, () => 'strand-a', () => true))
    await settle()
    expect(rows.get('msg-1')!.focused).toBe(1)
    hash.value = '#msg-2'
    await settle()
    expect(rows.get('msg-2')!.focused).toBe(1)
    expect(rows.get('msg-1')!.focused).toBe(1)
    scope.stop()
  })

  it('re-arms when the strand reloads with the same hash', async () => {
    const ready = ref(true)
    const strand = ref('strand-a')
    rows.set('msg-3', row('msg-3'))
    const scope = effectScope()
    scope.run(() => useMessageAnchor(() => '#msg-3', () => strand.value, () => ready.value))
    await settle()
    expect(rows.get('msg-3')!.focused).toBe(1)
    ready.value = false
    strand.value = 'strand-b'
    await settle()
    expect(rows.get('msg-3')!.focused).toBe(1)
    ready.value = true
    await settle()
    expect(rows.get('msg-3')!.focused).toBe(2)
    scope.stop()
  })
})

describe('useMessageAnchor follows the row while the layout settles', () => {
  let observers: Array<{ cb: () => void; observed: unknown[]; disconnected: boolean }>
  let listeners: Map<string, () => void>
  let top: number
  function followRow(id: string): FakeRow & { isConnected: boolean; parentElement: null; getBoundingClientRect(): { top: number; bottom: number; height: number } } {
    return { ...row(id), isConnected: true, parentElement: null, getBoundingClientRect: () => ({ top, bottom: top + 100, height: 100 }) }
  }
  beforeEach(() => {
    observers = []
    listeners = new Map()
    top = 400
    globals.ResizeObserver = class {
      entry = { cb: () => {}, observed: [] as unknown[], disconnected: false }
      constructor(cb: () => void) { this.entry.cb = cb; observers.push(this.entry) }
      observe(node: unknown) { this.entry.observed.push(node) }
      disconnect() { this.entry.disconnected = true }
    }
    globals.getComputedStyle = () => ({ overflowY: 'visible' })
    ;(globals.document as Record<string, unknown>).body = { children: [] }
    globals.window = {
      matchMedia: () => ({ matches: true }),
      innerHeight: 900,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    }
  })
  afterEach(() => {
    delete globals.ResizeObserver
    delete globals.getComputedStyle
  })

  it('repeats the jump when content above pushes the row out of view, then stops', async () => {
    const target = followRow('msg-5')
    rows.set('msg-5', target)
    const scope = effectScope()
    scope.run(() => useMessageAnchor(() => '#msg-5', () => 'strand-a', () => true))
    await settle()
    expect(target.scrolled).toBe(1)
    expect(observers).toHaveLength(1)
    expect(observers[0]!.observed).toContain(target)
    // Late images above the row: it drifts below the 900 px viewport.
    top = 985
    observers[0]!.cb()
    await vi.advanceTimersByTimeAsync(20)
    expect(target.scrolled).toBe(2)
    // Back in view: further resizes do not scroll again.
    top = 400
    observers[0]!.cb()
    await vi.advanceTimersByTimeAsync(20)
    expect(target.scrolled).toBe(2)
    // Layout quiet: the follow ends and lets go of the page.
    await vi.advanceTimersByTimeAsync(800)
    expect(observers[0]!.disconnected).toBe(true)
    expect(listeners.size).toBe(0)
    scope.stop()
  })

  it('stops following as soon as the reader scrolls or presses a key', async () => {
    const target = followRow('msg-6')
    rows.set('msg-6', target)
    const scope = effectScope()
    scope.run(() => useMessageAnchor(() => '#msg-6', () => 'strand-a', () => true))
    await settle()
    expect([...listeners.keys()].sort()).toEqual(['keydown', 'pointerdown', 'touchstart', 'wheel'])
    listeners.get('wheel')!()
    expect(observers[0]!.disconnected).toBe(true)
    top = 1500
    observers[0]!.cb()
    await vi.advanceTimersByTimeAsync(1000)
    expect(target.scrolled).toBe(1)
    scope.stop()
  })

  it('gives up after the hard limit even while the layout keeps changing', async () => {
    const target = followRow('msg-8')
    rows.set('msg-8', target)
    const scope = effectScope()
    scope.run(() => useMessageAnchor(() => '#msg-8', () => 'strand-a', () => true))
    await settle()
    for (let t = 0; t < 6000; t += 500) { observers[0]!.cb(); await vi.advanceTimersByTimeAsync(500) }
    expect(observers[0]!.disconnected).toBe(true)
    scope.stop()
  })
})
