#!/usr/bin/env node
/**
 * How long does the `feed_items` rebuild (boards migration) take on a feed
 * that is far bigger than any real one? Seeds a synthetic database with the
 * OLD table shape and measures `initDatabase()` — i.e. the rebuild plus the
 * index recreation — and then a second, already-migrated boot.
 *
 * Usage: node scripts/measure-feed-rebuild.mjs [rowCount]   (default 200000)
 * Requires `npm run build` (it imports packages/core/dist).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase } from '../packages/core/dist/index.js'

const rows = Number(process.argv[2] ?? 200_000)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-feed-rebuild-'))
const dbPath = path.join(dir, 'axiom.db')

const raw = new Database(dbPath)
raw.exec(`
  CREATE TABLE feed_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT,
    kind TEXT NOT NULL
      CHECK(kind IN ('task_result','task_question','cron_report','heartbeat','reminder','system')),
    title TEXT NOT NULL,
    body TEXT,
    task_id TEXT,
    strand_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT
  );
  CREATE INDEX idx_feed_user_created ON feed_items(user_id, created_at DESC);
`)
const insert = raw.prepare(
  `INSERT INTO feed_items (id, user_id, agent_id, kind, title, body, task_id, strand_id, created_at, read_at)
   VALUES (?, ?, 'main', ?, ?, ?, ?, ?, ?, ?)`,
)
const seed = raw.transaction(() => {
  for (let i = 0; i < rows; i++) {
    insert.run(
      `item-${i}`,
      String((i % 3) + 1),
      i % 2 === 0 ? 'cron_report' : 'task_result',
      `Synthetic item ${i}`,
      `Body ${i} `.repeat(20),
      `task-${i}`,
      i % 4 === 0 ? null : `strand-${i}`,
      '2026-09-20 06:00:00',
      i % 7 === 0 ? '2026-09-20 07:00:00' : null,
    )
  }
})
seed()
raw.close()

const sizeMb = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1)

const t0 = performance.now()
const db = initDatabase(dbPath)
const migrateMs = performance.now() - t0
const after = db.prepare('SELECT COUNT(*) AS c FROM feed_items').get().c
const firstRowid = db.prepare('SELECT rowid AS rid, id FROM feed_items ORDER BY rowid LIMIT 1').get()
db.close()

const t1 = performance.now()
const db2 = initDatabase(dbPath)
const secondMs = performance.now() - t1
db2.close()

console.log(JSON.stringify({
  rows,
  dbSizeMb: Number(sizeMb),
  rowsAfter: after,
  firstRow: firstRowid,
  migrationMs: Math.round(migrateMs),
  secondBootMs: Math.round(secondMs),
}, null, 2))

fs.rmSync(dir, { recursive: true, force: true })
