/**
 * The strand transcript is read with `user_id = ? AND session_id = ?` plus an
 * id cursor (`GET /api/chat/history`). Without statistics the planner picks
 * the single-column user index for that and walks every row of the user
 * (on a large database: the whole table) for each page and each COUNT.
 * The composite index serves the page, the cursor and the count directly.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SELECT = `SELECT cm.id, cm.role, cm.content, s.source AS source
  FROM chat_messages cm LEFT JOIN sessions s ON s.id = cm.session_id`

describe('chat_messages strand history index', () => {
  const tmpFiles: string[] = []
  afterEach(() => {
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${f}${suffix}`) } catch { /* ignore */ }
      }
    }
    tmpFiles.length = 0
  })

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-history-index-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  function plan(db: ReturnType<typeof initDatabase>, sql: string, ...params: unknown[]): string {
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(r => r.detail).join(' | ')
  }

  it('serves the backwards cursor, the catch-up and the count from (user_id, session_id, id) without a temp b-tree', () => {
    const db = initDatabase(tmpDbPath())
    const cursor = plan(db, `${SELECT} WHERE cm.user_id = ? AND cm.session_id = ? AND cm.id < ? ORDER BY cm.id DESC LIMIT 100`, 1, 's', 10)
    expect(cursor).toContain('idx_chat_messages_user_session_id (user_id=? AND session_id=? AND id<?)')
    expect(cursor).not.toContain('TEMP B-TREE')

    const newest = plan(db, `${SELECT} WHERE cm.user_id = ? AND cm.session_id = ? ORDER BY cm.id DESC LIMIT 100`, 1, 's')
    expect(newest).toContain('idx_chat_messages_user_session_id (user_id=? AND session_id=?)')
    expect(newest).not.toContain('TEMP B-TREE')

    const since = plan(db, `${SELECT} WHERE cm.user_id = ? AND cm.session_id = ? AND cm.id > ? ORDER BY cm.id ASC LIMIT 100`, 1, 's', 10)
    expect(since).toContain('idx_chat_messages_user_session_id (user_id=? AND session_id=? AND id>?)')
    expect(since).not.toContain('TEMP B-TREE')

    const count = plan(db, 'SELECT COUNT(*) AS count FROM chat_messages cm WHERE cm.user_id = ? AND cm.session_id = ? AND cm.id < ?', 1, 's', 10)
    expect(count).toContain('COVERING INDEX idx_chat_messages_user_session_id')
    db.close()
  })

  it('is idempotent: a second start keeps exactly one such index', () => {
    const dbPath = tmpDbPath()
    initDatabase(dbPath).close()
    const db = initDatabase(dbPath)
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_messages' AND name = 'idx_chat_messages_user_session_id'").all() as Array<{ sql: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sql).toContain('(user_id, session_id, id)')
    db.close()
  })
})
