import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { initDatabase, type Database } from './database.js'
import { logTokenUsage, getTokenUsage } from './token-logger.js'
import { queryUsageStats } from './usage-stats.js'
import { lastRequestUsageForStrand } from './strand-context-usage.js'
import { getSessionCacheStats } from './cache-stats.js'
import {
  logBackgroundUsage,
  backgroundUsageErrorCount,
  resetBackgroundUsageErrorCount,
} from './background-usage.js'

function response(partial: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'SECRET-ANSWER-TEXT' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-test',
    usage: {
      input: 120, output: 30, cacheRead: 400, cacheWrite: 50, totalTokens: 600,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...partial,
  } as AssistantMessage
}

const S1 = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f'

describe('background-usage (Background usage)', () => {
  const tmpFiles: string[] = []
  let db: Database | null = null

  function createDb(): Database {
    const p = path.join(os.tmpdir(), `axiom-bg-usage-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
    return db
  }

  beforeEach(() => resetBackgroundUsageErrorCount())
  afterEach(() => {
    try { db?.close() } catch { /* ignore */ }
    db = null
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(f + suffix) } catch { /* ignore */ }
      }
    }
    tmpFiles.length = 0
  })

  it('books one row with kind background and the purpose, without touching session totals', () => {
    const d = createDb()
    d.prepare('INSERT INTO sessions (id, source) VALUES (?, ?)').run(S1, 'web')

    logBackgroundUsage(null, response(), { purpose: 'fact_extraction', sessionId: S1, agentId: 'main', db: d })

    const rows = d.prepare('SELECT * FROM token_usage').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'background', purpose: 'fact_extraction', session_id: S1, agent_id: 'main',
      provider: 'anthropic', model: 'claude-test',
      prompt_tokens: 120, completion_tokens: 30, cache_read: 400, cache_write: 50,
      turn_id: null, error: null,
    })
    expect(rows[0].estimated_cost).toBeCloseTo(0.0123)
    // No content is stored anywhere in the row.
    expect(JSON.stringify(rows[0])).not.toContain('SECRET')

    const session = d.prepare('SELECT prompt_tokens, completion_tokens, cache_read, cache_write FROM sessions WHERE id = ?').get(S1)
    expect(session).toEqual({ prompt_tokens: 0, completion_tokens: 0, cache_read: 0, cache_write: 0 })
  })

  it('estimates the cost from the model price when the provider reports none', () => {
    const d = createDb()
    const model = { id: 'm', provider: 'p', contextWindow: 1000, cost: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const r = response({ usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
    logBackgroundUsage(model as never, r, { purpose: 'auto_title', db: d })
    const row = d.prepare('SELECT estimated_cost, context_window, session_id FROM token_usage').get() as { estimated_cost: number; context_window: number; session_id: string | null }
    expect(row.estimated_cost).toBeCloseTo(2)
    expect(row.context_window).toBe(1000)
    expect(row.session_id).toBeNull()
  })

  it('stores only the error class of a rejected call, never the provider text', () => {
    const d = createDb()
    const r = response({ stopReason: 'error', errorMessage: '429 rate limit: your prompt "SECRET-PROMPT" was too long', content: [] })
    logBackgroundUsage(null, r, { purpose: 'session_summary', db: d })
    const row = d.prepare('SELECT error FROM token_usage').get() as { error: string }
    expect(row.error).toBeTruthy()
    expect(row.error).not.toContain('SECRET')
  })

  it('never throws: a closed database is swallowed and counted', () => {
    const d = createDb()
    d.close()
    expect(() => logBackgroundUsage(null, response(), { purpose: 'capture_router', db: d })).not.toThrow()
    expect(() => logBackgroundUsage(null, response(), { purpose: 'capture_router', db: d })).not.toThrow()
    expect(backgroundUsageErrorCount()).toBe(2)
    db = null
  })

  it('ignores a missing response', () => {
    const d = createDb()
    logBackgroundUsage(null, undefined, { purpose: 'stt_rewrite', db: d })
    expect((d.prepare('SELECT count(*) n FROM token_usage').get() as { n: number }).n).toBe(0)
    expect(backgroundUsageErrorCount()).toBe(0)
  })

  it('leaves the readers that mean "conversation request" unchanged', () => {
    const d = createDb()
    d.prepare('INSERT INTO sessions (id, source) VALUES (?, ?)').run(S1, 'web')
    logTokenUsage(d, { provider: 'anthropic', model: 'claude-test', promptTokens: 10, completionTokens: 5, cacheRead: 1000, cacheWrite: 0, estimatedCost: 0.1, sessionId: S1 })

    const lastBefore = lastRequestUsageForStrand(d, S1)
    const cacheBefore = getSessionCacheStats(d, S1)

    logBackgroundUsage(null, response(), { purpose: 'fact_extraction', sessionId: S1, db: d })

    // Context fill of the strand: last kind=request row only.
    expect(lastRequestUsageForStrand(d, S1)).toEqual(lastBefore)
    // Cache ratio from the session totals: background rows do not count.
    expect(getSessionCacheStats(d, S1)).toEqual(cacheBefore)
    // Cost totals do count them (that is the point of booking).
    expect(queryUsageStats(d, {}).totals.estimatedCost).toBeCloseTo(0.1 + 0.0123)
    expect(getTokenUsage(d).filter(r => r.sessionId === S1)).toHaveLength(2)
  })

  it('keeps evaluations over existing rows identical across the migration', () => {
    const d = createDb()
    d.prepare('INSERT INTO sessions (id, source) VALUES (?, ?)').run(S1, 'web')
    logTokenUsage(d, { provider: 'anthropic', model: 'a', promptTokens: 10, completionTokens: 5, cacheRead: 100, cacheWrite: 20, estimatedCost: 0.5, sessionId: S1 })
    logTokenUsage(d, { provider: 'openai', model: 'b', promptTokens: 7, completionTokens: 3, cacheRead: 0, cacheWrite: 0, estimatedCost: 0.25, kind: 'voice_note' })
    const file = tmpFiles[tmpFiles.length - 1]
    const before = { stats: queryUsageStats(d, {}), rows: getTokenUsage(d), cache: getSessionCacheStats(d, S1) }
    d.close()

    // Simulate the pre-migration state (no purpose column), then migrate again.
    const reopened = initDatabase(file)
    db = reopened
    expect((reopened.prepare('PRAGMA table_info(token_usage)').all() as Array<{ name: string }>).some(c => c.name === 'purpose')).toBe(true)
    expect({ stats: queryUsageStats(reopened, {}), rows: getTokenUsage(reopened), cache: getSessionCacheStats(reopened, S1) }).toEqual(before)
    const purposes = reopened.prepare('SELECT purpose FROM token_usage').all() as Array<{ purpose: string | null }>
    expect(purposes.every(p => p.purpose === null)).toBe(true)
  })

  it('adds the purpose column to a legacy token_usage table without rebuilding it', () => {
    const d = createDb()
    const file = tmpFiles[tmpFiles.length - 1]
    logTokenUsage(d, { provider: 'anthropic', model: 'a', promptTokens: 1, completionTokens: 1, cacheRead: 0, cacheWrite: 0, estimatedCost: 0 })
    d.exec('ALTER TABLE token_usage DROP COLUMN purpose')
    d.close()
    const reopened = initDatabase(file)
    db = reopened
    const row = reopened.prepare('SELECT id, purpose, kind FROM token_usage').get() as { id: number; purpose: string | null; kind: string }
    expect(row).toEqual({ id: 1, purpose: null, kind: 'request' })
  })
})

describe('each completeSimple and streamSimple call is booked or documented as exempt', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const packagesDir = path.resolve(here, '..', '..')
  // One entry per call site, ordered by source location; a second call in the
  // same file requires its own entry. This inventory cannot prove runtime
  // invocation, correct usage figures, or the absence of dynamically named calls.
  const sites: Record<string, Array<'background' | 'callback' | 'exempt'>> = {
    'core/src/isolated-inference.ts': ['callback'],
    'core/src/strand-auto-title.ts': ['background'],
    'core/src/speech-summary.ts': ['background'],
    'core/src/provider-health.ts': ['exempt'],
    'core/src/capture-split.ts': ['background'],
    'core/src/task-runner.ts': ['background'],
    'core/src/ask-agent-tool.ts': ['background'],
    'core/src/agent.ts': ['background'],
    'core/src/ha-inference.ts': ['callback'],
    'core/src/voice-shorten.ts': ['background'],
    'core/src/fact-extraction.ts': ['background'],
    'core/src/stt.ts': ['background'],
    'core/src/capture-router.ts': ['background'],
    'core/src/ha-anthropic-relay.ts': ['callback'],
    'core/src/project-assignment.ts': ['background'],
    'web-backend/src/bootstrap/runtime-composition.ts': ['background'],
  }
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) sourceFiles(full, out)
      else if (/\.(ts|mts|vue)$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) out.push(full)
    }
    return out
  }
  it('finds no unclassified call site', () => {
    const found = new Map<string, number>()
    const offenders: string[] = []
    for (const file of sourceFiles(packagesDir)) {
      const rel = path.relative(packagesDir, file).split(path.sep).join('/')
      if (rel === 'core/src/pi-models.ts') continue // SDK wrapper definitions
      const raw = fs.readFileSync(file, 'utf8')
      const code = raw.split('\n').filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
      const matches = [...code.matchAll(/\b(?:completeSimple|streamSimple)\(/g)]
      if (!matches.length) continue
      found.set(rel, matches.length)
      const expected = sites[rel] ?? []
      if (matches.length !== expected.length) offenders.push(`${rel}: ${matches.length} calls, ${expected.length} classified`)
      for (const [index, kind] of expected.entries()) {
        if (index >= matches.length) break
        const marker = kind === 'exempt' ? 'background-usage: exempt'
          : kind === 'callback' ? 'onUsage' : 'logBackgroundUsage('
        // A call has an explicit file-level classification; the ordered list
        // makes additional calls fail instead of inheriting a sibling's booking.
        if (!raw.includes(marker) && !(kind === 'callback' &&
          ['core/src/ha-inference.ts', 'core/src/ha-anthropic-relay.ts'].includes(rel) &&
          raw.includes('HaCompletion'))) offenders.push(`${rel}#${index + 1}: missing ${marker}`)
      }
    }
    for (const rel of Object.keys(sites)) if (!found.has(rel)) offenders.push(`${rel}: missing call site`)
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(16)
    expect(offenders).toEqual([])
  })
})
