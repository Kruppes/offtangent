import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { lastCompactionForStrand,
  lastTranscriptWindowForStrand, lastRequestUsageForStrand } from './strand-context-usage.js'

/**
 * Synthetic fixtures only: made-up session ids and token counts, no captured
 * production data.
 */
function freshDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0.0,
      session_id TEXT,
      kind TEXT NOT NULL DEFAULT 'request'
    );
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      session_id TEXT,
      tool_name TEXT NOT NULL,
      input TEXT,
      output TEXT,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'success'
    );
  `)
  return db
}

function addUsage(db: ReturnType<typeof freshDb>, row: {
  session: string; provider?: string; model?: string; prompt?: number
  completion?: number; cacheRead?: number; cacheWrite?: number; at?: string
  kind?: 'request' | 'voice_note'
}) {
  db.prepare(
    `INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, cache_read, cache_write, estimated_cost, session_id, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    row.at ?? '2026-09-24 10:00:00',
    row.provider ?? 'anthropic',
    row.model ?? 'claude-sonnet-5',
    row.prompt ?? 0,
    row.completion ?? 0,
    row.cacheRead ?? 0,
    row.cacheWrite ?? 0,
    row.session,
    row.kind ?? 'request',
  )
}

describe('lastRequestUsageForStrand', () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => { db = freshDb() })

  it('returns null when the strand never reached a provider (unknown, not zero)', () => {
    expect(lastRequestUsageForStrand(db, 'strand-empty')).toBeNull()
  })

  it('counts cache read and cache write as part of the assembled request', () => {
    addUsage(db, { session: 's1', prompt: 1_200, cacheRead: 98_000, cacheWrite: 3_400, completion: 700 })
    const usage = lastRequestUsageForStrand(db, 's1')!
    expect(usage.requestTokens).toBe(1_200 + 98_000 + 3_400)
    expect(usage.inputTokens).toBe(1_200)
    expect(usage.cacheReadTokens).toBe(98_000)
    expect(usage.cacheWriteTokens).toBe(3_400)
    expect(usage.outputTokens).toBe(700)
  })

  it('uses the LAST request, not the accumulated billing total', () => {
    addUsage(db, { session: 's1', prompt: 50_000, at: '2026-09-24 10:00:00' })
    addUsage(db, { session: 's1', prompt: 60_000, at: '2026-09-24 10:05:00' })
    addUsage(db, { session: 's1', prompt: 12_000, at: '2026-09-24 10:09:00' })
    const usage = lastRequestUsageForStrand(db, 's1')!
    expect(usage.requestTokens).toBe(12_000)
    expect(usage.measuredAt).toBe('2026-09-24T10:09:00Z')
  })

  it('is isolated per strand even though the runtime is shared per persona', () => {
    addUsage(db, { session: 'strand-a', prompt: 11_111, at: '2026-09-24 10:00:00' })
    addUsage(db, { session: 'strand-b', prompt: 77_777, at: '2026-09-24 10:01:00' })
    expect(lastRequestUsageForStrand(db, 'strand-a')!.requestTokens).toBe(11_111)
    expect(lastRequestUsageForStrand(db, 'strand-b')!.requestTokens).toBe(77_777)
    expect(lastRequestUsageForStrand(db, 'strand-c')).toBeNull()
  })

  it('reports the model the measurement was taken on', () => {
    addUsage(db, { session: 's1', model: 'kimi-k2.6', provider: 'kimi', prompt: 4_000 })
    const usage = lastRequestUsageForStrand(db, 's1')!
    expect(usage.measuredModelId).toBe('kimi-k2.6')
    expect(usage.measuredProviderId).toBe('kimi')
  })

  it('keeps an explicit zone on the timestamp and passes ISO timestamps through', () => {
    addUsage(db, { session: 's1', prompt: 10, at: '2026-09-24T10:09:00.500Z' })
    expect(lastRequestUsageForStrand(db, 's1')!.measuredAt).toBe('2026-09-24T10:09:00.500Z')
  })
})

