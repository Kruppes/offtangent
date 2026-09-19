/**
 * Offtangent Stufe 1, robustness: orphan restore must not hand the (user,
 * persona) slot to an EMPTY thread.
 *
 * With threads a (user, agent) pair has several open interactive sessions
 * (parked ones keep `ended_at IS NULL`). `handleOrphanedSessions` restores them
 * oldest-first, so the last one restored owns the slot. A thread created via
 * POST /api/threads and never written to would therefore evict the real last
 * conversation on the next restart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from './session-manager.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'

describe('SessionManager orphan restore with threads', () => {
  let db: Database
  let tmpDir: string
  let memoryDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-orphans-'))
    memoryDir = path.join(tmpDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })
    db = initDatabase(path.join(tmpDir, 'db.sqlite'))
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function insertSession(id: string, minutesAgo: number, messageCount: number): void {
    const stamp = new Date(Date.now() - minutesAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19)
    db.prepare(
      `INSERT INTO sessions (id, source, type, session_user, agent_id, started_at, last_activity, message_count)
       VALUES (?, 'web', 'interactive', '1', 'bob', ?, ?, ?)`
    ).run(id, stamp, stamp, messageCount)
  }

  it('does not let an empty thread win the slot, and leaves it open without a timer', async () => {
    // The real conversation is older than the empty thread that was created
    // afterwards (POST /api/threads, never written to). Restoring oldest-first
    // would hand the slot to the empty one and the next message would land in
    // the wrong thread.
    const real = '11111111-1111-4111-8111-111111111111'
    const empty = '22222222-2222-4222-8222-222222222222'
    insertSession(real, 10, 4)
    insertSession(empty, 1, 0)

    const sm = new SessionManager({ db, memoryDir, scopedAgentMemory: false, timeoutMinutes: 15, onSummarize: async () => 'summary' })
    await sm.init()

    expect(sm.getSession('1', 'bob')?.id).toBe(real)
    // The empty thread is untouched: still open, just not in the slot.
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(empty) as { ended_at: string | null }).ended_at).toBeNull()
    await sm.dispose()
  })

  it('arms no timer for the empty thread (the restored one keeps the slot)', async () => {
    vi.useFakeTimers()
    try {
      const real = '33333333-3333-4333-8333-333333333333'
      const empty = '44444444-4444-4444-8444-444444444444'
      insertSession(real, 10, 4)
      insertSession(empty, 1, 0)

      const ended: string[] = []
      const sm = new SessionManager({
        db,
        memoryDir,
        scopedAgentMemory: false,
        timeoutMinutes: 15,
        onSummarize: async () => 'summary',
        onSessionEnd: session => { ended.push(session.id) },
      })
      await sm.init()

      // Only the restored thread's remaining 5 minutes may fire.
      await vi.advanceTimersByTimeAsync(6 * 60_000)
      expect(ended).toEqual([real])
      expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(empty) as { ended_at: string | null }).ended_at).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves empty threads OPEN even when they are older than the session timeout', async () => {
    // A thread created shortly before a restart (or an hour earlier) must
    // still be there when the app reopens: no summary to write, nothing to
    // close. Only the parked sweep (idle budget, default 24h) retires it.
    const empty = '55555555-5555-4555-8555-555555555555'
    insertSession(empty, 120, 0)

    const sm = new SessionManager({ db, memoryDir, scopedAgentMemory: false, timeoutMinutes: 15, onSummarize: async () => 'summary' })
    await sm.init()

    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(empty) as { ended_at: string | null }).ended_at).toBeNull()
    // Not in the slot either, and no timer was armed for it.
    expect(sm.getSession('1', 'bob')).toBeUndefined()
    await sm.dispose()
  })

  it('keeps an aged empty thread listed and reopenable, then lets the sweep close it', async () => {
    const empty = '66666666-6666-4666-8666-666666666666'
    insertSession(empty, 120, 0)

    const sm = new SessionManager({ db, memoryDir, scopedAgentMemory: false, timeoutMinutes: 15, onSummarize: async () => 'summary' })
    await sm.init()
    expect(sm.listThreads('1').map(t => t.id)).toEqual([empty])
    // Writing into it works without a reopen (it never ended).
    expect(sm.activateSession('1', empty, 'bob').id).toBe(empty)

    // Park it again and age it past the idle budget -> the sweep closes it.
    sm.activateSession('1', sm.createThread('1', 'bob', 'other').id, 'bob')
    db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?")
      .run(new Date(Date.now() - 30 * 3600_000).toISOString().replace('T', ' ').slice(0, 19), empty)
    expect(await sm.sweepParkedThreads()).toBe(1)
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(empty) as { ended_at: string | null }).ended_at).not.toBeNull()
    await sm.dispose()
  })
})
