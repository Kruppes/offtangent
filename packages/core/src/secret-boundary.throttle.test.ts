/**
 * F9 (review B finding C6, triage 2026-09-26 19:25) — second half.
 *
 * `sourceSignature()` runs on EVERY `redactKnown()` call, so it is on the hot
 * path of every message, every tool result and — since the task-channel fix
 * seals the system prompt — every `buildSystemPrompt()`. Two of its three parts
 * were already cheap or throttled (`secretFilesSignature()` got its own
 * five-second window); the expensive leftover was the scan over **all** of
 * `process.env`, measured at ~41 µs per call against ~3.5 µs for the two
 * `statSync` calls together (`node scripts/bench-secret-boundary.mjs`).
 *
 * The env scan is therefore cached for {@link KNOWN_ENV_SCAN_TTL_MS} of
 * monotonic time. The two `stat`s stay live on purpose: a value sealed by one
 * channel has to be redacted in every other channel *immediately*, and that
 * change shows up as a new mtime on `secrets.json`. Process env vars, by
 * contrast, are set before the process starts; a runtime addition becoming
 * effective after at most five seconds is the trade this test pins down.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { invalidateKnownValues, redactKnown, KNOWN_ENV_SCAN_TTL_MS, REDACTED_HANDLE } from './secret-boundary.js'
import { invalidateSecretHandleCache, sealSecret } from './secret-store.js'

let tmpDir: string
let previous: Record<string, string | undefined> = {}

/** Assembled at runtime so no scanner ever sees a credential-shaped literal. */
function syntheticValue(tag: string): string {
  return ['throttle', tag, 'Xq7Zr', '0192837465'].join('-')
}

beforeEach(() => {
  vi.useFakeTimers()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-boundary-throttle-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = {
    DATA_DIR: process.env.DATA_DIR,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    THROTTLE_TEST_API_TOKEN: process.env.THROTTLE_TEST_API_TOKEN,
  }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-f9'
  delete process.env.THROTTLE_TEST_API_TOKEN
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

afterEach(() => {
  vi.useRealTimers()
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

describe('F9: the env scan of the known-value index is throttled', () => {
  it('is five seconds', () => {
    expect(KNOWN_ENV_SCAN_TTL_MS).toBe(5_000)
  })

  it('does not scan process.env again within the window', () => {
    // Warm the index (and with it the env scan).
    redactKnown('nothing to see here')
    const entries = vi.spyOn(Object, 'entries')

    for (let i = 0; i < 50; i++) redactKnown('nothing to see here')

    // Not a single full env scan happened in the window. (Object.entries is
    // used for process.env in sourceSignature and in buildIndex; neither may
    // run again while the cached signature is valid.)
    const envScans = entries.mock.calls.filter(call => call[0] === process.env).length
    expect(envScans).toBe(0)
    entries.mockRestore()
  })

  it('picks a new credential-shaped env var up after the window', () => {
    const value = syntheticValue('env')
    redactKnown('warm up')

    process.env.THROTTLE_TEST_API_TOKEN = value
    // Inside the window the cached signature still holds, so the index is not
    // rebuilt and the new env value is not yet known.
    expect(redactKnown(`value=${value}`)).toBe(`value=${value}`)

    vi.advanceTimersByTime(KNOWN_ENV_SCAN_TTL_MS + 1)
    expect(redactKnown(`value=${value}`)).toBe(`value=${REDACTED_HANDLE}`)
  })

  it('is immediate after invalidateKnownValues()', () => {
    const value = syntheticValue('invalidate')
    redactKnown('warm up')

    process.env.THROTTLE_TEST_API_TOKEN = value
    expect(redactKnown(`value=${value}`)).toBe(`value=${value}`)

    invalidateKnownValues()
    expect(redactKnown(`value=${value}`)).toBe(`value=${REDACTED_HANDLE}`)
  })

  it('still redacts a value sealed a moment ago, without waiting for the window', () => {
    // The correctness half of the trade: sealing writes `secrets.json`, whose
    // `stat` is NOT throttled, so another channel redacts the value at once.
    const value = syntheticValue('sealed')
    redactKnown('warm up')

    const slug = sealSecret(value, 'password', 'test')
    expect(redactKnown(`value=${value}`)).toBe(`value={{secret:${slug}}}`)
  })
})
