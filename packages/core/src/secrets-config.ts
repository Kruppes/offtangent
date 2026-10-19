import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './config.js'
import { encrypt, decrypt, isEncrypted, maskApiKey } from './encryption.js'

/**
 * One sealed secret value (privacy plan 2026-09-26, D3).
 *
 * Stored in the `handles` section of secrets.json, addressed by its slug.
 * `value` is encrypted at rest like every other secret; `hash` is the SHA-256
 * of the plaintext and exists only so the same value can be recognised
 * without decrypting anything.
 */
export interface SecretHandleRecord {
  /** Secret class, e.g. `github-token`, `password`, `pin`. */
  kind: string
  /** Where the value came from, e.g. `chat`, `tool:shell`, `form`. */
  source: string
  /** SHA-256 (hex) of the plaintext, used for deduplication. */
  hash: string
  /** The value, encrypted at rest. */
  value: string
  /** ISO timestamp of the first seal. */
  createdAt: string
  /** ISO timestamp of the most recent dedupe hit. */
  lastSeenAt?: string
  /** Length of the plaintext (metadata for the UI, never the value itself). */
  length?: number
}

/**
 * The secrets.json file structure
 *
 * `handles` is optional on purpose: files written before the privacy step
 * (env section only) must keep loading without a migration.
 */
export interface SecretsFile {
  env: Record<string, string> // Values are encrypted at rest
  handles?: Record<string, SecretHandleRecord> // Values are encrypted at rest
}

const SECRETS_FILENAME = 'secrets.json'

/**
 * Load secrets.json from config directory
 */
export function loadSecrets(): SecretsFile {
  const configDir = getConfigDir()
  const filePath = path.join(configDir, SECRETS_FILENAME)

  if (!fs.existsSync(filePath)) {
    return { env: {} }
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const parsed = JSON.parse(content) as Partial<SecretsFile>
  // Migration-free read: old files have no `handles`, broken files may have no
  // `env`. Normalising here keeps every caller free of null checks.
  return {
    env: parsed.env ?? {},
    ...(parsed.handles ? { handles: parsed.handles } : {}),
  }
}

/** Absolute path of secrets.json in the current config directory. */
export function secretsFilePath(): string {
  return path.join(getConfigDir(), SECRETS_FILENAME)
}

/**
 * Save secrets.json to config directory.
 *
 * Mode 0600 on create AND after every write (review 2026-10-19, finding 7):
 * `writeFileSync`'s `mode` only applies when the file is created, so a file
 * restored from a backup or created by hand keeps loose bits otherwise.
 */
export function saveSecrets(data: SecretsFile): void {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  const filePath = path.join(configDir, SECRETS_FILENAME)
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // e.g. a share that squashes ownership — the write itself succeeded
  }
}

// ---------------------------------------------------------------------------
// Advisory file lock (review 2026-10-19, finding 6)
//
// Every read-modify-write of secrets.json in this process and in the cleanup
// script runs under `<secrets.json>.lock`, created exclusively (`wx`). The
// lock is re-entrant inside one process (sealSecret → saveSecrets), waits up
// to `SECRETS_LOCK_TIMEOUT_MS` and breaks a lock file older than
// `SECRETS_LOCK_STALE_MS` (a crashed writer).
// ---------------------------------------------------------------------------

export const SECRETS_LOCK_TIMEOUT_MS = 5_000
export const SECRETS_LOCK_STALE_MS = 30_000

let lockDepth = 0
let lockPathHeld: string | null = null

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run `fn` while holding the secrets.json lock. Synchronous on purpose: all
 * writers of the file are synchronous.
 */
