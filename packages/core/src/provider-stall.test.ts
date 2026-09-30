import { describe, it, expect, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  DEFAULT_STALL_ABORT_MS,
  DEFAULT_STALL_WARN_MS,
  PROVIDER_STALL_KIND,
  buildProviderStallMetadata,
  formatProviderStallContent,
  loadStallThresholds,
  parseProviderStallMetadata,
  queryStallStats,
} from './provider-stall.js'
import type { StallOutcome } from './agent-runtime-types.js'

describe('provider stall metadata', () => {
  it('round-trips an unresolved stall', () => {
    const metadata = buildProviderStallMetadata({ startedAt: '2026-01-01T00:00:00.000Z', durationMs: 30_000 })
    expect(metadata).toEqual({
      kind: PROVIDER_STALL_KIND,
      startedAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: null,
      durationMs: 30_000,
      outcome: null,
    })
    expect(parseProviderStallMetadata(JSON.stringify(metadata))).toEqual(metadata)
  })

  it('round-trips a resolved stall', () => {
    const metadata = buildProviderStallMetadata({
      messageId: 12,
      startedAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: '2026-01-01T00:00:42.000Z',
      durationMs: 42_000,
      outcome: 'recovered',
    })
    expect(parseProviderStallMetadata(JSON.stringify(metadata))).toEqual({
      kind: PROVIDER_STALL_KIND,
      startedAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: '2026-01-01T00:00:42.000Z',
      durationMs: 42_000,
      outcome: 'recovered',
    })
  })

  it('ignores metadata of other kinds and unparsable input', () => {
    expect(parseProviderStallMetadata(null)).toBeNull()
    expect(parseProviderStallMetadata('not json')).toBeNull()
    expect(parseProviderStallMetadata(JSON.stringify({ kind: 'thinking' }))).toBeNull()
  })

  it('drops an unknown outcome instead of trusting it', () => {
    const parsed = parseProviderStallMetadata(JSON.stringify({
      kind: PROVIDER_STALL_KIND,
      startedAt: '2026-01-01T00:00:00.000Z',
      outcome: 'exploded',
    }))
    expect(parsed?.outcome).toBeNull()
  })

  it('formats a distinct message per stall state', () => {
    const base = { startedAt: '2026-01-01T00:00:00.000Z', durationMs: 30_000 }
    expect(formatProviderStallContent(base)).toContain('has not responded for 30s')
    expect(formatProviderStallContent({ ...base, durationMs: 42_000, outcome: 'recovered' }))
      .toContain('recovered after 42s')
    expect(formatProviderStallContent({ ...base, durationMs: 90_000, outcome: 'aborted' }))
      .toContain('stopped responding')
  })
})

describe('queryStallStats', () => {
  let db: Database | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  function seed(): Database {
    db = initDatabase(':memory:')
    return db
  }

  function insertStall(
    testDb: Database,
    timestamp: string,
    durationMs: number,
    outcome: StallOutcome | null,
  ): void {
    const metadata = buildProviderStallMetadata({
      startedAt: timestamp,
      resolvedAt: outcome ? new Date(new Date(timestamp).getTime() + durationMs).toISOString() : undefined,
      durationMs,
      outcome: outcome ?? undefined,
    })
    testDb.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('stats-session', null, 'system', formatProviderStallContent({ startedAt: timestamp, durationMs, outcome: outcome ?? undefined }), JSON.stringify(metadata), timestamp)
  }

  function insertNoise(testDb: Database, timestamp: string): void {
    testDb.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('stats-session', null, 'assistant', 'hello', JSON.stringify({ kind: 'thinking' }), timestamp)
    testDb.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('stats-session', null, 'user', 'hi', null, timestamp)
  }

  it('counts stalls, averages durations and splits by outcome', () => {
    const testDb = seed()
    insertStall(testDb, '2026-04-10T10:00:00.000Z', 30_000, 'recovered')
    insertStall(testDb, '2026-04-10T11:00:00.000Z', 50_000, 'recovered')
    insertStall(testDb, '2026-04-11T09:00:00.000Z', 90_000, 'aborted')
    insertNoise(testDb, '2026-04-10T10:30:00.000Z')

    expect(queryStallStats(testDb)).toEqual({
      total: 3,
      recovered: 2,
      aborted: 1,
      unresolved: 0,
      averageDurationMs: 56_667,
      maxDurationMs: 90_000,
      averageRecoveredDurationMs: 40_000,
      averageAbortedDurationMs: 90_000,
    })
  })

  it('counts unresolved stalls but keeps them out of the averages', () => {
    const testDb = seed()
    insertStall(testDb, '2026-04-10T10:00:00.000Z', 40_000, 'recovered')
    insertStall(testDb, '2026-04-10T12:00:00.000Z', 30_000, null)

    const stats = queryStallStats(testDb)
    expect(stats.total).toBe(2)
    expect(stats.unresolved).toBe(1)
    expect(stats.averageDurationMs).toBe(40_000)
    expect(stats.maxDurationMs).toBe(40_000)
  })

  it('filters by period', () => {
    const testDb = seed()
    insertStall(testDb, '2026-04-09T23:00:00.000Z', 10_000, 'recovered')
    insertStall(testDb, '2026-04-10T10:00:00.000Z', 30_000, 'recovered')
    insertStall(testDb, '2026-04-11T10:00:00.000Z', 60_000, 'aborted')
    insertStall(testDb, '2026-04-12T10:00:00.000Z', 90_000, 'aborted')

    const stats = queryStallStats(testDb, {
      dateFrom: '2026-04-10T00:00:00.000Z',
      dateTo: '2026-04-11T23:59:59.999Z',
    })
    expect(stats.total).toBe(2)
    expect(stats.recovered).toBe(1)
    expect(stats.aborted).toBe(1)
    expect(stats.averageDurationMs).toBe(45_000)
  })

  it('returns zeroed stats for an empty period', () => {
    const testDb = seed()
    insertStall(testDb, '2026-04-10T10:00:00.000Z', 30_000, 'recovered')

    expect(queryStallStats(testDb, { dateFrom: '2026-05-01T00:00:00.000Z' })).toEqual({
      total: 0,
      recovered: 0,
      aborted: 0,
      unresolved: 0,
      averageDurationMs: 0,
      maxDurationMs: 0,
      averageRecoveredDurationMs: 0,
      averageAbortedDurationMs: 0,
    })
  })
})

describe('loadStallThresholds', () => {
  it('defaults to 30s warn / 90s abort when the settings file has no watchdog section', () => {
    expect(loadStallThresholds(() => ({}))).toEqual({
      warnMs: DEFAULT_STALL_WARN_MS,
      abortMs: DEFAULT_STALL_ABORT_MS,
    })
  })

  it('applies configured overrides', () => {
    expect(loadStallThresholds(() => ({ watchdog: { stallWarnMs: 5_000, stallAbortMs: 20_000 } }))).toEqual({
      warnMs: 5_000,
      abortMs: 20_000,
    })
  })

  it('falls back per field for invalid values and unreadable config', () => {
    expect(loadStallThresholds(() => ({ watchdog: { stallWarnMs: 0, stallAbortMs: 'soon' } }))).toEqual({
      warnMs: DEFAULT_STALL_WARN_MS,
      abortMs: DEFAULT_STALL_ABORT_MS,
    })
    expect(loadStallThresholds(() => { throw new Error('no config dir') })).toEqual({
      warnMs: DEFAULT_STALL_WARN_MS,
      abortMs: DEFAULT_STALL_ABORT_MS,
    })
  })
})
