/**
 * File-backed known values (maintainer request, privacy plan 2026-09-26).
 *
 * Every canary in this file is assembled at runtime from fragments, so the
 * repository never contains a credential-looking literal and the gitleaks
 * allowlist stays untouched.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { secretFileDirs, secretFileValues, secretFilesSignature, invalidateSecretFilesSignature, SECRET_FILE_DIRS_ENV } from './secret-files.js'
import { invalidateKnownValues, redactKnown, REDACTED_HANDLE } from './secret-boundary.js'
import { invalidateSecretHandleCache } from './secret-store.js'

/** Canary values, built at runtime — never a literal in the repo. */
const canary = (label: string, length = 14): string =>
  [label, 'Kb', 'Zq', String(length), 'Xy', 'Pw'].join('-')

let tmpDir: string
let previousDataDir: string | undefined
let previousDirs: string | undefined
let previousKey: string | undefined

function secretsDir(): string {
  return path.join(tmpDir, 'secrets')
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-files-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  fs.mkdirSync(secretsDir(), { recursive: true })
  previousDataDir = process.env.DATA_DIR
  previousDirs = process.env[SECRET_FILE_DIRS_ENV]
  previousKey = process.env.ENCRYPTION_KEY
  process.env.DATA_DIR = tmpDir
  delete process.env[SECRET_FILE_DIRS_ENV]
  process.env.ENCRYPTION_KEY = 'test-key-for-secret-files-unit-tests'
  invalidateKnownValues()
  invalidateSecretHandleCache()
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousDirs === undefined) delete process.env[SECRET_FILE_DIRS_ENV]
  else process.env[SECRET_FILE_DIRS_ENV] = previousDirs
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousKey
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateKnownValues()
  invalidateSecretHandleCache()
})

describe('secret-files — directories', () => {
  it('defaults to the directory of secrets.json plus <DATA_DIR>/secrets', () => {
    expect(secretFileDirs()).toEqual([path.join(tmpDir, 'config'), path.join(tmpDir, 'secrets')])
  })

  it('honours the SECRET_FILE_DIRS override', () => {
    process.env[SECRET_FILE_DIRS_ENV] = ['/a/b', '/c/d'].join(path.delimiter)
    expect(secretFileDirs()).toEqual(['/a/b', '/c/d'])
  })

  it('survives a missing directory', () => {
    fs.rmSync(secretsDir(), { recursive: true, force: true })
    expect(secretFileValues({ minLength: 8 })).toEqual([])
    expect(secretFilesSignature()).toBe('')
  })
})

