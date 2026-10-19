/**
 * Remove junk handles from `<DATA_DIR>/config/secrets.json` (fix 2026-10-19).
 *
 * A handle is junk when its value is trivial by `isTrivialSecretValue()` —
 * common word, placeholder, Bitwarden CLI status line, or a model id from
 * providers.json. Such handles made the global redaction rewrite ordinary
 * text. The runtime already ignores them for redaction after the fix; this
 * script removes them from the store so they also stop being resolvable and
 * listed.
 *
 * NEVER prints a value: only slug, kind, source, length and the reason.
 *
 *   npx tsx scripts/cleanup-trivial-secret-handles.ts            # dry run
 *   npx tsx scripts/cleanup-trivial-secret-handles.ts --apply    # backup + remove
 *
 * Needs the same DATA_DIR / ENCRYPTION_KEY as the backend (run it inside the
 * container, e.g. with `env $(cat /proc/<backend-pid>/environ | tr '\0' '\n' | grep -E '^(DATA_DIR|ENCRYPTION_KEY)=')`).
 * `--apply` copies secrets.json to secrets.json.bak-<timestamp> first.
 * Rollback: copy the backup back over secrets.json (mode 600).
 */
import fs from 'node:fs'
import path from 'node:path'
import { providerModelIds } from '../packages/core/src/secret-boundary.js'
import { getConfigDir } from '../packages/core/src/config.js'
import { invalidateSecretHandleCache, knownSecretValues, listSecrets, removeSecret } from '../packages/core/src/secret-store.js'
import { isTrivialSecretValue, TRIVIAL_SECRET_WORDS } from '../packages/core/src/secret-triviality.js'

const apply = process.argv.includes('--apply')
const modelIds = providerModelIds()
const meta = new Map(listSecrets().map(s => [s.slug, s]))

function reason(value: string): string | null {
  const v = value.trim()
  if (modelIds.has(v) || modelIds.has(v.toLowerCase())) return 'model-id'
  if (TRIVIAL_SECRET_WORDS.has(v.toLowerCase())) return 'common-word'
  if (isTrivialSecretValue(v)) return 'placeholder-or-vault-cli-message'
  return null
}

const junk: Array<{ slug: string; kind: string; source: string; length: number; reason: string }> = []
let shortCount = 0
for (const [value, slug] of knownSecretValues()) {
  const r = reason(value)
  if (value.length < 6) shortCount++
  if (!r) continue
  const m = meta.get(slug)
  junk.push({ slug, kind: m?.kind ?? '?', source: m?.source ?? '?', length: value.length, reason: r })
}

console.log(`handles: ${meta.size}, junk: ${junk.length}, below 6 chars (kept, never redacted globally): ${shortCount}`)
for (const j of junk) console.log(`  ${j.slug}\tkind=${j.kind}\tsource=${j.source}\tlen=${j.length}\t${j.reason}`)

if (!apply) {
  console.log('dry run — pass --apply to back up secrets.json and remove these handles')
  process.exit(0)
}
if (junk.length === 0) process.exit(0)

const file = path.join(getConfigDir(), 'secrets.json')
const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
fs.copyFileSync(file, backup)
fs.chmodSync(backup, 0o600)
console.log(`backup: ${backup}`)
let removed = 0
for (const j of junk) if (removeSecret(j.slug)) removed++
invalidateSecretHandleCache()
console.log(`removed: ${removed}`)
