import { describe, it, expect, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import { logTokenUsage, logToolCall, getTokenUsage, getToolCalls, queryToolCalls, getToolCallById, getDistinctToolNames, getMemoryUsageStats } from './token-logger.js'
import type { Database } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('token-logger', () => {
  const tmpFiles: string[] = []
  let db: Database

  afterEach(() => {
    if (db) {
      try { db.close() } catch { /* ignore */ }
    }
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  function createDb(): Database {
    const p = path.join(os.tmpdir(), `axiom-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
    return db
  }

  describe('logTokenUsage', () => {
    it('inserts token usage record', () => {
      const testDb = createDb()

      testDb.prepare(
        'INSERT INTO sessions (id, source) VALUES (?, ?)'
      ).run('session-123', 'web')

      logTokenUsage(testDb, {
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 150,
        completionTokens: 75, cacheRead: 0, cacheWrite: 0,
        estimatedCost: 0.001125,
        sessionId: 'session-123',
      })

      const rows = testDb.prepare('SELECT * FROM token_usage').all() as Record<string, unknown>[]
      expect(rows).toHaveLength(1)
      expect(rows[0].provider).toBe('openai')
      expect(rows[0].model).toBe('gpt-4o')
      expect(rows[0].prompt_tokens).toBe(150)
      expect(rows[0].completion_tokens).toBe(75)
      expect(rows[0].estimated_cost).toBeCloseTo(0.001125)
      expect(rows[0].session_id).toBe('session-123')
    })

    it('increments per-session token counters', () => {
      const testDb = createDb()

      testDb.prepare(
        'INSERT INTO sessions (id, source) VALUES (?, ?)'
      ).run('session-with-tokens', 'web')

      logTokenUsage(testDb, {
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 150,
        completionTokens: 75, cacheRead: 0, cacheWrite: 0,
        estimatedCost: 0.001125,
        sessionId: 'session-with-tokens',
      })

      const session = testDb.prepare(
        'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
      ).get('session-with-tokens') as { prompt_tokens: number, completion_tokens: number }

      expect(session.prompt_tokens).toBe(150)
      expect(session.completion_tokens).toBe(75)
    })

    it('accumulates per-session token counters across multiple calls', () => {
      const testDb = createDb()

      testDb.prepare(
        'INSERT INTO sessions (id, source) VALUES (?, ?)'
      ).run('session-accumulate', 'web')

      logTokenUsage(testDb, {
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 100,
        completionTokens: 50, cacheRead: 0, cacheWrite: 0,
        estimatedCost: 0.001,
        sessionId: 'session-accumulate',
      })
      logTokenUsage(testDb, {
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 25,
        completionTokens: 10, cacheRead: 0, cacheWrite: 0,
        estimatedCost: 0.00025,
        sessionId: 'session-accumulate',
      })

      const session = testDb.prepare(
        'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
      ).get('session-accumulate') as { prompt_tokens: number, completion_tokens: number }

      expect(session.prompt_tokens).toBe(125)
      expect(session.completion_tokens).toBe(60)
    })

    it('persists cache read/write tokens and accumulates them per session', () => {
      const testDb = createDb()

      testDb.prepare('INSERT INTO sessions (id, source) VALUES (?, ?)').run('session-cache', 'web')

      logTokenUsage(testDb, {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        promptTokens: 100,
        completionTokens: 50,
        cacheRead: 800,
        cacheWrite: 200,
        estimatedCost: 0.003,
        sessionId: 'session-cache',
      })
      logTokenUsage(testDb, {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        promptTokens: 20,
        completionTokens: 10,
        cacheRead: 400,
        cacheWrite: 0,
        estimatedCost: 0.001,
        sessionId: 'session-cache',
      })

      const rows = testDb.prepare('SELECT cache_read, cache_write FROM token_usage ORDER BY id').all() as { cache_read: number; cache_write: number }[]
      expect(rows[0].cache_read).toBe(800)
      expect(rows[0].cache_write).toBe(200)
      expect(rows[1].cache_read).toBe(400)
      expect(rows[1].cache_write).toBe(0)

      const session = testDb.prepare(
        'SELECT cache_read, cache_write FROM sessions WHERE id = ?'
      ).get('session-cache') as { cache_read: number; cache_write: number }
      expect(session.cache_read).toBe(1200)
      expect(session.cache_write).toBe(200)
    })

    it('inserts without session_id', () => {
      const testDb = createDb()

      logTokenUsage(testDb, {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        promptTokens: 200,
        completionTokens: 100, cacheRead: 0, cacheWrite: 0,
        estimatedCost: 0.002,
      })

      const rows = testDb.prepare('SELECT * FROM token_usage').all() as Record<string, unknown>[]
      expect(rows).toHaveLength(1)
      expect(rows[0].session_id).toBeNull()
    })

    it('does not update session counters when session_id is omitted', () => {
      const testDb = createDb()

      testDb.prepare(
        'INSERT INTO sessions (id, source) VALUES (?, ?)'
      ).run('session-no-op', 'web')

      expect(() => {
        logTokenUsage(testDb, {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          promptTokens: 200,
          completionTokens: 100, cacheRead: 0, cacheWrite: 0,
          estimatedCost: 0.002,
        })
      }).not.toThrow()

      const session = testDb.prepare(
        'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
      ).get('session-no-op') as { prompt_tokens: number, completion_tokens: number }

      expect(session.prompt_tokens).toBe(0)
      expect(session.completion_tokens).toBe(0)
    })
  })

  describe('logToolCall', () => {
    it('inserts tool call record', () => {
      const testDb = createDb()

      logToolCall(testDb, {
        sessionId: 'session-456',
        toolName: 'shell',
        input: '{"command": "ls -la"}',
        output: '{"exitCode": 0}',
        durationMs: 250,
      })

      const rows = testDb.prepare('SELECT * FROM tool_calls').all() as Record<string, unknown>[]
      expect(rows).toHaveLength(1)
      expect(rows[0].session_id).toBe('session-456')
      expect(rows[0].tool_name).toBe('shell')
      expect(rows[0].input).toBe('{"command": "ls -la"}')
      expect(rows[0].duration_ms).toBe(250)
    })
  })

  describe('getTokenUsage', () => {
    it('returns all records when no filters', () => {
      const testDb = createDb()

      logTokenUsage(testDb, { provider: 'openai', model: 'gpt-4o', promptTokens: 100, completionTokens: 50, cacheRead: 0, cacheWrite: 0, estimatedCost: 0.001 })
      logTokenUsage(testDb, { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', promptTokens: 200, completionTokens: 100, cacheRead: 0, cacheWrite: 0, estimatedCost: 0.002 })

      const records = getTokenUsage(testDb)
      expect(records).toHaveLength(2)
    })

    it('filters by provider', () => {
      const testDb = createDb()

      logTokenUsage(testDb, { provider: 'openai', model: 'gpt-4o', promptTokens: 100, completionTokens: 50, cacheRead: 0, cacheWrite: 0, estimatedCost: 0.001 })
      logTokenUsage(testDb, { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', promptTokens: 200, completionTokens: 100, cacheRead: 0, cacheWrite: 0, estimatedCost: 0.002 })

      const records = getTokenUsage(testDb, { provider: 'openai' })
      expect(records).toHaveLength(1)
      expect(records[0].provider).toBe('openai')
    })

    it('filters by model', () => {
      const testDb = createDb()

      logTokenUsage(testDb, { provider: 'openai', model: 'gpt-4o', promptTokens: 100, completionTokens: 50, cacheRead: 0, cacheWrite: 0, estimatedCost: 0.001 })
      logTokenUsage(testDb, { provider: 'openai', model: 'gpt-4o-mini', promptTokens: 50, completionTokens: 25, cacheRead: 0, cacheWrite: 0, estimatedCost: 0.0001 })

      const records = getTokenUsage(testDb, { model: 'gpt-4o-mini' })
      expect(records).toHaveLength(1)
      expect(records[0].model).toBe('gpt-4o-mini')
    })

    it('respects limit', () => {
      const testDb = createDb()

      for (let i = 0; i < 5; i++) {
        logTokenUsage(testDb, { provider: 'openai', model: 'gpt-4o', promptTokens: 100, completionTokens: 50, cacheRead: 0, cacheWrite: 0, estimatedCost: 0.001 })
      }

      const records = getTokenUsage(testDb, { limit: 3 })
      expect(records).toHaveLength(3)
    })
  })

  describe('getToolCalls', () => {
    it('returns all records when no filters', () => {
      const testDb = createDb()

      logToolCall(testDb, { sessionId: 's1', toolName: 'shell', input: '{}', output: '{}', durationMs: 100 })
      logToolCall(testDb, { sessionId: 's1', toolName: 'read_file', input: '{}', output: '{}', durationMs: 50 })

      const records = getToolCalls(testDb)
      expect(records).toHaveLength(2)
    })

    it('filters by sessionId', () => {
      const testDb = createDb()

      logToolCall(testDb, { sessionId: 's1', toolName: 'shell', input: '{}', output: '{}', durationMs: 100 })
      logToolCall(testDb, { sessionId: 's2', toolName: 'shell', input: '{}', output: '{}', durationMs: 100 })

      const records = getToolCalls(testDb, { sessionId: 's1' })
      expect(records).toHaveLength(1)
      expect(records[0].sessionId).toBe('s1')
    })

    it('filters by toolName', () => {
      const testDb = createDb()

      logToolCall(testDb, { sessionId: 's1', toolName: 'shell', input: '{}', output: '{}', durationMs: 100 })
      logToolCall(testDb, { sessionId: 's1', toolName: 'read_file', input: '{}', output: '{}', durationMs: 50 })

      const records = getToolCalls(testDb, { toolName: 'read_file' })
      expect(records).toHaveLength(1)
      expect(records[0].toolName).toBe('read_file')
    })

    it('respects limit', () => {
      const testDb = createDb()

      for (let i = 0; i < 5; i++) {
        logToolCall(testDb, { sessionId: 's1', toolName: 'shell', input: '{}', output: '{}', durationMs: 100 })
      }

      const records = getToolCalls(testDb, { limit: 2 })
      expect(records).toHaveLength(2)
    })

    it('pages by row id with afterId / throughId', () => {
      const testDb = createDb()

      const ids = ['a', 'b', 'c', 'd'].map(name =>
        logToolCall(testDb, { sessionId: 's1', toolName: name, input: '{}', output: '{}', durationMs: 1 }),
      )
      logToolCall(testDb, { sessionId: 's2', toolName: 'other', input: '{}', output: '{}', durationMs: 1 })

      // Everything after the second call, of this session only.
      const after = getToolCalls(testDb, { sessionId: 's1', afterId: ids[1] })
      expect(after.map(r => r.toolName).sort()).toEqual(['c', 'd'])

      // Upper bound pins a page end, so a row written after the head was
      // read cannot slip into a batch it was never counted into.
      const window = getToolCalls(testDb, { sessionId: 's1', afterId: ids[0], throughId: ids[2] })
      expect(window.map(r => r.toolName).sort()).toEqual(['b', 'c'])

      // The cursor of the last row yields nothing.
      expect(getToolCalls(testDb, { sessionId: 's1', afterId: ids[3] })).toEqual([])
    })
  })

  describe('logToolCall with status', () => {
    it('stores status field and returns id', () => {
      const testDb = createDb()

      const id = logToolCall(testDb, {
        sessionId: 's1',
        toolName: 'bash',
        input: 'ls',
        output: 'error!',
        durationMs: 10,
        status: 'error',
      })

      expect(id).toBeGreaterThan(0)
      const row = testDb.prepare('SELECT status FROM tool_calls WHERE id = ?').get(id) as { status: string }
      expect(row.status).toBe('error')
    })

    it('defaults status to success', () => {
      const testDb = createDb()

      const id = logToolCall(testDb, {
        sessionId: 's1',
        toolName: 'bash',
        input: 'ls',
        output: 'ok',
        durationMs: 10,
      })

      const row = testDb.prepare('SELECT status FROM tool_calls WHERE id = ?').get(id) as { status: string }
      expect(row.status).toBe('success')
    })
  })

  describe('getMemoryUsageStats', () => {
    it('aggregates memory file reads and fact searches', () => {
      const testDb = createDb()

      const readOutput = (p: string) => JSON.stringify({ content: [], details: { path: p, size: 10 } })
      logToolCall(testDb, { sessionId: 's1', toolName: 'read_file', input: '{"path":"MEMORY.md"}', output: readOutput('/data/memory/MEMORY.md'), durationMs: 5 })
      logToolCall(testDb, { sessionId: 's1', toolName: 'read_file', input: '{"path":"/data/memory/MEMORY.md"}', output: readOutput('/data/memory/MEMORY.md'), durationMs: 5 })
      logToolCall(testDb, { sessionId: 's1', toolName: 'read_file', input: '{"path":"wiki/foo.md"}', output: readOutput('/data/memory/wiki/foo.md'), durationMs: 5 })
      // outside memory dir — must be ignored
      logToolCall(testDb, { sessionId: 's1', toolName: 'read_file', input: '{"path":"/tmp/x"}', output: readOutput('/tmp/x'), durationMs: 5 })
      // failed read — must be ignored
      logToolCall(testDb, { sessionId: 's1', toolName: 'read_file', input: '{"path":"gone.md"}', output: '{"details":{"error":true}}', durationMs: 5, status: 'error' })

      logToolCall(testDb, {
        sessionId: 's1',
        toolName: 'search_memories',
        input: JSON.stringify({ query: 'postgres port' }),
        output: JSON.stringify({ content: [], details: { count: 1, query: 'postgres port', facts: [{ content: 'Port is 5433', timestamp: '2026-07-01', source: 'session', sessionId: 'x' }] } }),
        durationMs: 5,
      })
      logToolCall(testDb, {
        sessionId: 's1',
        toolName: 'search_memories',
        input: JSON.stringify({ query: 'nothing' }),
        output: JSON.stringify({ content: [], details: { count: 0, query: 'nothing' } }),
        durationMs: 5,
      })

      const stats = getMemoryUsageStats(testDb, { memoryDir: '/data/memory', days: 7 })

      expect(stats.fileReads).toEqual([
        { path: 'MEMORY.md', count: 2, lastReadAt: expect.any(String) },
        { path: 'wiki/foo.md', count: 1, lastReadAt: expect.any(String) },
      ])

      expect(stats.searches).toHaveLength(2)
      const byQuery = Object.fromEntries(stats.searches.map((s) => [s.query, s]))
      expect(byQuery['postgres port'].resultCount).toBe(1)
      expect(byQuery['postgres port'].facts).toEqual([{ content: 'Port is 5433', timestamp: '2026-07-01', source: 'session' }])
      expect(byQuery['nothing'].resultCount).toBe(0)
      expect(byQuery['nothing'].facts).toEqual([])
    })
  })

  describe('queryToolCalls', () => {
    it('returns paginated results', () => {
      const testDb = createDb()

      for (let i = 0; i < 10; i++) {
        logToolCall(testDb, { sessionId: 's1', toolName: 'shell', input: `cmd-${i}`, output: '{}', durationMs: 100 })
      }

      const result = queryToolCalls(testDb, { page: 1, limit: 3 })
      expect(result.records).toHaveLength(3)
      expect(result.total).toBe(10)
      expect(result.totalPages).toBe(4)
      expect(result.page).toBe(1)
    })

    it('searches across tool_name, input, and output', () => {
      const testDb = createDb()

      logToolCall(testDb, { sessionId: 's1', toolName: 'bash', input: 'echo hello', output: 'hello', durationMs: 10 })
      logToolCall(testDb, { sessionId: 's1', toolName: 'file_read', input: '/tmp/test', output: 'world', durationMs: 10 })

      const result = queryToolCalls(testDb, { search: 'hello' })
      expect(result.records).toHaveLength(1)
      expect(result.records[0].toolName).toBe('bash')

      const result2 = queryToolCalls(testDb, { search: 'file_read' })
      expect(result2.records).toHaveLength(1)
    })

    it('treats all background session types as task filter matches', () => {
      const testDb = createDb()

      testDb.prepare("INSERT INTO sessions (id, source, type) VALUES ('sess-main', 'web', 'interactive')").run()
      testDb.prepare("INSERT INTO sessions (id, source, type) VALUES ('sess-task', 'system', 'task')").run()
      testDb.prepare("INSERT INTO sessions (id, source, type) VALUES ('sess-hb', 'system', 'heartbeat')").run()
      testDb.prepare("INSERT INTO sessions (id, source, type) VALUES ('sess-cons', 'system', 'consolidation')").run()
      testDb.prepare("INSERT INTO sessions (id, source, type) VALUES ('sess-loop', 'system', 'loop_detection')").run()

      logToolCall(testDb, { sessionId: 'sess-main', toolName: 'main_call', input: '{}', output: '{}', durationMs: 10 })
      logToolCall(testDb, { sessionId: 'sess-task', toolName: 'task_call', input: '{}', output: '{}', durationMs: 10 })
      logToolCall(testDb, { sessionId: 'sess-hb', toolName: 'hb_call', input: '{}', output: '{}', durationMs: 10 })
      logToolCall(testDb, { sessionId: 'sess-cons', toolName: 'cons_call', input: '{}', output: '{}', durationMs: 10 })
      logToolCall(testDb, { sessionId: 'sess-loop', toolName: 'loop_call', input: '{}', output: '{}', durationMs: 10 })

      const taskOnly = queryToolCalls(testDb, { sessionType: 'task' })
      expect(taskOnly.total).toBe(4)
      expect(taskOnly.records.every(r =>
        r.sessionType === 'task'
        || r.sessionType === 'heartbeat'
        || r.sessionType === 'consolidation'
        || r.sessionType === 'loop_detection'
      )).toBe(true)

      const mainOnly = queryToolCalls(testDb, { sessionType: 'main' })
      expect(mainOnly.total).toBe(1)
      expect(mainOnly.records[0].sessionId).toBe('sess-main')
    })

    it('filters by session and tool name', () => {
      const testDb = createDb()

      logToolCall(testDb, { sessionId: 's1', toolName: 'bash', input: '{}', output: '{}', durationMs: 10 })
      logToolCall(testDb, { sessionId: 's2', toolName: 'bash', input: '{}', output: '{}', durationMs: 10 })

      const result = queryToolCalls(testDb, { sessionId: 's1' })
      expect(result.total).toBe(1)
    })
  })

  describe('getToolCallById', () => {
    it('returns full record by ID', () => {
      const testDb = createDb()

      const id = logToolCall(testDb, { sessionId: 's1', toolName: 'bash', input: 'test input', output: 'test output', durationMs: 50, status: 'success' })

      const record = getToolCallById(testDb, id)
      expect(record).not.toBeNull()
      expect(record!.id).toBe(id)
      expect(record!.toolName).toBe('bash')
      expect(record!.input).toBe('test input')
      expect(record!.status).toBe('success')
    })

    it('returns null for non-existent ID', () => {
      const testDb = createDb()
      expect(getToolCallById(testDb, 99999)).toBeNull()
    })
  })

  describe('getDistinctToolNames', () => {
    it('returns unique tool names', () => {
      const testDb = createDb()

      logToolCall(testDb, { sessionId: 's1', toolName: 'bash', input: '{}', output: '{}', durationMs: 10 })
      logToolCall(testDb, { sessionId: 's1', toolName: 'bash', input: '{}', output: '{}', durationMs: 10 })
      logToolCall(testDb, { sessionId: 's1', toolName: 'file_read', input: '{}', output: '{}', durationMs: 10 })

      const names = getDistinctToolNames(testDb)
      expect(names).toEqual(['bash', 'file_read'])
    })
  })
})
