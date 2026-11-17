/**
 * Strand statistics (`GET /api/strands/:id/stats`, schema strand_stats.v1).
 * Real database, real routes: ownership, prompt kinds, task tree incl. a
 * nested sub-task, local vs. cloud, autarky estimate vs. recorded turns,
 * tool errors and the 60 s cache.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'
import type { StrandStats } from './stats.js'
import { clearStrandStatsCache, computeStrandStats, intervalSum, parallelPeak, parseDbTime, unionIntervals } from './stats.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-strand-stats-'))
  process.env.DATA_DIR = tempDataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  server = http.createServer(createApp({ db, getAgentCore: () => agentCore }))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  clearStrandStatsCache()
  db.exec('DELETE FROM tool_calls; DELETE FROM token_usage; DELETE FROM chat_messages; DELETE FROM tasks; DELETE FROM strand_turns;')
})

async function api(url: string, authToken = token): Promise<{ status: number; body: StrandStats }> {
  const res = await fetch(`${baseUrl}${url}`, { headers: { Authorization: `Bearer ${authToken}` } })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as StrandStats }
}

function msg(sessionId: string, role: string, ts: string, metadata: unknown = null, content = 'x') {
  db.prepare('INSERT INTO chat_messages (session_id, role, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, role, content, ts, metadata === null ? null : JSON.stringify(metadata))
}

function usage(sessionId: string, ts: string, provider: string, model: string, p: number, c: number, cost: number) {
  db.prepare(`INSERT INTO token_usage (session_id, timestamp, provider, model, prompt_tokens, completion_tokens, cache_read, cache_write, estimated_cost)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`).run(sessionId, ts, provider, model, p, c, cost)
}

function tool(sessionId: string, ts: string, name: string, status = 'success') {
  db.prepare('INSERT INTO tool_calls (session_id, timestamp, tool_name, status) VALUES (?, ?, ?, ?)').run(sessionId, ts, name, status)
}

function task(id: string, sessionId: string, parentSessionId: string, created: string, done: string, triggerSourceId: string | null = null, status = 'completed') {
  db.prepare("INSERT OR IGNORE INTO sessions (id, user_id, agent_id, parent_session_id, source, type) VALUES (?, '1', 'main', ?, 'task', 'task')").run(sessionId, parentSessionId)
  db.prepare(`INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, created_at, started_at, completed_at, session_id)
    VALUES (?, ?, 'p', ?, 'agent', ?, ?, ?, ?, ?)`).run(id, `Task ${id}`, status, triggerSourceId, created, created, done, sessionId)
}

/** A strand with 3 prompts (typed, voice, answer), one task with a nested sub-task, a local model and a tool error. */
function seedStrand(): string {
  const strand = sessionManager.createThread('1', 'main', 'Stats strand')
  msg(strand.id, 'user', '2026-10-01 10:00:00', { inputMode: 'typed' })
  msg(strand.id, 'assistant', '2026-10-01 10:00:30')
  msg(strand.id, 'user', '2026-10-01 10:10:00', { files: [{ originalName: 'recording-2026-10-01-101000.m4a' }] })
  msg(strand.id, 'assistant', '2026-10-01 10:11:00')
  msg(strand.id, 'user', '2026-10-01 10:20:00', { type: 'interaction_answer' })
  msg(strand.id, 'assistant', '2026-10-01 10:20:20')
  usage(strand.id, '2026-10-01 10:00:10', 'anthropic', 'claude-sonnet', 1000, 100, 0.5)
  usage(strand.id, '2026-10-01 10:00:30', 'anthropic', 'claude-sonnet', 1200, 50, 0.25)
  usage(strand.id, '2026-10-01 10:10:40', 'ollama', 'qwen3', 800, 40, 0)
  usage(strand.id, '2026-10-01 10:20:20', 'anthropic', 'claude-sonnet', 900, 30, 0.25)
  tool(strand.id, '2026-10-01 10:00:05', 'shell')
  tool(strand.id, '2026-10-01 10:00:06', 'shell', 'error')
  tool(strand.id, '2026-10-01 10:10:20', 'strand_context')
  task('t-1', 's-task-1', strand.id, '2026-10-01 10:00:20', '2026-10-01 10:05:20')
  usage('s-task-1', '2026-10-01 10:01:00', 'anthropic', 'claude-sonnet', 5000, 500, 2)
  tool('s-task-1', '2026-10-01 10:01:10', 'web_fetch')
  task('t-2', 's-task-2', 's-task-1', '2026-10-01 10:02:00', '2026-10-01 10:04:00', 't-1')
  usage('s-task-2', '2026-10-01 10:02:30', 'ollama', 'qwen3', 2000, 200, 0)
  return strand.id
}

