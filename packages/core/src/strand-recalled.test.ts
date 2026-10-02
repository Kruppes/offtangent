/**
 * What the agent pulled back into a strand (W5b): recall_message calls and
 * the retrieval ids of the strand_context metric row, owner scoped.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { listRecalledMessages, RECALLED_EXCERPT_CHARS } from './strand-recalled.js'
import { logToolCall } from './token-logger.js'
import { assembleStrandContextWithStats } from './strand-context.js'

let db: Database

function strand(id: string, owner: number): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, agent_id, title)
     VALUES (?, ?, ?, 'web', 'interactive', 'main', ?)`,
  ).run(id, owner, String(owner), `Strand ${id}`)
}

function message(strandId: string, owner: number, role: string, content: string): number {
  return Number(db.prepare(
    "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, ?, ?, 'main')",
  ).run(strandId, owner, role, content).lastInsertRowid)
}

function recall(strandId: string, messageId: number | null, at: string, status: 'success' | 'error' = 'success'): void {
  const id = logToolCall(db, {
    sessionId: strandId,
    toolName: 'recall_message',
    input: JSON.stringify({ message_id: messageId }),
    output: JSON.stringify(messageId === null
      ? { content: [{ type: 'text', text: 'Error: message 9 not found.' }], details: { error: true, notFound: true } }
      : { content: [{ type: 'text', text: '…' }], details: { messageId, role: 'user', sessionId: strandId } }),
    durationMs: 1,
    status,
  })
  db.prepare('UPDATE tool_calls SET timestamp = ? WHERE id = ?').run(at, id)
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alpha', 'x', 'admin'), (2, 'beta', 'x', 'user')").run()
  strand('s1', 1)
  strand('s2', 1)
  strand('foreign', 2)
})

describe('listRecalledMessages', () => {
  it('lists successful recalls newest first with a cut excerpt and ISO time', () => {
    const a = message('s1', 1, 'user', 'first synthetic note about the garden plan')
    const b = message('s1', 1, 'assistant', `long answer ${'x'.repeat(400)}`)
    recall('s1', a, '2026-01-01 10:00:00')
    recall('s1', b, '2026-01-01 11:00:00')
    recall('s1', null, '2026-01-01 12:00:00', 'error')

    const list = listRecalledMessages(db, 1, 's1')
    expect(list.map(r => r.messageId)).toEqual([b, a])
    expect(list[0]).toMatchObject({ strandId: 's1', role: 'assistant', recalledAt: '2026-01-01T11:00:00.000Z', source: 'recall' })
    expect(list[0]!.excerpt.length).toBe(RECALLED_EXCERPT_CHARS)
    expect(list[0]!.excerpt.endsWith('…')).toBe(true)
    expect(list[1]).toEqual({
      messageId: a, strandId: 's1', role: 'user', excerpt: 'first synthetic note about the garden plan',
      recalledAt: '2026-01-01T10:00:00.000Z', source: 'recall',
    })
  })

  it('dedupes a message recalled twice to its latest recall', () => {
    const a = message('s1', 1, 'user', 'note')
    recall('s1', a, '2026-01-01 10:00:00')
    recall('s1', a, '2026-01-02 10:00:00')
    expect(listRecalledMessages(db, 1, 's1')).toHaveLength(1)
    expect(listRecalledMessages(db, 1, 's1')[0]!.recalledAt).toBe('2026-01-02T10:00:00.000Z')
  })

  it('includes ids retrieved by the strand context and ignores old metric rows without them', () => {
    const a = message('s1', 1, 'user', 'retrieved by context')
    logToolCall(db, { sessionId: 's1', toolName: 'strand_context', input: '{}', output: JSON.stringify({ retrieved: 1 }), durationMs: 0 })
    logToolCall(db, { sessionId: 's1', toolName: 'strand_context', input: '{}', output: JSON.stringify({ retrieved: 1, retrievedIds: [a, 'junk', -3] }), durationMs: 0 })
    const list = listRecalledMessages(db, 1, 's1')
    expect(list.map(r => [r.messageId, r.source])).toEqual([[a, 'context']])
  })

  it('never returns a message of another user, even when its id was recalled', () => {
    const foreign = message('foreign', 2, 'user', 'not yours')
    const own = message('s2', 1, 'user', 'yours, other strand')
    recall('s1', foreign, '2026-01-01 10:00:00')
    recall('s1', own, '2026-01-01 11:00:00')
    expect(listRecalledMessages(db, 1, 's1').map(r => [r.messageId, r.strandId])).toEqual([[own, 's2']])
  })

  it('is empty for a strand without recalls and honours the limit', () => {
    expect(listRecalledMessages(db, 1, 's2')).toEqual([])
    for (let i = 0; i < 5; i++) recall('s1', message('s1', 1, 'user', `n${i}`), `2026-01-01 10:0${i}:00`)
    expect(listRecalledMessages(db, 1, 's1', 3)).toHaveLength(3)
  })
})

describe('strand_context stats carry the retrieved ids', () => {
  it('reports retrievedIds next to the counters', () => {
    const { stats } = assembleStrandContextWithStats(db, 's2', 'hello', [])
    expect(Array.isArray(stats.retrievedIds)).toBe(true)
    expect(stats.retrievedIds).toHaveLength(stats.retrieved)
  })
})
