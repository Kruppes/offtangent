/**
 * Remove named junk handles from `<DATA_DIR>/config/secrets.json`
 * (fix 2026-10-19, narrowed after review finding 6).
 *
 * Nothing is selected by value. You name the slugs; the script only removes
 * handles whose source is automatic (`tool:shell`, `vaultwarden`), re-checks
 * that origin inside the secrets.json lock right before the write, and removes
 * nothing at all if one slug is unknown or refused. A `form`/`chat`/provider
 * handle can never be removed this way.
 *
 * NEVER prints a value: only slug, kind, source and length.
 *
 *   npx tsx scripts/cleanup-trivial-secret-handles.ts --slugs a,b,c            # dry run
 *   npx tsx scripts/cleanup-trivial-secret-handles.ts --slugs a,b,c --apply    # backup + remove
 *
 * Needs the same DATA_DIR / ENCRYPTION_KEY as the backend (run it inside the
 * container, e.g. with `env $(cat /proc/<backend-pid>/environ | tr '\0' '\n' | grep -E '^(DATA_DIR|ENCRYPTION_KEY)=')`).
 * `--apply` first creates secrets.json.bak-<timestamp> exclusively with mode
 * 0600 and fills it with the current bytes. Rollback: copy the backup back over
 * secrets.json and `chmod 600` it.
 */
import { cleanupSecretHandlesBySlug, CLEANUP_ALLOWED_SOURCES, parseSlugList } from '../packages/core/src/secret-handle-cleanup.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const slugArgIndex = args.indexOf('--slugs')
const slugArg = slugArgIndex >= 0 ? args[slugArgIndex + 1] : args.find(a => a.startsWith('--slugs='))?.slice('--slugs='.length)
if (!slugArg) {
  console.error('usage: cleanup-trivial-secret-handles.ts --slugs a,b,c [--apply]')
  process.exit(2)
}
const slugs = parseSlugList(slugArg)

const result = cleanupSecretHandlesBySlug({ slugs, apply })
for (const h of result.handles) {
  const meta = h.kind ? `\tkind=${h.kind}\tsource=${h.source}\tlen=${h.length}` : ''
  console.log(`  ${h.slug}\t${h.status}${meta}`)
}
if (result.refused) {
  console.error(`refused: only handles with source ${[...CLEANUP_ALLOWED_SOURCES].join('/')} that exist can be removed — nothing was changed`)
  process.exit(1)
}
if (!apply) {
  console.log(`dry run — ${result.handles.length} handle(s) eligible; pass --apply to back up secrets.json and remove them`)
  process.exit(0)
}
console.log(`backup: ${result.backupPath}`)
console.log(`removed: ${result.removed}`)
