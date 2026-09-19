import { describe, expect, it, beforeEach } from 'vitest'
import { createRecallMessageTool } from './recall-message-tool.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'

function text(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}

function details(result: Awaited<ReturnType<AgentTool['execute']>>): Record<string, unknown> {
  return (result as { details: Record<string, unknown> }).details ?? {}
}

describe('recall_message tool', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u1', 'h', 'admin')").run()
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'u2', 'h', 'user')").run()
    db.prepare("INSERT INTO sessions (id, user_id, source, type) VALUES ('s1', 1, 'web', 'interactive')").run()
    db.prepare(
      "INSERT INTO chat_messages (id, session_id, user_id, role, content, agent_id) VALUES (10, 's1', 1, 'assistant', ?, 'main')",
    ).run('The full original answer. '.repeat(20))
    db.prepare(
      "INSERT INTO chat_messages (id, session_id, user_id, role, content, metadata, agent_id) VALUES (11, 's1', 1, 'tool', 'Tool: shell', ?, 'main')",
    ).run(JSON.stringify({ toolName: 'shell', toolArgs: { command: 'ls' }, toolResult: 'a.txt\nb.txt' }))
    db.prepare(
      "INSERT INTO chat_messages (id, session_id, user_id, role, content, agent_id) VALUES (12, 's1', 1, 'assistant', 'bob only', 'bob')",
    ).run()
  })

  it('returns the verbatim content with the recalled marker', async () => {
    const tool = createRecallMessageTool({ db, getCurrentUserId: () => 1 })
    const r = await tool.execute('c1', { message_id: 10 })
    const t = text(r)
    expect(t.startsWith('[recalled] message 10 (assistant')).toBe(true)
    expect(t).toContain('The full original answer. The full original answer.')
    expect(details(r).messageId).toBe(10)
  })

  it('renders tool rows from their stored result', async () => {
    const tool = createRecallMessageTool({ db })
    const r = await tool.execute('c1', { message_id: 11 })
    const t = text(r)
    expect(t).toContain('Tool: shell')
    expect(t).toContain('"command":"ls"')
    expect(t).toContain('a.txt\nb.txt')
  })

  it('pages long messages by offset', async () => {
    const tool = createRecallMessageTool({ db, maxChars: 100 })
    const first = await tool.execute('c1', { message_id: 10 })
    expect(text(first)).toContain('more chars, call again with offset=100')
    const second = await tool.execute('c1', { message_id: 10, offset: 100 })
    expect(details(second).offset).toBe(100)
    expect(details(second).remaining).toBe(520 - 200)
  })

  it('hides rows of another user and of another persona', async () => {
    const otherUser = createRecallMessageTool({ db, getCurrentUserId: () => 2 })
    const r1 = await otherUser.execute('c1', { message_id: 10 })
    expect(details(r1).notFound).toBe(true)

    const bob = createRecallMessageTool({ db, getCurrentAgentId: () => 'bob' })
    const r2 = await bob.execute('c1', { message_id: 10 })
    expect(details(r2).notFound).toBe(true)
    const r3 = await bob.execute('c1', { message_id: 12 })
    expect(text(r3)).toContain('bob only')
  })

  it('rejects a non numeric id', async () => {
    const tool = createRecallMessageTool({ db })
    const r = await tool.execute('c1', { message_id: -1 })
    expect(details(r).error).toBe(true)
  })
})
