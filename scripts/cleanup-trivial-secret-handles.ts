/**
 * Remove named junk handles from `<DATA_DIR>/config/secrets.json`
 * (fix 2026-10-19, narrowed after review finding 6 and re-review).
 *
 * Nothing is selected by value. You name the slugs; the script only removes
 * existing handles whose source is automatic (`tool:shell`, `vaultwarden`) and
 * that were never stored explicitly, and removes nothing at all if one slug is
 * unknown or refused. A `form`/`chat`/provider handle can never be removed.
 *
 * RUN IT ONLY WITH THE BACKEND STOPPED. There is no file lock; instead the
 * script refuses (exit 3, no change, not even a dry run) while an Offtangent
 * backend is running: a process with `dist/server.js` in its command line, or
 * anything listening on 127.0.0.1:3000 (override with CLEANUP_BACKEND_PORT).
 *
 * NEVER prints a value: only slug, kind, source and length.
 *
 *   npx tsx scripts/cleanup-trivial-secret-handles.ts --slugs a,b,c            # dry run
 *   npx tsx scripts/cleanup-trivial-secret-handles.ts --slugs a,b,c --apply    # backup + remove
 *
 * Needs the same DATA_DIR / ENCRYPTION_KEY as the backend (take them from the
 * backend's environment before stopping it). `--apply` first creates
 * secrets.json.bak-<timestamp> exclusively with mode 0600, writes it
 * completely and verifies it byte by byte; only then is secrets.json replaced
 * atomically (temp file + rename, 0600). Rollback: copy the backup back over
 * secrets.json and `chmod 600` it.
 */
import { runCleanupCli } from '../packages/core/src/secret-handle-cleanup.js'

const port = process.env.CLEANUP_BACKEND_PORT ? Number(process.env.CLEANUP_BACKEND_PORT) : undefined
const result = await runCleanupCli(process.argv.slice(2), port ? { port } : {})
for (const line of result.out) console.log(line)
for (const line of result.err) console.error(line)
process.exit(result.code)
