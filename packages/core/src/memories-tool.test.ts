import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { createMemory } from './memories-store.js'
import { createSearchMemoriesTool } from './memories-tool.js'

/**
 * Config isolation, and why this file needs it (flake hunt 2026-09-26).
 *
 * `createMemory()` fires `embedMemoryBestEffort()` and the tool's hybrid
 * retrieval calls `searchMemoriesByEmbedding()`; both read
 * `settings.json.memoryEmbeddings` through `loadConfig()`, i.e. out of
 * `$DATA_DIR/config`. With the real DATA_DIR of a dev box (embeddings enabled,
 * pointing at an Ollama host) the two writes race against the query: if only
 * ONE of the two facts has its vector stored when the search runs, Reciprocal
 * Rank Fusion lifts that fact above the better lexical hit, and
 * `Postgres before Redis` fails with "expected 147 to be less than 61". The
 * race only loses under load, which is why it fails inside a full `npm test`
 * and never alone.
 *
 * Pointing DATA_DIR at an empty temp directory makes the ranking a pure,
 * deterministic FTS5 ranking (`memoryEmbeddings.enabled` is false in the
 * shipped template) and keeps the test off the network. The assertions stay
 * exactly as strict as before.
 */
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-memories-tool-'))
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  process.env.DATA_DIR = tempDataDir
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

function insertUser(db: Database, id: number, username: string): void {
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
  ).run(id, username, 'hash', 'user')
}

function getTextContent(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  if (!result || !('content' in result)) return ''
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(item => item.type === 'text').map(item => item.text ?? '').join('')
}

function getDetails(result: Awaited<ReturnType<AgentTool['execute']>>): Record<string, unknown> {
  if (!result || !('details' in result)) return {}
  return (result as { details: Record<string, unknown> }).details
}

