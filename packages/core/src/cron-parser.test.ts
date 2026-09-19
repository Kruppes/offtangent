import { describe, it, expect } from 'vitest'
import { parseCronExpression, validateCronExpression, getNextRunTime, cronToHumanReadable } from './cron-parser.js'

describe('parseCronExpression', () => {
  it('parses a simple daily cron', () => {
    const fields = parseCronExpression('0 9 * * *')
    expect(fields.minutes).toEqual([0])
    expect(fields.hours).toEqual([9])
    expect(fields.daysOfMonth).toHaveLength(31)
    expect(fields.months).toHaveLength(12)
    expect(fields.daysOfWeek).toHaveLength(7)
  })

  it('parses every 15 minutes', () => {
    const fields = parseCronExpression('*/15 * * * *')
    expect(fields.minutes).toEqual([0, 15, 30, 45])
    expect(fields.hours).toHaveLength(24)
  })

  it('parses weekday schedule', () => {
    const fields = parseCronExpression('30 14 * * 1-5')
    expect(fields.minutes).toEqual([30])
    expect(fields.hours).toEqual([14])
    expect(fields.daysOfWeek).toEqual([1, 2, 3, 4, 5])
  })

  it('parses comma-separated values', () => {
    const fields = parseCronExpression('0,30 9,18 * * *')
    expect(fields.minutes).toEqual([0, 30])
    expect(fields.hours).toEqual([9, 18])
  })

  it('parses first of month', () => {
    const fields = parseCronExpression('0 0 1 * *')
    expect(fields.daysOfMonth).toEqual([1])
    expect(fields.hours).toEqual([0])
    expect(fields.minutes).toEqual([0])
  })

  it('parses specific months', () => {
    const fields = parseCronExpression('0 0 1 1,6,12 *')
    expect(fields.months).toEqual([1, 6, 12])
  })

  it('parses range with step', () => {
    const fields = parseCronExpression('0-30/10 * * * *')
    expect(fields.minutes).toEqual([0, 10, 20, 30])
  })

  it('throws on invalid field count', () => {
    expect(() => parseCronExpression('0 9 *')).toThrow('expected 5 fields')
  })

  it('throws on invalid value', () => {
    expect(() => parseCronExpression('60 9 * * *')).toThrow('out of range')
  })

  it('throws on invalid characters', () => {
    expect(() => parseCronExpression('abc 9 * * *')).toThrow()
  })

  it('throws on invalid range', () => {
    expect(() => parseCronExpression('30-10 * * * *')).toThrow('Invalid range')
  })
})

describe('validateCronExpression', () => {
  it('returns null for valid expression', () => {
    expect(validateCronExpression('0 9 * * *')).toBeNull()
    expect(validateCronExpression('*/15 * * * *')).toBeNull()
    expect(validateCronExpression('30 14 * * 1-5')).toBeNull()
  })

  it('returns error message for invalid expression', () => {
    expect(validateCronExpression('invalid')).toContain('expected 5 fields')
    expect(validateCronExpression('60 9 * * *')).toContain('out of range')
  })
})

describe('getNextRunTime', () => {
  it('calculates next run for daily at 9:00', () => {
    const fields = parseCronExpression('0 9 * * *')
    const after = new Date('2026-03-29T08:00:00')
    const next = getNextRunTime(fields, after)

    expect(next).not.toBeNull()
    expect(next!.getHours()).toBe(9)
    expect(next!.getMinutes()).toBe(0)
    expect(next!.getDate()).toBe(29) // same day, 9:00 hasn't passed
  })

  it('rolls to next day if time has passed', () => {
    const fields = parseCronExpression('0 9 * * *')
    const after = new Date('2026-03-29T10:00:00')
    const next = getNextRunTime(fields, after)

    expect(next).not.toBeNull()
    expect(next!.getHours()).toBe(9)
    expect(next!.getDate()).toBe(30) // next day
  })

  it('calculates next run for every 15 minutes', () => {
    const fields = parseCronExpression('*/15 * * * *')
    const after = new Date('2026-03-29T10:07:00')
    const next = getNextRunTime(fields, after)

    expect(next).not.toBeNull()
    expect(next!.getMinutes()).toBe(15)
    expect(next!.getHours()).toBe(10)
  })

  it('respects day-of-week constraint', () => {
    const fields = parseCronExpression('0 9 * * 1') // Monday only
    // 2026-03-29 is a Sunday
    const after = new Date('2026-03-29T10:00:00')
    const next = getNextRunTime(fields, after)

    expect(next).not.toBeNull()
    expect(next!.getDay()).toBe(1) // Monday
    expect(next!.getDate()).toBe(30) // March 30, 2026 is Monday
  })

  it('returns a valid date within reasonable time', () => {
    const fields = parseCronExpression('0 0 1 1 *') // Jan 1st at midnight
    const after = new Date('2026-03-29T10:00:00')
    const next = getNextRunTime(fields, after)

    expect(next).not.toBeNull()
    expect(next!.getMonth()).toBe(0) // January
    expect(next!.getDate()).toBe(1)
    expect(next!.getFullYear()).toBe(2027)
  })
})

describe('cronToHumanReadable', () => {
  it('describes daily at 9:00', () => {
    const desc = cronToHumanReadable('0 9 * * *')
    expect(desc).toContain('09:00')
  })

  it('describes every 15 minutes', () => {
    const desc = cronToHumanReadable('*/15 * * * *')
    expect(desc).toContain('15')
    expect(desc).toContain('minute')
  })

  it('describes weekday schedule', () => {
    const desc = cronToHumanReadable('30 14 * * 1-5')
    expect(desc).toContain('14:30')
    expect(desc).toContain('Mon')
    expect(desc).toContain('Fri')
  })

  it('returns raw expression for invalid input', () => {
    expect(cronToHumanReadable('invalid stuff')).toBe('invalid stuff')
  })
})
