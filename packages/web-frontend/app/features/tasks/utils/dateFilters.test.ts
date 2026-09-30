import { describe, expect, it } from 'vitest'
import { createDefaultTaskDateRange, formatDateInputValue, formatTaskCreatedAtBoundary } from './dateFilters'

describe('task date filters', () => {
  it('keeps date input labels on the local calendar day', () => {
    expect(formatDateInputValue(new Date(2026, 2, 28, 15, 30, 0))).toBe('2026-03-28')
  })

  it('creates the default three-day date input range', () => {
    expect(createDefaultTaskDateRange(new Date(2026, 2, 28, 15, 30, 0))).toEqual({
      createdFrom: '2026-03-26',
      createdTo: '2026-03-28',
    })
  })

  it('converts picked local dates to UTC instants for API filters', () => {
    expect(formatTaskCreatedAtBoundary('2026-03-28', 'start'))
      .toBe(new Date(2026, 2, 28, 0, 0, 0).toISOString())
    expect(formatTaskCreatedAtBoundary('2026-03-28', 'end'))
      .toBe(new Date(2026, 2, 28, 23, 59, 59).toISOString())
  })

  it('leaves non-date-only values for backend validation', () => {
    expect(formatTaskCreatedAtBoundary('not-a-date', 'start')).toBe('not-a-date')
    expect(formatTaskCreatedAtBoundary('', 'start')).toBeUndefined()
  })
})
