/**
 * Encrypted storage for sealed secret values (plan 2026-09-26, decision D3).
 *
 * Values live in the `handles` section of the existing `secrets.json`, next to
 * the long-standing `env` section — **not** in the database, because the DB is
 * copied around as a multi-gigabyte backup. Every value is encrypted at rest
 * with the same AES-256-GCM helper the rest of the config uses
 * (`ENCRYPTION_KEY`), deduplicated by an HMAC-SHA256 of the plaintext (F7) and
 * addressed by a human-readable slug `<kind>-<n>` (e.g. `github-token-1`).
 *
 * Backwards compatibility is a hard requirement: an old `secrets.json` that
 * only has `env` loads unchanged, `env` keeps being injected into
 * `process.env` by {@link injectSecretsIntoEnv}, and writing handles never
 * touches or reorders the `env` section.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './config.js'
import { encrypt, decrypt, isEncrypted } from './encryption.js'
import { loadSecrets, saveSecrets, type SecretHandleRecord, type SecretsFile } from './secrets-config.js'

/** Metadata about a sealed secret. Never contains the value. */
export interface SecretHandleInfo {
  /** Slug used inside `{{secret:<slug>}}` handles. */
  slug: string
  /** Secret class, e.g. `github-token`, `password`, `pin`. */
  kind: string
  /** Where the value came from, e.g. `chat`, `tool:shell`, `form`. */
  source: string
  /** ISO timestamp of the first seal. */
  createdAt: string
  /** ISO timestamp of the last time this value was sealed again (dedupe hit). */
  lastSeenAt?: string
  /** Length of the plaintext — useful for the UI, harmless without the value. */
  length: number
}

const SECRETS_FILENAME = 'secrets.json'

/** Slug charset: lowercase letters, digits, dashes. Keeps handles greppable. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Legacy dedup hash (unsalted SHA-256) — only still read, never written. */
function legacySha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Context string of the dedup key (F7 of the review triage 2026-09-26 19:25).
 *
 * The dedup hash sits in `secrets.json` next to the ciphertext. As a plain
 * SHA-256 it was a guessing oracle: anyone holding the file (a backup, a
 * copy, an admin session) could test a CANDIDATE value against it without the
 * encryption key — deadly for low-entropy values like a PIN or a reused
 * password. The hash is an HMAC under a key derived from the same secret the
 * store encrypts with, so the comparison only works inside a system that
 * holds that key. The context string keeps this key separate from the AES key
 * even though both come from `ENCRYPTION_KEY`.
 */
const DEDUP_HMAC_CONTEXT = 'axiom/secret-store/dedup/v1'

/** Prefix that marks a hash as the HMAC form; anything else is legacy. */
const DEDUP_HASH_PREFIX = 'h2:'

let dedupKeyCache: { source: string; key: Buffer } | null = null

function dedupKey(): Buffer {
  // `ENCRYPTION_KEY` may be unset (dev default) or change in a test, so the
  // cache is keyed by its current value.
  const source = process.env.ENCRYPTION_KEY ?? 'openagent-dev-key'
  if (dedupKeyCache && dedupKeyCache.source === source) return dedupKeyCache.key
  const key = crypto.createHash('sha256').update(`${DEDUP_HMAC_CONTEXT}\u0000${source}`, 'utf8').digest()
  dedupKeyCache = { source, key }
  return key
}

function dedupHash(value: string): string {
  return `${DEDUP_HASH_PREFIX}${crypto.createHmac('sha256', dedupKey()).update(value, 'utf8').digest('hex')}`
}

function secretsFilePath(): string {
  return path.join(getConfigDir(), SECRETS_FILENAME)
}

/** Normalize a kind into a slug-safe prefix. */
function normalizeKind(kind: string): string {
  const cleaned = kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'secret'
}

// ---------------------------------------------------------------------------
// Cache
//
// knownValues() is called for every redaction pass, so it must not re-read and
// re-decrypt the file each time. The cache is invalidated explicitly on every
// write through this module and additionally whenever the file's mtime/size
// changes, so an edit by another process (or the settings UI) is picked up.
// ---------------------------------------------------------------------------

interface CacheEntry {
  stamp: string
  values: Map<string, string>
}

let _cache: CacheEntry | null = null