export function withSecretsFileLock<T>(fn: () => T): T {
  const lockPath = `${secretsFilePath()}.lock`
  if (lockDepth > 0 && lockPathHeld === lockPath) {
    lockDepth++
    try { return fn() } finally { lockDepth-- }
  }
  const dir = path.dirname(lockPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + SECRETS_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeSync(fd, `${process.pid}\n`)
      fs.closeSync(fd)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs
        if (age > SECRETS_LOCK_STALE_MS) { fs.rmSync(lockPath, { force: true }); continue }
      } catch {
        continue // vanished between open and stat — retry at once
      }
      if (Date.now() > deadline) throw new Error('secrets.json is locked by another writer')
      sleepSync(25)
    }
  }
  lockDepth = 1
  lockPathHeld = lockPath
  try {
    return fn()
  } finally {
    lockDepth = 0
    lockPathHeld = null
    fs.rmSync(lockPath, { force: true })
  }
}

/**
 * Get all secrets with values decrypted (for runtime use)
 */
export function loadSecretsDecrypted(): Record<string, string> {
  const file = loadSecrets()
  const decrypted: Record<string, string> = {}
  for (const [key, value] of Object.entries(file.env)) {
    if (value && isEncrypted(value)) {
      try {
        decrypted[key] = decrypt(value)
      } catch {
        // Skip secrets that can't be decrypted (e.g. ENCRYPTION_KEY changed)
        console.warn(`[axiom] Failed to decrypt secret "${key}", skipping`)
      }
    } else {
      decrypted[key] = value
    }
  }
  return decrypted
}

/**
 * Get secrets in masked form for API responses (never return real values)
 */
export function loadSecretsMasked(): Array<{ key: string; configured: boolean; maskedValue: string }> {
  const file = loadSecrets()
  const result: Array<{ key: string; configured: boolean; maskedValue: string }> = []
  for (const [key, encryptedValue] of Object.entries(file.env)) {
    if (!encryptedValue) {
      result.push({ key, configured: false, maskedValue: '' })
      continue
    }
    try {
      const decrypted = isEncrypted(encryptedValue) ? decrypt(encryptedValue) : encryptedValue
      result.push({
        key,
        configured: true,
        maskedValue: maskApiKey(decrypted),
      })
    } catch {
      result.push({ key, configured: true, maskedValue: '••••••••' })
    }
  }
  return result
}

/**
 * Set a secret (encrypts and saves)
 */
export function setSecret(key: string, value: string): void {
  withSecretsFileLock(() => {
    const file = loadSecrets()
    file.env[key] = value ? encrypt(value) : ''
    saveSecrets(file)
  })
}

/**
 * Set multiple secrets at once (encrypts and saves)
 */
export function setSecrets(secrets: Record<string, string>): void {
  withSecretsFileLock(() => {
    const file = loadSecrets()
    for (const [key, value] of Object.entries(secrets)) {
      file.env[key] = value ? encrypt(value) : ''
    }
    saveSecrets(file)
  })
}

/**
 * Delete a secret
 */
export function deleteSecret(key: string): void {
  withSecretsFileLock(() => {
    const file = loadSecrets()
    delete file.env[key]
    saveSecrets(file)
  })
}

/** Keys currently managed by injectSecretsIntoEnv — used to clean up removed secrets */
let _injectedKeys: Set<string> = new Set()

/**
 * Inject all decrypted secrets into process.env
 * Call this at startup and after secret changes.
 * Removes env vars for secrets that were previously injected but no longer exist.
 */
export function injectSecretsIntoEnv(): void {
  const decrypted = loadSecretsDecrypted()
  const currentKeys = new Set<string>()

  for (const [key, value] of Object.entries(decrypted)) {
    if (value) {
      process.env[key] = value
      currentKeys.add(key)
    }
  }

  // Clean up keys that were previously injected but are no longer in secrets
  for (const key of _injectedKeys) {
    if (!currentKeys.has(key)) {
      delete process.env[key]
    }
  }

  _injectedKeys = currentKeys

  if (currentKeys.size > 0) {
    console.log(`[axiom] Injected ${currentKeys.size} secret(s) into environment`)
  }
}
