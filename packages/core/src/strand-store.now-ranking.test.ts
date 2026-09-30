/**
 * The computed now set (`offtangent.nowSetMode = 'auto'`):
 * `rankStrandsByActivity` ranks strands by the days the USER came back to
 * them, not by how much was written.
 *
 * Every test fails against a ranking that counts messages, that lets
 * assistant/tool/system rows count, or that reads the `now_set` table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, rankStrandsByActivity, NOW_SET_RANKING_HALF_LIFE_DAYS, NOW_SET_RANKING_WINDOW_DAYS } from './index.js'
import type { Database } from './index.js'

let db: Database

/** Fixed reference point, so ages are exact and nothing depends on the clock. */
const NOW = new Date('2026-09-21T12:00:00Z')

function daysAgo(days: number, hourUtc = 9): string {
  const d = new Date(NOW.getTime() - days * 86_400_000)
  d.setUTCHours(hourUtc, 0, 0, 0)
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

function strand(
  id: string,
  options: { user?: string; title?: string | null; type?: string; archived?: 0 | 1; pinned?: 0 | 1 } = {},
): string {
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, agent_id, type, title, archived, pinned, started_at, last_activity, message_count)
     VALUES (?, ?, ?, 'main', ?, ?, ?, ?, 0, 0, 0)`,
  ).run(
    id,
    Number(options.user ?? '1'),
    options.user ?? '1',
    options.type ?? 'interactive',
    options.title === undefined ? `T ${id}` : options.title,
    options.archived ?? 0,
    options.pinned ?? 0,
  )
  return id
}

function message(sessionId: string, role: string, timestamp: string): void {
  db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, timestamp, agent_id)
     VALUES (?, (SELECT user_id FROM sessions WHERE id = ?), ?, 'x', ?, 'main')`,
  ).run(sessionId, sessionId, role, timestamp)
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (2, ?, ?, ?)').run('other', 'x', 'user')
})

afterEach(() => db.close())

describe('rankStrandsByActivity', () => {
  it('counts DISTINCT days, so a burst thread loses against one returned to repeatedly', () => {
    // 92 messages in two days — exactly the bench thread the ranking must not reward.
    strand('burst')
    for (let i = 0; i < 46; i++) {
      message('burst', 'user', daysAgo(1, 8))
      message('burst', 'user', daysAgo(2, 8))
    }
    // Five separate days that START on the same day as the burst: volume must
    // lose against returning, while the comparison stays inside one age band —
    // with a one-day half-life, mixing volume and age would only prove decay.
    strand('returned')
    for (const day of [1, 2, 3, 4, 5]) message('returned', 'user', daysAgo(day))

    expect(rankStrandsByActivity(db, '1', { max: 4, now: NOW })).toEqual(['returned', 'burst'])
  })

  it('decays: same number of days, the more recent strand wins', () => {
    strand('recent')
    for (const day of [1, 2, 3]) message('recent', 'user', daysAgo(day))
    strand('older')
    for (const day of [11, 12, 13]) message('older', 'user', daysAgo(day))

    expect(rankStrandsByActivity(db, '1', { max: 4, now: NOW })).toEqual(['recent', 'older'])
  })

  it('puts pinned strands first, even a pinned one without any activity', () => {
    strand('loud')
    for (const day of [1, 2, 3, 4]) message('loud', 'user', daysAgo(day))
    strand('pinned-quiet', { pinned: 1 })
    strand('pinned-active', { pinned: 1 })
    message('pinned-active', 'user', daysAgo(6))

    expect(rankStrandsByActivity(db, '1', { max: 4, now: NOW }))
      .toEqual(['pinned-active', 'pinned-quiet', 'loud'])
  })

  it('ignores assistant, tool and system rows, so cron and task reports never pull a strand in', () => {
    strand('injected')
    for (const day of [1, 2, 3, 4, 5]) {
      message('injected', 'assistant', daysAgo(day))
      message('injected', 'tool', daysAgo(day))
      message('injected', 'system', daysAgo(day))
    }
    strand('typed')
    message('typed', 'user', daysAgo(9))

    expect(rankStrandsByActivity(db, '1', { max: 4, now: NOW })).toEqual(['typed'])
  })

  it('excludes archived, untitled, task-type and foreign strands', () => {
    for (const [id, options] of [
      ['archived', { archived: 1 as const }],
      ['untitled', { title: null }],
      ['blank', { title: '   ' }],
      ['task', { type: 'task' }],
      ['foreign', { user: '2' }],
      ['ok', {}],
    ] as const) {
      strand(id, options)
      message(id, 'user', daysAgo(1))
    }

    expect(rankStrandsByActivity(db, '1', { max: 10, now: NOW })).toEqual(['ok'])
  })

  it('drops activity older than the window and strands without any score', () => {
    strand('stale')
    message('stale', 'user', daysAgo(NOW_SET_RANKING_WINDOW_DAYS + 2))
    strand('silent')
    strand('live')
    message('live', 'user', daysAgo(2))

    expect(rankStrandsByActivity(db, '1', { max: 10, now: NOW })).toEqual(['live'])
  })

  it('cuts at max and stays deterministic across repeated reads', () => {
    for (let i = 1; i <= 6; i++) {
      const id = `s${i}`
      strand(id)
      // Same score for every strand, same recency: only the id breaks the tie.
      message(id, 'user', daysAgo(2))
    }
    const first = rankStrandsByActivity(db, '1', { max: 3, now: NOW })
    expect(first).toEqual(['s1', 's2', 's3'])
    expect(rankStrandsByActivity(db, '1', { max: 3, now: NOW })).toEqual(first)
    expect(rankStrandsByActivity(db, '1', { max: 0, now: NOW })).toEqual([])
  })

  it('uses the half-life it documents: today outscores four days of last week', () => {
    // The regression measured on the live database on 23.09.2026: with a
    // five-day half-life, `lastweek` scored 4 * 0.5^(6/5) ≈ 1.74 against 1.0
    // for `today` and pushed everything current out of the set. With one day
    // it is 4 * 0.5^6 ≈ 0.06 against 1.0.
    strand('today')
    message('today', 'user', daysAgo(0))
    strand('lastweek')
    for (const day of [5, 6, 7, 8]) message('lastweek', 'user', daysAgo(day))

    expect(NOW_SET_RANKING_HALF_LIFE_DAYS).toBe(1)
    expect(rankStrandsByActivity(db, '1', { max: 4, now: NOW })).toEqual(['today', 'lastweek'])
  })

  it('still rewards coming back: three days in a row beat a single fresh day', () => {
    // 1 + 0.5 + 0.25 = 1.75 against 1.0 — returning stays the stronger signal
    // between two strands that were both touched today.
    strand('returning')
    for (const day of [0, 1, 2]) message('returning', 'user', daysAgo(day))
    strand('fresh')
    message('fresh', 'user', daysAgo(0))

    expect(rankStrandsByActivity(db, '1', { max: 4, now: NOW })).toEqual(['returning', 'fresh'])
  })

  it('never touches the now_set table', () => {
    strand('a')
    message('a', 'user', daysAgo(1))
    db.prepare('INSERT INTO now_set (user_id, strand_id, rank) VALUES (?, ?, ?)').run('1', 'a', 1)
    rankStrandsByActivity(db, '1', { max: 4, now: NOW })
    expect(db.prepare('SELECT count(*) c FROM now_set').get()).toEqual({ c: 1 })
  })

  it('SQLite provides pow(), which the scoring relies on', () => {
    expect(db.prepare('SELECT pow(0.5, 2.0) AS p').get()).toEqual({ p: 0.25 })
  })
})
