/**
 * Decision table of the MCP scope gate (fix after CI run 611, 2026-11-01).
 *
 * Clean-OFF provenance is a real strand row in the real database without any
 * private evidence; it does NOT depend on `settings.mcp.enabled`. Switching
 * MCP off never declassifies a strand, and a missing database / strand id /
 * strand row is never "clean" (fail closed), whatever the setting says.
 *
 * | situation                                   | gate result |
 * |---------------------------------------------|-------------|
 * | MCP OFF, real clean strand row              | allowed     |
 * | MCP ON,  real clean strand row              | allowed     |
 * | MCP ON,  strand with private rows/marker    | refused     |
 * | ON -> private -> OFF (rows or marker only)  | refused     |
 * | in-memory private turn (any setting)        | refused     |
 * | no DB / no strand id / no sessions row      | refused     |
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { initDatabase, type Database } from './database.js'
import { isPrivateMcpScope, markPrivateMcpSession, runInMcpPrivacyTurn, skipPrivateMcpSession } from './mcp-egress.js'

const settingsPath = () => path.join(process.env.DATA_DIR as string, 'config', 'settings.json')
const writeMcp = (mcp: unknown) => {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify({ mcp }), 'utf-8')
}
const MCP_ON = { enabled: true, servers: {} }
const MCP_OFF = { enabled: false }

let db: Database

function insertPrivateRow(sessionId: string): void {
  db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, 1, 'tool', 'Tool: mcp_review_read', ?, 'main')")
    .run(sessionId, JSON.stringify({ toolName: 'mcp_review_read', toolResult: { content: [{ type: 'text', text: 'PRIVATE_SYNTHETIC_6110' }], details: { mcpDataClass: 'local_only' } } }))
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'not-a-password')").run()
  for (const id of ['clean-strand', 'row-strand', 'marker-strand']) {
    db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES (?, 1, 'main')").run(id)
  }
})
afterEach(() => {
  fs.rmSync(settingsPath(), { force: true })
  db.close()
})

describe('MCP scope decision table', () => {
  it('clean MCP OFF: a real clean strand is allowed (summary/voice/task run unchanged)', () => {
    writeMcp(MCP_OFF)
    expect(isPrivateMcpScope(db, 'clean-strand')).toBe(false)
    expect(skipPrivateMcpSession(db, 'clean-strand', 'session summary')).toBe(false)
    fs.rmSync(settingsPath(), { force: true }) // no settings at all = default OFF
    expect(skipPrivateMcpSession(db, 'clean-strand', 'send_voice_message')).toBe(false)
  })

  it('MCP ON: a clean strand is allowed, a private strand is refused', () => {
    writeMcp(MCP_ON)
    insertPrivateRow('row-strand')
    expect(skipPrivateMcpSession(db, 'clean-strand', 'create_task')).toBe(false)
    expect(skipPrivateMcpSession(db, 'row-strand', 'create_task')).toBe(true)
  })

  it('ON -> private -> OFF: persisted rows and the persisted marker keep the strand refused', () => {
    writeMcp(MCP_ON)
    insertPrivateRow('row-strand')
    expect(markPrivateMcpSession(db, 'marker-strand')).toBe(true)
    writeMcp(MCP_OFF)
    expect(skipPrivateMcpSession(db, 'row-strand', 'session summary')).toBe(true)
    expect(skipPrivateMcpSession(db, 'marker-strand', 'session summary')).toBe(true)
    expect(skipPrivateMcpSession(db, 'marker-strand', 'send_voice_message')).toBe(true)
    expect(skipPrivateMcpSession(db, 'row-strand', 'create_task')).toBe(true)
    // The clean strand next to them is still allowed.
    expect(skipPrivateMcpSession(db, 'clean-strand', 'session summary')).toBe(false)
  })

  it('in-memory private turn content stays private after OFF', () => {
    writeMcp(MCP_OFF)
    const inside = runInMcpPrivacyTurn({ sessionId: 'clean-strand', private: true }, () => isPrivateMcpScope(db, 'clean-strand'))
    expect(inside).toBe(true)
  })

  it('unclear DB or scope is refused even with MCP OFF (missing DB is never proof of clean)', () => {
    writeMcp(MCP_OFF)
    expect(isPrivateMcpScope(undefined, 'clean-strand')).toBe(true)
    expect(isPrivateMcpScope(null, 'clean-strand')).toBe(true)
    expect(isPrivateMcpScope(db, null)).toBe(true)
    expect(isPrivateMcpScope(db, 'no-such-strand')).toBe(true)
    const broken = initDatabase(':memory:')
    broken.close()
    expect(isPrivateMcpScope(broken, 'clean-strand')).toBe(true)
  })
})
