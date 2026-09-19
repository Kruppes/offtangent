import { describe, expect, it } from 'vitest'
import { getCronjobScheduleType } from './scheduleType'

describe('getCronjobScheduleType', () => {
  it('treats fixed day and month as a fixed date', () => {
    expect(getCronjobScheduleType('0 7 23 6 *')).toBe('fixedDate')
    expect(getCronjobScheduleType('0 10 12,13 * *')).toBe('recurring')
    expect(getCronjobScheduleType('0 10 12,13 9 *')).toBe('fixedDate')
  })

  it('treats wildcards, ranges and steps as recurring', () => {
    expect(getCronjobScheduleType('0 9 * * *')).toBe('recurring')
    expect(getCronjobScheduleType('0 9 * * 6')).toBe('recurring')
    expect(getCronjobScheduleType('0 9 1-5 6 *')).toBe('recurring')
    expect(getCronjobScheduleType('0 9 */2 6 *')).toBe('recurring')
  })

  it('supports six-field crons with seconds', () => {
    expect(getCronjobScheduleType('0 0 7 23 6 *')).toBe('fixedDate')
    expect(getCronjobScheduleType('0 0 7 * * 1')).toBe('recurring')
  })

  it('falls back to recurring for malformed input', () => {
    expect(getCronjobScheduleType('')).toBe('recurring')
    expect(getCronjobScheduleType('0 9')).toBe('recurring')
  })
})
