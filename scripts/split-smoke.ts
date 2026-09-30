/**
 * Smoke run of split-on-intake against the real router chain and a read-only
 * copy of the live database. Not part of the test suite: it costs model calls.
 *
 *   DATA_DIR=/data npx tsx scripts/split-smoke.ts
 */
import { createRequire } from 'node:module'
import { runCaptureSplit, segmentSentences } from '../packages/core/src/capture-split.js'
import { resolveRouterChain } from '../packages/core/src/router-model.js'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const DB_PATH = '/tmp/axiom-copy.db'

function messageText(db: InstanceType<typeof Database>, id: number): string {
  const row = db.prepare('SELECT content FROM chat_messages WHERE id = ?').get(id) as { content: string } | undefined
  if (!row) throw new Error(`message ${id} not found`)
  return row.content
}

/** The spike's interleave: blocks of 1..3 sentences, alternating, seeded. */
function interleave(ids: number[], db: InstanceType<typeof Database>): { text: string; truth: string[] } {
  const sequences = ids.map(id => segmentSentences(messageText(db, id)))
  let seed = ids.reduce((a, b) => a + b, 7)
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const cursors = sequences.map(() => 0)
  const out: string[] = []
  const truth: string[] = []
  let last = -1
  while (cursors.some((c, k) => c < sequences[k].length)) {
    const open = sequences.map((_, k) => k).filter(k => cursors[k] < sequences[k].length && k !== last)
    const k = open.length ? open[Math.floor(rnd() * open.length)] : sequences.findIndex((s, i) => cursors[i] < s.length)
    const block = 1 + Math.floor(rnd() * 3)
    for (let b = 0; b < block && cursors[k] < sequences[k].length; b += 1) {
      out.push(sequences[k][cursors[k]++])
      truth.push(String.fromCharCode(65 + k))
    }
    last = k
  }
  return { text: out.join(' '), truth }
}

/** Sentence accuracy against the known source of every sentence of a mix. */
function accuracy(truth: string[], parts: Array<{ index: number; sentenceIds: number[] }>): string {
  const proposed = new Array<string>(truth.length).fill('?')
  for (const part of parts) for (const id of part.sentenceIds) proposed[id - 1] = String(part.index)
  const pairs = new Map<string, number>()
  for (let i = 0; i < truth.length; i += 1) {
    const key = `${truth[i]}|${proposed[i]}`
    pairs.set(key, (pairs.get(key) ?? 0) + 1)
  }
  const sorted = [...pairs.entries()].sort((a, b) => b[1] - a[1])
  const usedTruth = new Set<string>()
  const usedPart = new Set<string>()
  let correct = 0
  for (const [key, count] of sorted) {
    const [t, p] = key.split('|')
    if (usedTruth.has(t) || usedPart.has(p)) continue
    usedTruth.add(t); usedPart.add(p); correct += count
  }
  const assigned = parts.flatMap(p => p.sentenceIds)
  const unique = new Set(assigned)
  return `accuracy ${(100 * correct / truth.length).toFixed(1)} % (${correct}/${truth.length}), sentences assigned ${assigned.length}, unique ${unique.size}, expected ${truth.length}`
}

async function run(label: string, text: string, truth?: string[]): Promise<void> {
  const started = Date.now()
  const split = await runCaptureSplit(text)
  console.log(`\n=== ${label} (${text.length} chars, ${segmentSentences(text).length} sentences)`)
  console.log(`parts: ${split.parts.length} | splitConfidence ${split.splitConfidence} | gated ${split.gated} | model ${split.model} | ${((Date.now() - started) / 1000).toFixed(1)} s`)
  console.log(`rationale: ${split.rationale}`)
  for (const note of split.notes) console.log(`note: ${note}`)
  if (truth) console.log(accuracy(truth, split.parts))
  for (const part of split.parts) {
    console.log(`--- part ${part.index}: "${part.title}" sentences [${part.sentenceIds.join(',')}] ${part.text.length} chars`)
    console.log(part.text.slice(0, 400))
  }
}

async function main(): Promise<void> {
  console.log(`chain: ${resolveRouterChain().map(e => e.composite).join(', ') || '(empty)'}`)
  const db = new Database(DB_PATH, { readonly: true })
  const single = messageText(db, 121717)
  const mixed = interleave([25559, 23329], db)
  db.close()
  await run('single topic: chat_messages 121717', single)
  await run('interleaved mix: 25559 + 23329', mixed.text, mixed.truth)
}

main().catch(err => { console.error(err); process.exit(1) })
