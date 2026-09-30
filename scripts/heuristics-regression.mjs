#!/usr/bin/env node
/**
 * Heuristics regression corpus runner (SPEC 12.3).
 *
 * Every numeric heuristic in the backend is a configuration value
 * (`heuristics` block in settings.json, defaults in
 * packages/core/src/heuristics.ts). A default may only change after a run
 * of this script over a corpus of real strands with a known correct
 * outcome. The corpus is user data and lives OUTSIDE the repo; this script,
 * the case format and the report format live here.
 *
 * Usage:
 *   node scripts/heuristics-regression.mjs --corpus /data/heuristics-corpus \
 *        [--override overrides.json] [--repeat 3] [--out report.json]
 *   node scripts/heuristics-regression.mjs --export --db /data/db/axiom.db \
 *        --session <id> --out /data/heuristics-corpus/<name>.json
 *
 * Case file (one strand per file, JSON):
 *   {
 *     "name": "billing-migration-2026-09-01",
 *     "messages": [ { "role": "user"|"assistant", "content": "...", "timestamp": "2026-09-01T10:00:00Z" }, ... ],
 *     "expected": {
 *       "shiftAt": [12, 31],                 // indexes of user messages that start a new topic (empty = none)
 *       "duplicates": [ ["fact a", "fact a rephrased"], ... ]   // pairs the duplicate gate must merge
 *       "distinct":   [ ["fact a", "fact b"], ... ]             // pairs it must keep apart
 *     }
 *   }
 *
 * Override file: the same shape as the `heuristics` block in settings.json,
 * e.g. { "topicShift": { "jaccardThreshold": 0.3 } }.
 *
 * Report: per case and per heuristic the success rate, and the variance over
 * `--repeat` runs. Variance is the primary number (TRACE, arXiv:2608.06503).
 * Deterministic heuristics have variance 0 by construction; the field is
 * there so model backed steps (summary delta, fact extraction) can be added
 * to the same report without changing its shape. Removal criterion: if
 * switching a heuristic off keeps success equal and does not raise
 * variance, the heuristic goes.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

const args = parseArgs(process.argv.slice(2))
const require = createRequire(import.meta.url)

async function loadCore() {
  const distIndex = path.resolve(process.cwd(), 'packages/core/dist/index.js')
  if (!fs.existsSync(distIndex)) {
    console.error('packages/core/dist not found; run `npm run build --workspace=packages/core` first')
    process.exit(2)
  }
  return import(distIndex)
}

function parseArgs(argv) {
  const out = { repeat: 3 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--export') out.export = true
    else if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1], i++
  }
  return out
}

function variance(values) {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
}

async function exportCase(core) {
  if (!args.db || !args.session || !args.out) {
    console.error('--export needs --db, --session and --out')
    process.exit(2)
  }
  const Database = require('better-sqlite3')
  const db = new Database(args.db, { readonly: true })
  const rows = db.prepare(
    `SELECT role, content, timestamp FROM chat_messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id ASC`,
  ).all(args.session)
  const summary = core.getLatestSessionSummary(db, args.session)
  const caseFile = {
    name: path.basename(args.out, '.json'),
    sessionId: args.session,
    messages: rows,
    summary: summary?.summary ?? null,
    expected: { shiftAt: [], duplicates: [], distinct: [] },
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, JSON.stringify(caseFile, null, 2))
  console.log(`exported ${rows.length} messages to ${args.out}; fill in "expected" by hand`)
}

function runTopicShift(core, messages, thresholds, expectedShiftAt) {
  const history = []
  const predicted = []
  messages.forEach((m, idx) => {
    const msg = core.toSessionMessages([{ content: m.content, timestamp: m.timestamp }])[0]
    if (m.role === 'user' && history.length > 0) {
      const r = core.detectTopicShift(history, msg, false, thresholds)
      if (r.shiftDetected) predicted.push(idx)
    }
    history.push(msg)
  })
  const expected = new Set(expectedShiftAt)
  const tp = predicted.filter(i => expected.has(i)).length
  const fp = predicted.length - tp
  const fn = expectedShiftAt.length - tp
  const precision = predicted.length ? tp / predicted.length : (expectedShiftAt.length ? 0 : 1)
  const recall = expectedShiftAt.length ? tp / expectedShiftAt.length : 1
  return { predicted, tp, fp, fn, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 }
}

function runDuplicateGate(core, pairs, distinct, overlap) {
  // Uses the same word overlap the extractor uses (exported for this purpose).
  let ok = 0
  let total = 0
  for (const [a, b] of pairs) {
    total++
    if (core.computeFactOverlap(a, b) > overlap) ok++
  }
  for (const [a, b] of distinct) {
    total++
    if (core.computeFactOverlap(a, b) <= overlap) ok++
  }
  return { ok, total, success: total ? ok / total : 1 }
}

async function main() {
  const core = await loadCore()
  if (args.export) return exportCase(core)
  if (!args.corpus) {
    console.error('need --corpus <dir> (or --export)')
    process.exit(2)
  }
  const override = args.override ? JSON.parse(fs.readFileSync(args.override, 'utf-8')) : undefined
  const heuristics = core.resolveHeuristics(override)
  const repeat = Math.max(1, Number.parseInt(String(args.repeat), 10) || 3)
  const files = fs.readdirSync(args.corpus).filter(f => f.endsWith('.json')).sort()
  if (files.length === 0) {
    console.error(`no case files in ${args.corpus}`)
    process.exit(2)
  }

  const cases = []
  for (const file of files) {
    const c = JSON.parse(fs.readFileSync(path.join(args.corpus, file), 'utf-8'))
    const shiftRuns = []
    const dupRuns = []
    for (let r = 0; r < repeat; r++) {
      shiftRuns.push(runTopicShift(core, c.messages ?? [], heuristics.topicShift, c.expected?.shiftAt ?? []))
      dupRuns.push(runDuplicateGate(core, c.expected?.duplicates ?? [], c.expected?.distinct ?? [], heuristics.factExtraction.duplicateOverlap))
    }
    cases.push({
      name: c.name ?? file,
      messages: (c.messages ?? []).length,
      topicShift: {
        f1: shiftRuns[0].f1,
        precision: shiftRuns[0].precision,
        recall: shiftRuns[0].recall,
        predicted: shiftRuns[0].predicted,
        variance: variance(shiftRuns.map(r => r.f1)),
      },
      duplicateGate: {
        success: dupRuns[0].success,
        checked: dupRuns[0].total,
        variance: variance(dupRuns.map(r => r.success)),
      },
    })
  }

  const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
  const report = {
    generatedAt: new Date().toISOString(),
    corpus: path.resolve(args.corpus),
    override: override ?? null,
    heuristics,
    repeat,
    summary: {
      cases: cases.length,
      topicShiftF1: mean(cases.map(c => c.topicShift.f1)),
      topicShiftVariance: mean(cases.map(c => c.topicShift.variance)),
      duplicateGateSuccess: mean(cases.filter(c => c.duplicateGate.checked > 0).map(c => c.duplicateGate.success)),
    },
    cases,
  }

  const out = args.out ?? path.join(process.cwd(), 'heuristics-report.json')
  fs.writeFileSync(out, JSON.stringify(report, null, 2))

  console.log(`heuristics regression: ${cases.length} cases, repeat ${repeat}`)
  console.log(`  topic shift F1 ${report.summary.topicShiftF1.toFixed(3)} (variance ${report.summary.topicShiftVariance.toFixed(4)})`)
  console.log(`  duplicate gate success ${report.summary.duplicateGateSuccess.toFixed(3)}`)
  console.log('| case | msgs | shift F1 | P | R | dup ok | var |')
  console.log('|---|---:|---:|---:|---:|---:|---:|')
  for (const c of cases) {
    console.log(`| ${c.name} | ${c.messages} | ${c.topicShift.f1.toFixed(2)} | ${c.topicShift.precision.toFixed(2)} | ${c.topicShift.recall.toFixed(2)} | ${c.duplicateGate.success.toFixed(2)} | ${c.topicShift.variance.toFixed(4)} |`)
  }
  console.log(`report: ${out}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
