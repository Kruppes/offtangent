/**
 * Offtangent Stufe 1: threads = explicitly selectable interactive sessions.
 *
 * What these pin down (each fails against the pre-threads SessionManager,
 * which knew exactly ONE interactive session per user+persona):
 *   - listThreads/createThread/updateThread operate only on the caller's own
 *     interactive sessions (no background sessions, no foreign rows);
 *   - activateSession enforces existence/ownership/persona/archived and
 *     throws typed errors whose `code` is the wire contract;
 *   - switching threads PARKS the incumbent (no summary, no ended_at, no
 *     timer) instead of ending it;
 *   - an ended thread can be reopened and then carries its own tail forward.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from './session-manager.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  SessionAgentMismatchError,
  SessionForbiddenError,
  SessionNotFoundError,
} from './errors.js'

describe('SessionManager threads', () => {
  let db: Database
  let tmpDir: string
  let memoryDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-threads-'))
    memoryDir = path.join(tmpDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })
    db = initDatabase(path.join(tmpDir, 'db.sqlite'))
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function manager(options: Partial<{ timeoutMinutes: number }> = {}): SessionManager {
    return new SessionManager({ db, memoryDir, timeoutMinutes: options.timeoutMinutes ?? 15 })
  }

  function addMessage(sessionId: string, role: 'user' | 'assistant', content: string, agentId = 'bob'): void {
    db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, ?, ?, ?)',
    ).run(sessionId, 1, role, content, agentId)
  }

  describe('createThread', () => {
    it('creates an interactive session row without occupying the active slot', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'bob', 'Deploy plan')

      expect(thread.title).toBe('Deploy plan')
      expect(thread.agentId).toBe('bob')
      expect(thread.pinned).toBe(false)
      expect(thread.archived).toBe(false)
      expect(thread.messageCount).toBe(0)
      expect(thread.lastMessage).toBeNull()
      expect(thread.active).toBe(false)
      expect(thread.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

      const row = db.prepare('SELECT type, source, session_user, agent_id, ended_at FROM sessions WHERE id = ?').get(thread.id) as
        { type: string; source: string; session_user: string; agent_id: string; ended_at: string | null }
      expect(row).toEqual({ type: 'interactive', source: 'web', session_user: '1', agent_id: 'bob', ended_at: null })

      // Not cached: the user still has no active session for that persona.
      expect(sm.hasActiveSession('1', 'bob')).toBe(false)
    })

    it('treats an empty title as "no title"', () => {
      const sm = manager()
      expect(sm.createThread('1', 'bob', '   ').title).toBeNull()
      expect(sm.createThread('1', 'bob').title).toBeNull()
    })
  })

  describe('listThreads', () => {
    it('returns only own interactive sessions, newest activity first, with a truncated last message', () => {
      const sm = manager()
      const a = sm.createThread('1', 'bob', 'A')
      const b = sm.createThread('1', 'bob', 'B')
      sm.createSession({ type: 'task', source: 'task', userId: '1', agentId: 'bob' })
      db.prepare("INSERT INTO sessions (id, source, type, session_user, agent_id) VALUES ('foreign', 'web', 'interactive', '2', 'bob')").run()

      addMessage(a.id, 'user', 'first')
      addMessage(b.id, 'assistant', 'x'.repeat(500))
      db.prepare("UPDATE sessions SET last_activity = '2026-09-12 10:00:00' WHERE id = ?").run(a.id)
      db.prepare("UPDATE sessions SET last_activity = '2026-09-12 12:00:00' WHERE id = ?").run(b.id)

      const threads = sm.listThreads('1')
      expect(threads.map(t => t.id)).toEqual([b.id, a.id])
      expect(threads[0].lastMessage).toEqual({
        role: 'assistant',
        content: 'x'.repeat(200),
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      })
      expect(threads[1].lastMessage?.content).toBe('first')
      expect(threads[0].lastActivity).toBe('2026-09-12T12:00:00.000Z')
    })

    it('filters by persona, hides archived unless asked, and pages', () => {
      const sm = manager()
      const bobA = sm.createThread('1', 'bob', 'bob A')
      sm.createThread('1', 'warren', 'warren A')
      const archived = sm.createThread('1', 'bob', 'old')
      sm.updateThread('1', archived.id, { archived: true })

      expect(sm.listThreads('1', { agentId: 'bob' }).map(t => t.id)).toEqual([bobA.id])
      expect(sm.listThreads('1', { agentId: 'bob', includeArchived: true }).map(t => t.id).sort())
        .toEqual([bobA.id, archived.id].sort())
      expect(sm.listThreads('1').length).toBe(2)
      expect(sm.listThreads('1', { limit: 1 }).length).toBe(1)
      expect(sm.listThreads('1', { limit: 1, offset: 1 }).length).toBe(1)
      expect(sm.listThreads('1', { limit: 1 })[0].id).not.toBe(sm.listThreads('1', { limit: 1, offset: 1 })[0].id)
    })

    it('sorts pinned threads first, then by last activity', () => {
      const sm = manager()
      const oldPinned = sm.createThread('1', 'bob', 'old pinned')
      const fresh = sm.createThread('1', 'bob', 'fresh')
      db.prepare("UPDATE sessions SET last_activity = '2026-09-10 08:00:00' WHERE id = ?").run(oldPinned.id)
      db.prepare("UPDATE sessions SET last_activity = '2026-09-12 20:00:00' WHERE id = ?").run(fresh.id)
      sm.updateThread('1', oldPinned.id, { pinned: true })

      expect(sm.listThreads('1').map(t => t.title)).toEqual(['old pinned', 'fresh'])
      // Pinning stays authoritative across pages.
      expect(sm.listThreads('1', { limit: 1 }).map(t => t.title)).toEqual(['old pinned'])
    })

    it('flags the thread that currently holds the (user, persona) slot as active', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'bob', 'A')
      expect(sm.listThreads('1')[0].active).toBe(false)

      sm.activateSession('1', thread.id, 'bob')
      expect(sm.listThreads('1')[0].active).toBe(true)
      // Another persona's slot must not make it active.
      expect(sm.listThreads('1', { agentId: 'warren' })).toEqual([])
    })
  })

  describe('deleteThread', () => {
    it('deletes an empty thread and frees the slot it held', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'bob', 'oops')
      sm.activateSession('1', thread.id, 'bob')

      expect(sm.deleteThread('1', thread.id)).toBe('deleted')
      expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(thread.id)).toBeUndefined()
      expect(sm.getSession('1', 'bob')).toBeUndefined()
      expect(sm.listThreads('1')).toEqual([])
    })

    it('refuses threads that carry content, by counter or by rows', () => {
      const sm = manager()
      const counted = sm.createThread('1', 'bob', 'counted')
      db.prepare('UPDATE sessions SET message_count = 3 WHERE id = ?').run(counted.id)
      const withRows = sm.createThread('1', 'bob', 'rows only')
      addMessage(withRows.id, 'user', 'hello')

      expect(sm.deleteThread('1', counted.id)).toBe('not_empty')
      expect(sm.deleteThread('1', withRows.id)).toBe('not_empty')
      expect(sm.listThreads('1').length).toBe(2)
    })

    it('reports not_found for unknown, foreign and background sessions', () => {
      const sm = manager()
      const foreign = sm.createThread('2', 'bob', 'theirs')
      const task = sm.createSession({ type: 'task', source: 'task', userId: '1', agentId: 'bob' })

      expect(sm.deleteThread('1', 'nope')).toBe('not_found')
      expect(sm.deleteThread('1', foreign.id)).toBe('not_found')
      expect(sm.deleteThread('1', task.id)).toBe('not_found')
      expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(foreign.id)).toBeDefined()
      expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(task.id)).toBeDefined()
    })
  })

  describe('updateThread', () => {
    it('renames, pins and archives, and leaves omitted fields untouched', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'bob', 'Title')

      expect(sm.updateThread('1', thread.id, { pinned: true })).toMatchObject({ pinned: true, title: 'Title' })
      expect(sm.updateThread('1', thread.id, { title: 'Renamed' })).toMatchObject({ pinned: true, title: 'Renamed' })
      expect(sm.updateThread('1', thread.id, { title: null })).toMatchObject({ title: null, pinned: true })
      expect(sm.updateThread('1', thread.id, { archived: true })).toMatchObject({ archived: true })
    })

    it('returns null for unknown, foreign and non-interactive sessions', () => {
      const sm = manager()
      const task = sm.createSession({ type: 'task', source: 'task', userId: '1', agentId: 'bob' })
      db.prepare("INSERT INTO sessions (id, source, type, session_user, agent_id) VALUES ('foreign', 'web', 'interactive', '2', 'bob')").run()

      expect(sm.updateThread('1', 'does-not-exist', { pinned: true })).toBeNull()
      expect(sm.updateThread('1', task.id, { pinned: true })).toBeNull()
      expect(sm.updateThread('1', 'foreign', { pinned: true })).toBeNull()
      // The foreign row was not modified either.
      expect((db.prepare('SELECT pinned FROM sessions WHERE id = ?').get('foreign') as { pinned: number }).pinned).toBe(0)
    })
  })

  describe('activateSession guards', () => {
    it('rejects unknown ids and background sessions with SessionNotFoundError', () => {
      const sm = manager()
      const task = sm.createSession({ type: 'task', source: 'task', userId: '1', agentId: 'bob' })

      expect(() => sm.activateSession('1', 'nope', 'bob')).toThrow(SessionNotFoundError)
      expect(() => sm.activateSession('1', task.id, 'bob')).toThrow(SessionNotFoundError)
      try {
        sm.activateSession('1', 'nope', 'bob')
      } catch (err) {
        expect((err as SessionNotFoundError).code).toBe('session_not_found')
      }
    })

    it("rejects another user's thread with SessionForbiddenError", () => {
      const sm = manager()
      const mine = sm.createThread('2', 'bob', 'not yours')
      expect(() => sm.activateSession('1', mine.id, 'bob')).toThrow(SessionForbiddenError)
    })

    it('rejects a thread of another persona with SessionAgentMismatchError', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'bob', 'bob thread')
      try {
        sm.activateSession('1', thread.id, 'warren')
        throw new Error('expected a mismatch')
      } catch (err) {
        expect(err).toBeInstanceOf(SessionAgentMismatchError)
        expect((err as SessionAgentMismatchError).code).toBe('session_agent_mismatch')
      }
    })

    it('rejects an archived thread with SessionForbiddenError', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'bob', 'archived')
      sm.updateThread('1', thread.id, { archived: true })
      expect(() => sm.activateSession('1', thread.id, 'bob')).toThrow(SessionForbiddenError)
    })
  })

  describe('activateSession behaviour', () => {
    it('puts the thread into the slot and returns its SessionInfo', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'bob', 'A')
      const info = sm.activateSession('1', thread.id, 'bob')

      expect(info.id).toBe(thread.id)
      expect(info.agentId).toBe('bob')
      expect(info.userId).toBe('1')
      expect(info.source).toBe('web')
      expect(sm.getSession('1', 'bob')?.id).toBe(thread.id)
    })

    it('parks the incumbent instead of ending it, and clears its timer', () => {
      vi.useFakeTimers()
      try {
        const sm = manager({ timeoutMinutes: 15 })
        const onSessionEnd = vi.fn()
        const smWithHooks = new SessionManager({ db, memoryDir, timeoutMinutes: 15, onSessionEnd })

        const a = smWithHooks.createThread('1', 'bob', 'A')
        const b = smWithHooks.createThread('1', 'bob', 'B')
        smWithHooks.activateSession('1', a.id, 'bob')
        smWithHooks.recordMessage('1', 'bob')
        smWithHooks.activateSession('1', b.id, 'bob')

        // A is parked: still open, no summary, no end callback.
        const rowA = db.prepare('SELECT ended_at, summary_written FROM sessions WHERE id = ?').get(a.id) as
          { ended_at: string | null; summary_written: number }
        expect(rowA.ended_at).toBeNull()
        expect(onSessionEnd).not.toHaveBeenCalled()
        expect(smWithHooks.getSession('1', 'bob')?.id).toBe(b.id)

        // And A's inactivity timer is gone: advancing far past the timeout
        // must not end it (only the active thread B can time out).
        vi.advanceTimersByTime(20 * 60 * 1000)
        const stillOpen = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(a.id) as { ended_at: string | null }
        expect(stillOpen.ended_at).toBeNull()
        void sm
      } finally {
        vi.useRealTimers()
      }
    })

    it('is a no-op when the thread is already active', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'bob', 'A')
      const first = sm.activateSession('1', thread.id, 'bob')
      const second = sm.activateSession('1', thread.id, 'bob')
      expect(second).toBe(first)
      expect(sm.getSession('1', 'bob')?.id).toBe(thread.id)
    })

    it('reopens an ended thread and injects its own tail for continuity', () => {
      const sm = manager()
      const thread = sm.createThread('1', 'bob', 'Old thread')
      addMessage(thread.id, 'user', 'what about the deploy?')
      addMessage(thread.id, 'assistant', 'it is scheduled for friday')
      db.prepare("UPDATE sessions SET ended_at = datetime('now'), summary_written = 1, message_count = 2 WHERE id = ?").run(thread.id)

      const info = sm.activateSession('1', thread.id, 'bob', { messageText: 'and now?' })
      expect(info.id).toBe(thread.id)
      expect(info.restored).toBe(true)
      expect(info.messageCount).toBe(2)

      const row = db.prepare('SELECT ended_at, summary_written FROM sessions WHERE id = ?').get(thread.id) as
        { ended_at: string | null; summary_written: number }
      expect(row.ended_at).toBeNull()
      // Reopening does not retract the summary that was already written.
      expect(row.summary_written).toBe(1)

      const injection = sm.consumeFactInjection('1', 'bob')
      expect(injection).toContain('it is scheduled for friday')
      expect(injection).toContain('what about the deploy?')
      // Consumed exactly once.
      expect(sm.consumeFactInjection('1', 'bob')).toBeNull()
    })

    it('does not inject anything when an open thread is re-activated', () => {
      const sm = manager()
      const a = sm.createThread('1', 'bob', 'A')
      const b = sm.createThread('1', 'bob', 'B')
      addMessage(a.id, 'user', 'hello from A')

      sm.activateSession('1', a.id, 'bob')
      sm.activateSession('1', b.id, 'bob')
      sm.activateSession('1', a.id, 'bob', { messageText: 'back again' })

      expect(sm.consumeFactInjection('1', 'bob')).toBeNull()
    })

    it('restores the most recently active thread into the slot and leaves no stale timer', async () => {
      // Threads make several open interactive sessions per (user, agent) normal
      // (parked ones keep ended_at NULL). Restoring them must not arm one timer
      // per session under the same key: a stale timer fires later and ends
      // whatever session occupies the slot by then.
      const older = '44444444-4444-4444-8444-444444444444'
      const newer = '55555555-5555-4555-8555-555555555555'
      const now = Date.now()
      const stamp = (msAgo: number): string => new Date(now - msAgo).toISOString().replace('T', ' ').slice(0, 19)
      db.prepare(
        "INSERT INTO sessions (id, source, type, session_user, agent_id, started_at, last_activity, message_count) VALUES (?, 'web', 'interactive', '1', 'bob', ?, ?, 2)",
      ).run(older, stamp(10 * 60_000), stamp(10 * 60_000))
      db.prepare(
        "INSERT INTO sessions (id, source, type, session_user, agent_id, started_at, last_activity, message_count) VALUES (?, 'web', 'interactive', '1', 'bob', ?, ?, 2)",
      ).run(newer, stamp(60_000), stamp(60_000))

      const sm = new SessionManager({ db, memoryDir, timeoutMinutes: 15, onSummarize: async () => 'summary' })
      const clearSpy = vi.spyOn(global, 'clearTimeout')
      await sm.init()

      expect(sm.getSession('1', 'bob')?.id).toBe(newer)
      // The older restore's timer was retired instead of being left dangling.
      expect(clearSpy).toHaveBeenCalled()
      clearSpy.mockRestore()
    })

    it('counts messages against the activated thread', () => {
      const sm = manager()
      const a = sm.createThread('1', 'bob', 'A')
      const b = sm.createThread('1', 'bob', 'B')

      sm.activateSession('1', a.id, 'bob')
      sm.recordMessage('1', 'bob')
      sm.recordMessage('1', 'bob')
      sm.activateSession('1', b.id, 'bob')
      sm.recordMessage('1', 'bob')

      const counts = db.prepare('SELECT id, message_count FROM sessions WHERE id IN (?, ?)').all(a.id, b.id) as
        Array<{ id: string; message_count: number }>
      expect(counts.find(c => c.id === a.id)?.message_count).toBe(2)
      expect(counts.find(c => c.id === b.id)?.message_count).toBe(1)
    })
  })

  // Findings of the adversarial review (2026-09-13), each pinned by a test.
  describe('review findings', () => {
    it('assertSessionAccess runs the guards without touching the slot or the injection', () => {
      const sm = manager()
      const a = sm.createThread('1', 'bob', 'A')
      const b = sm.createThread('1', 'bob', 'B')
      sm.activateSession('1', a.id, 'bob')

      const row = sm.assertSessionAccess('1', b.id, 'bob')
      expect(row.id).toBe(b.id)
      // A is still the active one: nothing was parked.
      expect(sm.getSession('1', 'bob')?.id).toBe(a.id)
      expect(sm.consumeFactInjection('1', 'bob')).toBeNull()

      expect(() => sm.assertSessionAccess('1', 'nope', 'bob')).toThrow(SessionNotFoundError)
      expect(() => sm.assertSessionAccess('2', b.id, 'bob')).toThrow(SessionForbiddenError)
      expect(() => sm.assertSessionAccess('1', b.id, 'warren')).toThrow(SessionAgentMismatchError)
    })

    it('injects the thread tail when the caller holds no transcript, even for an open thread', () => {
      // Parked before a restart / evicted from the cache: ended_at is NULL,
      // but the model context is gone. The thread's own tail must come back.
      const sm = manager()
      const a = sm.createThread('1', 'bob', 'A')
      addMessage(a.id, 'user', 'remember the blue widget')
      addMessage(a.id, 'assistant', 'noted: blue widget')

      sm.activateSession('1', a.id, 'bob', { messageText: 'and?', hasTranscript: false })
      const injection = sm.consumeFactInjection('1', 'bob')
      expect(injection).toContain('remember the blue widget')
      expect(injection).toContain('noted: blue widget')

      // With the transcript present, nothing is injected.
      const b = sm.createThread('1', 'bob', 'B')
      addMessage(b.id, 'user', 'b content')
      sm.activateSession('1', b.id, 'bob', { messageText: 'x', hasTranscript: true })
      expect(sm.consumeFactInjection('1', 'bob')).toBeNull()
    })

    it('injects for the already-active slot after a restart (cold, same id)', async () => {
      const id = '66666666-6666-4666-8666-666666666666'
      const stamp = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19)
      db.prepare(
        "INSERT INTO sessions (id, source, type, session_user, agent_id, started_at, last_activity, message_count) VALUES (?, 'web', 'interactive', '1', 'bob', ?, ?, 1)",
      ).run(id, stamp, stamp)
      addMessage(id, 'user', 'survived the restart')
      const sm = new SessionManager({ db, memoryDir, timeoutMinutes: 15, onSummarize: async () => 'summary' })
      await sm.init()
      expect(sm.getSession('1', 'bob')?.id).toBe(id)

      sm.activateSession('1', id, 'bob', { messageText: 'hi', hasTranscript: false })
      expect(sm.consumeFactInjection('1', 'bob')).toContain('survived the restart')
    })

    it('parking drops the pending injection of the outgoing thread', () => {
      const sm = manager()
      const a = sm.createThread('1', 'bob', 'A')
      addMessage(a.id, 'user', 'only for A')
      const b = sm.createThread('1', 'bob', 'B')

      sm.activateSession('1', a.id, 'bob', { hasTranscript: false })   // queues A's tail
      sm.activateSession('1', b.id, 'bob', { hasTranscript: true })    // switch before it was consumed
      // B must not receive A's tail.
      expect(sm.consumeFactInjection('1', 'bob')).toBeNull()
    })

    it('archiving the active thread parks it', () => {
      const sm = manager()
      const a = sm.createThread('1', 'bob', 'A')
      sm.activateSession('1', a.id, 'bob')
      expect(sm.getSession('1', 'bob')?.id).toBe(a.id)

      const updated = sm.updateThread('1', a.id, { archived: true })
      expect(updated?.archived).toBe(true)
      expect(updated?.active).toBe(false)
      expect(sm.getSession('1', 'bob')).toBeUndefined()
      expect(() => sm.activateSession('1', a.id, 'bob')).toThrow(SessionForbiddenError)
    })

    it('owner rule matches listThreads: either session_user or user_id may carry the user', () => {
      const sm = manager()
      const legacy = '77777777-7777-4777-8777-777777777777'
      db.prepare(
        "INSERT INTO sessions (id, source, type, user_id, session_user, agent_id, started_at, message_count) VALUES (?, 'web', 'interactive', 1, 'someone-else', 'bob', datetime('now'), 0)",
      ).run(legacy)
      // Listed for user 1 ...
      expect(sm.listThreads('1', { agentId: 'bob' }).map(t => t.id)).toContain(legacy)
      // ... so user 1 may also activate it.
      expect(() => sm.activateSession('1', legacy, 'bob')).not.toThrow()
    })
  })
})
