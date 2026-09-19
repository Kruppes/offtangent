import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { getUsageSummary, queryUsageStats } from './usage-stats.js'

function createTimestamp(date: Date): string {
  return date.toISOString()
}

describe('usage-stats', () => {
  let db: Database | null = null
  let tmpDir = ''
  const previousDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (db) {
      try {
        db.close()
      } catch {
        // ignore close failures during cleanup
      }
    }
    db = null

    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    tmpDir = ''

    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR
    } else {
      process.env.DATA_DIR = previousDataDir
    }
  })

  function setup(): Database {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-usage-stats-'))
    process.env.DATA_DIR = tmpDir
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({
        tokenPriceTable: {
          'gpt-4o': { input: 2.5, output: 10 },
          'gpt-4o-mini': { input: 0.15, output: 0.6 },
          'custom-model': { input: 1.25, output: 2.5 },
        },
      }, null, 2),
      'utf-8',
    )

    db = initDatabase(path.join(tmpDir, 'db', 'stats.db'))
    return db
  }

  it('aggregates usage by provider and model with cost fallback', () => {
    const testDb = setup()

    testDb.prepare(
      'INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(createTimestamp(new Date('2026-03-20T10:00:00Z')), 'openai', 'gpt-4o', 1000, 500, 0, 'sess-1')
    testDb.prepare(
      'INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(createTimestamp(new Date('2026-03-20T11:00:00Z')), 'openai', 'gpt-4o', 2000, 1000, 0.5, 'sess-2')
    testDb.prepare(
      'INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(createTimestamp(new Date('2026-03-21T12:00:00Z')), 'anthropic', 'custom-model', 4000, 1000, 0, 'sess-3')

    const result = queryUsageStats(testDb, {
      groupBy: ['provider', 'model'],
      dateFrom: '2026-03-20T00:00:00.000Z',
      dateTo: '2026-03-21T23:59:59.999Z',
    })

    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].provider).toBe('openai')
    expect(result.rows[0].model).toBe('gpt-4o')
    expect(result.rows[0].requests).toBe(2)
    expect(result.rows[0].totalTokens).toBe(4500)
    expect(result.rows[0].estimatedCost).toBeCloseTo(0.5075, 6)
    expect(result.rows[1].provider).toBe('anthropic')
    expect(result.rows[1].estimatedCost).toBeCloseTo(0.0075, 6)
    expect(result.totals.totalTokens).toBe(9500)
    expect(result.availableProviders).toEqual(['anthropic', 'openai'])
    expect(result.availableModels).toEqual(['custom-model', 'gpt-4o'])
  })

  it('aggregates usage by day and hour with provider/model filters', () => {
    const testDb = setup()

    const insert = testDb.prepare(
      'INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES (?, ?, ?, ?, ?, ?)'
    )

    insert.run(createTimestamp(new Date('2026-03-20T10:00:00Z')), 'openai', 'gpt-4o', 100, 50, 0)
    insert.run(createTimestamp(new Date('2026-03-20T10:30:00Z')), 'openai', 'gpt-4o', 120, 30, 0)
    insert.run(createTimestamp(new Date('2026-03-20T11:00:00Z')), 'openai', 'gpt-4o-mini', 80, 20, 0)
    insert.run(createTimestamp(new Date('2026-03-21T11:00:00Z')), 'anthropic', 'custom-model', 300, 100, 0)

    const hourly = queryUsageStats(testDb, {
      groupBy: ['hour'],
      provider: 'openai',
      model: 'gpt-4o',
    })

    expect(hourly.rows).toHaveLength(1)
    expect(hourly.rows[0].hour).toBe('2026-03-20 10:00:00')
    expect(hourly.rows[0].promptTokens).toBe(220)
    expect(hourly.rows[0].completionTokens).toBe(80)

    const daily = queryUsageStats(testDb, {
      groupBy: ['day'],
      provider: 'openai',
    })

    expect(daily.rows).toHaveLength(1)
    expect(daily.rows[0].day).toBe('2026-03-20')
    expect(daily.rows[0].totalTokens).toBe(400)
    expect(daily.availableModels).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('filters by sessionType via sessions.type JOIN', () => {
    const testDb = setup()

    // Seed sessions with explicit types — no prefix matching.
    testDb.prepare("INSERT INTO sessions (id, source, type) VALUES ('sess-main', 'web', 'interactive')").run()
    testDb.prepare("INSERT INTO sessions (id, source, type) VALUES ('sess-task', 'system', 'task')").run()
    testDb.prepare("INSERT INTO sessions (id, source, type) VALUES ('sess-hb',   'system', 'heartbeat')").run()
    testDb.prepare("INSERT INTO sessions (id, source, type) VALUES ('sess-cons', 'system', 'consolidation')").run()
    testDb.prepare("INSERT INTO sessions (id, source, type) VALUES ('sess-loop', 'system', 'loop_detection')").run()

    const ts = createTimestamp(new Date('2026-03-22T10:00:00Z'))
    const insert = testDb.prepare(
      'INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run(ts, 'openai', 'gpt-4o', 100, 50, 0.001, 'sess-main')
    insert.run(ts, 'openai', 'gpt-4o', 200, 100, 0.002, 'sess-task')
    insert.run(ts, 'openai', 'gpt-4o', 300, 150, 0.003, 'sess-hb')
    insert.run(ts, 'openai', 'gpt-4o', 400, 200, 0.004, 'sess-cons')
    insert.run(ts, 'openai', 'gpt-4o', 500, 250, 0.005, 'sess-loop')
    // NULL session_id — should be treated as 'main' for backward compat.
    testDb.prepare(
      'INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(ts, 'openai', 'gpt-4o', 10, 5, 0.0001)

    const main = queryUsageStats(testDb, { sessionType: 'main' })
    expect(main.totals.requests).toBe(2) // sess-main + NULL
    expect(main.totals.totalTokens).toBe(100 + 50 + 10 + 5)

    // 'task' bucket includes task + consolidation + loop_detection.
    const task = queryUsageStats(testDb, { sessionType: 'task' })
    expect(task.totals.requests).toBe(3)
    expect(task.totals.totalTokens).toBe((200 + 100) + (400 + 200) + (500 + 250))

    const hb = queryUsageStats(testDb, { sessionType: 'heartbeat' })
    expect(hb.totals.requests).toBe(1)
    expect(hb.totals.totalTokens).toBe(300 + 150)

    const all = queryUsageStats(testDb)
    expect(all.totals.requests).toBe(6)

    // Invariant: the three buckets partition the data — main + task + heartbeat == all.
    expect(main.totals.requests + task.totals.requests + hb.totals.requests).toBe(all.totals.requests)
    expect(main.totals.totalTokens + task.totals.totalTokens + hb.totals.totalTokens).toBe(all.totals.totalTokens)
  })

  it('returns today/week/month/all-time totals', () => {
    const testDb = setup()
    const now = new Date('2026-03-27T15:30:00Z')
    const insert = testDb.prepare(
      'INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES (?, ?, ?, ?, ?, ?)'
    )

    insert.run(createTimestamp(new Date('2026-03-27T09:00:00Z')), 'openai', 'gpt-4o', 1000, 500, 0)
    insert.run(createTimestamp(new Date('2026-03-25T09:00:00Z')), 'openai', 'gpt-4o-mini', 2000, 1000, 0)
    insert.run(createTimestamp(new Date('2026-03-02T09:00:00Z')), 'anthropic', 'custom-model', 3000, 1500, 0)
    insert.run(createTimestamp(new Date('2026-02-20T09:00:00Z')), 'anthropic', 'custom-model', 4000, 2000, 0)

    const summary = getUsageSummary(testDb, now)

    expect(summary.today.requests).toBe(1)
    expect(summary.today.totalTokens).toBe(1500)
    expect(summary.week.totalTokens).toBe(4500)
    expect(summary.month.totalTokens).toBe(9000)
    expect(summary.allTime.totalTokens).toBe(15000)
    expect(summary.today.estimatedCost).toBeCloseTo(0.0075, 6)
    expect(summary.month.estimatedCost).toBeCloseTo(0.0159, 6)
  })
})