function fileStamp(): string {
  try {
    const stat = fs.statSync(secretsFilePath())
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

/** Drop the cached handle values. Called after every write. */
export function invalidateSecretHandleCache(): void {
  _cache = null
}

function readHandles(): Record<string, SecretHandleRecord> {
  const file = loadSecrets()
  return file.handles ?? {}
}

function writeHandles(mutate: (handles: Record<string, SecretHandleRecord>) => void): void {
  const file: SecretsFile = loadSecrets()
  const handles = { ...(file.handles ?? {}) }
  mutate(handles)
  saveSecrets({ ...file, handles })
  invalidateSecretHandleCache()
}

function decryptRecord(slug: string, record: SecretHandleRecord): string | null {
  const stored = record.value
  if (!stored) return null
  if (!isEncrypted(stored)) return stored
  try {
    return decrypt(stored)
  } catch {
    console.warn(`[axiom] Failed to decrypt secret handle "${slug}", skipping`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store `value` and return the slug of its handle.
 *
 * Deduplicated by SHA-256: sealing the same value twice returns the existing
 * slug (and refreshes `lastSeenAt`) instead of creating a second entry.
 */
export function sealSecret(value: string, kind: string, source: string): string {
  if (!value) throw new Error('sealSecret: value must not be empty')
  const hash = dedupHash(value)
  const legacy = legacySha256(value)
  const file = loadSecrets()
  const handles = { ...(file.handles ?? {}) }

  for (const [slug, record] of Object.entries(handles)) {
    // A record written before F7 still carries the unsalted SHA-256. It is
    // matched once and rewritten in the HMAC form, so the store migrates
    // itself on first touch and no value is filed twice. (On the live
    // instance there is no store yet — this path exists so an early tester's
    // file does not end up with duplicates.)
    if (record.hash === hash || record.hash === legacy) {
      handles[slug] = { ...record, hash, lastSeenAt: new Date().toISOString() }
      saveSecrets({ ...file, handles })
      invalidateSecretHandleCache()
      return slug
    }
  }

  const prefix = normalizeKind(kind)
  let n = 1
  while (handles[`${prefix}-${n}`]) n++
  const slug = `${prefix}-${n}`
  handles[slug] = {
    kind: prefix,
    source,
    hash,
    value: encrypt(value),
    createdAt: new Date().toISOString(),
    length: value.length,
  }
  saveSecrets({ ...file, handles })
  invalidateSecretHandleCache()
  return slug
}

/** Return the plaintext for a slug, or `null` when unknown/undecryptable. */
export function resolveSecret(slug: string): string | null {
  const record = readHandles()[slug]
  if (!record) return null
  return decryptRecord(slug, record)
}

/** All handles as metadata. Never returns values. */
export function listSecrets(): SecretHandleInfo[] {
  const handles = readHandles()
  return Object.entries(handles)
    .map(([slug, record]) => ({
      slug,
      kind: record.kind,
      source: record.source,
      createdAt: record.createdAt,
      ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
      length: record.length ?? 0,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * Rename a handle. The value stays untouched; only the slug changes, so old
 * text still containing `{{secret:<old>}}` no longer resolves — callers that
 * care must rewrite it.
 */
export function renameSecret(oldSlug: string, newSlug: string): void {
  if (!SLUG_RE.test(newSlug)) {
    throw new Error(`renameSecret: invalid slug "${newSlug}" (allowed: a-z, 0-9, dash)`)
  }
  let missing = false
  let conflict = false
  writeHandles(handles => {
    if (!handles[oldSlug]) { missing = true; return }
    if (oldSlug === newSlug) return
    if (handles[newSlug]) { conflict = true; return }
    handles[newSlug] = handles[oldSlug]
    delete handles[oldSlug]
  })
  if (missing) throw new Error(`renameSecret: unknown slug "${oldSlug}"`)
  if (conflict) throw new Error(`renameSecret: slug "${newSlug}" already exists`)
}

/** Delete a handle. Returns `true` when something was removed. */
export function removeSecret(slug: string): boolean {
  let removed = false
  writeHandles(handles => {
    if (handles[slug]) {
      delete handles[slug]
      removed = true
    }
  })
  return removed
}

/**
 * Map of plaintext value → slug for every handle, cached.
 *
 * The cache is dropped on every write through this module and whenever the
 * file changes on disk (mtime/size), so callers can hit this on every
 * redaction pass without re-reading and re-decrypting the file.
 */
export function knownSecretValues(): ReadonlyMap<string, string> {
  const stamp = fileStamp()
  if (_cache && _cache.stamp === stamp) return _cache.values
  const values = new Map<string, string>()
  for (const [slug, record] of Object.entries(readHandles())) {
    const plain = decryptRecord(slug, record)
    if (plain) values.set(plain, slug)
  }
  _cache = { stamp, values }
  return values
}

/**
 * Dedup hash of a value (HMAC-SHA256 under the store key, F7), exported for
 * callers that want to check for a dupe. Not reproducible without the
 * instance's `ENCRYPTION_KEY`, which is the whole point.
 */
export function secretValueHash(value: string): string {
  return dedupHash(value)
}
