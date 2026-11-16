import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getUsageSummary, initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { collectMetrics, toSqliteUtc } from './service.js'
let dir: string
let db: Database
const old = process.env.DATA_DIR
beforeEach(() => { dir = fs.mkdtempSync(path.join(process.cwd(), '.mqtt-test-')); process.env.DATA_DIR = dir; db = initDatabase(path.join(dir, 'db.sqlite')) })
afterEach(() => { db.close(); if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old; fs.rmSync(dir, { recursive: true, force: true }) })
describe('numeric metrics from local DB', () => {
  it('counts SQLite-native timestamps and known provider families without publishing account names', () => {
    db.prepare("INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES ('anthropic', 'test-model', 100, 25, 0.12)").run()
    db.prepare("INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES ('private-account-name', 'test-model', 10, 5, 0.03)").run()
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES ('session', 'user', 'Private chat content')").run()
    db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type) VALUES ('test-running', 'Private task name', 'Private prompt', 'running', 'user')").run()
    db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, completed_at) VALUES ('test-failed', 'Private task name', 'Private prompt', 'failed', 'user', datetime('now'))").run()
    const collected = collectMetrics(db)
    expect(collected.usage.today_total).toMatchObject({ tokens: 140, cost: 0.15 })
    expect(collected.usage.today_anthropic).toMatchObject({ tokens: 125, cost: 0.12 })
    expect(collected.activity).toMatchObject({ messagesToday: 1, runningTasks: 1, failedTasksToday: 1, lastCronRun: null })
    expect(JSON.stringify(collected)).not.toMatch(/Private|private-account-name/)
  })

  it('counts user messages from local midnight on, exactly like the former datetime() comparison', () => {
    const now = new Date()
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const stamp = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19)
    const insert = db.prepare("INSERT INTO chat_messages (session_id, role, content, timestamp) VALUES ('s', ?, 'x', ?)")
    insert.run('user', stamp(new Date(midnight.getTime() - 1000)))
    insert.run('user', stamp(midnight))
    insert.run('assistant', stamp(midnight))
    const legacy = (db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user' AND datetime(timestamp) >= datetime(?)")
      .get(midnight.toISOString()) as { n: number }).n
    expect(collectMetrics(db).activity.messagesToday).toBe(1)
    expect(legacy).toBe(1)
  })

  it('relies on the column default writing canonical `YYYY-MM-DD HH:MM:SS` UTC timestamps', () => {
    // The sargable `timestamp >= ?` equals `datetime(timestamp) >= datetime(?)`
    // only for this format; a writer that stores ISO `T`/offset values would
    // break that (checked on production 12.11.2026: 0 deviating rows).
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES ('s', 'user', 'x')").run()
    const { timestamp } = db.prepare('SELECT timestamp FROM chat_messages').get() as { timestamp: string }
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(toSqliteUtc('2026-11-11T23:00:00.000Z')).toBe('2026-11-11 23:00:00')
  })

  it('reads only dated token_usage ranges and keeps the today/month totals of getUsageSummary', () => {
    // Regression guard for the 12.11.2026 event-loop stalls: the former
    // getUsageSummary call also summed week and all-time every 60 s, the
    // latter a full token_usage scan whose result was never published.
    const insert = db.prepare("INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES (?, 'anthropic', 'm', ?, 1, 0.5)")
    const now = new Date()
    insert.run(toSqliteUtc(now.toISOString()), 100)
    insert.run(toSqliteUtc(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 1).toISOString()), 20)
    insert.run(toSqliteUtc(new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString()), 3)
    const seen: string[] = []
    const prepare = db.prepare.bind(db)
    const spy = { prepare: (sql: string) => { seen.push(sql); return prepare(sql) } } as unknown as Database
    const collected = collectMetrics(spy)
    const summary = getUsageSummary(db, now)
    expect(collected.usage.today_total).toEqual({ tokens: summary.today.totalTokens, cost: summary.today.estimatedCost })
    expect(collected.usage.month_total).toEqual({ tokens: summary.month.totalTokens, cost: summary.month.estimatedCost })
    const usageSql = seen.filter(sql => /FROM token_usage/.test(sql))
    // totals + per-provider rows for today, the same for the closed month
    // days (none on the 1st); no DISTINCT lists, no week/all-time sums.
    const firstOfMonth = now.getDate() === 1
    expect(usageSql).toHaveLength(firstOfMonth ? 2 : 4)
    for (const sql of usageSql) expect(sql).toMatch(/timestamp >= date\(\?, '-1 day'\)[\s\S]*timestamp < date\(\?, '\+2 days'\)/)
    expect(usageSql.some(sql => /DISTINCT/.test(sql))).toBe(false)
  })

  it('caches the closed month days and keeps today live', () => {
    const insert = db.prepare("INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES (?, 'anthropic', 'm', ?, 1, 0.5)")
    const now = new Date()
    insert.run(toSqliteUtc(now.toISOString()), 100)
    insert.run(toSqliteUtc(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 1).toISOString()), 20)
    const seen: string[] = []
    const prepare = db.prepare.bind(db)
    const spy = { prepare: (sql: string) => { seen.push(sql); return prepare(sql) } } as unknown as Database
    collectMetrics(spy)
    seen.length = 0
    insert.run(toSqliteUtc(new Date().toISOString()), 7)
    const second = collectMetrics(spy)
    // Second call: only today's two queries, and today's new row is in both periods.
    expect(seen.filter(sql => /FROM token_usage/.test(sql))).toHaveLength(2)
    const summary = getUsageSummary(db, new Date())
    expect(second.usage.today_total).toEqual({ tokens: summary.today.totalTokens, cost: summary.today.estimatedCost })
    expect(second.usage.month_total).toEqual({ tokens: summary.month.totalTokens, cost: summary.month.estimatedCost })
    expect(second.usage.month_anthropic).toEqual(second.usage.month_total)
  })
})
