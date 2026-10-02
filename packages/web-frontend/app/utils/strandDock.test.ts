import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_DEFAULT_HEIGHT, ACTIVITY_MIN_HEIGHT, CONTEXT_MIN_HEIGHT, DEFAULT_DOCK_STATE, DOCK_DEFAULT_WIDTH, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH,
  DOCK_STEP, DOCK_STEP_LARGE, activityHeightBounds, activityMaxHeight, clampActivityHeight, clampDockWidth, dockSplit, dockWidthBounds,
  parseDockState, resetActivityHeight, resetDockWidth, runningHint, separatorDragValue, separatorKeyValue, setActivityHeight, setDockWidth,
  setSectionOpen, toggleSection,
} from './strandDock'

describe('dock width', () => {
  it('stays between 280 and 560 px', () => {
    expect(clampDockWidth(100)).toBe(DOCK_MIN_WIDTH)
    expect(clampDockWidth(400)).toBe(400)
    expect(clampDockWidth(900)).toBe(DOCK_MAX_WIDTH)
    expect(clampDockWidth(333.6)).toBe(334)
  })
  it('never grows past what the window leaves next to the conversation', () => {
    expect(clampDockWidth(500, 304)).toBe(304)
    expect(clampDockWidth(290, 304)).toBe(290)
    // Even a tiny window yields the minimum; placement decides inline vs sheet.
    expect(clampDockWidth(500, 100)).toBe(DOCK_MIN_WIDTH)
  })
  it('announces window-aware bounds', () => {
    expect(dockWidthBounds(304)).toEqual({ min: 280, max: 304 })
    expect(dockWidthBounds(9999)).toEqual({ min: 280, max: 560 })
    expect(dockWidthBounds(10)).toEqual({ min: 280, max: 280 })
  })
  it('stores only clamped widths and resets to the default', () => {
    expect(setDockWidth(DEFAULT_DOCK_STATE, 1000).width).toBe(560)
    expect(setDockWidth(DEFAULT_DOCK_STATE, 1).width).toBe(280)
    expect(resetDockWidth({ ...DEFAULT_DOCK_STATE, width: 500 }).width).toBe(DOCK_DEFAULT_WIDTH)
  })
})

describe('height split', () => {
  it('leaves the context section its minimum', () => {
    expect(activityMaxHeight(600)).toBe(600 - CONTEXT_MIN_HEIGHT)
    expect(activityMaxHeight(100)).toBe(ACTIVITY_MIN_HEIGHT)
    expect(clampActivityHeight(10, 600)).toBe(ACTIVITY_MIN_HEIGHT)
    expect(clampActivityHeight(300, 600)).toBe(300)
    expect(clampActivityHeight(590, 600)).toBe(480)
    expect(activityHeightBounds(600)).toEqual({ min: ACTIVITY_MIN_HEIGHT, max: 480 })
  })
  it('keeps the stored height independent of the current window', () => {
    expect(setActivityHeight(DEFAULT_DOCK_STATE, 700).activityHeight).toBe(700)
    expect(setActivityHeight(DEFAULT_DOCK_STATE, 3).activityHeight).toBe(ACTIVITY_MIN_HEIGHT)
    expect(resetActivityHeight({ ...DEFAULT_DOCK_STATE, activityHeight: 500 }).activityHeight).toBe(ACTIVITY_DEFAULT_HEIGHT)
  })
  it('lays out the sections by their fold states', () => {
    expect(dockSplit({ activityOpen: true, contextOpen: true })).toBe('split')
    expect(dockSplit({ activityOpen: true, contextOpen: false })).toBe('activity-only')
    expect(dockSplit({ activityOpen: false, contextOpen: true })).toBe('context-only')
    expect(dockSplit({ activityOpen: false, contextOpen: false })).toBe('collapsed')
  })
})

describe('fold states', () => {
  it('folds each section on its own', () => {
    const a = toggleSection(DEFAULT_DOCK_STATE, 'activity')
    expect(a).toMatchObject({ activityOpen: false, contextOpen: true })
    const b = toggleSection(a, 'context')
    expect(b).toMatchObject({ activityOpen: false, contextOpen: false })
    expect(setSectionOpen(b, 'activity', true)).toMatchObject({ activityOpen: true, contextOpen: false })
    expect(DEFAULT_DOCK_STATE).toMatchObject({ activityOpen: true, contextOpen: true })
  })
})

