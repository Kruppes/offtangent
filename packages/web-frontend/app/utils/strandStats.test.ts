import { describe, expect, it } from 'vitest'
import { STRAND_STATS_PATH, compactNumber, formatDuration, formatUsd, isStrandStats, percent, shortModel, sparkPoints } from './strandStats'

describe('strandStats utils', () => {
  it('builds the stats path with includes', () => {
    expect(STRAND_STATS_PATH('a b')).toBe('/api/strands/a%20b/stats?include=tasks,series')
    expect(STRAND_STATS_PATH('x', [])).toBe('/api/strands/x/stats')
  })

  it('formats numbers, durations, money and ratios', () => {
    expect(compactNumber(999)).toBe('999')
    expect(compactNumber(1234)).toBe('1.2k')
    expect(compactNumber(15000)).toBe('15k')
    expect(compactNumber(2_500_000)).toBe('2.5M')
    expect(compactNumber(null)).toBe('–')
    expect(formatDuration(42)).toBe('42 s')
    expect(formatDuration(420)).toBe('7 min')
    expect(formatDuration(13564)).toBe('3 h 46 min')
    expect(formatDuration(7200)).toBe('2 h')
    expect(formatDuration(null)).toBe('–')
    expect(formatUsd(3, 'en')).toBe('$3.00')
    expect(formatUsd(71.6, 'en')).toBe('$72')
    expect(percent(1 / 3)).toBe('33 %')
    expect(percent(null)).toBe('–')
  })

  it('shortens model ids', () => {
    expect(shortModel('anthropic/claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(shortModel(null)).toBe('–')
  })

  it('recognises the schema', () => {
    expect(isStrandStats({ schema: 'strand_stats.v1' })).toBe(true)
    expect(isStrandStats({ schema: 'strand_stats.v2' })).toBe(false)
    expect(isStrandStats(null)).toBe(false)
  })

  it('draws sparkline points inside the box', () => {
    expect(sparkPoints([], 100, 20)).toBe('')
    expect(sparkPoints([0, 10], 100, 20)).toBe('0.0,19.0 100.0,1.0')
  })
})
