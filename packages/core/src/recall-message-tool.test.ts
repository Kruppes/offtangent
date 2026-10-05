import { describe, expect, it, beforeEach } from 'vitest'
import { createRecallMessageTool } from './recall-message-tool.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createYoloTools } from './agent-runtime.js'
import { freezeEcoToolResult } from './eco-tool-freeze.js'

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
      "INSERT INTO chat_messages (id, session_id, user_id, role, content, agent_id) VALUES (12, 's1', 1, 'assistant', 'coder only', 'coder')",
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

    const coder = createRecallMessageTool({ db, getCurrentAgentId: () => 'coder' })
    const r2 = await coder.execute('c1', { message_id: 10 })
    expect(details(r2).notFound).toBe(true)
    const r3 = await coder.execute('c1', { message_id: 12 })
    expect(text(r3)).toContain('coder only')
  })

  it('Eco original (eco_original): only the owning user AND persona get the verbatim original back', async () => {
    const big = Array.from({ length: 400 }, (_, i) => `row ${i} synthetic payload text ${i}`).join('\n') + '\nSECRET-MIDDLE-FACT-USER1'
    const frozen = freezeEcoToolResult({
      db, sessionId: 's1', userId: 1, ownerUserId: 1, agentId: 'main', toolName: 'shell', toolCallId: 'tc-user-scope',
      args: { command: 'npm test' }, content: [{ type: 'text', text: big }], details: undefined, isError: false,
    })!
    expect(frozen).not.toBeNull()
    const rowId = (frozen.details as { eco: { rowId: number } }).eco.rowId
    const owner = await createRecallMessageTool({ db, getCurrentUserId: () => 1, getCurrentAgentId: () => 'main', getCurrentSessionId: () => 's1', maxChars: 100000 }).execute('c', { message_id: rowId })
    expect(text(owner)).toContain('SECRET-MIDDLE-FACT-USER1')
    const otherUser = await createRecallMessageTool({ db, getCurrentUserId: () => 2, getCurrentAgentId: () => 'main', maxChars: 100000 }).execute('c', { message_id: rowId })
    expect(details(otherUser).notFound).toBe(true)
    expect(text(otherUser)).not.toContain('SECRET-MIDDLE-FACT-USER1')
    const otherPersona = await createRecallMessageTool({ db, getCurrentUserId: () => 1, getCurrentAgentId: () => 'coder', getCurrentSessionId: () => 's1', maxChars: 100000 }).execute('c', { message_id: rowId })
    expect(details(otherPersona).notFound).toBe(true)
  })

  it('rejects a non numeric id', async () => {
    const tool = createRecallMessageTool({ db })
    const r = await tool.execute('c1', { message_id: -1 })
    expect(details(r).error).toBe(true)
  })
  it('tool cap runs inside the tool BEFORE storage: recall labels the stored text as tool-capped, never as raw', async () => {
    // Real shell tool, synthetic output above the default caps.
    const shell = createYoloTools().find(t => t.name === 'shell')!
    const result = await shell.execute('cap1', { command: "python3 -c \"print('SYNTHETIC-HEAD'); print('x'*60000); print('SYNTHETIC-TAIL')\"" })
    const resDetails = (result as { details?: { truncated?: boolean } }).details
    expect(resDetails?.truncated).toBe(true)
    // Persist exactly what the runtime persists for tool rows (event.result).
    const info = db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      's1', 1, 'tool', 'Tool: shell', JSON.stringify({ toolName: 'shell', toolCallId: 'cap1', toolArgs: {}, toolResult: result }), 'main')
    const tool = createRecallMessageTool({ db })
    const out = text(await tool.execute('c1', { message_id: Number(info.lastInsertRowid) }))
    expect(out).toContain('tool-capped before storage')
    expect(out).toContain('not the raw output')
    // The stored text is far smaller than the 60k raw output.
    const stored = JSON.stringify((result as { content: unknown }).content)
    expect(stored.length).toBeLessThan(60000)
  }, 30_000)

  it('an uncapped tool row carries no cap note', async () => {
    const tool = createRecallMessageTool({ db })
    const out = text(await tool.execute('c1', { message_id: 11 }))
    expect(out).not.toContain('tool-capped')
  })
})

describe('recall_message schema is frozen (cache prefix, Eco cache gate N1)', () => {
  it('description and parameters are byte-identical to the legacy contract', () => {
    const tool = createRecallMessageTool({ db: {} as Database })
    expect(tool.description).toBe(
      'Reload the full, verbatim content of one earlier message by its id. Use this when the context shows a ' +
      'shortened line like "[msg:123] assistant, 5400 chars: ..." and you need the original text or the full tool ' +
      'result. Long messages are paged: pass `offset` to continue.',
    )
    expect(JSON.stringify(tool.parameters)).toBe(
      '{"type":"object","required":["message_id"],"properties":{"message_id":{"type":"number","description":"The numeric id from the \\"[msg:<id>]\\" digest line."},"offset":{"type":"number","description":"Character offset to continue a long message from (default 0)."}}}',
    )
  })
})