describe('lastCompactionForStrand', () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => { db = freshDb() })

  function addStrandContextRow(session: string, input: unknown, at: string) {
    db.prepare(
      `INSERT INTO tool_calls (timestamp, session_id, tool_name, input, output, duration_ms, status)
       VALUES (?, ?, 'strand_context', ?, '{}', 0, 'success')`,
    ).run(at, session, JSON.stringify(input))
  }

  it('is null without any compaction', () => {
    expect(lastCompactionForStrand(db, 's1')).toBeNull()
  })

  it('ignores rows that only built the context block (trimmed = 0)', () => {
    addStrandContextRow('s1', { budgetTokens: 24_000, keptTokens: 9_000, trimmed: 0 }, '2026-09-24 09:00:00')
    expect(lastCompactionForStrand(db, 's1')).toBeNull()
  })

  it('returns the newest real trim', () => {
    addStrandContextRow('s1', { budgetTokens: 24_000, keptTokens: 21_000, trimmed: 4 }, '2026-09-24 09:00:00')
    addStrandContextRow('s1', { budgetTokens: 24_000, keptTokens: 22_500, trimmed: 7 }, '2026-09-24 09:30:00')
    addStrandContextRow('s1', { budgetTokens: 24_000, keptTokens: 23_000, trimmed: 0 }, '2026-09-24 09:45:00')
    const event = lastCompactionForStrand(db, 's1')!
    expect(event.droppedMessages).toBe(7)
    expect(event.keptTokens).toBe(22_500)
    expect(event.budgetTokens).toBe(24_000)
    expect(event.at).toBe('2026-09-24T09:30:00Z')
  })

  it('never reports another strand\'s compaction', () => {
    addStrandContextRow('other', { budgetTokens: 24_000, keptTokens: 20_000, trimmed: 9 }, '2026-09-24 09:30:00')
    expect(lastCompactionForStrand(db, 's1')).toBeNull()
  })

  it('survives a malformed metric row', () => {
    db.prepare(
      `INSERT INTO tool_calls (timestamp, session_id, tool_name, input, output, duration_ms, status)
       VALUES ('2026-09-24 09:40:00', 's1', 'strand_context', 'not json', '{}', 0, 'success')`,
    ).run()
    addStrandContextRow('s1', { budgetTokens: 24_000, keptTokens: 22_000, trimmed: 3 }, '2026-09-24 09:30:00')
    expect(lastCompactionForStrand(db, 's1')!.droppedMessages).toBe(3)
  })
})

/**
 * The transcript window is the ONLY quantity the runtime's trim trigger is
 * applied to (`AgentCore.prepareStrandContext` trims `runtime.getMessages()`
 * against `heuristics.strand.windowTokens`). These tests pin that it stays
 * separate from the measured request total.
 */
describe('lastTranscriptWindowForStrand', () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => { db = freshDb() })

  function addStrandContextRow(session: string, input: unknown, at: string) {
    db.prepare(
      `INSERT INTO tool_calls (timestamp, session_id, tool_name, input, output, duration_ms, status)
       VALUES (?, ?, 'strand_context', ?, '{}', 0, 'success')`,
    ).run(at, session, JSON.stringify(input))
  }

  it('is unknown while the strand never wrote a metric row', () => {
    expect(lastTranscriptWindowForStrand(db, 's1')).toBeNull()
  })

  it('reports kept estimate and budget of the newest row, trimmed or not', () => {
    addStrandContextRow('s1', { budgetTokens: 24_000, keptTokens: 21_000, trimmed: 4 }, '2026-09-24 09:00:00')
    addStrandContextRow('s1', { budgetTokens: 24_000, keptTokens: 6_200, trimmed: 0 }, '2026-09-24 09:30:00')
    const window = lastTranscriptWindowForStrand(db, 's1')!
    expect(window.estimatedTokens).toBe(6_200)
    expect(window.budgetTokens).toBe(24_000)
    expect(window.at).toBe('2026-09-24T09:30:00Z')
  })

  it('never reports another strand\'s transcript window', () => {
    addStrandContextRow('other', { budgetTokens: 24_000, keptTokens: 20_000, trimmed: 0 }, '2026-09-24 09:30:00')
    expect(lastTranscriptWindowForStrand(db, 's1')).toBeNull()
  })

  it('skips rows without usable numbers instead of inventing them', () => {
    db.prepare(
      `INSERT INTO tool_calls (timestamp, session_id, tool_name, input, output, duration_ms, status)
       VALUES ('2026-09-24 09:40:00', 's1', 'strand_context', 'not json', '{}', 0, 'success')`,
    ).run()
    addStrandContextRow('s1', { budgetTokens: 0, keptTokens: 5, trimmed: 0 }, '2026-09-24 09:35:00')
    addStrandContextRow('s1', { budgetTokens: 24_000, keptTokens: 12_000, trimmed: 0 }, '2026-09-24 09:30:00')
    expect(lastTranscriptWindowForStrand(db, 's1')!.estimatedTokens).toBe(12_000)
  })

  it('stays independent of the measured request total (big prompt, short talk)', () => {
    db.prepare(
      `INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, cache_read, cache_write, estimated_cost, session_id)
       VALUES ('2026-09-24 11:00:00', 'anthropic', 'm', 4000, 300, 176000, 0, 0, 's1')`,
    ).run()
    addStrandContextRow('s1', { budgetTokens: 24_000, keptTokens: 6_200, trimmed: 0 }, '2026-09-24 11:00:00')
    expect(lastRequestUsageForStrand(db, 's1')!.requestTokens).toBe(180_000)
    expect(lastTranscriptWindowForStrand(db, 's1')!.estimatedTokens).toBe(6_200)
  })
})

