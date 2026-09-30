/**
 * Idempotency of the secret boundary (report Integration, open point 2).
 *
 * Bug: `sealText()` over a text that already carries handles produced nested
 * handles (`{{secret:{{secret:token-1}}}}`), because a context rule read the
 * slug inside `{{secret:…}}` as its value: `trimValue()` strips the leading
 * `{{` and the trailing `}}`, so the "already a handle" guard in
 * `secret-detect.ts` (`isPlaceholderValue`) never saw a handle.
 *
 * Real user path: the user refers to a displayed handle in a new message
 * ("nimm das Passwort {{secret:router}}"), and after T6 the normal chain runs
 * over tool output that already contains Vaultwarden handles.
 *
 * Contract under test: `sealText(sealText(x)) === sealText(x)` and the second
 * pass creates no new store entry.
 *
 * Every value here is synthetic and assembled at runtime.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  sealText,
  redactKnown,
  secretHandle,
  invalidateKnownValues,
  REDACTED_HANDLE,
} from './secret-boundary.js'
import { sealSecret, invalidateSecretHandleCache, listSecrets } from './secret-store.js'
import { CORPUS_POSITIVES } from './secret-corpus.fixture.js'

let tmpDir: string
let previousDataDir: string | undefined
let previousKey: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-idempotent-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previousDataDir = process.env.DATA_DIR
  previousKey = process.env.ENCRYPTION_KEY
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-secret-idempotency-tests'
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousKey
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

/** Seal twice and assert text stability plus "no new store entry". */
function expectStable(text: string, tier: 'user' | 'strong'): string {
  const first = sealText(text, { tier, source: 'chat' })
  const storeAfterFirst = listSecrets().map(entry => entry.slug).sort()
  const second = sealText(first.text, { tier, source: 'chat' })
  const storeAfterSecond = listSecrets().map(entry => entry.slug).sort()
  expect(second.text).toBe(first.text)
  expect(second.text).not.toMatch(/\{\{secret:[^}]*\{\{/)
  expect(storeAfterSecond).toEqual(storeAfterFirst)
  expect(second.sealed).toEqual([])
  return first.text
}

describe('sealText is idempotent over text that already contains handles', () => {
  it('leaves a handle after "password" untouched (user tier)', () => {
    const slug = sealSecret('Nordwind-42-Synthetic', 'password', 'form')
    const text = `nimm bitte das password ${secretHandle(slug)} für den Router`
    const result = sealText(text, { tier: 'user', source: 'chat' })
    expect(result.text).toBe(text)
    expect(result.sealed).toEqual([])
    expect(listSecrets()).toHaveLength(1)
  })

  it.each([
    ['password', 'the wifi password {{H}} please'],
    ['passwort', 'nimm das Passwort {{H}} vom Router'],
    ['Kennwort', 'Kennwort: {{H}}'],
    ['token', 'token = {{H}}'],
    ['pin', 'die PIN {{H}} steht auf der Karte'],
    ['token ist', 'der Token ist {{H}} und bleibt'],
  ])('does not re-seal a handle after %s', (_label, template) => {
    const slug = sealSecret('Synthetic-Value-4711!', 'password', 'form')
    const text = template.replace('{{H}}', secretHandle(slug))
    const result = sealText(text, { tier: 'user', source: 'chat' })
    expect(result.text).toBe(text)
    expect(result.text).not.toContain('{{secret:{{')
    expect(listSecrets()).toHaveLength(1)
  })

  it('keeps several handles in one line intact', () => {
    const a = sealSecret('Alpha-Synthetic-91!', 'password', 'form')
    const b = sealSecret('Beta-Synthetic-77!', 'token', 'form')
    const text = `password ${secretHandle(a)} und token: ${secretHandle(b)} zusammen in einer Zeile`
    expectStable(text, 'user')
    expect(sealText(text, { tier: 'user', source: 'chat' }).text).toBe(text)
    expect(listSecrets()).toHaveLength(2)
  })

  it('keeps the anonymous REDACTED_HANDLE intact', () => {
    const text = `password: ${REDACTED_HANDLE} (der Wert ist nicht im Store)`
    const result = sealText(text, { tier: 'user', source: 'chat' })
    expect(result.text).toBe(text)
    expect(result.sealed).toEqual([])
    expect(listSecrets()).toHaveLength(0)
  })

  it('keeps a handle inside JSON tool output intact (strong tier)', () => {
    const slug = sealSecret('Vault-Synthetic-2026!', 'vaultwarden', 'vaultwarden')
    const json = JSON.stringify(
      { name: 'router', login: { username: 'admin', password: secretHandle(slug) }, notes: REDACTED_HANDLE },
      null,
      2,
    )
    const strong = sealText(json, { tier: 'strong', source: 'tool:shell' })
    expect(strong.text).toBe(json)
    expect(strong.sealed).toEqual([])
    // The same JSON on the user path (a person pastes it back into the chat).
    const user = sealText(json, { tier: 'user', source: 'chat' })
    expect(user.text).toBe(json)
    expect(user.sealed).toEqual([])
    expect(listSecrets()).toHaveLength(1)
  })

  it('still seals a real secret that sits next to a handle', () => {
    const slug = sealSecret('Old-Synthetic-Value-1!', 'password', 'form')
    const fresh = ['Sommer', '2026', '!'].join('')
    const text = `alt: ${secretHandle(slug)}, neu ist das Passwort ${fresh}`
    const result = sealText(text, { tier: 'user', source: 'chat' })
    expect(result.text).toBe(`alt: ${secretHandle(slug)}, neu ist das Passwort {{secret:password-2}}`)
    expect(result.sealed).toEqual([{ slug: 'password-2', kind: 'password' }])
    expect(result.text).not.toContain(fresh)
    // …and sealing that result again changes nothing.
    expectStable(result.text, 'user')
  })

  it.each(['user', 'strong'] as const)('is stable over the whole corpus in the %s tier', tier => {
    for (const sample of CORPUS_POSITIVES) {
      if (tier === 'strong' && sample.tier === 'user') continue
      const first = sealText(sample.text, { tier, source: 'chat' })
      const slugsAfterFirst = listSecrets().map(entry => entry.slug).sort()
      const second = sealText(first.text, { tier, source: 'chat' })
      const slugsAfterSecond = listSecrets().map(entry => entry.slug).sort()
      expect(second.text, `second pass changed ${sample.id}`).toBe(first.text)
      expect(second.sealed, `second pass sealed again in ${sample.id}`).toEqual([])
      expect(slugsAfterSecond, `second pass added a store entry for ${sample.id}`).toEqual(slugsAfterFirst)
      expect(first.text, `nested handle in ${sample.id}`).not.toMatch(/\{\{secret:[^}]*\{\{/)
      for (const expected of sample.expect) {
        expect(first.text, `plaintext survived in ${sample.id}`).not.toContain(expected.value)
      }
    }
  })
})

describe('redactKnown never reaches into a handle', () => {
  it('leaves a handle alone when a known value is a substring of its slug', () => {
    // A (short, synthetic) known value that also occurs inside a slug text.
    const slug = sealSecret('Router-Synthetic-8!', 'password', 'form')
    expect(slug).toBe('password-1')
    // `password-1` is now filed as a *value* as well — the naming collision
    // that made the old redaction chew up handles.
    sealSecret('password-1', 'secret', 'form')
    const text = `siehe ${secretHandle(slug)} im Store`
    expect(redactKnown(text)).toBe(text)
  })

  it('still redacts a known value that stands next to a handle', () => {
    const value = ['Known', 'Synthetic', '2026!'].join('-')
    const known = sealSecret(value, 'password', 'form')
    const other = sealSecret('Other-Synthetic-5!', 'token', 'form')
    const text = `${value} steht neben ${secretHandle(other)}`
    expect(redactKnown(text)).toBe(`${secretHandle(known)} steht neben ${secretHandle(other)}`)
  })
})
