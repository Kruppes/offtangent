/**
 * W7 D3: bm25 ranks depend on index-wide statistics (row count, average
 * length, document frequency), so a message written between two pages shifts
 * every score. The cursor carries an upper bound (the newest message id when
 * page 1 was ranked) and the position of the last hit, so later pages rank
 * only the messages that existed for page 1: no gap, no repeat, and the
 * newcomer waits for a fresh search. Old cursors keep working. Synthetic data.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager } from '@axiom/core'
import type { Database } from '@axiom/core'
import { decodeSearchCursor, encodeSearchCursor, searchMessages } from './route.js'

let db: Database
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let strand: string

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-search-drift-'))
  process.env.DATA_DIR = tempDataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'first', 'x', 'admin')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
})

afterAll(() => {
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions;')
  strand = sessionManager.createThread('1', 'main', 'Synthetic drift').id
})

function write(text: string): number {
  return Number(db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, ?, ?, ?)')
    .run(strand, 'user', text, 'main').lastInsertRowid)
}

/** 60 hits with many distinct scores (term frequency and length vary). */
function seed(): number[] {
  const ids: number[] = []
  for (let i = 0; i < 60; i++) {
    const tf = 1 + (i % 4)
    const filler = ' calm filler words'.repeat(i % 7)
    ids.push(write(`${'lantern '.repeat(tf)}evening${filler}`))
  }
  // Non-matching rows shape the index statistics too.
  for (let i = 0; i < 20; i++) write(`unrelated synthetic note ${i}`)
  return ids
}

function pageThrough(q: string, limit: number, between?: (page: number) => void): number[] {
  const seen: number[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const res = searchMessages(db, 1, q, { limit, includeArchived: false, ...(cursor ? { cursor } : {}) })
    seen.push(...res.hits.map(h => h.messageId))
    between?.(page)
    if (!res.nextCursor) break
    cursor = res.nextCursor
  }
  return seen
}

describe('search paging under bm25 drift', () => {
  it('a message written between page 1 and 2 causes no gap and no repeat', () => {
    const ids = seed()
    const reference = pageThrough('lantern', 10)
    expect(reference).toHaveLength(60)

    let newcomer = 0
    const seen = pageThrough('lantern', 10, (page) => {
      if (page === 0) {
        // A strong match plus a burst of rows that move N and the average length.
        newcomer = write('lantern lantern lantern lantern lantern lantern')
        for (let i = 0; i < 30; i++) write(`lantern ${'long tail filler '.repeat(i % 5)}`)
      }
    })
    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b))
    // Exactly the order page 1 promised.
    expect(seen).toEqual(reference)
    // The newcomer waits for a fresh search instead of landing in the middle.
    expect(seen).not.toContain(newcomer)
    expect(searchMessages(db, 1, 'lantern', { limit: 5, includeArchived: false }).hits[0]?.messageId).toBe(newcomer)
  })

  it('the cursor carries the upper bound', () => {
    seed()
    const first = searchMessages(db, 1, 'lantern', { limit: 10, includeArchived: false })
    const cursor = decodeSearchCursor(first.nextCursor)!
    const max = (db.prepare('SELECT MAX(id) AS id FROM chat_messages').get() as { id: number }).id
    expect(cursor).toMatchObject({ m: 'fts', b: max })
  })

  it('still accepts a cursor without the bound (W6b clients)', () => {
    seed()
    const first = searchMessages(db, 1, 'lantern', { limit: 10, includeArchived: false })
    const { b: _b, ...legacy } = decodeSearchCursor(first.nextCursor)!
    const old = encodeSearchCursor(legacy)
    expect(decodeSearchCursor(old)).not.toBeNull()
    const second = searchMessages(db, 1, 'lantern', { limit: 10, includeArchived: false, cursor: old })
    expect(second.hits).toHaveLength(10)
    const firstIds = new Set(first.hits.map(h => h.messageId))
    expect(second.hits.some(h => firstIds.has(h.messageId))).toBe(false)
    // Its own next cursor is a bounded one again.
    expect(decodeSearchCursor(second.nextCursor)?.b).toEqual(expect.any(Number))
  })

  it('continues sensibly when the cursor message was deleted meanwhile', () => {
    seed()
    const reference = pageThrough('lantern', 10)
    const first = searchMessages(db, 1, 'lantern', { limit: 10, includeArchived: false })
    const last = first.hits.at(-1)!.messageId
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(last)
    const second = searchMessages(db, 1, 'lantern', { limit: 10, includeArchived: false, cursor: first.nextCursor! })
    expect(second.hits.map(h => h.messageId)).toEqual(reference.slice(10, 20))
  })

  it('rejects a bound that is not a positive integer', () => {
    seed()
    const first = searchMessages(db, 1, 'lantern', { limit: 10, includeArchived: false })
    const decoded = decodeSearchCursor(first.nextCursor)!
    for (const b of [0, -3, 1.5, 'x']) {
      expect(decodeSearchCursor(Buffer.from(JSON.stringify({ ...decoded, b })).toString('base64url'))).toBeNull()
    }
  })
})
