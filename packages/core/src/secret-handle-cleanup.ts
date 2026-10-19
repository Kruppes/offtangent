/**
 * Targeted removal of junk secret handles by slug (fix 2026-10-19, narrowed
 * after review finding 6).
 *
 * Earlier versions picked handles by a VALUE heuristic ("common word",
 * "placeholder"), which also matched real form handles (a dictionary password,
 * a repeated PIN). Now:
 *
 * - the caller names the slugs explicitly (`--slugs a,b,c`); nothing is
 *   selected by value;
 * - only handles whose `source` is an automatic one ({@link CLEANUP_ALLOWED_SOURCES})
 *   may be removed — a `form`, `chat`, provider or any other source is refused;
 * - the origin is checked again INSIDE the secrets.json lock, right before the
 *   write, so a concurrent rename/re-seal cannot slip a form handle in;
 * - all-or-nothing: if any slug is unknown or refused, nothing is removed;
 * - with `apply`, a backup is created exclusively (`open(…, 'wx', 0o600)`)
 *   and filled with the current file bytes before the write; secrets.json is
 *   0600 afterwards (`saveSecrets`).
 *
 * Never returns or prints a value: only slug, kind, source and length.
 */

import fs from 'node:fs'
import { loadSecrets, saveSecrets, secretsFilePath, withSecretsFileLock } from './secrets-config.js'
import { invalidateSecretHandleCache } from './secret-store.js'

/** Sources whose handles were created automatically and may be cleaned up. */
export const CLEANUP_ALLOWED_SOURCES: ReadonlySet<string> = new Set(['tool:shell', 'vaultwarden'])

export interface CleanupHandleReport {
  slug: string
  /** `remove` = eligible; otherwise the reason it is refused. */
  status: 'remove' | 'unknown-slug' | 'source-not-allowed'
  kind?: string
  source?: string
  length?: number
}

export interface CleanupResult {
  /** True when the store was changed. */
  applied: boolean
  /** True when at least one slug was refused (then nothing is removed). */
  refused: boolean
  handles: CleanupHandleReport[]
  backupPath?: string
  removed: number
}

/** Parse `a,b , c` into a deduplicated slug list. */
export function parseSlugList(raw: string): string[] {
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))]
}

function inspect(slugs: readonly string[]): CleanupHandleReport[] {
  const handles = loadSecrets().handles ?? {}
  return slugs.map(slug => {
    const record = Object.prototype.hasOwnProperty.call(handles, slug) ? handles[slug] : undefined
    if (!record) return { slug, status: 'unknown-slug' as const }
    const meta = { kind: record.kind, source: record.source, length: record.length ?? 0 }
    if (!CLEANUP_ALLOWED_SOURCES.has(record.source)) return { slug, status: 'source-not-allowed' as const, ...meta }
    return { slug, status: 'remove' as const, ...meta }
  })
}

/** Create `backupPath` exclusively with mode 0600 and fill it with `content`. */
export function writeExclusiveBackup(backupPath: string, content: Buffer): void {
  const fd = fs.openSync(backupPath, 'wx', 0o600)
  try {
    fs.writeSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Remove the named handles (or only report with `apply: false`).
 *
 * `backupSuffix` defaults to a timestamp; the backup sits next to
 * secrets.json as `secrets.json.bak-<suffix>`.
 */
export function cleanupSecretHandlesBySlug(options: {
  slugs: readonly string[]
  apply: boolean
  backupSuffix?: string
}): CleanupResult {
  const slugs = [...new Set(options.slugs)]
  if (!options.apply) {
    const handles = inspect(slugs)
    return { applied: false, refused: handles.some(h => h.status !== 'remove'), handles, removed: 0 }
  }
  return withSecretsFileLock(() => {
    // Re-check the origin inside the lock, right before the write.
    const handles = inspect(slugs)
    const refused = handles.some(h => h.status !== 'remove')
    if (refused || handles.length === 0) return { applied: false, refused, handles, removed: 0 }

    const file = secretsFilePath()
    const suffix = options.backupSuffix ?? new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${file}.bak-${suffix}`
    writeExclusiveBackup(backupPath, fs.readFileSync(file))

    const data = loadSecrets()
    const next = { ...(data.handles ?? {}) }
    let removed = 0
    for (const h of handles) {
      if (next[h.slug]) {
        delete next[h.slug]
        removed++
      }
    }
    saveSecrets({ ...data, handles: next })
    invalidateSecretHandleCache()
    return { applied: true, refused: false, handles, backupPath, removed }
  })
}
