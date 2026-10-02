import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { initDatabase, type Database } from './database.js'
import {
  dismissStrandTasks,
  ensureStrandTaskDismissalTable,
  listStrandTaskDismissals,
  undismissStrandTasks,
} from './strand-task-dismissals.js'

let db: Database

beforeEach(() => { db = initDatabase(':memory:') })
afterEach(() => { db.close() })

const tables = (d: Database) => (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(r => r.name)

describe('strand task dismissals (W6c)', () => {
  it('initDatabase creates the table and the migration is idempotent', () => {
    expect(tables(db)).toContain('strand_task_dismissals')
    dismissStrandTasks(db, 's1', ['t1'], '2026-10-02T21:00:00.000Z')
    ensureStrandTaskDismissalTable(db)
    ensureStrandTaskDismissalTable(db)
    expect(listStrandTaskDismissals(db, 's1').get('t1')).toBe('2026-10-02T21:00:00.000Z')
  })

  it('is purely additive: no column is added to tasks or sessions', () => {
    const plain = new BetterSqlite3(':memory:') as unknown as Database
    plain.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE sessions (id TEXT PRIMARY KEY)')
    const columns = (t: string) => (plain.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name)
    const before = [columns('tasks'), columns('sessions')]
    ensureStrandTaskDismissalTable(plain)
    expect([columns('tasks'), columns('sessions')]).toEqual(before)
    expect(tables(plain)).toContain('strand_task_dismissals')
    plain.close()
  })

  it('keeps the first timestamp, scopes by strand and restores', () => {
    dismissStrandTasks(db, 's1', ['a', 'b'], '2026-10-01T10:00:00.000Z')
    dismissStrandTasks(db, 's1', ['a'], '2026-10-02T10:00:00.000Z')
    dismissStrandTasks(db, 's2', ['a'], '2026-10-03T10:00:00.000Z')
    expect(Object.fromEntries(listStrandTaskDismissals(db, 's1'))).toEqual({ a: '2026-10-01T10:00:00.000Z', b: '2026-10-01T10:00:00.000Z' })
    undismissStrandTasks(db, 's1', ['a', 'unknown'])
    expect([...listStrandTaskDismissals(db, 's1').keys()]).toEqual(['b'])
    expect([...listStrandTaskDismissals(db, 's2').keys()]).toEqual(['a'])
  })

  it('binds ids as parameters (an id that looks like SQL is stored verbatim)', () => {
    const evil = "x'); DROP TABLE strand_task_dismissals; --"
    dismissStrandTasks(db, 's1', [evil], '2026-10-01T10:00:00.000Z')
    expect(listStrandTaskDismissals(db, 's1').has(evil)).toBe(true)
    expect(tables(db)).toContain('strand_task_dismissals')
  })
})
