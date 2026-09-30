/**
 * Known secret values that live in *files* (privacy plan 2026-09-26, D4
 * extension, maintainer request).
 *
 * Decision D4 harvests known values from `secrets.json › env`, the provider
 * config and credential-looking `process.env` names. That misses every value
 * that only exists in a file on disk — the master password of a password
 * manager in `<DATA_DIR>/secrets/<service>.env` being the motivating example:
 * it is neither in `secrets.json` nor in `process.env`, so `cat` of that file
 * used to hand the plaintext straight to the model.
 *
 * This module is the file-backed source of known values. It is deliberately
 * narrow, because everything it returns is redacted **everywhere** afterwards:
 *
 * - Only files directly inside the configured secret directories are read
 *   (no recursion — see "Limits" below).
 * - A file contributes values only when it is an env file (`KEY=VALUE`), a PEM
 *   key block, or a single opaque token on one line.
 * - Values shorter than the caller's minimum length are ignored.
 * - Binary files are skipped.
 *
 * Every value is handed to the caller as plaintext and is used **opaquely**
 * (the boundary maps it to `{{secret:redacted}}`); nothing is written to the
 * secret store, so a file value never creates a handle and never leaves the
 * process.
 *
 * Limits (documented on purpose, see docs/guide/secrets.md):
 * - No recursion into subdirectories: `<DATA_DIR>/secrets/firebase/*.json`
 *   style credential bundles are not covered.
 * - JSON files are not parsed. `settings.json` sits in the same config
 *   directory, and treating every JSON string leaf as a secret would redact
 *   model names, paths and prose.
 * - Binary blobs (keystores, `.p12`) are skipped: a byte sequence cannot be
 *   matched inside a text stream in a meaningful way.
 */

import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './config.js'

/** Env var to override the directories that are scanned (path-delimiter list). */
export const SECRET_FILE_DIRS_ENV = 'SECRET_FILE_DIRS'

/** Largest file that is read. Bigger files are skipped, not truncated. */
const MAX_FILE_BYTES = 256 * 1024

/** Longest single value taken from a file (a 4096-bit PEM key is ~3.2 KB). */
const MAX_VALUE_LENGTH = 8192

/** Files that other sources already cover, or that must never be scanned. */
const SKIPPED_FILENAMES = new Set(['secrets.json', 'providers.json', 'settings.json'])

/** `KEY=VALUE`, optionally `export KEY=VALUE`, quotes optional. */
const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

/**
 * The directories scanned for secret files.
 *
 * Default: the directory that holds `secrets.json` (`<DATA_DIR>/config`, see
 * {@link getConfigDir}) plus `<DATA_DIR>/secrets`, which is where the
 * hand-maintained `*.env` files of this deployment live. Override with
 * `SECRET_FILE_DIRS` (e.g. `/data/secrets:/srv/creds`).
 */
export function secretFileDirs(): string[] {
  const override = process.env[SECRET_FILE_DIRS_ENV]
  if (override && override.trim()) {
    return dedupe(override.split(path.delimiter).map(entry => entry.trim()).filter(Boolean))
  }
  const dataDir = process.env.DATA_DIR ?? '/data'
  return dedupe([getConfigDir(), path.join(dataDir, 'secrets')])
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

function listCandidateFiles(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (SKIPPED_FILENAMES.has(entry.name)) continue
    files.push(path.join(dir, entry.name))
  }
  return files.sort()
}

/**
 * How long a computed signature is reused (F9 of the review triage 2026-09-26
 * 19:25).
 *
 * The fingerprint costs one `readdir` per secret directory plus one `stat` per
 * file. That ran on every `redactKnown()` — every message, every tool result,
 * every system prompt — which is thousands of syscalls per turn for data that
 * changes maybe once a week. Within this window the previous answer is
 * reused, so a change on disk becomes effective after at most five seconds;
 * {@link invalidateSecretFilesSignature} (called by `invalidateKnownValues()`)
 * makes it immediate.
 */
export const SECRET_FILES_SIGNATURE_TTL_MS = 5_000

let signatureCache: { value: string; at: number } | null = null

/**
 * Monotonic milliseconds. `Date.now()` would be wrong here: a clock jump
 * backwards (NTP, a container resume) could freeze the cache.
 */
function monotonicNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

/** Drop the throttled signature, so the next call stats again. */
export function invalidateSecretFilesSignature(): void {
  signatureCache = null
}

