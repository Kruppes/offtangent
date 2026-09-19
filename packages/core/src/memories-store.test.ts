import { beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  createMemory,
  deleteMemory,
  getMemoryById,
  listMemories,
  searchMemories,
  updateMemory,
} from './memories-store.js'

function insertUser(db: Database, id: number, username: string): void {
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
  ).run(id, username, 'hash', 'user')
}

describe('memories-store', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    insertUser(db, 1, 'alice')
    insertUser(db, 2, 'bob')
  })

  it('creates and fetches a memory by id', () => {
    const id = createMemory(db, 1, 'session-a', 'Postgres runs on port 5432', 'extracted_fact')

    const memory = getMemoryById(db, id)
    expect(memory).toMatchObject({
      id,
      userId: 1,
      sessionId: 'session-a',
      content: 'Postgres runs on port 5432',
      source: 'extracted_fact',
    })
    expect(memory?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} /)
  })

  it('searches memories with FTS5 and orders by BM25 relevance', () => {
    createMemory(db, 1, 'session-a', 'postgres quickstart guide', 'session')
    createMemory(db, 1, 'session-b', 'postgres postgres port is 5432', 'session')
    createMemory(db, 1, 'session-c', 'redis port is 6379', 'session')

    const results = searchMemories(db, 'postgres', { userId: 1 })

    expect(results).toHaveLength(2)
    expect(results[0].content).toBe('postgres postgres port is 5432')
    expect(results[1].content).toBe('postgres quickstart guide')
  })

  it('returns partial matches for multi-keyword plain queries', () => {
    createMemory(db, 1, 'session-a', 'User prefers dark mode', 'session')

    const results = searchMemories(db, 'dark mode terminal settings', { userId: 1 })

    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('User prefers dark mode')
  })

  it('ranks facts matching more query tokens above facts matching fewer', () => {
    createMemory(db, 1, 'session-a', 'Deploys with docker on the server', 'session')
    createMemory(db, 1, 'session-b', 'Runs docker compose on the staging server', 'session')

    const results = searchMemories(db, 'docker compose staging', { userId: 1 })

    expect(results).toHaveLength(2)
    expect(results[0].content).toBe('Runs docker compose on the staging server')
  })

  it('keeps explicit boolean operators as strict filters', () => {
    createMemory(db, 1, 'session-a', 'postgres port is 5432', 'session')
    createMemory(db, 1, 'session-b', 'postgres backup schedule', 'session')

    const results = searchMemories(db, 'postgres AND port', { userId: 1 })

    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('postgres port is 5432')
  })

  it('keeps quoted phrase queries strict', () => {
    createMemory(db, 1, 'session-a', 'prefers dark mode', 'session')
    createMemory(db, 1, 'session-b', 'dark roast coffee mode', 'session')

    const results = searchMemories(db, '"dark mode"', { userId: 1 })

    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('prefers dark mode')
  })

  it('keeps wildcard queries unchanged', () => {
    createMemory(db, 1, 'session-a', 'postgresql tuning notes', 'session')

    const results = searchMemories(db, 'postgre*', { userId: 1 })

    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('postgresql tuning notes')
  })

  it('respects user scoping in searchMemories', () => {
    createMemory(db, 1, 'session-a', 'postgres port is 5432', 'session')
    createMemory(db, 2, 'session-b', 'postgres port is 6432', 'session')

    const results = searchMemories(db, 'postgres', { userId: 2 })

    expect(results).toHaveLength(1)
    expect(results[0].userId).toBe(2)
    expect(results[0].content).toContain('6432')
  })

  it('scopes searchMemories to a persona plus shared facts (multi-persona bleeding regression)', () => {
    createMemory(db, 1, 'session-a', 'warren postgres fact', 'extracted_fact', 'warren')
    createMemory(db, 1, 'session-b', 'bob postgres fact', 'extracted_fact', 'bob')
    createMemory(db, 1, 'session-c', 'shared postgres fact', 'extracted_fact', 'shared')
    createMemory(db, 1, 'session-d', 'main postgres fact', 'extracted_fact', 'main')

    const warrenResults = searchMemories(db, 'postgres', { agentId: 'warren' })
    expect(warrenResults.map(f => f.content).sort()).toEqual(['shared postgres fact', 'warren postgres fact'])
    expect(warrenResults.every(f => f.agentId === 'warren' || f.agentId === 'shared')).toBe(true)

    // Unscoped (main / legacy) search still sees everything
    const allResults = searchMemories(db, 'postgres', {})
    expect(allResults).toHaveLength(4)
  })

  it('lists memories with pagination and correct total count', () => {
    createMemory(db, 1, 'session-1', 'alpha memory', 'session')
    createMemory(db, 1, 'session-2', 'beta memory', 'session')
    createMemory(db, 1, 'session-3', 'gamma memory', 'session')

    const page = listMemories(db, { userId: 1, limit: 2, offset: 1 })

    expect(page.total).toBe(3)
    expect(page.facts).toHaveLength(2)
    expect(page.facts.map(fact => fact.content)).toEqual(['beta memory', 'alpha memory'])
  })

  it('supports query filtering in listMemories', () => {
    createMemory(db, 1, 'session-1', 'docker container deployed', 'session')
    createMemory(db, 1, 'session-2', 'docker image built', 'session')
    createMemory(db, 1, 'session-3', 'postgres database ready', 'session')

    const page = listMemories(db, { userId: 1, query: 'docker', limit: 10, offset: 0 })

    expect(page.total).toBe(2)
    expect(page.facts).toHaveLength(2)
    expect(page.facts.every(fact => fact.content.includes('docker'))).toBe(true)
  })

  it('treats punctuation-heavy UI queries as plain text instead of raw FTS syntax', () => {
    createMemory(db, 1, 'session-special', 'Uses C# (legacy) stack', 'session')

    expect(() => listMemories(db, {
      userId: 1,
      query: 'C# (legacy)',
      limit: 10,
      offset: 0,
    })).not.toThrow()

    const page = listMemories(db, {
      userId: 1,
      query: 'C# (legacy)',
      limit: 10,
      offset: 0,
    })
    expect(page.total).toBe(1)
    expect(page.facts[0].content).toBe('Uses C# (legacy) stack')
  })

  it('sanitizes unmatched quotes in plain-text queries', () => {
    createMemory(db, 1, 'session-quote', 'User prefers dark mode', 'session')

    const page = listMemories(db, {
      userId: 1,
      query: '"dark mode',
      limit: 10,
      offset: 0,
    })

    expect(page.total).toBe(1)
    expect(page.facts[0].content).toBe('User prefers dark mode')
  })

  it('updates the FTS index when a memory is created', () => {
    const id = createMemory(db, 1, 'session-a', 'Remember the postgres port', 'session')

    const ftsRow = db.prepare(
      'SELECT rowid, content FROM memories_fts WHERE rowid = ?'
    ).get(id) as { rowid: number; content: string } | undefined

    expect(ftsRow).toEqual({ rowid: id, content: 'Remember the postgres port' })
    expect(searchMemories(db, 'postgres', { userId: 1 }).map(fact => fact.id)).toEqual([id])
  })

  it('updates the FTS index when a memory is updated', () => {
    const id = createMemory(db, 1, 'session-a', 'Old mysql detail', 'session')

    updateMemory(db, id, 'New postgres detail')

    const ftsRow = db.prepare(
      'SELECT rowid, content FROM memories_fts WHERE rowid = ?'
    ).get(id) as { rowid: number; content: string } | undefined

    expect(ftsRow).toEqual({ rowid: id, content: 'New postgres detail' })
    expect(searchMemories(db, 'postgres', { userId: 1 }).map(fact => fact.id)).toEqual([id])
    expect(searchMemories(db, 'mysql', { userId: 1 })).toHaveLength(0)
  })

  it('cleans the FTS index when a memory is deleted', () => {
    const id = createMemory(db, 1, 'session-a', 'Temporary postgres detail', 'session')

    deleteMemory(db, id)

    const ftsRow = db.prepare('SELECT rowid FROM memories_fts WHERE rowid = ?').get(id)
    expect(ftsRow).toBeUndefined()
    expect(getMemoryById(db, id)).toBeNull()
    expect(searchMemories(db, 'postgres', { userId: 1 })).toHaveLength(0)
  })
})
