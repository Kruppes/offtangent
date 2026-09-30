/**
 * Runtime of the strand task tree on a copy of the live database.
 *
 * Usage: node scripts/perf-strand-tasks.mjs /path/to/copy.db
 * Prints p50/p95/max over the busiest strands plus a cold-run number.
 */
import { createRequire } from 'node:module'
import { buildStrandTaskTree } from '../packages/core/dist/task-tree.js'

const require = createRequire(import.meta.url)
const DatabaseCtor = require('better-sqlite3')

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: node scripts/perf-strand-tasks.mjs <db>')
  process.exit(1)
}

const db = new DatabaseCtor(dbPath, { readonly: true })

// Strands that actually have tasks hanging off them (the expensive case),
// plus a sample of plain strands (the common case).
const busy = db.prepare(`
  SELECT s.parent_session_id AS id, COUNT(*) AS c
    FROM tasks t JOIN sessions s ON s.id = t.session_id
   WHERE s.parent_session_id IS NOT NULL
   GROUP BY s.parent_session_id
   ORDER BY c DESC
   LIMIT 25
`).all()

const plain = db.prepare(
  "SELECT id FROM sessions WHERE type = 'interactive' ORDER BY last_activity DESC LIMIT 100",
).all()

function measure(label, ids, include) {
  const times = []
  let nodes = 0
  for (const { id } of ids) {
    const t0 = process.hrtime.bigint()
    const tree = buildStrandTaskTree(db, id, { include })
    const t1 = process.hrtime.bigint()
    times.push(Number(t1 - t0) / 1e6)
    nodes += tree.tasks.length
  }
  times.sort((a, b) => a - b)
  const p = q => times[Math.min(times.length - 1, Math.floor(times.length * q))]
  console.log(
    `${label} include=${include}: n=${times.length} nodes=${nodes} ` +
    `p50=${p(0.5).toFixed(2)}ms p95=${p(0.95).toFixed(2)}ms max=${times[times.length - 1].toFixed(2)}ms`,
  )
}

console.log('busiest strands by delegated task count:', busy.slice(0, 5).map(b => `${b.id.slice(0, 8)}…=${b.c}`).join(' '))

// Cold: very first call, includes SQLite page cache misses.
const cold0 = process.hrtime.bigint()
const coldTree = buildStrandTaskTree(db, busy[0].id, { include: 'all' })
const cold1 = process.hrtime.bigint()
console.log(`cold first call on the busiest strand: ${(Number(cold1 - cold0) / 1e6).toFixed(2)}ms (${coldTree.tasks.length} nodes)`)

measure('busy strands', busy, 'all')
measure('busy strands', busy, 'active')
measure('recent strands', plain, 'active')

db.close()
