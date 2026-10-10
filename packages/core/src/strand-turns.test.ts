import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { logTokenUsage, logToolCall } from './token-logger.js'
import {
  ensureStrandStatsSchema,
  recordStrandTurnStart,
  recordStrandTurnFirstToken,
  recordStrandTurnEnd,
  activeStrandTurnId,
  billingForProvider,
  billingMapping,
  configureBillingMapping,
  clearActiveStrandTurn,
  closeOrphanedStrandTurns,
  IS_INTERNAL_BACKFILL_KEY,
} from './strand-turns.js'

describe('strand-turns', () => {
  const tmpFiles: string[] = []
  let db: Database | null = null

  afterEach(() => {
    try { db?.close() } catch { /* ignore */ }
    db = null
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(f + suffix) } catch { /* ignore */ }
      }
    }
    tmpFiles.length = 0
    configureBillingMapping(null)
    delete process.env.OFFTANGENT_BILLING_MAP
  })

  function createDb(): Database {
    const p = path.join(os.tmpdir(), `axiom-strand-turns-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
    return db
  }

  it('migration adds the table and nullable columns, idempotently', () => {
    const d = createDb()
    ensureStrandStatsSchema(d)
    ensureStrandStatsSchema(d)
    const cols = (t: string) => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name)
    expect(cols('strand_turns')).toEqual(expect.arrayContaining(['id', 'session_id', 'agent_id', 'trigger', 'input_mode', 'started_at', 'first_token_at', 'ended_at', 'status']))
    expect(cols('token_usage')).toEqual(expect.arrayContaining(['turn_id', 'billing', 'agent_id', 'context_window', 'error']))
    expect(cols('tool_calls')).toEqual(expect.arrayContaining(['turn_id', 'is_internal']))
    expect(cols('persona_delegations')).toContain('origin_session_id')
  })

  it('backfills is_internal once on an old database and keeps old rows readable', () => {
    const p = path.join(os.tmpdir(), `axiom-strand-turns-old-${Date.now()}.db`)
    tmpFiles.push(p)
    const raw = new BetterSqlite3(p)
    raw.exec(`
      CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT NOT NULL, session_id TEXT);
      CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tool_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'success');
      CREATE TABLE persona_delegations (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT);
      INSERT INTO token_usage (provider, model, session_id) VALUES ('anthropic', 'm', 's1');
      INSERT INTO tool_calls (session_id, tool_name) VALUES ('s1', 'shell'), ('s1', 'internal_metric');
    `)
    ensureStrandStatsSchema(raw as unknown as Database, ['internal_metric'])
    const rows = raw.prepare('SELECT tool_name, is_internal, turn_id FROM tool_calls ORDER BY id').all()
    expect(rows).toEqual([
      { tool_name: 'shell', is_internal: 0, turn_id: null },
      { tool_name: 'internal_metric', is_internal: 1, turn_id: null },
    ])
    const tu = raw.prepare('SELECT billing, turn_id FROM token_usage').get()
    expect(tu).toEqual({ billing: null, turn_id: null })
    raw.close()
  })

  function oldDb(): BetterSqlite3.Database {
    const p = path.join(os.tmpdir(), `axiom-strand-turns-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    const raw = new BetterSqlite3(p)
    raw.exec(`
      CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT NOT NULL, session_id TEXT);
      CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tool_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'success');
      CREATE TABLE persona_delegations (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT);
      INSERT INTO tool_calls (session_id, tool_name) VALUES ('s1', 'shell'), ('s1', 'internal_metric');
    `)
    return raw
  }

  it('M2: a migration interrupted after ALTER (column present, no backfill) is backfilled on the next start', () => {
    const raw = oldDb()
    // State a crash between the two old steps left behind: column added with
    // DEFAULT 0, backfill never ran, no marker.
    raw.exec('ALTER TABLE tool_calls ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0')
    ensureStrandStatsSchema(raw as unknown as Database, ['internal_metric'])
    expect(raw.prepare('SELECT tool_name, is_internal FROM tool_calls ORDER BY id').all()).toEqual([
      { tool_name: 'shell', is_internal: 0 },
      { tool_name: 'internal_metric', is_internal: 1 },
    ])
    expect(raw.prepare('SELECT key FROM strand_stats_migrations').all()).toEqual([{ key: IS_INTERNAL_BACKFILL_KEY }])
    // Second boot: marker present, nothing re-runs (a row written as 0 later stays 0).
    raw.exec("INSERT INTO tool_calls (session_id, tool_name, is_internal) VALUES ('s1', 'internal_metric', 0)")
    ensureStrandStatsSchema(raw as unknown as Database, ['internal_metric'])
    expect((raw.prepare('SELECT is_internal FROM tool_calls ORDER BY id DESC LIMIT 1').get() as { is_internal: number }).is_internal).toBe(0)
    raw.close()
  })

  it('M2: ALTER and backfill are atomic, a failing backfill leaves neither column nor marker, the rerun completes', () => {
    const raw = oldDb()
    raw.exec("CREATE TRIGGER fail_backfill BEFORE UPDATE ON tool_calls BEGIN SELECT RAISE(ABORT, 'simulated crash'); END")
    expect(() => ensureStrandStatsSchema(raw as unknown as Database, ['internal_metric'])).toThrow(/simulated crash/)
    const cols = (raw.prepare('PRAGMA table_info(tool_calls)').all() as { name: string }[]).map(c => c.name)
    expect(cols).not.toContain('is_internal')
    expect(raw.prepare('SELECT count(*) n FROM strand_stats_migrations').get()).toEqual({ n: 0 })
    raw.exec('DROP TRIGGER fail_backfill')
    ensureStrandStatsSchema(raw as unknown as Database, ['internal_metric'])
    expect(raw.prepare('SELECT tool_name, is_internal FROM tool_calls ORDER BY id').all()).toEqual([
      { tool_name: 'shell', is_internal: 0 },
      { tool_name: 'internal_metric', is_internal: 1 },
    ])
    raw.close()
  })

  it('M1: a turn left running by a dead process is closed as interrupted at its last activity on restart', () => {
    const p = path.join(os.tmpdir(), `axiom-strand-turns-restart-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    let d = initDatabase(p)
    recordStrandTurnStart(d, { id: 'orphan', sessionId: 's9', startedAt: '2026-10-10T10:00:00.000Z' })
    d.prepare("INSERT INTO token_usage (provider, model, session_id, turn_id, timestamp) VALUES ('anthropic', 'm', 's9', 'orphan', '2026-10-10 10:00:20')").run()
    d.prepare("INSERT INTO tool_calls (session_id, tool_name, turn_id, timestamp) VALUES ('s9', 'shell', 'orphan', '2026-10-10T10:00:42.000Z')").run()
    d.prepare("INSERT INTO chat_messages (session_id, role, content, timestamp) VALUES ('s9', 'assistant', 'x', '2026-10-10 10:00:35')").run()
    // A turn of the CURRENT process must survive a second initDatabase.
    recordStrandTurnStart(d, { id: 'live', sessionId: 's10', startedAt: '2026-10-10T10:00:00.000Z' })
    clearActiveStrandTurn('s9', 'orphan') // the process that ran it is gone
    d.close()
    d = initDatabase(p) // restart
    db = d
    expect(d.prepare("SELECT status, ended_at FROM strand_turns WHERE id = 'orphan'").get())
      .toEqual({ status: 'interrupted', ended_at: '2026-10-10T10:00:42.000Z' })
    expect(d.prepare("SELECT status, ended_at FROM strand_turns WHERE id = 'live'").get()).toEqual({ status: 'running', ended_at: null })
    // Idempotent: a later restart does not move the end.
    expect(closeOrphanedStrandTurns(d)).toBe(0)
    expect((d.prepare("SELECT ended_at FROM strand_turns WHERE id = 'orphan'").get() as { ended_at: string }).ended_at).toBe('2026-10-10T10:00:42.000Z')
    clearActiveStrandTurn('s10', 'live')
  })

  it('M1: an orphan without any activity ends at its start', () => {
    const d = createDb()
    recordStrandTurnStart(d, { id: 'bare', sessionId: 's11', startedAt: '2026-10-10T09:00:00.000Z' })
    clearActiveStrandTurn('s11', 'bare')
    expect(closeOrphanedStrandTurns(d)).toBe(1)
    expect(d.prepare("SELECT status, ended_at FROM strand_turns WHERE id = 'bare'").get()).toEqual({ status: 'interrupted', ended_at: '2026-10-10T09:00:00.000Z' })
  })

  it('records the turn lifecycle and tags usage + tool rows with the active turn', () => {
    const d = createDb()
    recordStrandTurnStart(d, { id: 't1', sessionId: 's1', agentId: 'main', trigger: 'user', inputMode: 'voice', startedAt: '2026-10-10T10:00:00.000Z' })
    expect(activeStrandTurnId('s1')).toBe('t1')
    recordStrandTurnFirstToken(d, 't1', '2026-10-10T10:00:03.000Z')
    recordStrandTurnFirstToken(d, 't1', '2026-10-10T10:00:09.000Z')
    logTokenUsage(d, { provider: 'anthropic', model: 'm', promptTokens: 10, completionTokens: 5, cacheRead: 0, cacheWrite: 0, estimatedCost: 0.1, sessionId: 's1', agentId: 'main', contextWindow: 200000 })
    logToolCall(d, { sessionId: 's1', toolName: 'shell', input: '{}', output: '{}', durationMs: 5, status: 'error' })
    logTokenUsage(d, { provider: 'anthropic', model: 'm', promptTokens: 1, completionTokens: 1, cacheRead: 0, cacheWrite: 0, estimatedCost: 0, sessionId: 'other' })
    recordStrandTurnEnd(d, 't1', 's1', 'completed', '2026-10-10T10:01:00.000Z')
    expect(activeStrandTurnId('s1')).toBeNull()

    const turn = d.prepare('SELECT * FROM strand_turns WHERE id = ?').get('t1') as Record<string, unknown>
    expect(turn).toMatchObject({ session_id: 's1', trigger: 'user', input_mode: 'voice', first_token_at: '2026-10-10T10:00:03.000Z', ended_at: '2026-10-10T10:01:00.000Z', status: 'completed' })
    const usage = d.prepare('SELECT session_id, turn_id, billing, agent_id, context_window FROM token_usage ORDER BY id').all()
    expect(usage).toEqual([
      { session_id: 's1', turn_id: 't1', billing: 'subscription', agent_id: 'main', context_window: 200000 },
      { session_id: 'other', turn_id: null, billing: 'subscription', agent_id: null, context_window: null },
    ])
    const tool = d.prepare('SELECT turn_id, status, is_internal FROM tool_calls').get()
    expect(tool).toEqual({ turn_id: 't1', status: 'error', is_internal: 0 })
  })

  it('a second end call does not overwrite the first', () => {
    const d = createDb()
    recordStrandTurnStart(d, { id: 't2', sessionId: 's2' })
    recordStrandTurnEnd(d, 't2', 's2', 'failed', '2026-10-10T10:00:00.000Z')
    recordStrandTurnEnd(d, 't2', 's2', 'completed', '2026-10-10T11:00:00.000Z')
    expect(d.prepare('SELECT status, ended_at FROM strand_turns WHERE id = ?').get('t2')).toEqual({ status: 'failed', ended_at: '2026-10-10T10:00:00.000Z' })
  })

  it('writers never throw without a database', () => {
    expect(() => recordStrandTurnStart(null, { id: 'x', sessionId: 'y' })).not.toThrow()
    expect(() => recordStrandTurnFirstToken(undefined, 'x')).not.toThrow()
    expect(() => recordStrandTurnEnd(null, 'x', 'y', 'completed')).not.toThrow()
  })

  describe('billing mapping', () => {
    it('defaults: subscription, local, unknown → metered', () => {
      expect(billingForProvider('anthropic')).toBe('subscription')
      expect(billingForProvider('ollama')).toBe('local')
      expect(billingForProvider('some-new-provider')).toBe('metered')
      expect(billingForProvider(null)).toBe('metered')
    })

    it('is configurable via env and overrides, not hard-wired', () => {
      process.env.OFFTANGENT_BILLING_MAP = JSON.stringify({ 'my-gpu-box': 'local', anthropic: 'metered', bad: 'nope' })
      expect(billingForProvider('my-gpu-box')).toBe('local')
      expect(billingForProvider('anthropic')).toBe('metered')
      expect(billingMapping().bad).toBeUndefined()
      configureBillingMapping({ anthropic: 'subscription' })
      expect(billingForProvider('anthropic')).toBe('subscription')
    })

    it('ignores an invalid env value', () => {
      process.env.OFFTANGENT_BILLING_MAP = '{not json'
      expect(billingForProvider('anthropic')).toBe('subscription')
    })
  })
})
