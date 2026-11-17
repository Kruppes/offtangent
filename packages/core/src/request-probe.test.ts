import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type Database } from './database.js'
import { logTokenUsage } from './token-logger.js'
import { SYSTEM_PROMPT_CACHE_MARKER } from './prompt-cache.js'
import { stripStrandContextFromLastUserMessage, trimMessagesToBudget } from './strand-context.js'
import {
  RequestProbeRecorder,
  pruneRequestProbes,
  requestProbeErrorCount,
  requestProbeDroppedCount,
  resetRequestProbeCounters,
  resolveRequestProbeSettings,
  type RequestProbeHint,
  type RequestProbeSettings,
} from './request-probe.js'

const ON: RequestProbeSettings = { enabled: true, retentionDays: 60 }
const OFF: RequestProbeSettings = { enabled: false, retentionDays: 60 }

const PRE = 'Stable persona prefix GEHEIM-PRE-7781 with enough words to pass the minimum length for a checksum.'
const POST = 'Volatile tail GEHEIM-POST-4410 with memory and time, also long enough for a checksum of its own.'
const TOOLS = [
  { name: 'tool_geheim_alpha', description: 'GEHEIM-TOOL-DESC reads a thing', parameters: { type: 'object', properties: { pfad: { type: 'string' } } } },
  { name: 'tool_geheim_beta', description: 'writes another thing', parameters: { type: 'object', properties: {} } },
]

function user(text: string) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 }
}
function assistant(text: string) {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 }
}

function ctx(opts: { pre?: string; post?: string; tools?: unknown[]; messages: unknown[] }) {
  return {
    systemPrompt: `${opts.pre ?? PRE}${SYSTEM_PROMPT_CACHE_MARKER}${opts.post ?? POST}`,
    tools: opts.tools ?? TOOLS,
    messages: opts.messages,
  }
}

