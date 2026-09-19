import { describe, expect, it, beforeEach } from 'vitest'
import { createReadChatHistoryTool } from './chat-history-tools.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'

function insertMessage(
  db: Database,
  sessionId: string,
  role: string,
  content: string,
  timestamp: string,
  userId: number | null = 1,
  metadata: string | null = null,
) {
  db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sessionId, userId, role, content, metadata, timestamp)
}

/**
 * Seed a session row so the `read_chat_history` source filter (which joins
 * the `sessions` table) can resolve its type/source metadata. Safe to call
 * multiple times for the same id — subsequent calls are ignored.
 */
function ensureSession(
  db: Database,
  sessionId: string,
  type: 'interactive' | 'task' | 'heartbeat' | 'consolidation' | 'loop_detection',
  source: string,
) {
  db.prepare(
    'INSERT OR IGNORE INTO sessions (id, user_id, source, type) VALUES (?, ?, ?, ?)',
  ).run(sessionId, 1, source, type)
}

function getTextContent(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  if (!result || !('content' in result)) return ''
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}

function getDetails(result: Awaited<ReturnType<AgentTool['execute']>>): Record<string, unknown> {
  if (!result || !('details' in result)) return {}
  return (result as { details: Record<string, unknown> }).details
}

describe('read_chat_history tool', () => {
  let db: Database
  let tool: AgentTool

  beforeEach(() => {
    db = initDatabase(':memory:')
    tool = createReadChatHistoryTool({ db })

    // Create a test user to satisfy foreign key constraints
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'testuser', 'hash', 'admin')",
    ).run()

    // Seed test sessions with explicit type/source metadata. After PRD #11
    // the source filter resolves via JOIN on `sessions.type`/`sessions.source`
    // rather than session_id string prefixes.
    ensureSession(db, 'session-1-abc', 'interactive', 'web')
    ensureSession(db, 'web-1-xyz', 'interactive', 'web')
    ensureSession(db, 'telegram-42-abc', 'interactive', 'telegram')
    ensureSession(db, 'task-heartbeat-123', 'heartbeat', 'system')
    ensureSession(db, 'session-1-def', 'interactive', 'web')

    // Seed test data
    insertMessage(db, 'session-1-abc', 'user', 'Hello, how are you?', '2025-04-04 10:00:00')
    insertMessage(db, 'session-1-abc', 'assistant', 'I am doing great!', '2025-04-04 10:00:05')
    insertMessage(db, 'session-1-abc', 'user', 'Tell me about AI', '2025-04-04 10:05:00')
    insertMessage(db, 'session-1-abc', 'assistant', 'AI is a broad field...', '2025-04-04 10:05:10')

    insertMessage(db, 'web-1-xyz', 'user', 'Web message here', '2025-04-04 14:00:00')
    insertMessage(db, 'web-1-xyz', 'assistant', 'Web response', '2025-04-04 14:00:05')

    insertMessage(db, 'telegram-42-abc', 'user', 'Telegram message', '2025-04-04 16:00:00')
    insertMessage(db, 'telegram-42-abc', 'assistant', 'Telegram response', '2025-04-04 16:00:05')

    insertMessage(db, 'task-heartbeat-123', 'assistant', 'Heartbeat done', '2025-04-04 18:00:00')

    insertMessage(db, 'session-1-def', 'user', 'Next day message', '2025-04-05 09:00:00')
    insertMessage(db, 'session-1-def', 'assistant', 'Next day response', '2025-04-05 09:00:05')
  })

  it('returns all messages without filters', async () => {
    const result = await tool.execute('tc-1', { limit: 50 })
    const details = getDetails(result)
    expect(details.total).toBe(11)
    expect(details.count).toBe(11)
  })

  it('filters by start datetime', async () => {
    const result = await tool.execute('tc-1', { start: '2025-04-04T14:00:00' })
    const details = getDetails(result)
    expect(details.total).toBe(7) // web (14:00, 14:00:05) + telegram (16:00, 16:00:05) + task (18:00) + next day (09:00, 09:00:05)
  })

  it('filters by end datetime', async () => {
    const result = await tool.execute('tc-1', { end: '2025-04-04T14:00:00' })
    const details = getDetails(result)
    expect(details.total).toBe(4) // The 4 session-1-abc messages at 10:00-10:05
  })

  it('filters by start and end datetime range', async () => {
    const result = await tool.execute('tc-1', {
      start: '2025-04-04T14:00:00',
      end: '2025-04-04T17:00:00',
    })
    const details = getDetails(result)
    expect(details.total).toBe(4) // web (14:00, 14:00:05) + telegram (16:00, 16:00:05)
  })

  it('filters by date-only (expands to full day)', async () => {
    const result = await tool.execute('tc-1', {
      start: '2025-04-05',
      end: '2025-04-06',
    })
    const details = getDetails(result)
    expect(details.total).toBe(2) // next day messages
  })

  it('filters by source: web', async () => {
    const result = await tool.execute('tc-1', { source: 'web' })
    const details = getDetails(result)
    // session-1-abc (4) + web-1-xyz (2) + session-1-def (2) = 8
    expect(details.total).toBe(8)
  })

  it('filters by source: telegram', async () => {
    const result = await tool.execute('tc-1', { source: 'telegram' })
    const details = getDetails(result)
    expect(details.total).toBe(2)
  })

  it('filters by source: task', async () => {
    const result = await tool.execute('tc-1', { source: 'task' })
    const details = getDetails(result)
    expect(details.total).toBe(1) // task-heartbeat-123
  })

  it('filters by role', async () => {
    const result = await tool.execute('tc-1', { role: 'user' })
    const details = getDetails(result)
    expect(details.total).toBe(5) // all user messages
  })

  it('filters by session_id', async () => {
    const result = await tool.execute('tc-1', { session_id: 'web-1-xyz' })
    const details = getDetails(result)
    expect(details.total).toBe(2)
  })

  it('combines multiple filters', async () => {
    const result = await tool.execute('tc-1', {
      start: '2025-04-04T10:00:00',
      end: '2025-04-04T10:06:00',
      role: 'user',
    })
    const details = getDetails(result)
    expect(details.total).toBe(2) // user messages at 10:00:00 and 10:05:00
  })

  it('respects limit', async () => {
    const result = await tool.execute('tc-1', { limit: 3 })
    const details = getDetails(result)
    expect(details.count).toBe(3)
    expect(details.total).toBe(11)
  })

  it('respects offset for pagination', async () => {
    const result = await tool.execute('tc-1', { limit: 3, offset: 3 })
    const details = getDetails(result)
    expect(details.count).toBe(3)
    expect(details.offset).toBe(3)
  })

  it('caps limit at 500', async () => {
    const result = await tool.execute('tc-1', { limit: 1000 })
    const details = getDetails(result)
    expect(details.limit).toBe(500)
  })

  it('returns empty result with filter description', async () => {
    const result = await tool.execute('tc-1', {
      start: '2030-01-01',
      end: '2030-01-02',
    })
    const text = getTextContent(result)
    expect(text).toContain('No chat messages found')
    expect(text).toContain('2030-01-01')
  })

  it('rejects invalid start datetime', async () => {
    const result = await tool.execute('tc-1', { start: 'not-a-date' })
    const text = getTextContent(result)
    expect(text).toContain('Error: Invalid start datetime')
  })

  it('rejects invalid end datetime', async () => {
    const result = await tool.execute('tc-1', { end: 'garbage' })
    const text = getTextContent(result)
    expect(text).toContain('Error: Invalid end datetime')
  })

  it('rejects invalid source', async () => {
    const result = await tool.execute('tc-1', { source: 'invalid' })
    const text = getTextContent(result)
    expect(text).toContain('Error: Invalid source')
  })

  it('rejects invalid role', async () => {
    const result = await tool.execute('tc-1', { role: 'admin' })
    const text = getTextContent(result)
    expect(text).toContain('Error: Invalid role')
  })

  it('messages are in chronological order', async () => {
    const result = await tool.execute('tc-1', { limit: 50 })
    const text = getTextContent(result)
    const timestamps = text.match(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/g) ?? []
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] >= timestamps[i - 1]).toBe(true)
    }
  })

  it('truncates very long messages', async () => {
    const longContent = 'A'.repeat(3000)
    insertMessage(db, 'session-long', 'user', longContent, '2025-04-06 12:00:00')

    const result = await tool.execute('tc-1', { session_id: 'session-long' })
    const text = getTextContent(result)
    expect(text).toContain('truncated')
    expect(text).toContain('3000 chars total')
  })

  it('includes source label in output', async () => {
    const result = await tool.execute('tc-1', { session_id: 'telegram-42-abc' })
    const text = getTextContent(result)
    expect(text).toContain('[telegram]')
  })

  it('shows pagination hint when there are more results', async () => {
    const result = await tool.execute('tc-1', { limit: 3 })
    const text = getTextContent(result)
    expect(text).toContain('offset=3')
  })

  describe('query parameter', () => {
    it('filters messages by content match', async () => {
      const result = await tool.execute('tc-1', { query: 'Tell me about AI' })
      const details = getDetails(result)
      expect(details.total).toBe(1)
      const text = getTextContent(result)
      expect(text).toContain('Tell me about AI')
    })

    it('is case-insensitive', async () => {
      const result = await tool.execute('tc-1', { query: 'tell me about ai' })
      const details = getDetails(result)
      expect(details.total).toBe(1)
    })

    it('uses FTS word matching for message content', async () => {
      insertMessage(db, 'session-fts-word', 'user', 'Server-Setup checklist is ready', '2025-04-06 09:00:00')
      insertMessage(db, 'session-fts-word', 'assistant', 'The database backup finished', '2025-04-06 09:00:05')
      insertMessage(db, 'session-fts-word', 'assistant', 'myserveralias should not match a token search', '2025-04-06 09:00:10')

      const result = await tool.execute('tc-1', { query: 'server' })
      const details = getDetails(result)
      const text = getTextContent(result)

      expect(details.total).toBe(1)
      expect(text).toContain('Server-Setup checklist is ready')
      expect(text).not.toContain('myserveralias should not match a token search')
    })

    it('supports phrase matching', async () => {
      insertMessage(db, 'session-fts-phrase', 'user', 'The memory system stores important facts', '2025-04-06 10:00:00')
      insertMessage(db, 'session-fts-phrase', 'assistant', 'The system for memory is separate', '2025-04-06 10:00:05')

      const result = await tool.execute('tc-1', { query: '"memory system"' })
      const details = getDetails(result)
      const text = getTextContent(result)

      expect(details.total).toBe(1)
      expect(text).toContain('The memory system stores important facts')
      expect(text).not.toContain('The system for memory is separate')
    })

    it('supports prefix matching', async () => {
      insertMessage(db, 'session-fts-prefix', 'user', 'config loaded successfully', '2025-04-06 11:00:00')
      insertMessage(db, 'session-fts-prefix', 'assistant', 'The configuration file was updated', '2025-04-06 11:00:05')
      insertMessage(db, 'session-fts-prefix', 'assistant', 'Service configured and running', '2025-04-06 11:00:10')

      const result = await tool.execute('tc-1', { query: 'config*' })
      const details = getDetails(result)
      const text = getTextContent(result)

      expect(details.total).toBe(3)
      expect(text).toContain('config loaded successfully')
      expect(text).toContain('The configuration file was updated')
      expect(text).toContain('Service configured and running')
    })

    it('orders FTS matches by BM25 relevance before timestamp', async () => {
      insertMessage(db, 'session-fts-rank', 'user', 'docker quickstart guide', '2025-04-06 08:00:00')
      insertMessage(db, 'session-fts-rank', 'assistant', 'docker docker docker container image', '2025-04-06 20:00:00')

      const result = await tool.execute('tc-1', { query: 'docker' })
      const text = getTextContent(result)

      expect(text.indexOf('docker docker docker container image')).toBeLessThan(
        text.indexOf('docker quickstart guide'),
      )
    })

    it('combines FTS queries with other filters', async () => {
      ensureSession(db, 'telegram-99-filter', 'interactive', 'telegram')
      ensureSession(db, 'web-99-filter', 'interactive', 'web')
      insertMessage(db, 'telegram-99-filter', 'assistant', 'Docker container deployed', '2025-04-06 12:00:00')
      insertMessage(db, 'telegram-99-filter', 'user', 'Docker container deployed', '2025-04-06 12:00:05')
      insertMessage(db, 'web-99-filter', 'assistant', 'Docker container deployed', '2025-04-06 12:00:10')

      const result = await tool.execute('tc-1', {
        query: 'docker',
        source: 'telegram',
        role: 'assistant',
        session_id: 'telegram-99-filter',
        start: '2025-04-06T11:59:00',
        end: '2025-04-06T12:00:01',
      })
      const details = getDetails(result)
      const text = getTextContent(result)

      expect(details.total).toBe(1)
      expect(text).toContain('Docker container deployed')
      expect(text).toContain('[telegram]')
      expect(text).toContain('[assistant]')
    })

    it('paginates FTS results correctly', async () => {
      insertMessage(db, 'session-fts-pagination', 'user', 'docker alpha', '2025-04-06 07:00:00')
      insertMessage(db, 'session-fts-pagination', 'user', 'docker beta beta', '2025-04-06 07:00:05')
      insertMessage(db, 'session-fts-pagination', 'user', 'docker gamma gamma gamma', '2025-04-06 07:00:10')

      const result = await tool.execute('tc-1', { query: 'docker', limit: 1, offset: 1 })
      const details = getDetails(result)
      const text = getTextContent(result)

      expect(details.total).toBe(3)
      expect(details.count).toBe(1)
      expect(details.offset).toBe(1)
      expect(text).toContain('Showing 2–2 of 3 messages')
    })

    it('returns no results for non-matching query', async () => {
      const result = await tool.execute('tc-1', { query: 'xyzzy-no-match-12345' })
      const details = getDetails(result)
      expect(details.total).toBe(0)
    })

    it('combines query with role filter', async () => {
      // 'I am doing great!' is assistant; user messages contain 'Hello' and 'Tell me'
      const result = await tool.execute('tc-1', { query: 'I am doing great', role: 'assistant' })
      const details = getDetails(result)
      expect(details.total).toBe(1)
      const text = getTextContent(result)
      expect(text).toContain('[assistant]')
    })

    it('combines query with datetime filter', async () => {
      // 'Web message here' is at 14:00:00; restrict to before that
      const result = await tool.execute('tc-1', { query: 'Web message', end: '2025-04-04T13:00:00' })
      const details = getDetails(result)
      expect(details.total).toBe(0)
    })

    it('includes query in filter details', async () => {
      const result = await tool.execute('tc-1', { query: 'Hello' })
      const details = getDetails(result)
      const filters = details.filters as Record<string, unknown>
      expect(filters.query).toBe('Hello')
    })

    it('includes query in empty-result filter description', async () => {
      const result = await tool.execute('tc-1', { query: 'no-match-xyz' })
      const text = getTextContent(result)
      expect(text).toContain('no-match-xyz')
    })

    it('matches tool call input/output via LIKE fallback', async () => {
      // Insert a tool call whose input contains a unique string NOT present in any chat_message content
      db.prepare(
        'INSERT INTO tool_calls (session_id, tool_name, input, output, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run('session-1-abc', 'web_fetch', '{"url":"https://example.com/secret-page-xyz"}', 'Fetched content', '2025-04-04 10:00:30')

      // The chat messages in session-1-abc do NOT contain 'secret-page-xyz' in their content,
      // so these results must come from the tool call fallback path.
      const result = await tool.execute('tc-1', { query: 'secret-page-xyz' })
      const details = getDetails(result)
      const text = getTextContent(result)

      expect(details.total).toBe(4)
      expect(text).toContain('Hello, how are you?')
      expect(text).not.toContain('secret-page-xyz')
    })

    it('sanitizes punctuation-heavy plain-text queries before sending them to FTS', async () => {
      insertMessage(db, 'session-fts-special', 'user', 'Uses C# (legacy) stack', '2025-04-06 13:00:00')

      const result = await tool.execute('tc-1', { query: 'C# (legacy)' })
      const details = getDetails(result)
      const text = getTextContent(result)

      expect(details.total).toBe(1)
      expect(text).toContain('Uses C# (legacy) stack')
    })
  })

  describe('persona scoping (multi-persona bleeding regression)', () => {
    function insertAgentMessage(sessionId: string, content: string, agentId: string, ts: string) {
      db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content, timestamp, agent_id) VALUES (?, 1, ?, ?, ?, ?)',
      ).run(sessionId, 'assistant', content, ts, agentId)
    }

    it('a non-main persona only sees its own messages', async () => {
      insertAgentMessage('session-1-abc', 'warren portfolio update', 'warren', '2025-04-07 10:00:00')
      insertAgentMessage('session-1-abc', 'bob workshop update', 'bob', '2025-04-07 10:01:00')

      const warrenTool = createReadChatHistoryTool({ db, getCurrentAgentId: () => 'warren' })
      const result = await warrenTool.execute('tc-1', { start: '2025-04-07', end: '2025-04-08' })
      const text = getTextContent(result)

      expect(text).toContain('warren portfolio update')
      expect(text).not.toContain('bob workshop update')
    })

    it('main stays unscoped (orchestrator sees everything)', async () => {
      insertAgentMessage('session-1-abc', 'warren portfolio update', 'warren', '2025-04-07 10:00:00')
      insertAgentMessage('session-1-abc', 'bob workshop update', 'bob', '2025-04-07 10:01:00')

      const mainTool = createReadChatHistoryTool({ db, getCurrentAgentId: () => 'main' })
      const result = await mainTool.execute('tc-1', { start: '2025-04-07', end: '2025-04-08' })
      const text = getTextContent(result)

      expect(text).toContain('warren portfolio update')
      expect(text).toContain('bob workshop update')
    })
  })

  describe('cross-persona read scope (RC4: agent parameter)', () => {
    const personas = () => ['bob', 'gekko', 'warren']

    function insertAgentMessage(sessionId: string, content: string, agentId: string, ts: string, userId = 1) {
      db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content, timestamp, agent_id) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(sessionId, userId, 'assistant', content, ts, agentId)
    }

    it('default (no agent): non-main persona still sees only its own bucket', async () => {
      insertAgentMessage('session-1-abc', 'warren portfolio update', 'warren', '2025-04-07 10:00:00')
      insertAgentMessage('session-1-abc', 'bob workshop update', 'bob', '2025-04-07 10:01:00')

      const bobTool = createReadChatHistoryTool({ db, getCurrentAgentId: () => 'bob', listAgentIds: personas })
      const text = getTextContent(await bobTool.execute('tc', { start: '2025-04-07', end: '2025-04-08' }))
      expect(text).toContain('bob workshop update')
      expect(text).not.toContain('warren portfolio update')
    })

    it('agent:"main" from a non-main persona returns main rows', async () => {
      insertAgentMessage('session-1-abc', 'bob workshop update', 'bob', '2025-04-07 10:00:00')
      insertAgentMessage('session-1-abc', 'main orchestrator note', 'main', '2025-04-07 10:01:00')

      const bobTool = createReadChatHistoryTool({ db, getCurrentAgentId: () => 'bob', listAgentIds: personas })
      const text = getTextContent(await bobTool.execute('tc', { start: '2025-04-07', end: '2025-04-08', agent: 'main' }))
      expect(text).toContain('main orchestrator note')
      expect(text).not.toContain('bob workshop update')
    })

    it('agent:"all" returns rows across multiple agent buckets', async () => {
      insertAgentMessage('session-1-abc', 'warren portfolio update', 'warren', '2025-04-07 10:00:00')
      insertAgentMessage('session-1-abc', 'bob workshop update', 'bob', '2025-04-07 10:01:00')
      insertAgentMessage('session-1-abc', 'main orchestrator note', 'main', '2025-04-07 10:02:00')

      const bobTool = createReadChatHistoryTool({ db, getCurrentAgentId: () => 'bob', listAgentIds: personas })
      const text = getTextContent(await bobTool.execute('tc', { start: '2025-04-07', end: '2025-04-08', agent: 'all' }))
      expect(text).toContain('warren portfolio update')
      expect(text).toContain('bob workshop update')
      expect(text).toContain('main orchestrator note')
    })

    it('unknown agent id returns an error, not an empty list', async () => {
      insertAgentMessage('session-1-abc', 'bob workshop update', 'bob', '2025-04-07 10:00:00')

      const bobTool = createReadChatHistoryTool({ db, getCurrentAgentId: () => 'bob', listAgentIds: personas })
      const result = await bobTool.execute('tc', { start: '2025-04-07', end: '2025-04-08', agent: 'schluchti' })
      const text = getTextContent(result)
      const details = getDetails(result)
      expect(details.error).toBe(true)
      expect(text).toContain('unknown agent "schluchti"')
      expect(text).not.toContain('No chat messages found')
    })

    it('finds a freshly inserted message from another persona (in-progress session case)', async () => {
      // Simulate a message just written to another persona's live session.
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
      insertAgentMessage('session-live-xyz', 'gekko just said something important', 'gekko', now)

      const bobTool = createReadChatHistoryTool({ db, getCurrentAgentId: () => 'bob', listAgentIds: personas })
      // Default scope: bob cannot see it.
      const defaultText = getTextContent(await bobTool.execute('tc', { query: 'important' }))
      expect(defaultText).not.toContain('gekko just said something important')
      // Cross-persona: bob reads gekko's fresh message on demand.
      const crossText = getTextContent(await bobTool.execute('tc', { query: 'important', agent: 'gekko' }))
      expect(crossText).toContain('gekko just said something important')
    })

    it('still applies user-id scoping is not our axis, but agent scope + shared works', async () => {
      // 'shared'-tagged messages are included for an explicit concrete id.
      insertAgentMessage('session-1-abc', 'main note here', 'main', '2025-04-07 10:00:00')
      insertAgentMessage('session-1-abc', 'shared cross note', 'shared', '2025-04-07 10:01:00')
      insertAgentMessage('session-1-abc', 'bob private note', 'bob', '2025-04-07 10:02:00')

      const bobTool = createReadChatHistoryTool({ db, getCurrentAgentId: () => 'bob', listAgentIds: personas })
      const text = getTextContent(await bobTool.execute('tc', { start: '2025-04-07', end: '2025-04-08', agent: 'main' }))
      expect(text).toContain('main note here')
      expect(text).toContain('shared cross note')
      expect(text).not.toContain('bob private note')
    })
  })
})