/**
 * Fingerprint of every scanned file (`mtime:size`), used to invalidate the
 * cached known-value regex. Directory listing plus one `stat` per file,
 * throttled to at most one scan per {@link SECRET_FILES_SIGNATURE_TTL_MS}.
 */
export function secretFilesSignature(): string {
  const now = monotonicNow()
  if (signatureCache && now - signatureCache.at < SECRET_FILES_SIGNATURE_TTL_MS) {
    return signatureCache.value
  }
  const signature = computeSecretFilesSignature()
  signatureCache = { value: signature, at: now }
  return signature
}

function computeSecretFilesSignature(): string {
  const parts: string[] = []
  for (const dir of secretFileDirs()) {
    for (const file of listCandidateFiles(dir)) {
      try {
        const stat = fs.statSync(file)
        if (stat.size > MAX_FILE_BYTES) continue
        parts.push(`${file}@${stat.mtimeMs}:${stat.size}`)
      } catch {
        // vanished between readdir and stat — nothing to fingerprint
      }
    }
  }
  return parts.join('|')
}

/** Strip one layer of matching quotes and a trailing inline comment-free tail. */
function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return value.slice(1, -1)
    }
  }
  return value
}

function isEnvFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === 'env' || lower === '.env' || lower === '.envrc') return true
  // matches `service.env`, `.env.local`, `service.env.LOCKED-…`
  return /(^|\.)env(\.|$)/.test(lower)
}

function isPemBlock(content: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(content)
}

function envValues(content: string, minLength: number): string[] {
  const values: string[] = []
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = ENV_LINE_RE.exec(line)
    if (!match) continue
    const value = unquote(match[2] ?? '')
    if (value.length < minLength || value.length > MAX_VALUE_LENGTH) continue
    // `$VAR` references are not values of their own.
    if (/^\$[A-Za-z_{]/.test(value)) continue
    values.push(value)
  }
  return values
}

/**
 * True when every content line is a `KEY=VALUE` assignment (or blank, or a
 * comment). Used so a Markdown file that happens to contain one `a=b` line
 * does not turn its text into a "known secret".
 */
function looksLikeEnvContent(content: string): boolean {
  let assignments = 0
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (!ENV_LINE_RE.test(line)) return false
    assignments++
  }
  return assignments > 0
}

export interface SecretFileValuesOptions {
  /** Minimum length of a value, supplied by the caller (single source of truth). */
  minLength: number
  /** Directories to scan; defaults to {@link secretFileDirs}. */
  dirs?: string[]
}

/**
 * Collect the secret values stored in files.
 *
 * Returns plaintext values without any metadata: the caller treats them as
 * opaque known values (`{{secret:redacted}}`).
 */
export function secretFileValues(options: SecretFileValuesOptions): string[] {
  const { minLength } = options
  const dirs = options.dirs ?? secretFileDirs()
  const values: string[] = []

  for (const dir of dirs) {
    for (const file of listCandidateFiles(dir)) {
      let buffer: Buffer
      try {
        const stat = fs.statSync(file)
        if (stat.size === 0 || stat.size > MAX_FILE_BYTES) continue
        buffer = fs.readFileSync(file)
      } catch {
        continue
      }
      // Binary guard: a NUL byte in the first KB means this is not text.
      if (buffer.subarray(0, 1024).includes(0)) continue
      const content = buffer.toString('utf-8')
      const name = path.basename(file)

      if (isPemBlock(content)) {
        // Whole file as one value: a key file is printed as a unit
        // (`cat id_ed25519`). A *partial* print is caught by the structural
        // PEM rule in secret-detect.ts instead.
        const trimmed = content.trim()
        if (trimmed.length >= minLength && trimmed.length <= MAX_VALUE_LENGTH) values.push(trimmed)
        continue
      }

      if (isEnvFileName(name) || looksLikeEnvContent(content)) {
        values.push(...envValues(content, minLength))
        continue
      }

      // A single opaque token on one line (session keys, API tokens dropped
      // into a file without a KEY= prefix).
      const trimmed = content.trim()
      if (
        trimmed.length >= minLength
        && trimmed.length <= MAX_VALUE_LENGTH
        && !/\s/.test(trimmed)
      ) {
        values.push(trimmed)
      }
    }
  }

  return dedupe(values)
}