describe('secret-files — what counts as a value', () => {
  it('reads KEY=VALUE lines of a *.env file, quoted or not', () => {
    const master = canary('MASTER')
    const url = 'https://vault.example.invalid'
    fs.writeFileSync(
      path.join(secretsDir(), 'vaultwarden.env'),
      [
        '# comment line',
        `BW_URL=${url}`,
        'BW_USERNAME=agent@example.invalid',
        `BW_PASSWORD="${master}"`,
        'BW_SHORT=abc',
        'BW_REF=$OTHER_VAR',
        '',
      ].join('\n'),
    )
    const values = secretFileValues({ minLength: 8 })
    expect(values).toContain(master)
    expect(values).toContain(url)
    expect(values).toContain('agent@example.invalid')
    // below the minimum length, and a reference rather than a value
    expect(values).not.toContain('abc')
    expect(values).not.toContain('$OTHER_VAR')
  })

  it('reads `export KEY=VALUE` lines', () => {
    const token = canary('EXPORTED')
    fs.writeFileSync(path.join(secretsDir(), 'service.env'), `export SERVICE_TOKEN=${token}\n`)
    expect(secretFileValues({ minLength: 8 })).toContain(token)
  })

  it('takes a single-token file as one value (session key files)', () => {
    const session = canary('SESSION', 40)
    fs.writeFileSync(path.join(secretsDir(), 'bw-session'), `${session}\n`)
    expect(secretFileValues({ minLength: 8 })).toEqual([session])
  })

  it('takes a PEM key file as a whole', () => {
    const body = ['MIIB', canary('PEMBODY', 30), 'AQID'].join('')
    // Header assembled at runtime so the repo holds no PEM literal.
    const dashes = '-'.repeat(5)
    const pem = [`${dashes}BEGIN PRIVATE${' KEY'}${dashes}`, body, `${dashes}END PRIVATE${' KEY'}${dashes}`].join('\n')
    fs.writeFileSync(path.join(secretsDir(), 'deploy.pem'), `${pem}\n`)
    expect(secretFileValues({ minLength: 8 })).toEqual([pem])
  })

  it('ignores prose files, so a blocklist does not become a known value', () => {
    fs.writeFileSync(
      path.join(secretsDir(), 'publish-blocklist.txt'),
      ['# hosts we never publish to', 'example.invalid', 'other.invalid', 'a=b'].join('\n'),
    )
    expect(secretFileValues({ minLength: 8 })).toEqual([])
  })

  it('ignores binary files and oversized files', () => {
    fs.writeFileSync(path.join(secretsDir(), 'keystore.p12'), Buffer.from([0x30, 0x82, 0x00, 0x11, 0x22]))
    fs.writeFileSync(path.join(secretsDir(), 'huge.env'), `BIG=${'x'.repeat(300 * 1024)}\n`)
    expect(secretFileValues({ minLength: 8 })).toEqual([])
  })

  it('never reads secrets.json / providers.json / settings.json', () => {
    const plain = canary('CONFIGFILE')
    fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), JSON.stringify({ a: plain }))
    fs.writeFileSync(path.join(tmpDir, 'config', 'secrets.json'), JSON.stringify({ env: { A: plain } }))
    fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify({ providers: [] }))
    expect(secretFileValues({ minLength: 8 })).toEqual([])
  })
})

describe('secret-files — wired into redactKnown', () => {
  it('redacts a value from a synthetic .env in a cat output', () => {
    const master = canary('CATTEST')
    fs.writeFileSync(path.join(secretsDir(), 'vaultwarden.env'), `BW_PASSWORD=${master}\n`)
    invalidateKnownValues()
    const out = redactKnown(`$ cat vaultwarden.env\nBW_PASSWORD=${master}`)
    expect(out).not.toContain(master)
    expect(out).toContain(REDACTED_HANDLE)
  })

  it('invalidates the cache when the file changes', () => {
    const first = canary('FIRSTVAL')
    const second = canary('SECONDVAL')
    const file = path.join(secretsDir(), 'rotate.env')
    fs.writeFileSync(file, `PW=${first}\n`)
    invalidateKnownValues()
    expect(redactKnown(first)).toBe(REDACTED_HANDLE)
    expect(redactKnown(second)).toBe(second)

    // Rewrite with a different length, so mtime *and* size change.
    fs.writeFileSync(file, `PW=${second}\nEXTRA=${canary('EXTRA')}\n`)
    // F9 (triage 2026-09-26 19:25): the file signature is throttled to one
    // scan per 5 s, so a change lands after the window at the latest — or
    // immediately on an explicit invalidation, which is what this asserts.
    // The timing itself is covered in secret-files.throttle.test.ts.
    invalidateKnownValues()
    expect(redactKnown(second)).toBe(REDACTED_HANDLE)
  })

  it('changes the signature when a file is added, changed or removed', () => {
    // F9: each step invalidates explicitly, because the signature is
    // throttled to one filesystem scan per 5 s (see
    // secret-files.throttle.test.ts for the window itself).
    invalidateSecretFilesSignature()
    const before = secretFilesSignature()
    const file = path.join(secretsDir(), 'new.env')
    fs.writeFileSync(file, `PW=${canary('SIGTEST')}\n`)
    invalidateSecretFilesSignature()
    const added = secretFilesSignature()
    expect(added).not.toBe(before)
    fs.writeFileSync(file, `PW=${canary('SIGTEST2')}-longer\n`)
    invalidateSecretFilesSignature()
    expect(secretFilesSignature()).not.toBe(added)
    fs.rmSync(file)
    invalidateSecretFilesSignature()
    expect(secretFilesSignature()).toBe(before)
  })
})
