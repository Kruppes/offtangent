/**
 * Review 2026-10-19, findings 6 and 7: junk handles are removed only by an
 * explicit slug list, only for automatic sources, with an exclusive 0600
 * backup; secrets.json stays 0600. Synthetic values only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cleanupSecretHandlesBySlug, parseSlugList, writeExclusiveBackup } from './secret-handle-cleanup.js'
import { invalidateSecretHandleCache, listSecrets, sealSecret } from './secret-store.js'
import { saveSecrets, loadSecrets, secretsFilePath, withSecretsFileLock } from './secrets-config.js'

let tmpDir: string
let previous: Record<string, string | undefined> = {}

const mode = (file: string): number => fs.statSync(file).mode & 0o777

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-cleanup-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-cleanup'
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

describe('cleanupSecretHandlesBySlug', () => {
  it('never removes form handles, even a dictionary word or a repeated PIN (finding 6)', () => {
    const formWord = sealSecret(['pass', 'word'].join(''), 'password', 'form')
    const formPin = sealSecret('11111111', 'pin', 'form')
    const chat = sealSecret('changeme', 'password', 'chat')
    const junk = sealSecret('complete', 'url-password', 'tool:shell')

    const dry = cleanupSecretHandlesBySlug({ slugs: [formWord, formPin, chat, junk], apply: false })
    expect(dry.refused).toBe(true)
    expect(dry.handles.map(h => h.status)).toEqual(['source-not-allowed', 'source-not-allowed', 'source-not-allowed', 'remove'])

    // all-or-nothing: a refused slug in the list blocks the whole run
    const applied = cleanupSecretHandlesBySlug({ slugs: [formWord, junk], apply: true, backupSuffix: 't1' })
    expect(applied.applied).toBe(false)
    expect(listSecrets().map(s => s.slug).sort()).toEqual([formWord, formPin, chat, junk].sort())
    expect(fs.existsSync(`${secretsFilePath()}.bak-t1`)).toBe(false)
  })

  it('nothing is selected by value: without a slug list nothing is removed', () => {
    sealSecret('complete', 'url-password', 'tool:shell')
    const r = cleanupSecretHandlesBySlug({ slugs: [], apply: true, backupSuffix: 't2' })
    expect(r.applied).toBe(false)
    expect(listSecrets()).toHaveLength(1)
  })

  it('refuses unknown slugs', () => {
    const junk = sealSecret('complete', 'url-password', 'tool:shell')
    const r = cleanupSecretHandlesBySlug({ slugs: [junk, 'does-not-exist-1'], apply: true, backupSuffix: 't3' })
    expect(r.refused).toBe(true)
    expect(r.handles[1]!.status).toBe('unknown-slug')
    expect(listSecrets()).toHaveLength(1)
  })

  it('removes named tool:shell / vaultwarden handles, keeps the rest, writes an exclusive 0600 backup (finding 7)', () => {
    const keep = sealSecret(['Hx4', 'q9Lm', '2Wv'].join(''), 'password', 'form')
    const junkA = sealSecret('complete', 'url-password', 'tool:shell')
    const junkB = sealSecret('Vault is locked.', 'vaultwarden', 'vaultwarden')
    fs.chmodSync(secretsFilePath(), 0o644) // a loose file from an old version

    const before = fs.readFileSync(secretsFilePath())
    const r = cleanupSecretHandlesBySlug({ slugs: [junkA, junkB], apply: true, backupSuffix: 't4' })
    expect(r).toMatchObject({ applied: true, refused: false, removed: 2 })
    expect(listSecrets().map(s => s.slug)).toEqual([keep])

    const backup = `${secretsFilePath()}.bak-t4`
    expect(r.backupPath).toBe(backup)
    expect(fs.readFileSync(backup).equals(before)).toBe(true)
    expect(mode(backup)).toBe(0o600)
    expect(mode(secretsFilePath())).toBe(0o600)
    // the report never carries a value
    expect(JSON.stringify(r).includes('complete')).toBe(false)
    expect(JSON.stringify(r).includes('Vault is locked')).toBe(false)

    // the backup is exclusive: an existing file is never overwritten
    const again = sealSecret('session', 'url-password', 'tool:shell')
    expect(() => cleanupSecretHandlesBySlug({ slugs: [again], apply: true, backupSuffix: 't4' })).toThrow()
    expect(fs.readFileSync(backup).equals(before)).toBe(true)
    expect(listSecrets().some(s => s.slug === again)).toBe(true)
  })

  it('re-checks the origin under the lock: a handle whose source changed to form is refused', () => {
    const slug = sealSecret('complete', 'url-password', 'tool:shell')
    // simulate a concurrent change of origin between dry run and apply
    expect(cleanupSecretHandlesBySlug({ slugs: [slug], apply: false }).refused).toBe(false)
    const file = loadSecrets()
    file.handles![slug]!.source = 'form'
    saveSecrets(file)
    invalidateSecretHandleCache()
    const r = cleanupSecretHandlesBySlug({ slugs: [slug], apply: true, backupSuffix: 't5' })
    expect(r.applied).toBe(false)
    expect(listSecrets()).toHaveLength(1)
  })

  it('waits for the secrets.json lock and fails instead of writing concurrently', () => {
    const slug = sealSecret('complete', 'url-password', 'tool:shell')
    const lockPath = `${secretsFilePath()}.lock`
    fs.writeFileSync(lockPath, '99999\n')
    try {
      expect(() => cleanupSecretHandlesBySlug({ slugs: [slug], apply: true, backupSuffix: 't6' })).toThrow(/locked/)
      expect(listSecrets()).toHaveLength(1)
    } finally {
      fs.rmSync(lockPath, { force: true })
    }
    // re-entrant inside one process
    expect(withSecretsFileLock(() => withSecretsFileLock(() => 42))).toBe(42)
    expect(fs.existsSync(lockPath)).toBe(false)
  }, 15_000) // the lock waits SECRETS_LOCK_TIMEOUT_MS (5 s) before giving up
})

describe('helpers', () => {
  it('parseSlugList trims and dedupes', () => {
    expect(parseSlugList(' a,b , a,,c ')).toEqual(['a', 'b', 'c'])
  })

  it('writeExclusiveBackup creates 0600 and refuses to overwrite', () => {
    const file = path.join(tmpDir, 'b.bak')
    writeExclusiveBackup(file, Buffer.from('x'))
    expect(mode(file)).toBe(0o600)
    expect(() => writeExclusiveBackup(file, Buffer.from('y'))).toThrow()
    expect(fs.readFileSync(file, 'utf-8')).toBe('x')
  })

  it('saveSecrets leaves secrets.json at 0600 even when it existed with looser bits', () => {
    saveSecrets({ env: {} })
    fs.chmodSync(secretsFilePath(), 0o644)
    saveSecrets({ env: {} })
    expect(mode(secretsFilePath())).toBe(0o600)
  })
})