describe('GET /api/strands/:id/stats', () => {
  it('returns strand_stats.v1 with prompts, tokens, models, local share and task tree', async () => {
    const id = seedStrand()
    const res = await api(`/api/strands/${id}/stats?include=tasks,series`)
    expect(res.status).toBe(200)
    const s = res.body
    expect(s.schema).toBe('strand_stats.v1')
    expect(s.strandId).toBe(id)
    expect(s.prompts).toEqual({ total: 3, typed: 1, voice: 1, answers: 1 })
    expect(s.turns.source).toBe('estimated')
    expect(s.turns.user).toBe(3)
    expect(s.taskCount).toBe(2)
    expect(s.nestedTasks).toBe(1)
    expect(s.taskStatus.completed).toBe(2)
    expect(s.tokens.main.requests).toBe(4)
    expect(s.tokens.tasks.requests).toBe(2)
    expect(s.tokens.total.requests).toBe(6)
    expect(s.cost.totalUsd).toBeCloseTo(3, 5)
    expect(s.local.requests).toBe(2)
    expect(s.local.requestShare).toBeCloseTo(2 / 6, 5)
    const models = s.models.map(m => m.model).sort()
    expect(models).toEqual(['claude-sonnet', 'qwen3'])
    // strand_context is an internal metric tool, never counted as work
    expect(s.tools.main).toBe(2)
    expect(s.tools.total).toBe(3)
    expect(s.tools.errors).toBe(1)
    expect(s.autarky.estimated).toBe(true)
    expect(s.autarky.tasksSec).toBe(300)
    expect(s.autarky.parallelPeak).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(s.tasks)).toBe(true)
    expect(s.tasks).toHaveLength(2)
    expect(Array.isArray(s.series)).toBe(true)
  })

  it('keeps task-review cost but does not count its background row as a task request', async () => {
    const id = seedStrand()
    // The shared fixture reuses task session ids across tests; reparent the root.
    db.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = 's-task-1'").run(id)
    const before = (await api(`/api/strands/${id}/stats?include=tasks`)).body
    const taskSession = db.prepare('SELECT session_id FROM tasks LIMIT 1').get() as { session_id: string }
    db.prepare(`INSERT INTO token_usage (session_id, provider, model, kind, purpose, prompt_tokens, completion_tokens,
      cache_read, cache_write, estimated_cost) VALUES (?, 'anthropic', 'claude-sonnet', 'background', 'task_review', 10, 3, 0, 0, 0.75)`)
      .run(taskSession.session_id)
    clearStrandStatsCache()
    const after = (await api(`/api/strands/${id}/stats?include=tasks`)).body
    expect(after.tasks?.find(t => t.id === 't-1')?.costUsd).toBeCloseTo(
      (before.tasks?.find(t => t.id === 't-1')?.costUsd ?? 0) + 0.75,
    )
    expect(after.tokens.tasks.requests).toBe(before.tokens.tasks.requests)
    expect(after.tokens.tasks.costUsd).toBeCloseTo(before.tokens.tasks.costUsd + 0.75)
  })

  it('omits tasks and series unless requested', async () => {
    const id = seedStrand()
    const res = await api(`/api/strands/${id}/stats`)
    expect(res.status).toBe(200)
    expect(res.body.tasks).toBeUndefined()
    expect(res.body.series).toBeUndefined()
  })

  it('answers 404 for a strand of another user and for an unknown strand', async () => {
    const id = seedStrand()
    expect((await api(`/api/strands/${id}/stats`, otherToken)).status).toBe(404)
    expect((await api('/api/strands/does-not-exist/stats')).status).toBe(404)
  })

  it('uses recorded strand_turns when present and marks autarky as measured', async () => {
    const id = seedStrand()
    db.prepare(`INSERT INTO strand_turns (id, session_id, trigger, started_at, first_token_at, ended_at)
      VALUES ('turn-1', ?, 'user', '2026-10-01 10:00:00', '2026-10-01 10:00:04', '2026-10-01 10:00:30'),
             ('turn-2', ?, 'user', '2026-10-01 10:10:00', '2026-10-01 10:10:06', '2026-10-01 10:11:00'),
             ('turn-3', ?, 'user', '2026-10-01 10:20:00', '2026-10-01 10:20:02', '2026-10-01 10:20:20')`).run(id, id, id)
    const s = computeStrandStats(db, id)
    expect(s.turns.source).toBe('recorded')
    expect(s.turns.recorded).toBe(3)
    expect(s.autarky.estimated).toBe(false)
    expect(s.autarky.mainSec).toBe(30 + 60 + 20)
    expect(s.autarky.latencyMedianSec).toBe(4)
  })

  it('M1: an open turn without a live runner is capped at its last activity, a live one counts to now', () => {
    const id = seedStrand()
    db.prepare(`INSERT INTO strand_turns (id, session_id, trigger, started_at, first_token_at, ended_at, status)
      VALUES ('dead', ?, 'user', '2026-10-01 10:20:00', '2026-10-01 10:20:02', NULL, 'running')`).run(id)
    const now = Date.parse('2026-10-05T10:00:00Z') / 1000
    // Not active in this process: last evidence is the assistant message / usage at 10:20:20.
    const dead = computeStrandStats(db, id, { now, isTurnActive: () => false })
    // 30 + 60 s estimated from the two earlier prompts, + 20 s capped open turn.
    expect(dead.autarky.mainSec).toBe(30 + 60 + 20)
    expect(dead.turns.interrupted).toBe(1)
    expect(dead.autarky.estimated).toBe(true)
    clearStrandStatsCache()
    // Really running in this process: counts up to now.
    const live = computeStrandStats(db, id, { now, isTurnActive: t => t === 'dead' })
    expect(live.autarky.mainSec).toBe(30 + 60 + now - Date.parse('2026-10-01T10:20:00Z') / 1000)
    expect(live.turns.interrupted).toBe(0)
  })

  it('M1: turns closed as interrupted at boot count as estimated', () => {
    const id = seedStrand()
    db.prepare(`INSERT INTO strand_turns (id, session_id, trigger, started_at, ended_at, status)
      VALUES ('i1', ?, 'user', '2026-10-01 10:00:00', '2026-10-01 10:00:30', 'completed'),
             ('i2', ?, 'user', '2026-10-01 10:10:00', '2026-10-01T10:11:00.000Z', 'interrupted')`).run(id, id)
    const s = computeStrandStats(db, id)
    expect(s.turns.interrupted).toBe(1)
    expect(s.autarky.mainSec).toBe(30 + 60)
    expect(s.autarky.estimated).toBe(true)
  })

  it('M3: the same model under two billing classes stays two entries with correct shares', () => {
    const strand = sessionManager.createThread('1', 'main', 'Mixed billing')
    msg(strand.id, 'user', '2026-10-01 10:00:00')
    msg(strand.id, 'assistant', '2026-10-01 10:00:30')
    const ins = db.prepare(`INSERT INTO token_usage (session_id, timestamp, provider, model, prompt_tokens, completion_tokens, cache_read, cache_write, estimated_cost, billing)
      VALUES (?, ?, 'anthropic', 'claude-sonnet', ?, 10, 0, 0, ?, ?)`)
    // Metered row first so the old fold-by-first-row would have labelled the whole model metered.
    ins.run(strand.id, '2026-10-01 10:00:05', 100, 1, 'metered')
    ins.run(strand.id, '2026-10-01 10:00:10', 300, 3, 'subscription')
    ins.run(strand.id, '2026-10-01 10:00:20', 300, 3, 'subscription')
    const s = computeStrandStats(db, strand.id)
    const sonnet = s.models.filter(m => m.model === 'claude-sonnet').map(m => ({ billing: m.billing, requests: m.requests, costUsd: m.costUsd }))
      .sort((a, b) => a.billing.localeCompare(b.billing))
    expect(sonnet).toEqual([
      { billing: 'metered', requests: 1, costUsd: 1 },
      { billing: 'subscription', requests: 2, costUsd: 6 },
    ])
    expect(s.cost.totalUsd).toBe(7)
    expect(s.cost.subscriptionUsd).toBe(6)
    expect(s.cost.meteredUsd).toBe(1)
    expect(s.cost.subscriptionShare).toBeCloseTo(6 / 7, 5)
  })

  it('Background usage: background rows get their own bucket and leave main, voice and turns unchanged', () => {
    const id = seedStrand()
    clearStrandStatsCache()
    const before = computeStrandStats(db, id)
    db.prepare(`INSERT INTO token_usage (session_id, timestamp, provider, model, prompt_tokens, completion_tokens, cache_read, cache_write, estimated_cost, kind)
      VALUES (?, '2026-10-01 10:20:25', 'anthropic', 'claude-haiku', 400, 20, 0, 0, 0.1, 'background')`).run(id)
    clearStrandStatsCache()
    const after = computeStrandStats(db, id)
    expect(after.tokens.main).toEqual(before.tokens.main)
    expect(after.tokens.voice).toEqual(before.tokens.voice)
    expect(after.tokens.tasks).toEqual(before.tokens.tasks)
    expect(after.turns).toEqual(before.turns)
    expect(after.tokens.background.requests).toBe(1)
    expect(after.tokens.total.requests).toBe(before.tokens.total.requests + 1)
  })

  it('caches for 60 s per strand', async () => {
    const id = seedStrand()
    const first = await api(`/api/strands/${id}/stats`)
    usage(id, '2026-10-01 10:30:00', 'anthropic', 'claude-sonnet', 10, 10, 1)
    const second = await api(`/api/strands/${id}/stats`)
    expect(second.body.cost.totalUsd).toBe(first.body.cost.totalUsd)
    clearStrandStatsCache()
    const third = await api(`/api/strands/${id}/stats`)
    expect(third.body.cost.totalUsd).toBeCloseTo(first.body.cost.totalUsd + 1, 5)
  })
})

describe('stats helpers', () => {
  it('parses SQLite and ISO timestamps as UTC', () => {
    expect(parseDbTime('2026-10-01 10:00:00')).toBe(Date.UTC(2026, 9, 1, 10) / 1000)
    expect(parseDbTime('2026-10-01T10:00:00.000Z')).toBe(Date.UTC(2026, 9, 1, 10) / 1000)
    expect(parseDbTime(null)).toBeNull()
  })

  it('unions intervals and finds the parallel peak', () => {
    const iv: Array<[number, number]> = [[0, 10], [5, 15], [20, 30], [22, 25], [24, 26]]
    expect(unionIntervals(iv)).toEqual([[0, 15], [20, 30]])
    expect(intervalSum(unionIntervals(iv))).toBe(25)
    expect(parallelPeak(iv)).toBe(3)
  })
})
