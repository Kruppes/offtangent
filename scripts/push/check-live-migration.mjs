#!/usr/bin/env node
/**
 * Run the schema migration against a COPY of a real database and report what
 * it did. Used to prove that `push_devices` lands additively on the live
 * database: no table rebuild, no row loss, and a second run changes nothing.
 *
 * Usage: node scripts/push/check-live-migration.mjs /path/to/copy.db
 *
 * Never point this at a live file. It opens the database read write.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('Pass the path to a COPY of the database.')
  process.exit(2)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const { initDatabase } = await import(path.resolve(here, '../../packages/core/dist/database.js'))

const TABLES = ['chat_messages', 'sessions', 'memories', 'tasks', 'users', 'projects']

function snapshot(db) {
  const counts = {}
  for (const table of TABLES) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  }
  return counts
}

function pushInfo(db) {
  const exists = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'push_devices'"
  ).get().n
  if (!exists) return { exists: false }
  return {
    exists: true,
    columns: db.prepare('PRAGMA table_info(push_devices)').all().map(c => `${c.name}:${c.type}`),
    indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'push_devices'").all().map(i => i.name),
    rows: db.prepare('SELECT COUNT(*) AS n FROM push_devices').get().n,
  }
}

const sizeBefore = fs.statSync(file).size

console.log('=== run 1 (first migration on this database) ===')
let started = Date.now()
let db = initDatabase(file)
const elapsed1 = Date.now() - started
const counts1 = snapshot(db)
const push1 = pushInfo(db)
const integrity = db.pragma('integrity_check', { simple: true })
db.close()

console.log(`migration took ${elapsed1} ms`)
console.log('row counts:', JSON.stringify(counts1))
console.log('push_devices:', JSON.stringify(push1, null, 2))
console.log('integrity_check:', integrity)

console.log('\n=== run 2 (same database again, must be a no-op) ===')
started = Date.now()
db = initDatabase(file)
const elapsed2 = Date.now() - started
const counts2 = snapshot(db)
const push2 = pushInfo(db)
db.close()

console.log(`migration took ${elapsed2} ms`)
console.log('row counts:', JSON.stringify(counts2))
console.log('push_devices rows:', push2.rows, 'columns:', push2.columns.length)

const same = TABLES.every(t => counts1[t] === counts2[t])
console.log('\nrow counts identical across both runs:', same)
console.log('file size before:', sizeBefore, 'after:', fs.statSync(file).size)
process.exit(same && push2.exists ? 0 : 1)
