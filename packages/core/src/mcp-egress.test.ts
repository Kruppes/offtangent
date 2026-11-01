/**
 * Review 2 (REVIEW-77292ef9.md) / B: unit regressions of the MCP egress gate.
 * Real recall/history tools against a real (in-memory) database; the runtime
 * wire test lives in agent-runtime.mcp-egress.test.ts.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { initDatabase, type Database } from './database.js'
import { createRecallMessageTool } from './recall-message-tool.js'
import { createReadChatHistoryTool } from './chat-history-tools.js'
import { findPrivateMcpEvidence, isPrivateMcpSession } from './mcp-egress.js'

const MARKER = 'PRIVATE_PERSISTED_MCP_SYNTHETIC_875912'
const QUOTE = 'ASSISTANT_QUOTE_SYNTHETIC_31337'
const S = 'private-strand'

let db: Database
let rowId: number

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'not-a-password')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES (?, 1, 'main')").run(S)
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('clean-strand', 1, 'main')").run()
  rowId = Number(db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, 1, 'tool', 'Tool: mcp_review_read', ?, 'main')")
    .run(S, JSON.stringify({ toolName: 'mcp_review_read', toolCallId: 'c', toolArgs: {}, toolResult: { content: [{ type: 'text', text: MARKER }], details: { mcpDataClass: 'local_only' } } })).lastInsertRowid)
  // The assistant quoting the private output: the quote row itself has no MCP marker.
  db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'assistant', ?, 'main')").run(S, `Exact quote: ${QUOTE}`)
  db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES ('clean-strand', 1, 'assistant', 'clean text', 'main')").run()
})

describe('persisted private strand', () => {
  it('is detected from the persisted rows; a cloud_ok row or a clean strand is not', () => {
    expect(isPrivateMcpSession(db, S)).toBe(true)
    expect(isPrivateMcpSession(db, 'clean-strand')).toBe(false)
    db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('cloud-strand', 1, 'main')").run()
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES ('cloud-strand', 1, 'tool', 'x', ?, 'main')")
      .run(JSON.stringify({ toolName: 'mcp_review_read', toolResult: { details: { mcpDataClass: 'cloud_ok' } } }))
    expect(isPrivateMcpSession(db, 'cloud-strand')).toBe(false)
  })

  it('fails closed on a broken database', () => {
    const broken = initDatabase(':memory:')
    broken.close()
    expect(isPrivateMcpSession(broken, S)).toBe(true)
  })
})

describe('recall_message (recall-probes.mts)', () => {
  const tool = (allow: boolean | undefined) => createRecallMessageTool({
    db, getCurrentUserId: () => 1, getCurrentAgentId: () => 'main', getCurrentSessionId: () => 'clean-strand',
    ...(allow === undefined ? {} : { allowPrivateMcp: () => allow }),
  })

  it('withholds a private MCP row and an assistant quote of it from a non-local model, and by default', async () => {
    for (const allow of [false, undefined]) {
      const r1 = await tool(allow).execute('r', { message_id: rowId })
      const r2 = await tool(allow).execute('r', { message_id: rowId + 1 })
      expect(JSON.stringify(r1)).not.toContain(MARKER)
      expect(JSON.stringify(r2)).not.toContain(QUOTE)
      expect((r1 as { details: Record<string, unknown> }).details.mcpPrivateWithheld).toBe(true)
    }
  })

  it('serves a local model and marks the result, so the runtime refuses later cloud requests', async () => {
    const r = await tool(true).execute('r', { message_id: rowId })
    expect(JSON.stringify(r)).toContain(MARKER)
    expect((r as { details: Record<string, unknown> }).details.mcpPrivate).toBe(true)
    expect(findPrivateMcpEvidence([{ role: 'toolResult', toolName: 'recall_message', toolCallId: 'r', ...r }], new Set())).toBe('recalled_private_history')
  })
})

describe('read_chat_history', () => {
  const tool = (allow: boolean) => createReadChatHistoryTool({ db, getCurrentAgentId: () => 'main', allowPrivateMcp: () => allow })

  it('replaces the rows of a private strand for a non-local model and keeps clean strands', async () => {
    const r = await tool(false).execute('h', { limit: 50 })
    const text = JSON.stringify(r)
    expect(text).not.toContain(MARKER)
    expect(text).not.toContain(QUOTE)
    expect(text).toContain('clean text')
  })

  it('marks the result for a local model', async () => {
    const r = await tool(true).execute('h', { limit: 50 })
    expect(JSON.stringify(r)).toContain(QUOTE)
    expect(findPrivateMcpEvidence([{ role: 'toolResult', toolName: 'read_chat_history', toolCallId: 'h', ...r }], new Set())).toBe('recalled_private_history')
  })
})

describe('findPrivateMcpEvidence', () => {
  it('flags results, call arguments and tool declarations; cloud_ok passes', () => {
    expect(findPrivateMcpEvidence([{ role: 'toolResult', toolName: 'mcp_a_x', details: { mcpDataClass: 'local_only' } }], new Set())).toBe('tool_result')
    expect(findPrivateMcpEvidence([{ role: 'toolResult', toolName: 'mcp_a_x' }], new Set())).toBe('tool_result')
    expect(findPrivateMcpEvidence([{ role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'mcp_a_x', arguments: {} }] }], new Set())).toBe('tool_call')
    expect(findPrivateMcpEvidence([{ role: 'custom', toolsAdded: [{ name: 'mcp_a_x' }] }], new Set())).toBe('tool_definition')
    expect(findPrivateMcpEvidence([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'mcp_a_x', arguments: {} }] },
      { role: 'toolResult', toolName: 'mcp_a_x', toolCallId: 'c', details: { mcpDataClass: 'cloud_ok' } },
    ], new Set())).toBeNull()
    expect(findPrivateMcpEvidence([{ role: 'user', content: 'hi' }], new Set())).toBeNull()
  })
})