describe('non-request usage rows (voice notes)', () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => { db = freshDb() })

  it('never reports a text-to-speech estimate as the last model request', () => {
    addUsage(db, { session: 's1', provider: 'anthropic', model: 'claude-sonnet-5', prompt: 4_000, cacheRead: 120_000, at: '2026-09-24 10:00:00' })
    // A voice note rendered afterwards books on the same session with locally
    // estimated counts — it is an audio render, not a conversation request.
    addUsage(db, { session: 's1', provider: 'gemini', model: 'tts-1', prompt: 320, completion: 0, kind: 'voice_note', at: '2026-09-24 10:05:00' })
    const usage = lastRequestUsageForStrand(db, 's1')!
    expect(usage.requestTokens).toBe(124_000)
    expect(usage.measuredProviderId).toBe('anthropic')
    expect(usage.measuredModelId).toBe('claude-sonnet-5')
  })

  it('reports no measurement at all when a strand only ever rendered audio', () => {
    addUsage(db, { session: 's2', provider: 'gemini', model: 'tts-1', prompt: 500, kind: 'voice_note' })
    expect(lastRequestUsageForStrand(db, 's2')).toBeNull()
  })
})

describe('trim state of the transcript window', () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => { db = freshDb() })

  it('carries how many messages the measured turn dropped', () => {
    db.prepare(
      `INSERT INTO tool_calls (timestamp, session_id, tool_name, input, output, duration_ms, status)
       VALUES ('2026-09-24 12:00:00', 's1', 'strand_context', ?, '{}', 0, 'success')`,
    ).run(JSON.stringify({ budgetTokens: 24_000, keptTokens: 23_100, trimmed: 6 }))
    const window = lastTranscriptWindowForStrand(db, 's1')!
    expect(window.trimmedMessages).toBe(6)
    expect(window.estimatedTokens).toBe(23_100)
  })

  it('defaults the trim count to zero when the metric row predates the field', () => {
    db.prepare(
      `INSERT INTO tool_calls (timestamp, session_id, tool_name, input, output, duration_ms, status)
       VALUES ('2026-09-24 12:00:00', 's1', 'strand_context', ?, '{}', 0, 'success')`,
    ).run(JSON.stringify({ budgetTokens: 24_000, keptTokens: 9_000 }))
    expect(lastTranscriptWindowForStrand(db, 's1')!.trimmedMessages).toBe(0)
  })

  it('still finds a compaction that happened long before the newest turns', () => {
    db.prepare(
      `INSERT INTO tool_calls (timestamp, session_id, tool_name, input, output, duration_ms, status)
       VALUES ('2026-09-20 08:00:00', 's1', 'strand_context', ?, '{}', 0, 'success')`,
    ).run(JSON.stringify({ budgetTokens: 24_000, keptTokens: 21_000, trimmed: 9 }))
    for (let i = 0; i < 60; i++) {
      db.prepare(
        `INSERT INTO tool_calls (timestamp, session_id, tool_name, input, output, duration_ms, status)
         VALUES ('2026-09-24 09:00:00', 's1', 'strand_context', ?, '{}', 0, 'success')`,
      ).run(JSON.stringify({ budgetTokens: 24_000, keptTokens: 1_000 + i, trimmed: 0 }))
    }
    const compaction = lastCompactionForStrand(db, 's1')!
    expect(compaction.droppedMessages).toBe(9)
    expect(compaction.at).toBe('2026-09-20T08:00:00Z')
  })
})
