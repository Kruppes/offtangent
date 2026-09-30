#!/usr/bin/env node
/**
 * Micro-benchmark for the secret boundary (F9 of the review triage
 * 2026-09-26 19:25). NOT part of the test suite — it allocates megabytes and
 * takes a few seconds.
 *
 *   node scripts/bench-secret-boundary.mjs
 *
 * Measures the two functions that run on every tool result:
 *   - redactKnown()   — literal replacement of every known value
 *   - detectSecrets() — the structural detector (tier `strong`)
 * over 1 MB and 5 MB of synthetic tool output with 50 known values in the
 * store, one of them a PEM block — plus sealSystemText() over a 100 KB system
 * prompt, which since the F2 fix runs on every buildSystemPrompt() call.
 *
 * Everything is synthetic and assembled at runtime; nothing is read from a
 * real store. The benchmark uses its own DATA_DIR in the OS temp directory.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-secret-boundary-'))
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true })
process.env.DATA_DIR = tmp
process.env.ENCRYPTION_KEY = 'bench-key-not-a-real-secret'

const core = await import('../packages/core/dist/index.js')
const { sealSecret, invalidateSecretHandleCache } = core
const { redactKnown, invalidateKnownValues } = core
const { detectSecrets } = core
const { sealSystemText } = core
const { secretFilesSignature, invalidateSecretFilesSignature, SECRET_FILE_DIRS_ENV } = core

// ── synthetic known values ────────────────────────────────────────────
const parts = ['bench', 'value']
const knownValues = []
for (let i = 0; i < 49; i++) {
  knownValues.push([...parts, String(i).padStart(3, '0'), 'Xq7Zr'].join('-'))
}
const pemBody = Array.from({ length: 24 }, (_, i) => `MIIEow${String(i).padStart(3, '0')}IBAAKCAQEAvbench0000000000000000000000000000000000000`).join('\n')
const pem = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ') + '\n' + pemBody + '\n' + ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')
knownValues.push(pem)

for (const value of knownValues) sealSecret(value, 'password', 'bench')
invalidateSecretHandleCache()
invalidateKnownValues()

// ── synthetic tool output ─────────────────────────────────────────────
function buildOutput(targetBytes) {
  const chunks = []
  let size = 0
  let i = 0
  while (size < targetBytes) {
    // every 40th line carries a known value, every 97th a SHAPED token so the
    // structural detector has real work too (assembled at runtime, synthetic)
    const shaped = ['gh', 'p', '_'].join('') + 'Bench'.repeat(2) + String(i).padStart(4, '0') + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7'
    const line = i % 40 === 0
      ? `2026-09-26T19:${String(i % 60).padStart(2, '0')}:00 value=${knownValues[i % knownValues.length]}\n`
      : i % 97 === 0
        ? `2026-09-26T19:00:00 WARN token=${shaped} rejected\n`
        : `2026-09-26T19:00:00 INFO worker ${i} processed batch ${i * 7} in ${i % 97}ms path=/data/x/${i}/file.json\n`
    chunks.push(line)
    size += line.length
    i++
  }
  return chunks.join('')
}

function measure(label, fn, runs = 3) {
  // one warm-up run, then the median of `runs`
  fn()
  const times = []
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint()
    fn()
    times.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  console.log(`${label.padEnd(34)} ${median.toFixed(1).padStart(9)} ms   (runs: ${times.map(t => t.toFixed(1)).join(', ')})`)
  return median
}

/**
 * A realistically large system prompt (~100 KB): persona, memory block, skill
 * list, provider list and docs excerpts. Synthetic text, but with the shape of
 * the real thing — long prose lines plus a few key=value lines, no known store
 * value in it (a system prompt normally carries none).
 */
function buildSystemPrompt(targetBytes) {
  const chunks = []
  let size = 0
  let i = 0
  while (size < targetBytes) {
    const line = i % 11 === 0
      ? `- skill ${i}: use it when the user asks about topic ${i % 37}; entry point scripts/skill-${i}.md\n`
      : i % 23 === 0
        ? `provider ${i % 9} model qwen3-coder:${i}b context=262144 hosting=local audit=on\n`
        : `You are a careful assistant. Paragraph ${i} explains that the answer must stay short, name concrete files and never invent a command that was not run.\n`
    chunks.push(line)
    size += line.length
    i++
  }
  return chunks.join('')
}

