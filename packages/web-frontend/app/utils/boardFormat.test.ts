import { describe, expect, it } from 'vitest'
import { deltaClass, formatEur, formatPct, formatSignedEur, isExternalHttpUrl, plainSummary, relativeTimeKey } from './boardFormat'

describe('board formatting', () => {
  it('formats EUR and percentages in de-DE and marks the direction', () => {
    expect(formatEur(104320.5)).toBe('104.320,50\u00a0€')
    expect(formatEur(104320.5, true)).toBe('104.321\u00a0€')
    expect(formatSignedEur(1250.5)).toBe('+1.250,50\u00a0€')
    expect(formatSignedEur(-1250.5)).toBe('-1.250,50\u00a0€')
    expect(formatPct(1.21)).toBe('+1,21 %')
    expect(formatPct(1.21, false)).toBe('1,21 %')
    expect(formatEur(undefined)).toBe('—')
    expect(formatPct(Number.NaN)).toBe('—')
    expect(deltaClass(1)).toBe('text-gain')
    expect(deltaClass(-1)).toBe('text-loss')
    expect(deltaClass(0)).toBe('text-muted-foreground')
  })

  it('buckets relative update times and survives missing timestamps', () => {
    const now = new Date('2026-09-25T20:00:00Z')
    expect(relativeTimeKey('2026-09-25T19:59:30Z', now)).toEqual({ key: 'boards.updatedNow', count: 0 })
    expect(relativeTimeKey('2026-09-25T19:30:00Z', now)).toEqual({ key: 'boards.updatedMinutes', count: 30 })
    expect(relativeTimeKey('2026-09-25T15:00:00Z', now)).toEqual({ key: 'boards.updatedHours', count: 5 })
    expect(relativeTimeKey('2026-09-22T15:00:00Z', now)).toEqual({ key: 'boards.updatedDays', count: 3 })
    expect(relativeTimeKey(null, now).key).toBe('boards.updatedUnknown')
  })

  it('accepts only http(s) URLs as links', () => {
    expect(isExternalHttpUrl('https://news.example.com/a')).toBe(true)
    expect(isExternalHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isExternalHttpUrl('/local')).toBe(false)
    expect(isExternalHttpUrl(null)).toBe(false)
  })

  it('reduces a markdown summary to one plain line', () => {
    expect(plainSummary('Cheapest **thermal paste** is `19,99 €`\nat [Example](https://shop.example.com)')).toBe('Cheapest thermal paste is 19,99 € at Example')
    expect(plainSummary(null)).toBe('')
  })
})
