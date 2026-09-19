/**
 * Offtangent Stufe 1, robustness: parked threads must expire.
 *
 * Switching threads PARKS the incumbent — the slot is freed and its inactivity
 * timer is cleared, but `ended_at` stays NULL. Without a sweep such a thread is
 * never summarized, the set of open interactive sessions grows without bound
 * and every restart iterates all of them (`handleOrphanedSessions`).
 *
 * What these tests pin down:
 *   - the sweep closes parked threads idle beyond `parkedTimeoutHours` through
 *     the regular lifecycle (summary, ended_at, tool_call entry, onSessionEnd
 *     with `parked: true`);
 *   - empty threads are closed without a summary and without a callback;
 *   - a thread that holds the (user, agent) slot is NEVER touched;
 *   - a closed thread stays listed and is reopened by the next explicit
 *     message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from './session-manager.js'
import type { SessionEndCallbackOptions, SessionInfo } from './session-manager.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'

/** SQLite datetime string (UTC, no zone marker) `hours` in the past. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
}

describe('SessionManager parked-thread sweep', () => {
  let db: Database
  let tmpDir: string
  let memoryDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-sweep-'))
    memoryDir = path.join(tmpDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })
    db = initDatabase(path.join(tmpDir, 'db.sqlite'))
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  interface EndCall {
    session: SessionInfo
    summary: string | null
    options?: SessionEndCallbackOptions
  }

  function manager(options: {
    parkedTimeoutHours?: number
    parkedSweepIntervalMinutes?: number
    onSummarize?: (sessionId: string, userId: string, history?: string) => Promise<string>
    ends?: EndCall[]
  } = {}): SessionManager {
    return new SessionManager({
      db,
      memoryDir,
      // Keep summaries inside the temp memory dir instead of the persona's
      // real (scoped) memory root.
      scopedAgentMemory: false,
      timeoutMinutes: 15,
      parkedTimeoutHours: options.parkedTimeoutHours ?? 24,
      parkedSweepIntervalMinutes: options.parkedSweepIntervalMinutes,
      onSummarize: options.onSummarize ?? (async () => 'a summary'),
      onSessionEnd: (session, summary, opts) => {
        options.ends?.push({ session, summary, options: opts })
      },
    })
  }

  function addMessage(sessionId: string, role: 'user' | 'assistant', content: string, agentId = 'bob'): void {
    db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, ?, ?, ?)',
    ).run(sessionId, 1, role, content, agentId)
  }

  /** Make a thread look idle: both the row and its message count. */
  function ageThread(sessionId: string, hours: number, messageCount: number): void {
    db.prepare('UPDATE sessions SET last_activity = ?, started_at = ?, message_count = ? WHERE id = ?')
      .run(hoursAgo(hours), hoursAgo(hours + 1), messageCount, sessionId)
  }

  it('summarizes and closes a parked thread that is idle beyond the timeout', async () => {
    const ends: EndCall[] = []
    const summarize = vi.fn(async () => 'thread summary')
    const sm = manager({ ends, onSummarize: summarize })

    const thread = sm.createThread('1', 'bob', 'Parked')
    addMessage(thread.id, 'user', 'the deploy plan')
    addMessage(thread.id, 'assistant', 'is ready')
    ageThread(thread.id, 30, 2)

    expect(await sm.sweepParkedThreads()).toBe(1)

    const row = db.prepare('SELECT ended_at, summary_written FROM sessions WHERE id = ?').get(thread.id) as
      { ended_at: string | null; summary_written: number }
    expect(row.ended_at).not.toBeNull()
    expect(row.summary_written).toBe(1)
    expect(summarize).toHaveBeenCalledTimes(1)

    // onSessionEnd fires so AgentCore can drop the thread's transcript — and it
    // is flagged `parked` so listeners do not touch the live runtime/session.
    expect(ends).toHaveLength(1)
    expect(ends[0].session.id).toBe(thread.id)
    expect(ends[0].session.agentId).toBe('bob')
    expect(ends[0].summary).toBe('thread summary')
    expect(ends[0].options).toEqual({ parked: true })

    // The end is visible in the activity log with its own reason.
    const call = db.prepare('SELECT tool_name, input FROM tool_calls WHERE session_id = ?').get(thread.id) as
      { tool_name: string; input: string }
    expect(call.tool_name).toBe('session_timeout')
    expect(JSON.parse(call.input).reason).toBe('parked_timeout')

    // The thread stays in the list, now with endedAt set.
    const listed = sm.listThreads('1').find(t => t.id === thread.id)
    expect(listed?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // The daily file got the summary.
    const daily = fs.readdirSync(path.join(memoryDir, 'daily'))
    expect(daily.length).toBe(1)
    expect(fs.readFileSync(path.join(memoryDir, 'daily', daily[0]), 'utf-8')).toContain('thread summary')
  })

  it('closes an empty parked thread without a summary and without a callback', async () => {
    const ends: EndCall[] = []
    const summarize = vi.fn(async () => 'never')
    const sm = manager({ ends, onSummarize: summarize })

    const empty = sm.createThread('1', 'bob', 'Created and forgotten')
    ageThread(empty.id, 48, 0)

    expect(await sm.sweepParkedThreads()).toBe(1)

    const row = db.prepare('SELECT ended_at, summary_written FROM sessions WHERE id = ?').get(empty.id) as
      { ended_at: string | null; summary_written: number }
    expect(row.ended_at).not.toBeNull()
    expect(row.summary_written).toBe(0)
    expect(summarize).not.toHaveBeenCalled()
    expect(ends).toHaveLength(0)
  })

  it('never touches the thread that holds the slot, however idle its row looks', async () => {
    const ends: EndCall[] = []
    const sm = manager({ ends })

    const active = sm.createThread('1', 'bob', 'Active')
    const parked = sm.createThread('1', 'bob', 'Parked')
    addMessage(active.id, 'user', 'still here')
    addMessage(parked.id, 'user', 'older')
    ageThread(active.id, 72, 1)
    ageThread(parked.id, 72, 1)

    // Activating writes lastActivity in memory only; the row stays ancient.
    sm.activateSession('1', active.id, 'bob')

    expect(await sm.sweepParkedThreads()).toBe(1)

    const activeRow = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(active.id) as { ended_at: string | null }
    const parkedRow = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(parked.id) as { ended_at: string | null }
    expect(activeRow.ended_at).toBeNull()
    expect(parkedRow.ended_at).not.toBeNull()
    expect(sm.getSession('1', 'bob')?.id).toBe(active.id)
    expect(ends.map(e => e.session.id)).toEqual([parked.id])
  })

  it('leaves threads inside the idle budget alone and ignores background sessions', async () => {
    const sm = manager({ parkedTimeoutHours: 24 })

    const fresh = sm.createThread('1', 'bob', 'Fresh')
    addMessage(fresh.id, 'user', 'recent')
    ageThread(fresh.id, 23, 1)

    const task = sm.createSession({ type: 'task', source: 'task', userId: '1', agentId: 'bob' })
    db.prepare('UPDATE sessions SET last_activity = ?, started_at = ? WHERE id = ?')
      .run(hoursAgo(100), hoursAgo(100), task.id)

    expect(await sm.sweepParkedThreads()).toBe(0)
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(fresh.id) as { ended_at: string | null }).ended_at).toBeNull()
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(task.id) as { ended_at: string | null }).ended_at).toBeNull()
  })

  it('is disabled when parkedTimeoutHours is 0', async () => {
    const sm = manager({ parkedTimeoutHours: 0 })
    const thread = sm.createThread('1', 'bob', 'Forever')
    addMessage(thread.id, 'user', 'x')
    ageThread(thread.id, 1000, 1)

    expect(await sm.sweepParkedThreads()).toBe(0)
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(thread.id) as { ended_at: string | null }).ended_at).toBeNull()
  })

  it('runs periodically once init() armed it, and stops on dispose()', async () => {
    vi.useFakeTimers()
    try {
      const ends: EndCall[] = []
      const sm = manager({ ends, parkedSweepIntervalMinutes: 10 })
      await sm.init()

      const thread = sm.createThread('1', 'bob', 'Parked')
      addMessage(thread.id, 'user', 'hello')
      ageThread(thread.id, 30, 1)
      // Nothing happens before the first tick.
      expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(thread.id) as { ended_at: string | null }).ended_at).toBeNull()

      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(thread.id) as { ended_at: string | null }).ended_at).not.toBeNull()
      expect(ends).toHaveLength(1)

      // dispose() stops the sweep: a second parked thread that ages past the
      // budget afterwards is no longer touched.
      const second = sm.createThread('1', 'bob', 'Second')
      addMessage(second.id, 'user', 'hello again')
      ageThread(second.id, 30, 1)
      await sm.dispose()
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(second.id) as { ended_at: string | null }).ended_at).toBeNull()
      expect(ends).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off when the thread was reactivated while its summary was running', async () => {
    const ends: EndCall[] = []
    const holder: { sm?: SessionManager } = {}
    const summarize = vi.fn(async (sessionId: string) => {
      // The user re-enters the thread while the summarizer is still working.
      holder.sm!.activateSession('1', sessionId, 'bob')
      return 'late summary'
    })
    const sm = manager({ ends, onSummarize: summarize })
    holder.sm = sm

    const thread = sm.createThread('1', 'bob', 'Race')
    addMessage(thread.id, 'user', 'hi')
    ageThread(thread.id, 30, 1)

    expect(await sm.sweepParkedThreads()).toBe(0)
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(thread.id) as { ended_at: string | null }).ended_at).toBeNull()
    expect(ends).toHaveLength(0)
    expect(sm.getSession('1', 'bob')?.id).toBe(thread.id)
  })

  it('reopens a swept thread on the next explicit message, with its own tail', async () => {
    const sm = manager()
    const thread = sm.createThread('1', 'bob', 'Reopen me')
    addMessage(thread.id, 'user', 'what about the blue widget?')
    addMessage(thread.id, 'assistant', 'the blue widget ships friday')
    ageThread(thread.id, 30, 2)

    await sm.sweepParkedThreads()
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(thread.id) as { ended_at: string | null }).ended_at).not.toBeNull()

    const info = sm.activateSession('1', thread.id, 'bob', { messageText: 'and now?' })
    expect(info.id).toBe(thread.id)
    expect((db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(thread.id) as { ended_at: string | null }).ended_at).toBeNull()
    const injection = sm.consumeFactInjection('1', 'bob')
    expect(injection).toContain('the blue widget ships friday')
  })

  it('sweeps threads of several users and personas in one pass', async () => {
    const ends: EndCall[] = []
    const sm = manager({ ends })
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'other', 'x')

    const mine = sm.createThread('1', 'bob', 'mine')
    const other = sm.createThread('2', 'warren', 'theirs')
    addMessage(mine.id, 'user', 'a')
    addMessage(other.id, 'user', 'b', 'warren')
    ageThread(mine.id, 30, 1)
    ageThread(other.id, 30, 1)

    expect(await sm.sweepParkedThreads()).toBe(2)
    expect(ends.map(e => e.session.userId).sort()).toEqual(['1', '2'])
    expect(ends.map(e => e.session.agentId).sort()).toEqual(['bob', 'warren'])
  })

  it('still retires a parked thread when no summarizer is configured (no summary, but closed)', async () => {
    // A manager without onSummarize must not let parked threads live forever;
    // it closes them without a daily-log entry (warned once).
    const sm = new SessionManager({ db, memoryDir, scopedAgentMemory: false, timeoutMinutes: 15, parkedTimeoutHours: 24 })
    const thread = sm.createThread('1', 'bob', 'no summarizer')
    addMessage(thread.id, 'user', 'x')
    ageThread(thread.id, 30, 1)

    expect(await sm.sweepParkedThreads()).toBe(1)
    const row = db.prepare('SELECT ended_at, summary_written FROM sessions WHERE id = ?').get(thread.id) as
      { ended_at: string | null; summary_written: number }
    expect(row.ended_at).not.toBeNull()
    expect(row.summary_written).toBe(0)
  })

  it('closes a parked thread whose summary was already written, without summarizing again', async () => {
    const ends: EndCall[] = []
    const summarize = vi.fn(async () => 'should not run')
    const sm = manager({ ends, onSummarize: summarize })
    const thread = sm.createThread('1', 'bob', 'already summarized')
    addMessage(thread.id, 'user', 'x')
    ageThread(thread.id, 30, 2)
    db.prepare('UPDATE sessions SET summary_written = 1 WHERE id = ?').run(thread.id)

    expect(await sm.sweepParkedThreads()).toBe(1)
    expect(summarize).not.toHaveBeenCalled()
    const row = db.prepare('SELECT ended_at, summary_written FROM sessions WHERE id = ?').get(thread.id) as
      { ended_at: string | null; summary_written: number }
    expect(row.ended_at).not.toBeNull()
    expect(row.summary_written).toBe(1)
    // onSessionEnd still fires so the transcript is dropped.
    expect(ends.map(e => e.session.id)).toEqual([thread.id])
    expect(ends[0].options).toEqual({ parked: true })
  })
})
