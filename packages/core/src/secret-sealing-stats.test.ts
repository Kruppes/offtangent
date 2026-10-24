/**
 * S0-A / A2: per-turn sealing counters through an AsyncLocalStorage scope.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  SEALING_HOT_ENTRY_THRESHOLD,
  SEALING_MAX_ENTRIES,
  createSealingScope,
  finishSealingScope,
  recordSealing,
  resetSealingStats,
  runInSealingScope,
  sealingStatsSnapshot,
} from './secret-sealing-stats.js'

beforeEach(() => resetSealingStats())

describe('sealing scope', () => {
  it('attributes async replacements to the scope that started them', async () => {
    const a = createSealingScope('agent=a')
    const b = createSealingScope('agent=b')
    await Promise.all([
      runInSealingScope(a, async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        recordSealing('{{secret:x}}', 2)
      }),
      runInSealingScope(b, async () => {
        recordSealing('{{secret:y}}')
      }),
    ])
    recordSealing('{{secret:z}}') // outside any scope
    expect(a.total).toBe(2)
    expect(b.total).toBe(1)
    expect(sealingStatsSnapshot().total).toBe(4)
  })

  it('returns null for a turn without replacements', () => {
    expect(finishSealingScope(createSealingScope('agent=idle'))).toBeNull()
  })

  it('logs handle and count, and flags a hot entry', () => {
    const scope = createSealingScope('agent=main session=s1')
    runInSealingScope(scope, () => {
      recordSealing('{{secret:vw-session-20}}', SEALING_HOT_ENTRY_THRESHOLD)
      recordSealing('redacted:env:1a2b3c4d')
    })
    const result = finishSealingScope(scope)
    expect(result?.hot).toBe(true)
    expect(result?.line).toContain(`replacements=${SEALING_HOT_ENTRY_THRESHOLD + 1}`)
    expect(result?.line).toContain(`{{secret:vw-session-20}}=${SEALING_HOT_ENTRY_THRESHOLD}`)
    expect(sealingStatsSnapshot().recentTurns[0]?.label).toBe('agent=main session=s1')
  })
})

describe('bounded counters (S0-A / A2 review)', () => {
  it('keeps at most SEALING_MAX_ENTRIES process entries, dropping the least recently counted', () => {
    expect(SEALING_MAX_ENTRIES).toBe(500)
    recordSealing('entry:keep', 7)
    for (let i = 0; i < SEALING_MAX_ENTRIES + 50; i++) {
      recordSealing(`entry:flood-${i}`)
      // Touching an entry makes it recent again: it survives the flood.
      if (i % 100 === 0) recordSealing('entry:keep')
    }
    const snapshot = sealingStatsSnapshot(10_000)
    expect(snapshot.entries).toHaveLength(SEALING_MAX_ENTRIES)
    expect(snapshot.total).toBe(7 + SEALING_MAX_ENTRIES + 50 + 6)
    const names = new Set(snapshot.entries.map(e => e.entry))
    expect(names.has('entry:keep')).toBe(true)
    expect(names.has('entry:flood-0')).toBe(false)
    expect(names.has(`entry:flood-${SEALING_MAX_ENTRIES + 49}`)).toBe(true)
  })

  it('bounds a turn scope the same way', () => {
    const scope = createSealingScope('agent=flood')
    runInSealingScope(scope, () => {
      for (let i = 0; i < SEALING_MAX_ENTRIES * 2; i++) recordSealing(`entry:s-${i}`)
    })
    expect(scope.counts.size).toBe(SEALING_MAX_ENTRIES)
    expect(scope.total).toBe(SEALING_MAX_ENTRIES * 2)
  })
})