const systemPrompt = buildSystemPrompt(100 * 1024)
console.log(`\n── 100 KB system prompt (${systemPrompt.length} chars, F2 path: every buildSystemPrompt) ──`)
console.log(`   sanity: sealed length ${sealSystemText(systemPrompt, 'bench').length}`)
measure('sealSystemText 100 KB', () => sealSystemText(systemPrompt, 'bench'))

for (const mb of [1, 5]) {
  const text = buildOutput(mb * 1024 * 1024)
  console.log(`\n── ${mb} MB tool output (${text.length} chars, 50 known values incl. PEM) ──`)
  const redacted = redactKnown(text)
  const replaced = (redacted.match(/\{\{secret:/g) ?? []).length
  console.log(`   sanity: ${replaced} known values replaced, ${detectSecrets(text, { tier: 'strong' }).length} structural findings`)
  measure(`redactKnown ${mb} MB`, () => redactKnown(text))
  measure(`detectSecrets strong ${mb} MB`, () => detectSecrets(text, { tier: 'strong' }))
}

// ── F9: the throttled file signature on the hot path ─────────────────
// Before the fix `secretFilesSignature()` ran on EVERY redactKnown() call:
// one readdir per secret directory plus one stat per file. This section
// contrasts the throttled call with the unthrottled one (explicit
// invalidation before each call = the old behaviour).
const secretsDir = path.join(tmp, 'secrets')
fs.mkdirSync(secretsDir, { recursive: true })
for (let i = 0; i < 20; i++) {
  fs.writeFileSync(path.join(secretsDir, `bench-${i}.env`), `TOKEN_${i}=bench-file-value-${i}-Zq7Xr\n`)
}
process.env[SECRET_FILE_DIRS_ENV] = secretsDir
invalidateSecretFilesSignature()
invalidateKnownValues()

const CALLS = 10_000
console.log(`\n── F9: secretFilesSignature(), ${CALLS} calls, 20 secret files ──`)
measure(`signature throttled x${CALLS}`, () => {
  for (let i = 0; i < CALLS; i++) secretFilesSignature()
})
measure(`signature per call (pre-F9) x${CALLS}`, () => {
  for (let i = 0; i < CALLS; i++) {
    invalidateSecretFilesSignature()
    secretFilesSignature()
  }
})
invalidateSecretFilesSignature()

// The same contrast on the real hot path: a 4 KB message going through
// redactKnown 2000 times (a busy turn with many tool results).
const hotText = buildOutput(4 * 1024)
const HOT_CALLS = 2_000
console.log(`\n── F9: redactKnown() on ${hotText.length} chars, ${HOT_CALLS} calls ──`)
measure(`redactKnown throttled x${HOT_CALLS}`, () => {
  for (let i = 0; i < HOT_CALLS; i++) redactKnown(hotText)
})
measure(`redactKnown file stat per call x${HOT_CALLS}`, () => {
  for (let i = 0; i < HOT_CALLS; i++) {
    invalidateSecretFilesSignature()
    redactKnown(hotText)
  }
})

// The second throttled part of the signature is the scan over process.env. It
// has no public invalidation (invalidateKnownValues() would also drop the
// index, which pre-F9 was NOT rebuilt per call), so its per-call cost is
// measured directly here with the same filter the boundary uses. Add this row
// to the one above to get the full pre-F9 cost of HOT_CALLS redactions.
const ENV_NAME_RE = /KEY|SECRET|TOKEN|PASSWORD/i
measure(`env scan per call x${HOT_CALLS}`, () => {
  for (let i = 0; i < HOT_CALLS; i++) {
    const parts = []
    for (const [name, value] of Object.entries(process.env)) {
      if (!value || value.length < 8) continue
      if (!ENV_NAME_RE.test(name)) continue
      parts.push(`${name}=${value.length}`)
    }
    parts.join('|')
  }
})

fs.rmSync(tmp, { recursive: true, force: true })
