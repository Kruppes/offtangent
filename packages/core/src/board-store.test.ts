/**
 * Board storage: revisions, retention, series and — the part that would be a
 * data leak if it broke — the user scoping of every read and write.
 *
 * All fixtures are synthetic: "Alpha Corp", "Beta Industries" and
 * ISIN-shaped strings like XX0000000001 that belong to nobody.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  BOARD_REVISION_RETENTION,
  deleteBoard,
  getBoard,
  getBoardRevision,
  getBoardSeries,
  listBoardRevisions,
  listBoards,
  upsertBoard,
  upsertBoardSeries,
} from './board-store.js'

let db: Database

beforeEach(() => {
  db = initDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

function publish(userId: string, key: string, overrides: Record<string, unknown> = {}) {
  return upsertBoard(db, {
    userId,
    key,
    kind: 'portfolio_digest.v1',
    title: 'Portfolio',
    icon: '📈',
    agentId: 'main',
    summary: 'Up a bit.',
    payload: { schema_version: '1', holdings: [{ name: 'Alpha Corp', isin: 'XX0000000001' }] },
    asOf: '2026-09-25T20:00:00Z',
    ...overrides,
  })
}

describe('upsertBoard', () => {
  it('starts at revision 1 and counts up on every publish', () => {
    expect(publish('1', 'portfolio').revision).toBe(1)
    expect(publish('1', 'portfolio', { title: 'Portfolio II' }).revision).toBe(2)
    expect(publish('1', 'portfolio').revision).toBe(3)

    const board = getBoard(db, '1', 'portfolio')!
    expect(board.revision).toBe(3)
    expect(board.title).toBe('Portfolio')
    // One current row per (user, key) — the board is overwritten, not appended.
    expect(db.prepare('SELECT COUNT(*) AS c FROM boards').get()).toEqual({ c: 1 })
  })

  it('returns the payload as an object, not as the stored JSON string', () => {
    publish('1', 'portfolio')
    const board = getBoard(db, '1', 'portfolio')!
    expect(board.payload).toEqual({
      schema_version: '1',
      holdings: [{ name: 'Alpha Corp', isin: 'XX0000000001' }],
    })
    expect(typeof db.prepare('SELECT payload FROM boards').pluck().get()).toBe('string')
  })

  it('keeps every earlier state as a revision', () => {
    publish('1', 'portfolio', { summary: 'first', payload: { n: 1 } })
    publish('1', 'portfolio', { summary: 'second', payload: { n: 2 } })

    expect(listBoardRevisions(db, '1', 'portfolio').map(r => r.revision)).toEqual([2, 1])
    expect(getBoardRevision(db, '1', 'portfolio', 1)).toMatchObject({ summary: 'first', payload: { n: 1 } })
    expect(getBoardRevision(db, '1', 'portfolio', 2)).toMatchObject({ summary: 'second', payload: { n: 2 } })
    expect(getBoardRevision(db, '1', 'portfolio', 3)).toBeNull()
  })

  it(`prunes revisions beyond the last ${BOARD_REVISION_RETENTION}`, () => {
    for (let i = 1; i <= BOARD_REVISION_RETENTION + 5; i++) publish('1', 'portfolio', { payload: { n: i } })

    const revisions = listBoardRevisions(db, '1', 'portfolio').map(r => r.revision)
    expect(revisions).toHaveLength(BOARD_REVISION_RETENTION)
    expect(revisions[0]).toBe(BOARD_REVISION_RETENTION + 5)
    expect(revisions.at(-1)).toBe(6)
    expect(getBoardRevision(db, '1', 'portfolio', 5)).toBeNull()
    // Retention is per (user, key): another board of the same user is untouched.
    publish('1', 'other')
    expect(listBoardRevisions(db, '1', 'other')).toHaveLength(1)
  })
})

describe('user scoping', () => {
  it('never lets one user see, change or delete the board of another', () => {
    publish('1', 'portfolio', { summary: 'mine' })
    publish('2', 'portfolio', { summary: 'theirs' })

    expect(getBoard(db, '1', 'portfolio')!.summary).toBe('mine')
    expect(getBoard(db, '2', 'portfolio')!.summary).toBe('theirs')
    expect(getBoard(db, '3', 'portfolio')).toBeNull()
    expect(listBoards(db, '3')).toEqual([])
    expect(listBoardRevisions(db, '3', 'portfolio')).toEqual([])
    expect(getBoardRevision(db, '3', 'portfolio', 1)).toBeNull()

    expect(deleteBoard(db, '3', 'portfolio')).toBe(false)
    expect(deleteBoard(db, '1', 'portfolio')).toBe(true)
    expect(getBoard(db, '1', 'portfolio')).toBeNull()
    expect(getBoard(db, '2', 'portfolio')!.summary).toBe('theirs')
  })

  it('lists boards of one user newest first, without the payload', () => {
    publish('1', 'alpha')
    publish('1', 'beta')
    publish('2', 'gamma')

    const boards = listBoards(db, '1')
    expect(boards.map(b => b.key).sort()).toEqual(['alpha', 'beta'])
    expect(Object.keys(boards[0]!).sort()).toEqual(
      ['agentId', 'asOf', 'icon', 'key', 'kind', 'revision', 'summary', 'title', 'updatedAt'],
    )
  })
})

describe('board series', () => {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

  it('keeps the last write of a day per series and returns points oldest first', () => {
    publish('1', 'portfolio')
    upsertBoardSeries(db, '1', 'portfolio', [
      { series: 'total_eur', day: yesterday, value: 100 },
      { series: 'total_eur', day: today, value: 110 },
      { series: 'cash_eur', day: today, value: 20, meta: { note: 'synthetic' } },
    ])
    upsertBoardSeries(db, '1', 'portfolio', [{ series: 'total_eur', day: today, value: 111.5 }])

    const series = getBoardSeries(db, '1', 'portfolio', ['total_eur', 'cash_eur', 'unknown'], 90)
    expect(series.total_eur).toEqual([
      { day: yesterday, value: 100 },
      { day: today, value: 111.5 },
    ])
    expect(series.cash_eur).toEqual([{ day: today, value: 20, meta: { note: 'synthetic' } }])
    // A series nobody wrote is an empty list, not a missing key.
    expect(series.unknown).toEqual([])
  })

  it('clamps the window and ignores points outside it', () => {
    publish('1', 'portfolio')
    const old = new Date(Date.now() - 500 * 86_400_000).toISOString().slice(0, 10)
    upsertBoardSeries(db, '1', 'portfolio', [
      { series: 'total_eur', day: old, value: 1 },
      { series: 'total_eur', day: today, value: 2 },
    ])

    expect(getBoardSeries(db, '1', 'portfolio', ['total_eur'], 1)).toEqual({
      total_eur: [{ day: today, value: 2 }],
    })
    // Even "give me everything" stops at the documented maximum of 400 days.
    expect(getBoardSeries(db, '1', 'portfolio', ['total_eur'], 100_000).total_eur).toHaveLength(1)
  })

  it('scopes series by user and removes them with the board', () => {
    publish('1', 'portfolio')
    publish('2', 'portfolio')
    upsertBoardSeries(db, '1', 'portfolio', [{ series: 'total_eur', day: today, value: 1 }])
    upsertBoardSeries(db, '2', 'portfolio', [{ series: 'total_eur', day: today, value: 2 }])

    expect(getBoardSeries(db, '2', 'portfolio', ['total_eur'], 30).total_eur).toEqual([{ day: today, value: 2 }])

    deleteBoard(db, '1', 'portfolio')
    expect(getBoardSeries(db, '1', 'portfolio', ['total_eur'], 30).total_eur).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS c FROM board_revisions WHERE user_id = ?').get('1')).toEqual({ c: 0 })
    expect(getBoardSeries(db, '2', 'portfolio', ['total_eur'], 30).total_eur).toHaveLength(1)
  })
})
