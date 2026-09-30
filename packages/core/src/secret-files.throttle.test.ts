/**
 * F9 (review B finding C6, triage 2026-09-26 19:25): `secretFilesSignature()`
 * ran on EVERY `redactKnown()` call — one `readdir` per secret directory plus
 * one `stat` per file, on the hot path of every message, every tool result and
 * (since the F2 fix) every system prompt. The signature is now cached for at
 * most {@link SECRET_FILES_SIGNATURE_TTL_MS} of monotonic time; a change on
 * disk is picked up after that at the latest, and `invalidateKnownValues()` /
 * `invalidateSecretFilesSignature()` make it immediate.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SECRET_FILE_DIRS_ENV,
  SECRET_FILES_SIGNATURE_TTL_MS,
  invalidateSecretFilesSignature,
  secretFilesSignature,
} from './secret-files.js'

let dir: string
let previous: string | undefined

beforeEach(() => {
  vi.useFakeTimers()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-files-throttle-'))
  previous = process.env[SECRET_FILE_DIRS_ENV]
  process.env[SECRET_FILE_DIRS_ENV] = dir
  invalidateSecretFilesSignature()
})

afterEach(() => {
  vi.useRealTimers()
  if (previous === undefined) delete process.env[SECRET_FILE_DIRS_ENV]
  else process.env[SECRET_FILE_DIRS_ENV] = previous
  fs.rmSync(dir, { recursive: true, force: true })
  invalidateSecretFilesSignature()
})

describe('F9: the secret-file signature is throttled', () => {
  it('does not stat again within the window', () => {
    fs.writeFileSync(path.join(dir, 'a.env'), 'TOKEN=aaaaaaaaaaaa\n')
    const readdir = vi.spyOn(fs, 'readdirSync')
    const stat = vi.spyOn(fs, 'statSync')

    const first = secretFilesSignature()
    const callsAfterFirst = readdir.mock.calls.length + stat.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    for (let i = 0; i < 50; i++) expect(secretFilesSignature()).toBe(first)
    expect(readdir.mock.calls.length + stat.mock.calls.length).toBe(callsAfterFirst)

    readdir.mockRestore()
    stat.mockRestore()
  })

  it('picks a change up after the window at the latest', () => {
    fs.writeFileSync(path.join(dir, 'a.env'), 'TOKEN=aaaaaaaaaaaa\n')
    const before = secretFilesSignature()

    fs.writeFileSync(path.join(dir, 'b.env'), 'OTHER=bbbbbbbbbbbbbb\n')
    expect(secretFilesSignature()).toBe(before)

    vi.advanceTimersByTime(SECRET_FILES_SIGNATURE_TTL_MS - 1)
    expect(secretFilesSignature()).toBe(before)

    vi.advanceTimersByTime(2)
    const after = secretFilesSignature()
    expect(after).not.toBe(before)
    expect(after).toContain('b.env')
  })

  it('is immediate after an explicit invalidation', () => {
    fs.writeFileSync(path.join(dir, 'a.env'), 'TOKEN=aaaaaaaaaaaa\n')
    const before = secretFilesSignature()

    fs.writeFileSync(path.join(dir, 'c.env'), 'THIRD=cccccccccccccc\n')
    expect(secretFilesSignature()).toBe(before)

    invalidateSecretFilesSignature()
    expect(secretFilesSignature()).toContain('c.env')
  })

  it('is five seconds', () => {
    expect(SECRET_FILES_SIGNATURE_TTL_MS).toBe(5_000)
  })
})
