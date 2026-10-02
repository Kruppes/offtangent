import { describe, expect, it } from 'vitest'
import { CAPTURE_NAV_ITEMS, counterLabel } from './shellNav'

describe('capture navigation', () => {
  it('lists Unsorted (with counter) and Week', () => {
    expect(CAPTURE_NAV_ITEMS.map(item => [item.path, item.counter])).toEqual([['/unsorted', 'unsorted'], ['/week', null]])
  })
  it('labels the counter: empty at zero, "+" when a page was full', () => {
    expect(counterLabel(0, false)).toBe('')
    expect(counterLabel(-1, true)).toBe('')
    expect(counterLabel(3, false)).toBe('3')
    expect(counterLabel(50, true)).toBe('50+')
  })
})
