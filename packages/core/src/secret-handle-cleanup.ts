/**
 * Targeted removal of junk secret handles by slug (fix 2026-10-19, narrowed
 * after review finding 6 and re-review 2026-10-19).
 *
 * Earlier versions picked handles by a VALUE heuristic ("common word",
 * "placeholder"), which also matched real form handles (a dictionary password,
 * a repeated PIN). Now:
 *
 * - the caller names the slugs explicitly (`--slugs a,b,c`); nothing is
 *   selected by value;
 * - only handles whose `source` is an automatic one ({@link CLEANUP_ALLOWED_SOURCES})
 *   may be removed — a `form`, `chat`, provider or any other source is refused,
 *   and so is a handle marked `explicitlyStored` (an automatic value the user
 *   later filed on purpose, re-review N4);
 * - all-or-nothing: if any slug is unknown or refused, nothing is removed;
 * - with `apply`, a backup is created exclusively (`open(…, 'wx', 0o600)`),
 *   written completely, fsynced, read back and compared byte by byte with the
 *   original; on any mismatch nothing is removed (re-review N6). secrets.json
 *   is then replaced atomically with mode 0600 (`saveSecrets`).
 *
 * There is NO file lock (re-review N2/N3): the cleanup is a one-off run with
 * the backend STOPPED. The CLI refuses to run while an Offtangent backend is
 * up ({@link findRunningBackend}).
 *
 * Never returns or prints a value: only slug, kind, source and length.
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { loadSecrets, saveSecrets, secretsFilePath, writeAllSync } from './secrets-config.js'
import { invalidateSecretHandleCache } from './secret-store.js'

/** Sources whose handles were created automatically and may be cleaned up. */
export const CLEANUP_ALLOWED_SOURCES: ReadonlySet<string> = new Set(['tool:shell', 'vaultwarden'])

export interface CleanupHandleReport {
  slug: string
  /** `remove` = eligible; otherwise the reason it is refused. */
  status: 'remove' | 'unknown-slug' | 'source-not-allowed' | 'explicitly-stored'
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
    if (record.explicitlyStored) return { slug, status: 'explicitly-stored' as const, ...meta }
    if (!CLEANUP_ALLOWED_SOURCES.has(record.source)) return { slug, status: 'source-not-allowed' as const, ...meta }
    return { slug, status: 'remove' as const, ...meta }
  })
}

/**
 * Create `backupPath` exclusively with mode 0600, write ALL of `content`
 * (a loop over `writeSync`, which may write less than asked), fsync, then
 * read the file back and compare it byte by byte. Throws on any mismatch, so
 * the caller never deletes anything on the strength of a partial backup.
 */
export function writeExclusiveBackup(backupPath: string, content: Buffer): void {
  const fd = fs.openSync(backupPath, 'wx', 0o600)
  try {
    writeAllSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  const back = fs.readFileSync(backupPath)
  if (!back.equals(content)) {
    throw new Error(`backup ${path.basename(backupPath)} does not match the original (${back.length} of ${content.length} bytes) — nothing was removed`)
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
  const handles = inspect(slugs)
  const refused = handles.some(h => h.status !== 'remove')
  if (refused || handles.length === 0) return { applied: false, refused, handles, removed: 0 }

  const file = secretsFilePath()
  const suffix = options.backupSuffix ?? new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${file}.bak-${suffix}`
  const original = fs.readFileSync(file)
  writeExclusiveBackup(backupPath, original)

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
}

// ---------------------------------------------------------------------------
// Backend guard: the cleanup runs only while the backend is stopped
// ---------------------------------------------------------------------------

export interface BackendProbeOptions {
  /** `/proc` (overridable for tests). */
  procDir?: string
  /** Health port of the backend (default 3000). */
  port?: number
  host?: string
  timeoutMs?: number
  /** pid to ignore (default: this process). */
  selfPid?: number
}

/** Command-line fragments that identify a running Offtangent backend. */
export const BACKEND_CMDLINE_MARKERS: readonly string[] = ['dist/server.js']

/**
 * Reasons an Offtangent backend looks alive: a process whose command line
 * contains `dist/server.js`, or anything accepting connections on the health
 * port. Empty list = stopped. A probe that cannot run (no `/proc`) is not a
 * reason by itself; the port probe still applies.
 */
export async function findRunningBackend(options: BackendProbeOptions = {}): Promise<string[]> {
  const procDir = options.procDir ?? '/proc'
  const selfPid = options.selfPid ?? process.pid
  const reasons: string[] = []
  let entries: string[] = []
  try {
    entries = fs.readdirSync(procDir)
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === selfPid) continue
    let cmdline: string
    try {
      cmdline = fs.readFileSync(path.join(procDir, entry, 'cmdline'), 'utf-8').split('\0').join(' ')
    } catch {
      continue
    }
    if (BACKEND_CMDLINE_MARKERS.some(marker => cmdline.includes(marker))) reasons.push(`process ${entry} runs ${BACKEND_CMDLINE_MARKERS.join('/')}`)
  }
  const port = options.port ?? 3000
  const host = options.host ?? '127.0.0.1'
  if (await portAcceptsConnections(host, port, options.timeoutMs ?? 1000)) reasons.push(`${host}:${port} accepts connections`)
  return reasons
}

function portAcceptsConnections(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port })
    const done = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Exit code + lines of one CLI run; the script is a thin wrapper around it. */
export interface CleanupCliResult {
  code: number
  out: string[]
  err: string[]
}

/**
 * The `scripts/cleanup-trivial-secret-handles.ts` CLI. Refuses (exit 3, no
 * change, not even a dry run) while a backend is running.
 */
export async function runCleanupCli(argv: readonly string[], probe: BackendProbeOptions = {}): Promise<CleanupCliResult> {
  const out: string[] = []
  const err: string[] = []
  const apply = argv.includes('--apply')
  const slugArgIndex = argv.indexOf('--slugs')
  const slugArg = slugArgIndex >= 0 ? argv[slugArgIndex + 1] : argv.find(a => a.startsWith('--slugs='))?.slice('--slugs='.length)
  if (!slugArg) {
    err.push('usage: cleanup-trivial-secret-handles.ts --slugs a,b,c [--apply]')
    return { code: 2, out, err }
  }
  const running = await findRunningBackend(probe)
  if (running.length > 0) {
    err.push('refused: the Offtangent backend is running — stop it first (nothing was changed):')
    for (const reason of running) err.push(`  ${reason}`)
    return { code: 3, out, err }
  }
  const result = cleanupSecretHandlesBySlug({ slugs: parseSlugList(slugArg), apply })
  for (const h of result.handles) {
    const meta = h.kind ? `\tkind=${h.kind}\tsource=${h.source}\tlen=${h.length}` : ''
    out.push(`  ${h.slug}\t${h.status}${meta}`)
  }
  if (result.refused) {
    err.push(`refused: only existing handles with source ${[...CLEANUP_ALLOWED_SOURCES].join('/')} that were never stored explicitly can be removed — nothing was changed`)
    return { code: 1, out, err }
  }
  if (!apply) {
    out.push(`dry run — ${result.handles.length} handle(s) eligible; pass --apply to back up secrets.json and remove them`)
    return { code: 0, out, err }
  }
  out.push(`backup: ${result.backupPath}`)
  out.push(`removed: ${result.removed}`)
  return { code: 0, out, err }
}
