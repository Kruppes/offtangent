/**
 * F5 (review A finding A5 / review B, triage 19:25): the known-value index
 * redacted stored values from four characters up. A 4-digit PIN in the store
 * therefore rewrote every date, port and line number containing those digits,
 * in every tool output and every message. The floor is six characters now —
 * resolving a short value through its handle is unaffected.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SECRET_HANDLE_MIN_VALUE_LENGTH } from './contracts/secrets.js'
import { invalidateKnownValues, redactKnown, resolveHandles, secretHandle } from './secret-boundary.js'
import { invalidateSecretHandleCache, sealSecret } from './secret-store.js'

let tmpDir: string
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-minlen-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-min-length'
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

describe('F5: minimum length of a globally redacted value', () => {
  it('is six characters', () => {
    expect(SECRET_HANDLE_MIN_VALUE_LENGTH).toBe(6)
  })

  it('does not rewrite a four-digit value that happens to appear in output', () => {
    sealSecret('1234', 'password', 'form')
    invalidateKnownValues()
    const text = 'listening on port 1234, build 1234'
    expect(redactKnown(text)).toBe(text)
  })

  it('does not rewrite a five-character value either', () => {
    sealSecret('abcde', 'password', 'form')
    invalidateKnownValues()
    expect(redactKnown('the word abcde stays')).toBe('the word abcde stays')
  })

  it('still rewrites a six-character value', () => {
    const slug = sealSecret('abcdef', 'password', 'form')
    invalidateKnownValues()
    expect(redactKnown('the value abcdef goes')).toBe(`the value ${secretHandle(slug)} goes`)
  })

  it('resolves a short value through its handle regardless of the floor', () => {
    const slug = sealSecret('1234', 'password', 'form')
    invalidateKnownValues()
    const resolved = resolveHandles(`pin ${secretHandle(slug)}`)
    expect(resolved.text).toBe('pin 1234')
    expect(resolved.unknown).toEqual([])
  })
})