describe('request-probe', () => {
  const tmpFiles: string[] = []
  let db: Database

  beforeEach(() => {
    resetRequestProbeCounters()
    const p = path.join(os.tmpdir(), `axiom-probe-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(f + suffix) } catch { /* ignore */ }
      }
    }
    tmpFiles.length = 0
  })

  /** One request: hint (optional), turn start, measure, usage row, commit. */
  function request(
    rec: RequestProbeRecorder,
    sessionId: string,
    context: unknown,
    usage: { input: number; cacheRead: number; cacheWrite: number },
    hint?: RequestProbeHint,
    newTurn = true,
  ): number | null {
    if (hint) rec.setHint(hint)
    if (newTurn) rec.beginTurn()
    rec.observe(sessionId, context)
    const usageId = logTokenUsage(db, {
      provider: 'anthropic',
      model: 'claude-test',
      promptTokens: usage.input,
      completionTokens: 10,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      estimatedCost: 0,
      sessionId,
      agentId: 'main',
    })
    rec.commit(usageId)
    return usageId
  }

  function rows(): Array<Record<string, unknown>> {
    return db.prepare('SELECT * FROM request_probe ORDER BY id').all() as Array<Record<string, unknown>>
  }

  it('links each row to its token_usage row and counts tool-loop requests', () => {
    const rec = new RequestProbeRecorder(() => db, () => 'main', () => ON)
    const u1 = request(rec, 's1', ctx({ messages: [user('hello')] }), { input: 100, cacheRead: 0, cacheWrite: 900 },
      { turnKind: 'interactive', trimDropped: 0, trimRepaired: false, trimBudgetTokens: 24000, trimKeptTokens: 50, digestChars: 0 })
    const u2 = request(rec, 's1', ctx({ messages: [user('hello'), assistant('call'), user('result')] }), { input: 5, cacheRead: 990, cacheWrite: 20 }, undefined, false)
    const r = rows()
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ usage_id: u1, session_id: 's1', agent_id: 'main', turn_kind: 'interactive', turn_seq: 0, trim_dropped: 0, trim_budget_tokens: 24000, history_kept_msgs: null })
    // Turn-start fields only on the first request of the turn.
    expect(r[1]).toMatchObject({ usage_id: u2, turn_seq: 1, trim_dropped: null, trim_budget_tokens: null, prev_msg_count: 1, history_kept_msgs: 1, msg_count: 3 })
    expect(r[0]!.tools_count).toBe(2)
    expect(r[0]!.sys_marker).toBe(1)
    expect(r[0]!.sys_pre_chars).toBe(PRE.length)
    expect(r[0]!.sys_post_chars).toBe(POST.length)
  })

  it('stores no content: no text, tool names, arguments or plain checksums', () => {
    const rec = new RequestProbeRecorder(() => db, () => 'main', () => ON)
    const messages = [
      user('GEHEIM-USER-1 please open private_fixture.txt'),
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'tool_geheim_alpha', arguments: { pfad: 'private_fixture.txt' } }], timestamp: 3 },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'tool_geheim_alpha', content: [{ type: 'text', text: 'GEHEIM-RESULT' }], timestamp: 4 },
    ]
    request(rec, 's-content', ctx({ messages }), { input: 10, cacheRead: 0, cacheWrite: 500 }, { turnKind: 'interactive', trimDropped: 0 })
    const all = rows()
    expect(all).toHaveLength(1)
    const dump = JSON.stringify(all).toLowerCase()
    for (const needle of ['geheim', 'tool_', 'pfad', 'home', 'datei', 'stable persona', 'volatile', 'reads a thing']) {
      expect(dump).not.toContain(needle)
    }
    const row = all[0]!
    // Every text column is an id, a kind, a timestamp or a keyed checksum.
    const textCols = Object.entries(row).filter(([, v]) => typeof v === 'string').map(([k]) => k).sort()
    expect(textCols).toEqual(['agent_id', 'created_at', 'first_difference', 'session_id', 'sys_post_hash', 'sys_pre_hash', 'tools_hash', 'turn_kind'])
    const keyRows = db.prepare('SELECT * FROM request_probe_key').all() as Array<Record<string, unknown>>
    for (const tableRow of [...all, ...keyRows]) {
      for (const [column, value] of Object.entries(tableRow)) {
        if (value === null) continue
        if (column === 'secret') expect(value).toMatch(/^[a-f0-9]{64}$/)
        else if (column.endsWith('_hash')) expect(value).toMatch(/^[a-f0-9]{16}$/)
        else if (column === 'turn_kind') expect(['interactive', 'task_injection', 'other']).toContain(value)
        else if (column === 'first_difference') expect(['first', 'prefix', 'shifted', 'context_removed', 'changed']).toContain(value)
        else if (column === 'created_at') expect(value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
        else if (column === 'agent_id' || column === 'session_id') expect(value).toMatch(/^[a-z0-9_-]+$/)
        else expect(Number.isSafeInteger(value)).toBe(true)
      }
    }
    for (const col of ['sys_post_hash', 'sys_pre_hash', 'tools_hash']) {
      expect(row[col]).toMatch(/^[0-9a-f]{16}$/)
    }
    // Keyed: a plain hash of the block (guessable) is not what is stored.
    expect(row.sys_pre_hash).not.toBe(createHash('sha256').update(PRE).digest('hex').slice(0, 16))
    expect(row.sys_post_hash).not.toBe(createHash('sha256').update(POST).digest('hex').slice(0, 16))
  })

  it('gives short blocks no checksum, only a length', () => {
    const rec = new RequestProbeRecorder(() => db, () => 'main', () => ON)
    request(rec, 's-short', ctx({ pre: 'short', post: 'tiny', tools: [], messages: [user('x')] }), { input: 1, cacheRead: 0, cacheWrite: 1 })
    const row = rows()[0]!
    expect(row).toMatchObject({ sys_pre_chars: 5, sys_pre_hash: null, sys_post_chars: 4, sys_post_hash: null, tools_count: 0, tools_hash: null })
  })

  it('switch off: nothing is measured or written, not even the table', () => {
    const rec = new RequestProbeRecorder(() => db, () => 'main', () => OFF)
    request(rec, 's-off', ctx({ messages: [user('hello')] }), { input: 1, cacheRead: 0, cacheWrite: 1 }, { turnKind: 'interactive' })
    expect(rec.peekPending()).toBeNull()
    const table = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('request_probe', 'request_probe_key')").all()
    expect(table).toEqual([])
    expect(resolveRequestProbeSettings({ enabled: false })).toEqual({ enabled: false, retentionDays: 60 })
    expect(resolveRequestProbeSettings({ retentionDays: 9999 })).toEqual({ enabled: true, retentionDays: 365 })
    expect(resolveRequestProbeSettings('garbage')).toEqual({ enabled: true, retentionDays: 60 })
  })

  it('never throws and never changes the request when measuring fails', () => {
    const broken = new RequestProbeRecorder(() => { throw new Error('db gone') }, () => 'main', () => ON)
    const context = ctx({ messages: [user('hello')] })
    const before = JSON.stringify(context)
    broken.beginTurn()
    expect(() => broken.observe('s-err', context)).not.toThrow()
    expect(() => broken.commit(1)).not.toThrow()
    expect(JSON.stringify(context)).toBe(before)
    expect(requestProbeErrorCount()).toBeGreaterThan(0)

    // A context that cannot be serialized is measured as empty, the turn goes on.
    const ok = new RequestProbeRecorder(() => db, () => 'main', () => ON)
    const cyclic: Record<string, unknown> = { role: 'user' }
    cyclic.self = cyclic
    ok.beginTurn()
    expect(() => ok.observe('s-err', { systemPrompt: 42, tools: 'x', messages: [cyclic] })).not.toThrow()
  })

  it('keeps the hint of a turn across an internal retry', () => {
    const rec = new RequestProbeRecorder(() => db, () => 'main', () => ON)
    rec.setHint({ turnKind: 'task_injection' })
    rec.beginTurn()
    rec.observe('s-r', ctx({ messages: [user('a')] }))
    rec.beginTurn(true)
    rec.observe('s-r', ctx({ messages: [user('a')] }))
    expect(rec.peekPending()).toMatchObject({ turn_kind: 'task_injection', turn_seq: 1 })
  })

  it('prunes rows older than the retention', () => {
    const rec = new RequestProbeRecorder(() => db, () => 'main', () => ON)
    request(rec, 's-old', ctx({ messages: [user('a')] }), { input: 1, cacheRead: 0, cacheWrite: 1 })
    request(rec, 's-old', ctx({ messages: [user('a')] }), { input: 1, cacheRead: 0, cacheWrite: 1 })
    db.prepare("UPDATE request_probe SET created_at = datetime('now', '-90 days') WHERE id = (SELECT MIN(id) FROM request_probe)").run()
    expect(pruneRequestProbes(db, 60)).toBe(1)
    expect(rows()).toHaveLength(1)
  })

  it('keeps request numbering on an internal retry after a response-less request', () => {
    const rec = new RequestProbeRecorder(() => db, () => 'main', () => ON)
    rec.beginTurn()
    rec.observe('retry', ctx({ messages: [user('one')] }))
    rec.commit(logTokenUsage(db, { provider: 'anthropic', model: 'a', promptTokens: 3, completionTokens: 2, cacheRead: 0, cacheWrite: 0, estimatedCost: 0 }))
    rec.observe('retry', ctx({ messages: [user('two')] }))
    rec.beginTurn(true)
    rec.observe('retry', ctx({ messages: [user('retry')] }))
    rec.commit(logTokenUsage(db, { provider: 'anthropic', model: 'a', promptTokens: 3, completionTokens: 2, cacheRead: 0, cacheWrite: 0, estimatedCost: 0 }))
    expect(rows().map(r => r.turn_seq)).toEqual([0, 2])
    expect(requestProbeDroppedCount()).toBe(1)
  })

  it('measures a bounded 300-message request without changing its context', () => {
    const rec = new RequestProbeRecorder(() => db, () => 'main', () => ON)
    const messages = Array.from({ length: 300 }, (_, i) => i % 2 ? assistant(`answer ${i}`) : user(`message ${i}`))
    const context = ctx({ messages })
    const before = JSON.stringify(context)
    const times: number[] = []
    for (let i = 0; i < 21; i++) {
      rec.beginTurn()
      const start = performance.now()
      rec.observe('bench', context)
      times.push(performance.now() - start)
    }
    expect(JSON.stringify(context)).toBe(before)
    expect(times.slice(1).sort((a, b) => a - b)[9]).toBeLessThan(20)
    console.info(`request-probe 300 messages median ${times.slice(1).sort((a, b) => a - b)[9]!.toFixed(2)} ms`)
  })

  it('adds columns to an existing first-build probe table', () => {
    db.exec(`CREATE TABLE request_probe (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      usage_id INTEGER, session_id TEXT, agent_id TEXT, turn_kind TEXT NOT NULL,
      turn_seq INTEGER NOT NULL, trim_dropped INTEGER, trim_repaired INTEGER,
      trim_budget_tokens INTEGER, trim_kept_tokens INTEGER, digest_chars INTEGER,
      tools_count INTEGER NOT NULL, tools_chars INTEGER NOT NULL, tools_hash TEXT,
      sys_marker INTEGER NOT NULL, sys_pre_chars INTEGER NOT NULL, sys_pre_hash TEXT,
      sys_post_chars INTEGER NOT NULL, sys_post_hash TEXT, msg_count INTEGER NOT NULL,
      history_chars INTEGER NOT NULL, new_msg_chars INTEGER NOT NULL, prev_msg_count INTEGER,
      history_kept_msgs INTEGER, est_sys_tokens INTEGER NOT NULL, est_tools_tokens INTEGER NOT NULL,
      est_history_tokens INTEGER NOT NULL, est_new_tokens INTEGER NOT NULL
    );`)
    const rec = new RequestProbeRecorder(() => db, () => 'main', () => ON)
    request(rec, 'old-schema', ctx({ messages: [user('hi')] }), { input: 1, cacheRead: 0, cacheWrite: 1 })
    expect(rows()[0]).toMatchObject({ first_difference: 'first', history_kept_chars: null })
  })

  it('recognizes context stripping, a moved window, their overlap and changed tools', () => {
    const rec = new RequestProbeRecorder(() => db, () => 'main', () => ON)
    const block = '<strand_context>summary</strand_context>\n'
    const first = [user('old'), assistant('response'), user(block + 'first turn'), assistant('answer')]
    const next = stripStrandContextFromLastUserMessage(first as never[])
    expect(next).not.toBeNull()
    request(rec, 'sequence', ctx({ messages: first }), { input: 100, cacheRead: 0, cacheWrite: 300 }, { turnKind: 'interactive' })
    const noCut = trimMessagesToBudget([...next!, user('second')] as never[], 10000)
    request(rec, 'sequence', ctx({ messages: noCut.messages }), { input: 100, cacheRead: 0, cacheWrite: 300 }, { turnKind: 'interactive', trimDropped: noCut.droppedCount })
    expect(rows()[1]).toMatchObject({ first_difference: 'context_removed', trim_dropped: 0, history_kept_msgs: 2, context_kept_msgs: 4 })

    const cutBase = [user('opening'.repeat(100)), assistant('old response'.repeat(100)), user(block + 'second turn'), assistant('new answer')]
    request(rec, 'moved', ctx({ messages: cutBase }), { input: 100, cacheRead: 0, cacheWrite: 300 }, { turnKind: 'interactive' })
    const cut = trimMessagesToBudget([...stripStrandContextFromLastUserMessage(cutBase as never[])!, user('third')] as never[], 35)
    expect(cut.droppedCount).toBeGreaterThan(0)
    request(rec, 'moved', ctx({ messages: cut.messages }), { input: 100, cacheRead: 0, cacheWrite: 300 }, { turnKind: 'interactive', trimDropped: cut.droppedCount })
    expect(rows()[3]!.trim_dropped).toBeGreaterThan(0)
    expect(rows()[3]!.first_difference).toBe('shifted')
    // A stable opener followed by shifted messages still counts as a moved cut.
    const stable = [user('stable opener'), assistant('old'), user(block + 'turn'), assistant('answer')]
    request(rec, 'both', ctx({ messages: stable }), { input: 100, cacheRead: 0, cacheWrite: 300 }, { turnKind: 'interactive' })
    const shifted = [user('stable opener'), ...stripStrandContextFromLastUserMessage(stable as never[])!.slice(2), user('next')]
    request(rec, 'both', ctx({ messages: shifted, tools: [TOOLS[0]] }), { input: 100, cacheRead: 0, cacheWrite: 300 }, { turnKind: 'interactive', trimDropped: 1, trimRepaired: true })
    expect(rows()[5]).toMatchObject({ first_difference: 'shifted', shifted_msgs: 1, trim_dropped: 1 })
    expect(Number(rows()[5]!.context_kept_msgs)).toBeGreaterThan(0)
    const sql = fs.readFileSync(new URL('./request-probe-report.sql', import.meta.url), 'utf8')
    const causesBlock = sql.split(/^-- @query /m).find(part => part.startsWith('causes\n'))!
    const cross = db.prepare(causesBlock.slice('causes\n'.length)).all() as Array<Record<string, unknown>>
    expect(cross.find(r => r.first_difference === 'shifted' && r.tools_changed === 1 && r.trim_removed === 1)).toMatchObject({ rewrites: 1, rewrite_write_tokens: 300 })
    const decision = sql.split(/^-- @query /m).find(part => part.startsWith('decision\n'))!
    const totals = db.prepare(decision.slice('decision\n'.length)).all() as Array<Record<string, unknown>>
    expect(totals.find(r => r.scenario === 'trim_removed')?.rewrite_write_tokens).toBe(600)
    expect(totals.find(r => r.scenario === 'context_only')?.rewrite_write_tokens).toBe(300)
  })

  describe('report (request-probe-report.sql)', () => {
    const sql = fs.readFileSync(new URL('./request-probe-report.sql', import.meta.url), 'utf8')
    function query(name: string): Array<Record<string, unknown>> {
      const parts = sql.split(/^-- @query /m)
      const block = parts.find(p => p.startsWith(`${name}\n`))
      if (!block) throw new Error(`query ${name} missing`)
      return db.prepare(block.slice(name.length + 1)).all() as Array<Record<string, unknown>>
    }

    it('separates trim, tool block, prompt before and after the marker, history and nothing', () => {
      const rec = new RequestProbeRecorder(() => db, () => 'main', () => ON)
      const turn1 = [user('first question'), assistant('first answer')]
      const turn2 = [...turn1, user('second question')]
      const hit = { input: 50, cacheRead: 1000, cacheWrite: 50 }
      const miss = { input: 50, cacheRead: 300, cacheWrite: 800 }
      const base = (s: string) => request(rec, s, ctx({ messages: [user('first question')] }), { input: 100, cacheRead: 0, cacheWrite: 1000 }, { turnKind: 'interactive', trimDropped: 0 })

      base('s-none')
      request(rec, 's-none', ctx({ messages: turn2 }), hit, { turnKind: 'interactive', trimDropped: 0 })

      base('s-trim')
      request(rec, 's-trim', ctx({ messages: [user('opener'), user('second question')] }), miss, { turnKind: 'interactive', trimDropped: 2, trimRepaired: true })

      base('s-tools')
      request(rec, 's-tools', ctx({ tools: [TOOLS[0]], messages: turn2 }), miss, { turnKind: 'interactive', trimDropped: 0 })

      base('s-pre')
      request(rec, 's-pre', ctx({ pre: `${PRE} plus a changed persona sentence`, messages: turn2 }), miss, { turnKind: 'interactive', trimDropped: 0 })

      base('s-post')
      request(rec, 's-post', ctx({ post: `${POST} plus a new memory line`, messages: turn2 }), miss, { turnKind: 'interactive', trimDropped: 0 })

      // Trim active, but the cut did not move: the message prefix is the same.
      base('s-trim-still')
      request(rec, 's-trim-still', ctx({ messages: turn2 }), hit, { turnKind: 'interactive', trimDropped: 4 })

      base('s-history')
      request(rec, 's-history', ctx({ messages: [user('first question, edited'), assistant('first answer'), user('second question')] }), miss, { turnKind: 'task_injection' })

      const detail = query('requests')
      const second = new Map(detail.filter(r => r.turn_seq === 0 && r.earliest_cache_break !== 'first').map(r => [r.session_id, r]))
      expect(Object.fromEntries([...second].map(([s, r]) => [s, r.earliest_cache_break]))).toEqual({
        's-history': 'history',
        's-none': 'none',
        's-post': 'sys_post',
        's-pre': 'sys_pre',
        's-tools': 'tools',
        's-trim': 'history',
        's-trim-still': 'none',
      })
      expect(second.get('s-trim-still')!.trim_active).toBe(1)
      expect(second.get('s-trim')!.trim_active).toBe(1)
      expect(second.get('s-tools')!.trim_active).toBe(0)
      expect(second.get('s-none')!.rewrite).toBe(0)
      for (const s of ['s-trim', 's-tools', 's-pre', 's-post', 's-history']) expect(second.get(s)!.rewrite).toBe(1)
      expect(detail.filter(r => r.earliest_cache_break === 'first')).toHaveLength(7)

      const causes = query('causes')
      const byCause = Object.fromEntries(causes.map(r => [`${r.turn_kind}/${r.earliest_cache_break}`, r]))
      expect(Object.keys(byCause).sort()).toEqual(['interactive/history', 'interactive/none', 'interactive/sys_post', 'interactive/sys_pre', 'interactive/tools', 'task_injection/history'])
      expect(byCause['interactive/history']).toMatchObject({ turn_starts: 1, rewrites: 1, rewrite_write_tokens: 800, share_of_rewrite_writes_pct: 20 })
      expect(causes.filter(r => r.turn_kind === 'interactive' && r.earliest_cache_break === 'none').reduce((n, r) => n + Number(r.turn_starts), 0)).toBe(2)

      const health = query('health')
      expect(health).toHaveLength(1)
      expect(health[0]).toMatchObject({ probe_rows: 14, strand_requests: 14, coverage_pct: 100 })
    })
  })
})