describe('separator keyboard', () => {
  const bounds = { min: 280, max: 560 }
  it('grows the dock with ArrowLeft, shrinks with ArrowRight (vertical handle on its left edge)', () => {
    expect(separatorKeyValue('ArrowLeft', false, 320, bounds, 'vertical')).toBe(320 + DOCK_STEP)
    expect(separatorKeyValue('ArrowRight', false, 320, bounds, 'vertical')).toBe(320 - DOCK_STEP)
    expect(separatorKeyValue('ArrowLeft', true, 320, bounds, 'vertical')).toBe(320 + DOCK_STEP_LARGE)
    expect(separatorKeyValue('ArrowRight', true, 300, bounds, 'vertical')).toBe(280)
    expect(separatorKeyValue('ArrowLeft', true, 550, bounds, 'vertical')).toBe(560)
  })
  it('grows the activity section with ArrowDown (horizontal handle below it)', () => {
    expect(separatorKeyValue('ArrowDown', false, 200, { min: 96, max: 400 }, 'horizontal')).toBe(216)
    expect(separatorKeyValue('ArrowUp', true, 200, { min: 96, max: 400 }, 'horizontal')).toBe(136)
  })
  it('jumps to the bounds with Home/End and ignores other keys', () => {
    expect(separatorKeyValue('Home', false, 400, bounds, 'vertical')).toBe(280)
    expect(separatorKeyValue('End', false, 400, bounds, 'vertical')).toBe(560)
    expect(separatorKeyValue('ArrowUp', false, 400, bounds, 'vertical')).toBeNull()
    expect(separatorKeyValue('Enter', false, 400, bounds, 'horizontal')).toBeNull()
  })
})

describe('separator drag', () => {
  it('moves the left edge: pointer left = wider dock', () => {
    expect(separatorDragValue('vertical', 320, 1000, 900, { min: 280, max: 560 })).toBe(420)
    expect(separatorDragValue('vertical', 320, 1000, 1100, { min: 280, max: 560 })).toBe(280)
    expect(separatorDragValue('vertical', 320, 1000, 400, { min: 280, max: 352 })).toBe(352)
  })
  it('moves the split: pointer down = taller activity', () => {
    expect(separatorDragValue('horizontal', 240, 300, 340, { min: 96, max: 480 })).toBe(280)
    expect(separatorDragValue('horizontal', 240, 300, 0, { min: 96, max: 480 })).toBe(96)
  })
})

describe('stored dock state', () => {
  it('parses defensively', () => {
    expect(parseDockState('x')).toEqual(DEFAULT_DOCK_STATE)
    expect(parseDockState('[1]')).toEqual(DEFAULT_DOCK_STATE)
    expect(parseDockState(null)).toEqual(DEFAULT_DOCK_STATE)
    expect(parseDockState('{"width":"wide","activityOpen":"yes","contextOpen":false,"activityHeight":null}'))
      .toEqual({ ...DEFAULT_DOCK_STATE, contextOpen: false })
    expect(parseDockState('{"width":9000,"activityHeight":5,"activityOpen":false,"contextOpen":true}'))
      .toEqual({ width: 560, activityHeight: ACTIVITY_MIN_HEIGHT, activityOpen: false, contextOpen: true })
    expect(parseDockState({ width: 400.4, activityHeight: 300, activityOpen: true, contextOpen: true }))
      .toEqual({ width: 400, activityHeight: 300, activityOpen: true, contextOpen: true })
  })
  it('round-trips through JSON', () => {
    const state = { width: 452, activityHeight: 310, activityOpen: false, contextOpen: true }
    expect(parseDockState(JSON.stringify(state))).toEqual(state)
  })
})

describe('strand head hint', () => {
  it('says nothing while the dock is open: it shows the signal itself', () => {
    expect(runningHint(true, true, 3)).toEqual({ kind: 'none' })
  })
  it('names the running answer and the live tasks while the dock is closed', () => {
    expect(runningHint(false, false, 0)).toEqual({ kind: 'none' })
    expect(runningHint(false, true, 0)).toEqual({ kind: 'turn' })
    expect(runningHint(false, false, 2)).toEqual({ kind: 'tasks', count: 2 })
    expect(runningHint(false, true, 2)).toEqual({ kind: 'turn-and-tasks', count: 2 })
    expect(runningHint(false, false, -1)).toEqual({ kind: 'none' })
  })
})
