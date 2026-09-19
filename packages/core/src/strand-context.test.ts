import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { insertSessionSummary } from './session-summary-store.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'
import {
  estimateMessageTokens,
  trimMessagesToBudget,
  countUserTurns,
  loadStrandRows,
  splitRowsOutsideMemory,
  retrieveOlderRows,
  buildStrandContextBlock,
  assembleStrandContext,
  stripStrandContextFromLastUserMessage,
  STRAND_CONTEXT_OPEN,
  STRAND_CONTEXT_CLOSE,
} from './strand-context.js'

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as unknown as AgentMessage
}
function assistant(text: string, toolCallId?: string): AgentMessage {
  const content: unknown[] = [{ type: 'text', text }]
  if (toolCallId) content.push({ type: 'toolCall', id: toolCallId, name: 'shell', arguments: {} })
  return { role: 'assistant', content, timestamp: Date.now(), stopReason: toolCallId ? 'toolUse' : 'stop' } as unknown as AgentMessage
}
function toolResult(toolCallId: string, text: string): AgentMessage {
  return { role: 'toolResult', toolCallId, toolName: 'shell', content: [{ type: 'text', text }], isError: false, timestamp: Date.now() } as unknown as AgentMessage
}

describe('trimMessagesToBudget', () => {
  it('keeps everything under budget', () => {
    const msgs = [user('a'), assistant('b')]
    const r = trimMessagesToBudget(msgs, 1000)
    expect(r.droppedCount).toBe(0)
    expect(r.messages).toHaveLength(2)
  })

  it('drops the oldest turns and opens the window on a user message', () => {
    const msgs = [user('x'.repeat(400)), assistant('y'.repeat(400)), user('z'.repeat(400)), assistant('w'.repeat(400))]
    const r = trimMessagesToBudget(msgs, 250)
    expect(r.messages.map(m => (m as { role: string }).role)).toEqual(['user', 'assistant'])
    expect((r.messages[0] as { content: Array<{ text: string }> }).content[0].text.startsWith('z')).toBe(true)
    expect(r.droppedCount).toBe(2)
  })

  it('never splits a tool call from its result at the cut', () => {
    const msgs = [
      user('old question'),
      assistant('calling', 'tc1'),
      toolResult('tc1', 'r'.repeat(800)),
      assistant('done'),
    ]
    const r = trimMessagesToBudget(msgs, 210)
    const roles = r.messages.map(m => (m as { role: string }).role)
    expect(roles).not.toContain('toolResult')
    expect(roles[roles.length - 1]).toBe('assistant')
  })

  it('estimates tokens over text blocks', () => {
    expect(estimateMessageTokens(user('abcd'.repeat(10)))).toBe(10)
    expect(countUserTurns([user('a'), assistant('b'), user('c')])).toBe(2)
  })
})

