import { describe, expect, it } from 'vitest'
import { DOCK_MAX_WIDTH } from './strandDock'
import {
  CONTEXT_WIDTH, LIST_WIDTH, MIN_CONVERSATION_WIDTH, dockMaxWidth, inlineDockWidth, effectiveSidebarMode, SIDEBAR_WIDTH, columnTier, contextPlacement, isContextOpen, parseContextOverrides,
  parseSidebarState, rememberContext, setSidebarMode, toggleSidebarCompact, toggleSidebarHidden, visiblePanes, listMode,
} from './shellLayout'

describe('sidebar state', () => {
  it('has the three widths of the approved draft', () => {
    expect(SIDEBAR_WIDTH).toEqual({ full: 256, rail: 56, hidden: 0 })
  })
  it('reads stored values defensively', () => {
    expect(parseSidebarState(null)).toEqual({ mode: 'full', lastVisible: 'full' })
    expect(parseSidebarState('not json')).toEqual({ mode: 'full', lastVisible: 'full' })
    expect(parseSidebarState('{"mode":"wide"}')).toEqual({ mode: 'full', lastVisible: 'full' })
    expect(parseSidebarState('{"mode":"rail","lastVisible":"full"}')).toEqual({ mode: 'rail', lastVisible: 'rail' })
    expect(parseSidebarState({ mode: 'hidden', lastVisible: 'rail' })).toEqual({ mode: 'hidden', lastVisible: 'rail' })
    expect(parseSidebarState({ mode: 'hidden' })).toEqual({ mode: 'hidden', lastVisible: 'full' })
  })
  it('collapse button switches labelled and icons, and brings a hidden sidebar back', () => {
    const full = { mode: 'full', lastVisible: 'full' } as const
    const rail = toggleSidebarCompact(full)
    expect(rail).toEqual({ mode: 'rail', lastVisible: 'rail' })
    expect(toggleSidebarCompact(rail)).toEqual(full)
    expect(toggleSidebarCompact({ mode: 'hidden', lastVisible: 'rail' })).toEqual({ mode: 'rail', lastVisible: 'rail' })
  })
  it('shortcut hides completely and restores the last visible mode', () => {
    const hidden = toggleSidebarHidden({ mode: 'rail', lastVisible: 'rail' })
    expect(hidden).toEqual({ mode: 'hidden', lastVisible: 'rail' })
    expect(toggleSidebarHidden(hidden)).toEqual({ mode: 'rail', lastVisible: 'rail' })
    expect(toggleSidebarHidden(toggleSidebarHidden({ mode: 'full', lastVisible: 'full' }))).toEqual({ mode: 'full', lastVisible: 'full' })
  })
  it('explicit mode keeps the last visible mode when hiding', () => {
    expect(setSidebarMode({ mode: 'full', lastVisible: 'full' }, 'hidden')).toEqual({ mode: 'hidden', lastVisible: 'full' })
  })
})

describe('effective sidebar mode', () => {
  it('uses the drawer on phones, icons below 1280 px, the stored mode above', () => {
    expect(effectiveSidebarMode('full', 390)).toBe('hidden')
    expect(effectiveSidebarMode('rail', 767)).toBe('hidden')
    expect(effectiveSidebarMode('full', 768)).toBe('rail')
    expect(effectiveSidebarMode('full', 1279)).toBe('rail')
    expect(effectiveSidebarMode('full', 1280)).toBe('full')
    expect(effectiveSidebarMode('rail', 1440)).toBe('rail')
    expect(effectiveSidebarMode('hidden', 1024)).toBe('hidden')
    expect(effectiveSidebarMode('hidden', 1440)).toBe('hidden')
  })
  it('keeps the reading column (31rem + padding) next to list at 1024 px', () => {
    const conversation = 1024 - SIDEBAR_WIDTH[effectiveSidebarMode('full', 1024)] - LIST_WIDTH
    expect(conversation).toBeGreaterThanOrEqual(31 * 16 + 48)
  })
})

