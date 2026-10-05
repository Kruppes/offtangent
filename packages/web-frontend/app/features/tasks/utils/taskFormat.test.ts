import { describe, expect, it } from 'vitest'
import { cacheHitRate, cacheSummary, cachedInputPercent, formatCachePercent, formatTaskDuration, taskDisplayStatus, taskStatusVariant } from './taskFormat'

/**
 * Task timestamps arrive in two shapes: SQLite's naked `2026-09-15 06:15:53`
 * (UTC, no marker) and ISO-8601 with `Z`. Both have to produce the same
 * duration; the old parser appended a second `Z` to the ISO form and returned
 * NaN.
 */
describe('formatTaskDuration', () => {
  it('handles naked SQLite timestamps', () => {
    expect(formatTaskDuration({
      startedAt: '2026-09-15 06:15:53',
      completedAt: '2026-09-15 06:17:23',
    })).toBe('1m 30s')
  })

  it('handles ISO-8601 timestamps with an explicit UTC marker', () => {
    expect(formatTaskDuration({
      startedAt: '2026-09-15T06:15:53.000Z',
      completedAt: '2026-09-15T06:17:23.000Z',
    })).toBe('1m 30s')
  })

  it('reads both shapes as the same instant', () => {
    const naked = formatTaskDuration({ startedAt: '2026-09-15 06:15:53', completedAt: '2026-09-15 06:15:58' })
    const iso = formatTaskDuration({ startedAt: '2026-09-15T06:15:53.000Z', completedAt: '2026-09-15T06:15:58.000Z' })
    expect(iso).toBe(naked)
    expect(naked).toBe('5s')
  })

  it('shows a dash instead of NaN for an unparseable value', () => {
    expect(formatTaskDuration({ startedAt: 'kaputt', completedAt: null })).toBe('—')
    expect(formatTaskDuration({ startedAt: '2026-09-15 06:15:53', completedAt: 'kaputt' })).toBe('—')
    expect(formatTaskDuration({ startedAt: null, completedAt: null })).toBe('—')
  })
})

/**
 * A task waiting for a free concurrency slot is stored as `running` without a
 * start time (no extra status, so existing clients keep working). The list must
 * not claim such a task is working.
 */
describe('taskDisplayStatus', () => {
  it('maps running without a start time to queued', () => {
    expect(taskDisplayStatus({ status: 'running', startedAt: null })).toBe('queued')
  })

  it('keeps running once the task really started', () => {
    expect(taskDisplayStatus({ status: 'running', startedAt: '2026-09-26 10:00:00' })).toBe('running')
  })

  it('leaves every other status untouched', () => {
    expect(taskDisplayStatus({ status: 'paused', startedAt: null })).toBe('paused')
    expect(taskDisplayStatus({ status: 'completed', startedAt: '2026-09-26 10:00:00' })).toBe('completed')
    expect(taskDisplayStatus({ status: 'failed', startedAt: null })).toBe('failed')
  })

  it('has its own badge variant', () => {
    expect(taskStatusVariant('queued')).toBe('muted')
    expect(taskStatusVariant('running')).toBe('default')
  })
})

// Cached-input share. Usage numbers are pi-ai normalized: `promptTokens` is the
// uncached input, `cacheRead` / `cacheWrite` are reported next to it.
describe('cachedInputPercent', () => {
  it('is cacheRead over the full input (uncached + read + write), not over output', () => {
    // 5 %: 50 of 1000 input tokens came from the cache; output does not count.
    expect(cachedInputPercent({ promptTokens: 900, cacheRead: 50, cacheWrite: 50 })).toBeCloseTo(5, 10)
    expect(formatCachePercent(cachedInputPercent({ promptTokens: 900, cacheRead: 50, cacheWrite: 50 }))).toBe('5.0%')
  })

  it('reports a real 0 % when input was recorded but nothing was read from the cache', () => {
    expect(cachedInputPercent({ promptTokens: 1200, cacheRead: 0, cacheWrite: 0 })).toBe(0)
    expect(formatCachePercent(0)).toBe('0.0%')
  })

  it('reports 100 % when the whole input was a cache read', () => {
    expect(cachedInputPercent({ promptTokens: 0, cacheRead: 4096, cacheWrite: 0 })).toBe(100)
  })

  it('never counts a cache write as a hit', () => {
    expect(cachedInputPercent({ promptTokens: 0, cacheRead: 0, cacheWrite: 8000 })).toBe(0)
    expect(cachedInputPercent({ promptTokens: 100, cacheRead: 100, cacheWrite: 800 })).toBeCloseTo(10, 10)
  })

  it('is unknown (dash, not 0) without usage or with missing, negative or non-finite fields', () => {
    expect(cachedInputPercent({ promptTokens: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(cachedInputPercent({})).toBeNull()
    expect(cachedInputPercent({ promptTokens: 10, cacheRead: undefined, cacheWrite: 0 })).toBeNull()
    expect(cachedInputPercent({ promptTokens: 10, cacheRead: null, cacheWrite: 0 })).toBeNull()
    expect(cachedInputPercent({ promptTokens: -5, cacheRead: 10, cacheWrite: 0 })).toBeNull()
    expect(cachedInputPercent({ promptTokens: 10, cacheRead: Number.NaN, cacheWrite: 0 })).toBeNull()
    expect(cachedInputPercent({ promptTokens: 10, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 0 })).toBeNull()
    expect(formatCachePercent(null)).toBe('—')
    expect(cacheSummary({ promptTokens: 0, cacheRead: 0, cacheWrite: 0 })).toBe('CH —')
  })

  it('keeps cacheHitRate as the same formula for existing callers', () => {
    const task = { promptTokens: 78, cacheRead: 1308532, cacheWrite: 55092 }
    expect(cacheHitRate(task)).toBe(cachedInputPercent(task))
    expect(cacheSummary(task)).toBe(`CH ${((1308532 / (78 + 1308532 + 55092)) * 100).toFixed(1)}%`)
  })
})
