import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { createMemory } from './memories-store.js'
import { createSearchMemoriesTool } from './memories-tool.js'

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
    insertUser(db, 2, 'bob')
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
    createMemory(db, 1, 'session-a', 'warren postgres fact', 'extracted_fact', 'warren')
    createMemory(db, 1, 'session-b', 'bob postgres fact', 'extracted_fact', 'bob')
    createMemory(db, 1, 'session-c', 'shared postgres fact', 'extracted_fact', 'shared')
    createMemory(db, 1, 'session-d', 'main postgres fact', 'extracted_fact', 'main')

    const warrenTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'warren' })
    const warrenText = getTextContent(await warrenTool.execute('tc-w', { query: 'postgres' }))
    expect(warrenText).toContain('warren postgres fact')
    expect(warrenText).toContain('shared postgres fact')
    expect(warrenText).not.toContain('bob postgres fact')
    expect(warrenText).not.toContain('main postgres fact')

    const mainTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'main' })
    const mainText = getTextContent(await mainTool.execute('tc-m', { query: 'postgres' }))
    expect(mainText).toContain('warren postgres fact')
    expect(mainText).toContain('bob postgres fact')
    expect(mainText).toContain('main postgres fact')
  })

  describe('cross-persona read scope (RC4: agent parameter)', () => {
    const personas = () => ['bob', 'gekko', 'warren']

    beforeEach(() => {
      createMemory(db, 1, 'session-a', 'warren postgres fact', 'extracted_fact', 'warren')
      createMemory(db, 1, 'session-b', 'bob postgres fact', 'extracted_fact', 'bob')
      createMemory(db, 1, 'session-c', 'shared postgres fact', 'extracted_fact', 'shared')
      createMemory(db, 1, 'session-d', 'main postgres fact', 'extracted_fact', 'main')
    })

    it('default (no agent): non-main persona still sees only its own + shared', async () => {
      const bobTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'bob', listAgentIds: personas })
      const text = getTextContent(await bobTool.execute('tc', { query: 'postgres' }))
      expect(text).toContain('bob postgres fact')
      expect(text).toContain('shared postgres fact')
      expect(text).not.toContain('warren postgres fact')
      expect(text).not.toContain('main postgres fact')
    })

    it('default (no agent): main stays unscoped', async () => {
      const mainTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'main', listAgentIds: personas })
      const text = getTextContent(await mainTool.execute('tc', { query: 'postgres' }))
      expect(text).toContain('bob postgres fact')
      expect(text).toContain('warren postgres fact')
      expect(text).toContain('main postgres fact')
    })

    it('agent:"main" from a non-main persona returns main rows (+ shared)', async () => {
      const bobTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'bob', listAgentIds: personas })
      const text = getTextContent(await bobTool.execute('tc', { query: 'postgres', agent: 'main' }))
      expect(text).toContain('main postgres fact')
      expect(text).toContain('shared postgres fact')
      expect(text).not.toContain('bob postgres fact')
      expect(text).not.toContain('warren postgres fact')
    })

    it('agent:"all" returns rows across every persona bucket', async () => {
      const bobTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'bob', listAgentIds: personas })
      const text = getTextContent(await bobTool.execute('tc', { query: 'postgres', agent: 'all', limit: 50 }))
      expect(text).toContain('bob postgres fact')
      expect(text).toContain('warren postgres fact')
      expect(text).toContain('main postgres fact')
      expect(text).toContain('shared postgres fact')
    })

    it('unknown agent id returns an error, not an empty list', async () => {
      const bobTool = createSearchMemoriesTool({ db, getCurrentAgentId: () => 'bob', listAgentIds: personas })
      const result = await bobTool.execute('tc', { query: 'postgres', agent: 'schluchti' })
      const text = getTextContent(result)
      const details = getDetails(result)
      expect(details.error).toBe(true)
      expect(text).toContain('unknown agent "schluchti"')
      expect(text).toContain('all')
      // must NOT be the empty-result message
      expect(text).not.toContain('No memories found')
    })

    it('still applies user-id scoping when combined with a cross-agent value', async () => {
      createMemory(db, 2, 'session-e', 'main postgres user-two fact', 'extracted_fact', 'main')
      const bobTool = createSearchMemoriesTool({
        db,
        getCurrentAgentId: () => 'bob',
        getCurrentUserId: () => 1,
        listAgentIds: personas,
      })
      const text = getTextContent(await bobTool.execute('tc', { query: 'postgres', agent: 'all', limit: 50 }))
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
