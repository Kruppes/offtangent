/**
 * Review 4 (REVIEW-7133aef7.md) / P1-B and P2 with real strand rows.
 *
 * P1-B: fork_strand of a private strand persisted the private seed in an
 * UNMARKED child, and fact extraction then sent it to a cloud model. The
 * child is now marked private in the same transaction that writes the seed.
 * P2: an arbitrary non-empty id without a `sessions` row counted as clean.
 * Every "clean" strand below is a real SessionManager thread. {{secret:url-password-10}} data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const completeSimple = vi.fn()
vi.mock('./pi-models.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pi-models.js')>()
  return { ...real, completeSimple: (...a: unknown[]) => completeSimple(...a) }
})

import { initDatabase, type Database } from './database.js'
import { SessionManager } from './session-manager.js'
import { forkStrand } from './strand-fork.js'
import { extractAndStoreFacts } from './fact-extraction.js'
import { isPrivateMcpScope, isPrivateMcpSession, markPrivateMcpSession } from './mcp-egress.js'
import { createAskAgentTool } from './ask-agent-tool.js'

const SEED = 'Private seed quoting MCP output 840266'

describe('fork + unknown scope (review 4)', () => {
  let dir: string
  let db: Database
  let sessions: SessionManager

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fork-scope-'))
    db = initDatabase(path.join(dir, 'db.sqlite'))
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'fixture', 'none')").run()
    sessions = new SessionManager({ db, memoryDir: path.join(dir, 'memory'), timeoutMinutes: 15 })
    completeSimple.mockReset()
    completeSimple.mockResolvedValue({ role: 'assistant', content: [{ type: 'text', text: '- a fact' }], stopReason: 'stop', usage: {} })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('P1-B: the fork of a private strand is private before its seed exists; facts never reach a cloud model', async () => {
    const parent = sessions.createThread('1', 'main', 'Private parent')
    expect(markPrivateMcpSession(db, parent.id)).toBe(true)
    const fork = forkStrand({ db, sessions, userId: '1', parentStrandId: parent.id, title: 'Side path', seed: SEED })
    expect(isPrivateMcpSession(db, fork.strandId)).toBe(true)
    const stored = db.prepare('SELECT content FROM chat_messages WHERE session_id = ?').all(fork.strandId) as Array<{ content: string }>
    expect(stored.some(r => r.content.includes(SEED))).toBe(true)
    const facts = await extractAndStoreFacts(db, 1, fork.strandId, `User: ${SEED}`, { id: 'cloud-model' } as never, 'k')
    expect(facts.skipped).toBe('mcp_private')
    expect(completeSimple).not.toHaveBeenCalled()
  })

  it('a fork of a real clean strand stays clean and its facts are extracted as before', async () => {
    const parent = sessions.createThread('1', 'main', 'Clean parent')
    const fork = forkStrand({ db, sessions, userId: '1', parentStrandId: parent.id, title: 'Side path', seed: 'harmless seed' })
    expect(isPrivateMcpScope(db, fork.strandId)).toBe(false)
    await extractAndStoreFacts(db, 1, fork.strandId, 'User: I prefer tea over coffee', { id: 'cloud-model' } as never, 'k')
    expect(completeSimple).toHaveBeenCalledTimes(1)
  })

  it('P2: a non-empty id without a sessions row is an unknown scope, refused everywhere', async () => {
    expect(isPrivateMcpScope(db, 'no-such-strand')).toBe(true)
    const facts = await extractAndStoreFacts(db, 1, 'no-such-strand', `User: ${SEED}`, { id: 'cloud-model' } as never, 'k')
    expect(facts.skipped).toBe('mcp_private')
    const ask = createAskAgentTool({ getCurrentAgentId: () => 'main', getModel: () => ({ id: 'x' }) as never, getApiKey: () => 'k', db, getCurrentSessionId: () => 'no-such-strand' })
    expect(JSON.stringify(await ask.execute('a', { agent_id: 'builder', question: SEED }))).toContain('MCP privacy gate')
    expect(completeSimple).not.toHaveBeenCalled()
    // The same id becomes clean only once a real strand row exists.
    const real = sessions.createThread('1', 'main', 'Real')
    expect(isPrivateMcpScope(db, real.id)).toBe(false)
  })
})