describe('strand rows and retrieval', () => {
  let db: Database
  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u', 'h', 'user')").run()
    db.prepare("INSERT INTO sessions (id, user_id, source, type) VALUES ('s1', 1, 'web', 'interactive')").run()
    const ins = db.prepare("INSERT INTO chat_messages (id, session_id, user_id, role, content) VALUES (?, 's1', 1, ?, ?)")
    ins.run(1, 'user', 'Plan the kubernetes migration for the billing service')
    ins.run(2, 'assistant', 'We start with the billing service and its postgres database.')
    ins.run(3, 'user', 'What about the caching layer?')
    ins.run(4, 'assistant', 'Redis stays outside the cluster for now.')
    ins.run(5, 'user', 'Now the current question about kubernetes')
    setHeuristicsOverrideForTests({ strand: { retrievalHits: 2, retrievalChars: 30, indexLines: 3, windowTokens: 100 } })
  })
  afterEach(() => {
    setHeuristicsOverrideForTests(null)
    db.close()
  })

  it('drops the trailing current user row and splits by user turns in memory', () => {
    const rows = loadStrandRows(db, 's1', 'Now the current question about kubernetes')
    expect(rows.map(r => r.id)).toEqual([1, 2, 3, 4])
    const split = splitRowsOutsideMemory(rows, 1)
    expect(split.older.map(r => r.id)).toEqual([1, 2])
    expect(split.covered.map(r => r.id)).toEqual([3, 4])
    expect(splitRowsOutsideMemory(rows, 0).older).toHaveLength(4)
    expect(splitRowsOutsideMemory(rows, 5).older).toHaveLength(0)
  })

  it('retrieves only older rows, capped and cut with the id kept', () => {
    const hits = retrieveOlderRows(db, 's1', 'kubernetes billing migration', new Set([1, 2]), 2, 30)
    expect(hits.map(h => h.id)).toEqual([1, 2])
    expect(hits[0].truncated).toBe(true)
    expect(hits[0].content).toHaveLength(30)
    expect(retrieveOlderRows(db, 's1', 'kubernetes billing migration', new Set([1, 2]), 1, 30)).toHaveLength(1)
    expect(retrieveOlderRows(db, 's1', 'kubernetes', new Set([3, 4]), 2, 30)).toEqual([])
  })

  it('assembles notes, index and retrieval and returns null for a short strand', () => {
    insertSessionSummary(db, 's1', { goal: 'Migrate billing.', decisions: ['Postgres first'], open: ['Redis placement'], artifacts: [], next: [] }, null, null)
    const block = assembleStrandContext(db, 's1', 'Now the current question about kubernetes', [user('What about the caching layer?'), assistant('Redis stays outside the cluster for now.')])
    expect(block).not.toBeNull()
    expect(block!.startsWith(STRAND_CONTEXT_OPEN)).toBe(true)
    expect(block).toContain('Goal: Migrate billing.')
    expect(block).toContain('- Redis placement')
    expect(block).toContain('[msg:1] user, 53 chars: Plan the kubernetes migration for the billing service')
    expect(block).toContain('[msg:2] assistant')
    expect(block).not.toContain('[msg:3]')
    expect(block).toContain('<retrieved_messages>')
    expect(block).toMatch(/\[recalled\] \[msg:1\] User: Plan the kubernetes migration\s+\[cut, recall_message\(1\) for the rest\]/)

    const all = assembleStrandContext(db, 's2', 'x', [])
    expect(all).toBeNull()
  })

  it('caps the index at indexLines, oldest dropped first', () => {
    const block = buildStrandContextBlock({
      notes: null,
      older: [1, 2, 3, 4, 5].map(id => ({ id, role: 'user' as const, content: `m${id}` })),
      retrieved: [],
      indexLines: 3,
    })!
    expect(block).toContain('(2 oldest not listed)')
    expect(block).not.toContain('[msg:2]')
    expect(block).toContain('[msg:3]')
    expect(block).toContain('[msg:5]')
  })
})

describe('stripStrandContextFromLastUserMessage', () => {
  it('removes the block from a text block user message and leaves others alone', () => {
    const blocked = `${STRAND_CONTEXT_OPEN}\nstuff\n${STRAND_CONTEXT_CLOSE}\n\nreal question\n\ntime`
    const msgs = [user('earlier'), assistant('a'), user(blocked), assistant('b')]
    const out = stripStrandContextFromLastUserMessage(msgs)!
    expect((out[2] as { content: Array<{ text: string }> }).content[0].text).toBe('real question\n\ntime')
    expect(out[0]).toBe(msgs[0])
    expect(stripStrandContextFromLastUserMessage([user('plain')])).toBeNull()
  })

  it('handles string content', () => {
    const msg = { role: 'user', content: `${STRAND_CONTEXT_OPEN}\nx\n${STRAND_CONTEXT_CLOSE}\nq`, timestamp: 1 } as unknown as AgentMessage
    const out = stripStrandContextFromLastUserMessage([msg])!
    expect((out[0] as { content: string }).content).toBe('q')
  })
})
