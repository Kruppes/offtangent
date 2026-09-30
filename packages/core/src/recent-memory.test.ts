import { describe, it, expect, vi } from 'vitest'
import { budgetRecentMemory, DAILY_SEPARATOR } from './recent-memory.js'
import type { DailyMemoryEntry } from './recent-memory.js'

function entry(date: string, chars: number, marker = 'x'): DailyMemoryEntry {
  return {
    date,
    path: `/data/memory/daily/${date}.md`,
    content: `${date}-START\n${marker.repeat(Math.max(0, chars - 30))}\n${date}-END`,
  }
}

const DAILY_DIR = '/data/memory/daily'

describe('budgetRecentMemory', () => {
  it('returns the plain join when everything fits (byte-identical to the unbudgeted path)', () => {
    const entries = [entry('2026-09-17', 500, 'a'), entry('2026-09-16', 400, 'b')]

    const result = budgetRecentMemory(entries, { maxChars: 8000, dailyDir: DAILY_DIR })

    expect(result.truncated).toBe(false)
    expect(result.droppedChars).toBe(0)
    expect(result.droppedFiles).toBe(0)
    expect(result.text).toBe(entries.map(e => e.content).join(DAILY_SEPARATOR))
    expect(result.text).not.toContain('[truncated')
    expect(result.text).not.toContain('[omitted')
  })

  it('returns an empty block for no daily content', () => {
    const result = budgetRecentMemory([], { maxChars: 8000, dailyDir: DAILY_DIR })
    expect(result.text).toBe('')
    expect(result.rawChars).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('keeps the newest day in full and drops the oldest first', () => {
    const entries = [entry('2026-09-17', 3000, 'a'), entry('2026-09-16', 3000, 'b'), entry('2026-09-15', 3000, 'c')]

    const result = budgetRecentMemory(entries, { maxChars: 4000, dailyDir: DAILY_DIR })

    expect(result.truncated).toBe(true)
    expect(result.text).toContain('2026-09-17-START')
    expect(result.text).toContain('2026-09-17-END')
    // The oldest day is gone entirely and named in the omission marker.
    expect(result.text).not.toContain('2026-09-15-END')
    expect(result.text).toContain('[omitted:')
    expect(result.text).toContain('2026-09-15')
    expect(result.text).toContain(DAILY_DIR)
    expect(result.droppedFiles).toBeGreaterThanOrEqual(1)
  })

  it('stays inside the budget', () => {
    const entries = [entry('2026-09-17', 40000, 'a'), entry('2026-09-16', 40000, 'b')]

    const result = budgetRecentMemory(entries, { maxChars: 8000, dailyDir: DAILY_DIR })

    expect(result.text.length).toBeLessThanOrEqual(8000)
    expect(result.rawChars).toBe(entries[0].content.length + entries[1].content.length + DAILY_SEPARATOR.length)
    expect(result.droppedChars).toBeGreaterThan(60000)
  })

  it('cuts a partially kept day at the front and names the file in the marker', () => {
    const entries = [entry('2026-09-17', 2000, 'a'), entry('2026-09-16', 20000, 'b')]

    const result = budgetRecentMemory(entries, { maxChars: 8000, dailyDir: DAILY_DIR })

    // Newest day survives whole...
    expect(result.text).toContain('2026-09-17-START')
    // ...the older one keeps its END (newest notes of that day) and says so.
    expect(result.text).toContain('2026-09-16-END')
    expect(result.text).not.toContain('2026-09-16-START')
    expect(result.text).toMatch(/\[truncated: \d+ older chars of this day — read \/data\/memory\/daily\/2026-09-16\.md for the full notes\]/)
  })

  it('warns when the raw size exceeds the budget by the warn factor', () => {
    const warn = vi.fn()
    budgetRecentMemory([entry('2026-09-17', 50000, 'a')], {
      maxChars: 8000,
      dailyDir: DAILY_DIR,
      warnFactor: 3,
      logger: { warn },
    })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('consolidation is likely not running')
  })

  it('does not warn below the warn factor and never warns when it is 0', () => {
    const warn = vi.fn()
    budgetRecentMemory([entry('2026-09-17', 16000, 'a')], {
      maxChars: 8000, dailyDir: DAILY_DIR, warnFactor: 3, logger: { warn },
    })
    expect(warn).not.toHaveBeenCalled()

    budgetRecentMemory([entry('2026-09-17', 50000, 'a')], {
      maxChars: 8000, dailyDir: DAILY_DIR, warnFactor: 0, logger: { warn },
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('treats a non-positive budget as "no budget"', () => {
    const entries = [entry('2026-09-17', 50000, 'a')]
    const result = budgetRecentMemory(entries, { maxChars: 0, dailyDir: DAILY_DIR })
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(entries[0].content)
  })
})