describe('search_memories tool', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    insertUser(db, 1, 'alice')
    insertUser(db, 2, 'coder')
  })

  it('creates a tool with correct metadata and schema', () => {
    const tool = createSearchMemoriesTool({ db })

    expect(tool.name).toBe('search_memories')
    expect(tool.label).toBe('Search Memories')
    expect(tool.description).toContain('fact memory')
    const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(schema.properties.query).toBeDefined()
    expect(schema.properties.limit).toBeDefined()
    expect(schema.required).toContain('query')
  })

  it('returns formatted results when called', async () => {
    createMemory(db, 1, 'session-a', 'Postgres runs on port 5432', 'extracted_fact')
    createMemory(db, 1, 'session-b', 'Redis runs on port 6379', 'extracted_fact')

    const tool = createSearchMemoriesTool({ db, getCurrentUserId: () => 1 })
    const result = await tool.execute('tool-call-1', { query: 'postgres port' })
    const text = getTextContent(result)
    const details = getDetails(result)

    expect(text).toContain('[extracted_fact]')
    expect(text).toContain('Session: session-a')
    expect(text).toContain('Postgres runs on port 5432')
    // OR semantics: 'port' also matches the Redis fact, but Postgres ranks first
    expect(details.count).toBe(2)
    expect(text.indexOf('Postgres')).toBeLessThan(text.indexOf('Redis'))
    expect(details.userId).toBe(1)
  })

  it('scopes search results to the current user when available', async () => {
    createMemory(db, 1, 'session-a', 'postgres port is 5432', 'session')
    createMemory(db, 2, 'session-b', 'postgres port is 6432', 'session')

    const tool = createSearchMemoriesTool({ db, getCurrentUserId: () => 2 })
    const result = await tool.execute('tool-call-2', { query: 'postgres' })
    const text = getTextContent(result)

    expect(text).toContain('6432')
    expect(text).not.toContain('5432')
  })

  it('scopes a non-main persona to its own facts plus shared (multi-persona bleeding regression)', async () => {
    createMemory(db, 1, 'session-a', 'analyst postgres fact', 'extracted_fact', 'analyst')
    createMemory(db, 1, 'session-b', 'coder postgres fact', 'extracted_fact', 'coder')
    createMemory(db, 1, 'session-c', 'shared postgres fact', 'extracted_fact', 'shared')
    createMemory(db, 1, 'session-d', 'main postgres fact', 'extracted_fact', 'main')

    const analystTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'analyst' })
    const analystText = getTextContent(await analystTool.execute('tc-w', { query: 'postgres' }))
    expect(analystText).toContain('analyst postgres fact')
    expect(analystText).toContain('shared postgres fact')
    expect(analystText).not.toContain('coder postgres fact')
    expect(analystText).not.toContain('main postgres fact')

    const mainTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'main' })
    const mainText = getTextContent(await mainTool.execute('tc-m', { query: 'postgres' }))
    expect(mainText).toContain('analyst postgres fact')
    expect(mainText).toContain('coder postgres fact')
    expect(mainText).toContain('main postgres fact')
  })

  describe('cross-persona read scope (RC4: agent parameter)', () => {
    const personas = () => ['coder', 'advisor', 'analyst']

    beforeEach(() => {
      createMemory(db, 1, 'session-a', 'analyst postgres fact', 'extracted_fact', 'analyst')
      createMemory(db, 1, 'session-b', 'coder postgres fact', 'extracted_fact', 'coder')
      createMemory(db, 1, 'session-c', 'shared postgres fact', 'extracted_fact', 'shared')
      createMemory(db, 1, 'session-d', 'main postgres fact', 'extracted_fact', 'main')
    })

    it('default (no agent): non-main persona still sees only its own + shared', async () => {
      const coderTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'coder', listAgentIds: personas })
      const text = getTextContent(await coderTool.execute('tc', { query: 'postgres' }))
      expect(text).toContain('coder postgres fact')
      expect(text).toContain('shared postgres fact')
      expect(text).not.toContain('analyst postgres fact')
      expect(text).not.toContain('main postgres fact')
    })

    it('default (no agent): main stays unscoped', async () => {
      const mainTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'main', listAgentIds: personas })
      const text = getTextContent(await mainTool.execute('tc', { query: 'postgres' }))
      expect(text).toContain('coder postgres fact')
      expect(text).toContain('analyst postgres fact')
      expect(text).toContain('main postgres fact')
    })

    it('agent:"main" from a non-main persona returns main rows (+ shared)', async () => {
      const coderTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'coder', listAgentIds: personas })
      const text = getTextContent(await coderTool.execute('tc', { query: 'postgres', agent: 'main' }))
      expect(text).toContain('main postgres fact')
      expect(text).toContain('shared postgres fact')
      expect(text).not.toContain('coder postgres fact')
      expect(text).not.toContain('analyst postgres fact')
    })

    it('agent:"all" returns rows across every persona bucket', async () => {
      const coderTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'coder', listAgentIds: personas })
      const text = getTextContent(await coderTool.execute('tc', { query: 'postgres', agent: 'all', limit: 50 }))
      expect(text).toContain('coder postgres fact')
      expect(text).toContain('analyst postgres fact')
      expect(text).toContain('main postgres fact')
      expect(text).toContain('shared postgres fact')
    })

    it('unknown agent id returns an error, not an empty list', async () => {
      const coderTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'coder', listAgentIds: personas })
      const result = await coderTool.execute('tc', { query: 'postgres', agent: 'researcher' })
      const text = getTextContent(result)
      const details = getDetails(result)
      expect(details.error).toBe(true)
      expect(text).toContain('unknown agent "researcher"')
      expect(text).toContain('all')
      // must NOT be the empty-result message
      expect(text).not.toContain('No memories found')
    })

    it('still applies user-id scoping when combined with a cross-agent value', async () => {
      createMemory(db, 2, 'session-e', 'main postgres user-two fact', 'extracted_fact', 'main')
      const coderTool = createSearchMemoriesTool({
        db,
        getCurrentAgentId: () => 'coder',
        getCurrentUserId: () => 1,
        listAgentIds: personas,
      })
      const text = getTextContent(await coderTool.execute('tc', { query: 'postgres', agent: 'all', limit: 50 }))
      expect(text).toContain('main postgres fact')
      expect(text).not.toContain('user-two fact')
    })
  })

  it('handles empty results gracefully', async () => {
    const tool = createSearchMemoriesTool({ db, getCurrentUserId: () => 1 })
    const result = await tool.execute('tool-call-3', { query: 'no-match-xyz' })
    const text = getTextContent(result)
    const details = getDetails(result)

    expect(text).toContain('No memories found for query "no-match-xyz".')
    expect(details.count).toBe(0)
  })

  it('validates query and limit parameters', async () => {
    const tool = createSearchMemoriesTool({ db })

    const blankQueryResult = await tool.execute('tool-call-4', { query: '   ' })
    expect(getTextContent(blankQueryResult)).toContain('query must be a non-empty string')

    const invalidLimitResult = await tool.execute('tool-call-5', { query: 'postgres', limit: 0 })
    expect(getTextContent(invalidLimitResult)).toContain('limit must be a positive number')
  })

  it('caps limit at 50', async () => {
    for (let i = 0; i < 60; i++) {
      createMemory(db, 1, `session-${i}`, `postgres fact ${i}`, 'session')
    }

    const tool = createSearchMemoriesTool({ db, getCurrentUserId: () => 1 })
    const result = await tool.execute('tool-call-6', { query: 'postgres', limit: 100 })
    const details = getDetails(result)

    expect(details.limit).toBe(50)
    expect(details.count).toBe(50)
  })
})
