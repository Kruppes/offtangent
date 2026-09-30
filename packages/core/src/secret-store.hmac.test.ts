/**
 * F7 (review A finding 6, triage 2026-09-26 19:25): the dedup hash was a plain
 * unsalted SHA-256 of the plaintext, stored next to the ciphertext in
 * `secrets.json`. Anyone who reads that file — a backup, a stale copy, an
 * admin JWT plus the API — can test a CANDIDATE value against it without the
 * encryption key: a guessing oracle for everything with low entropy (PINs,
 * reused passwords, an id from a leak).
 *
 * The hash is an HMAC-SHA256 under a key derived from the store's encryption
 * key now, with its own context string, so the comparison only works inside a
 * system that holds the key. The API no longer reports `deduplicated` either.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { invalidateSecretHandleCache, listSecrets, resolveSecret, sealSecret, secretValueHash } from './secret-store.js'

let tmpDir: string
let previous: Record<string, string | undefined> = {}

function secretsJson(): { handles?: Record<string, { hash?: string; value?: string }> } {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'config', 'secrets.json'), 'utf8'))
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-hmac-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-f7'
  invalidateSecretHandleCache()
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
})

describe('F7: the dedup hash is not a guessing oracle', () => {
  const value = ['candidate', '-', 'value', '-', '1234'].join('')

  it('does not store the plain SHA-256 of the value', () => {
    sealSecret(value, 'password', 'form')
    const stored = Object.values(secretsJson().handles ?? {})[0]
    const plainSha = crypto.createHash('sha256').update(value, 'utf8').digest('hex')
    expect(stored?.hash).toBeTruthy()
    expect(stored?.hash).not.toContain(plainSha)
  })

  it('depends on the encryption key, so another instance cannot reproduce it', () => {
    const here = secretValueHash(value)
    process.env.ENCRYPTION_KEY = 'a-completely-different-key'
    const elsewhere = secretValueHash(value)
    process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-f7'
    expect(elsewhere).not.toBe(here)
    expect(secretValueHash(value)).toBe(here)
  })

  it('still deduplicates the same value', () => {
    const first = sealSecret(value, 'password', 'form')
    const second = sealSecret(value, 'password', 'chat')
    expect(second).toBe(first)
    expect(listSecrets()).toHaveLength(1)
  })

  it('migrates a legacy sha256 entry instead of filing the value twice', () => {
    // A store written before this fix: hash = unsalted sha256.
    const slug = sealSecret(value, 'password', 'form')
    const file = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config', 'secrets.json'), 'utf8'))
    file.handles[slug].hash = crypto.createHash('sha256').update(value, 'utf8').digest('hex')
    fs.writeFileSync(path.join(tmpDir, 'config', 'secrets.json'), JSON.stringify(file, null, 2))
    invalidateSecretHandleCache()

    const again = sealSecret(value, 'password', 'chat')
    expect(again).toBe(slug)
    expect(listSecrets()).toHaveLength(1)
    expect(resolveSecret(slug)).toBe(value)
    // …and the legacy hash is gone afterwards.
    const stored = secretsJson().handles?.[slug]
    expect(stored?.hash).toBe(secretValueHash(value))
    expect(stored?.hash).not.toBe(crypto.createHash('sha256').update(value, 'utf8').digest('hex'))
  })
})