describe('column tiers', () => {
  it('switches at 768 and 1024 px', () => {
    expect(columnTier(390)).toBe('one')
    expect(columnTier(767)).toBe('one')
    expect(columnTier(768)).toBe('two')
    expect(columnTier(1023)).toBe('two')
    expect(columnTier(1024)).toBe('three')
    expect(columnTier(1440)).toBe('three')
  })
  it('shows list OR strand on one column, both from two columns on', () => {
    expect(visiblePanes('one', false)).toEqual({ list: true, conversation: false })
    expect(visiblePanes('one', true)).toEqual({ list: false, conversation: true })
    expect(visiblePanes('two', true)).toEqual({ list: true, conversation: true })
    expect(visiblePanes('three', false)).toEqual({ list: true, conversation: false })
    expect(visiblePanes('two', false)).toEqual({ list: true, conversation: false })
  })
  it('shows the overview without a strand and the side column with one', () => {
    expect(listMode('one', false)).toBe('overview')
    expect(listMode('three', false)).toBe('overview')
    expect(listMode('two', true)).toBe('side')
    expect(listMode('three', true)).toBe('side')
    expect(listMode('one', true)).toBe('hidden')
  })
  it('lets the dock grow only into what the reading measure leaves', () => {
    // 1440 with the labelled sidebar: 1440 - 256 - 304 - 576 = 304.
    expect(dockMaxWidth(1440, 256)).toBe(304)
    expect(dockMaxWidth(1440, 56)).toBe(504)
    expect(dockMaxWidth(1920, 56)).toBe(560)
    expect(inlineDockWidth(320, 1440, 256)).toBe(304)
    expect(inlineDockWidth(560, 1440, 56)).toBe(504)
    expect(inlineDockWidth(200, 1920, 56)).toBe(280)
    // The conversation keeps MIN_CONVERSATION_WIDTH at every inline width.
    for (const [viewport, sidebar] of [[1440, 256], [1440, 56], [1280, 56], [1600, 256], [1920, 0]] as const) {
      if (contextPlacement(viewport, sidebar) !== 'inline') continue
      const conversation = viewport - sidebar - LIST_WIDTH - inlineDockWidth(DOCK_MAX_WIDTH, viewport, sidebar)
      expect(conversation).toBeGreaterThanOrEqual(MIN_CONVERSATION_WIDTH)
    }
  })
  it('puts the context column inline only when the conversation keeps its reading width', () => {
    expect(LIST_WIDTH + CONTEXT_WIDTH).toBe(624)
    expect(contextPlacement(1440, 256)).toBe('inline')
    expect(contextPlacement(1440, 56)).toBe('inline')
    // Just below: the dock at its 280 px minimum would squeeze the conversation.
    expect(contextPlacement(1415, 256)).toBe('overlay')
    expect(contextPlacement(1416, 256)).toBe('inline')
    expect(contextPlacement(1280, 256)).toBe('overlay')
    expect(contextPlacement(1280, 56)).toBe('inline')
    expect(contextPlacement(1024, 0)).toBe('overlay')
    expect(contextPlacement(900, 0)).toBe('overlay')
    expect(contextPlacement(390, 0)).toBe('overlay')
  })
})

describe('context column per strand', () => {
  it('opens by default only with content, manual choice wins', () => {
    expect(isContextOpen({}, 's1', false)).toBe(false)
    expect(isContextOpen({}, 's1', true)).toBe(true)
    expect(isContextOpen({ s1: false }, 's1', true)).toBe(false)
    expect(isContextOpen({ s1: true }, 's1', false)).toBe(true)
  })
  it('remembers at most 100 strands, newest last', () => {
    let overrides = {}
    for (let i = 0; i < 120; i++) overrides = rememberContext(overrides, `s${i}`, i % 2 === 0)
    const keys = Object.keys(overrides)
    expect(keys).toHaveLength(100)
    expect(keys[0]).toBe('s20')
    expect(keys.at(-1)).toBe('s119')
    overrides = rememberContext(overrides, 's20', true)
    expect(Object.keys(overrides).at(-1)).toBe('s20')
    expect(Object.keys(overrides)).toHaveLength(100)
  })
  it('parses stored overrides defensively', () => {
    expect(parseContextOverrides('x')).toEqual({})
    expect(parseContextOverrides('[1]')).toEqual({})
    expect(parseContextOverrides('{"a":true,"b":"yes","c":false}')).toEqual({ a: true, c: false })
  })
})
