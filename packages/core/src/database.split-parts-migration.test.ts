/**
 * Split-on-intake (plan 2026-09-24) adds five columns to `router_decisions`
 * and one to `chat_messages`. Purely additive, no rebuild, so what has to be
 * proven is that an existing database keeps every row and reads it as the
 * single part it was, and that a second boot changes nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase } from './database.js'
import { getCurrentDecision, listCurrentDecisions, capturePartCount } from './strand-store.js'

describe('split part columns migration', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-split-migration-'))
    dbPath = path.join(tmpDir, 'axiom.db')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** A database built by the previous release, with one filed capture. */
  function seedPrevious(): void {
    const first = initDatabase(dbPath)
    first.close()
    const raw = new Database(dbPath)
    raw.exec('DROP INDEX IF EXISTS idx_router_decisions_part')
    for (const column of ['part_index', 'part_count', 'part_text', 'part_title', 'sentence_ids']) {
      const cols = (raw.prepare('PRAGMA table_info(router_decisions)').all() as Array<{ name: string }>).map(c => c.name)
      if (cols.includes(column)) raw.exec(`ALTER TABLE router_decisions DROP COLUMN ${column}`)
    }
    const chatCols = (raw.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>).map(c => c.name)
    if (chatCols.includes('part_index')) raw.exec('ALTER TABLE chat_messages DROP COLUMN part_index')
    raw.prepare(
      `INSERT INTO captures (id, user_id, text, kind, source, status, strand_id, message_id)
       VALUES ('cap1', '1', 'Winterreifen kaufen.', 'voice', 'puck', 'filed', 's1', 7)`,
    ).run()
    raw.prepare(
      `INSERT INTO router_decisions (id, capture_id, action, target_strand_id, intent, confidence, state, model)
       VALUES ('d1', 'cap1', 'append', 's1', 'note', 0.82, 'applied', 'p:m')`,
    ).run()
    raw.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, capture_id)
       VALUES ('s1', NULL, 'user', 'Winterreifen kaufen.', 'cap1')`,
    ).run()
    raw.close()
  }

  it('adds the columns and reads an old row as one part', () => {
    seedPrevious()
    const db = initDatabase(dbPath)
    const decisionCols = (db.prepare('PRAGMA table_info(router_decisions)').all() as Array<{ name: string }>).map(c => c.name)
    expect(decisionCols).toContain('part_index')
    expect(decisionCols).toContain('part_count')
    expect(decisionCols).toContain('part_text')
    expect(decisionCols).toContain('part_title')
    expect(decisionCols).toContain('sentence_ids')
    const chatCols = (db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>).map(c => c.name)
    expect(chatCols).toContain('part_index')

    const decision = getCurrentDecision(db, 'cap1')!
    expect(decision.id).toBe('d1')
    expect(decision.partIndex).toBe(0)
    expect(decision.partCount).toBe(1)
    expect(decision.partText).toBeNull()
    expect(decision.partTitle).toBeNull()
    expect(decision.sentenceIds).toEqual([])
    expect(capturePartCount(db, 'cap1')).toBe(1)
    expect(listCurrentDecisions(db, 'cap1').map(d => d.id)).toEqual(['d1'])
    expect((db.prepare('SELECT part_index FROM chat_messages WHERE capture_id = ?').get('cap1') as { part_index: number }).part_index).toBe(0)
    db.close()
  })

  it('has the part index and keeps every row on the second boot', () => {
    seedPrevious()
    let db = initDatabase(dbPath)
    const sqlAfterFirst = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'router_decisions'").get() as { sql: string }).sql
    db.close()
    db = initDatabase(dbPath)
    const sqlAfterSecond = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'router_decisions'").get() as { sql: string }).sql
    expect(sqlAfterSecond).toBe(sqlAfterFirst)
    expect((db.prepare('SELECT COUNT(*) AS c FROM router_decisions').get() as { c: number }).c).toBe(1)
    expect((db.prepare('PRAGMA index_list(router_decisions)').all() as Array<{ name: string }>).map(r => r.name))
      .toContain('idx_router_decisions_part')
    db.close()
  })

  it('gives a fresh install the same columns as a migrated one', () => {
    seedPrevious()
    const migrated = initDatabase(dbPath)
    const migratedCols = (migrated.prepare('PRAGMA table_info(router_decisions)').all() as Array<{ name: string; type: string }>)
      .map(c => `${c.name}:${c.type}`)
    migrated.close()
    const fresh = initDatabase(path.join(tmpDir, 'fresh.db'))
    const freshCols = (fresh.prepare('PRAGMA table_info(router_decisions)').all() as Array<{ name: string; type: string }>)
      .map(c => `${c.name}:${c.type}`)
    fresh.close()
    expect(migratedCols).toEqual(freshCols)
  })
})
