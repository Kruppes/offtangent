/**
 * Fix 2026-10-19 (narrowed after review 2026-10-19): ordinary words and a model
 * id were rewritten into handles in every output. The fix corrects the SOURCES
 * instead of exempting values globally:
 *
 * - a value in `<DATA_DIR>/secrets/*.env` is skipped only when its KEY is in
 *   the explicit settings.json allowlist `secrets.nonSecretEnvKeys`, no
 *   detector fires on it and it is not a known secret otherwise (no key-name
 *   heuristic, re-review 2026-10-19);
 * - a NEW trivial url-password finding in a tool output gets no lasting
 *   handle but is still replaced by the anonymous handle (re-review N1).
 *
 * Guiding rule under test: no exception ever lifts the redaction of a real,
 * deliberately stored secret. All values here are synthetic; assertions use
 * `.includes(...) === false` so a failure never prints a value.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  invalidateKnownValues,
  REDACTED_HANDLE,
  redactKnown,
  resolveHandles,
  sealSystemText,
  sealText,
  sealToolText,
  secretHandle,
} from './secret-boundary.js'
import { invalidateSecretFilesSignature, SECRET_FILE_DIRS_ENV } from './secret-files.js'
import { invalidateSecretHandleCache, listSecrets, sealSecret } from './secret-store.js'
import { isTrivialSecretValue, skipTrivialAutomaticFinding, TRIVIAL_SECRET_WORDS } from './secret-triviality.js'

const MODEL_ID = ['claude', 'opus', '4', '6'].join('-')
// Synthetic credentials, assembled at runtime so no literal key sits in the file.
const ANTHROPIC_SHAPED = ['sk', 'ant', 'api03', 'Zq8Lm2Np9Rv4Tz8WQx7Lm2Np9Rv4Tz8W'].join('-')
const GITHUB_SHAPED = ['ghp', 'Q7x2Lm9Np4Rv8Tz3Wk6Yb1Hc5Jd0Fg2Se7Ua4'].join('_')
// Model-id-shaped opaque values (no detector rule fires on them).
const PROVIDER_KEY_MODEL_SHAPED = ['acct', '7f3k', '9q2m', 'x8v1'].join('-')
const HANDLE_MODEL_SHAPED = ['tenant', 'k4m9', 'p2q7', 'z5w3'].join('-')
let tmpDir: string
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-trivial-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'secrets'), { recursive: true })
  previous = {
    DATA_DIR: process.env.DATA_DIR,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    [SECRET_FILE_DIRS_ENV]: process.env[SECRET_FILE_DIRS_ENV],
  }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-triviality'
  delete process.env[SECRET_FILE_DIRS_ENV]
  invalidateSecretHandleCache()
  invalidateSecretFilesSignature()
  invalidateKnownValues()
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateSecretFilesSignature()
  invalidateKnownValues()
})

function writeProvidersJson(providers: unknown[]): void {
  fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify({ providers }))
  invalidateKnownValues()
}

function provider(fields: Record<string, unknown>): Record<string, unknown> {
  return { id: 'p', name: 'P', type: 'anthropic-messages', provider: 'anthropic', ...fields }
}

/** The four providers.json places a model id can sit in. */
function modelFieldVariants(value: string): Array<[string, Record<string, unknown>]> {
  return [
    ['enabledModels', { enabledModels: [value] }],
    ['pinnedModels', { pinnedModels: [value] }],
    ['knownModels', { knownModels: [value] }],
    ['models[].id', { models: [{ id: value, name: value }] }],
  ]
}

function hidden(out: string, value: string): boolean {
  return !out.includes(value) && !out.toLowerCase().includes(value.toLowerCase())
}

describe('finding 1: a model id in providers.json never exempts a secret', () => {
  it('a provider API key that is also listed as a model id stays redacted (all four fields, any case)', () => {
    for (const [field, extra] of modelFieldVariants(ANTHROPIC_SHAPED)) {
      writeProvidersJson([provider({ apiKey: ANTHROPIC_SHAPED, ...extra })])
      expect({ field, redactKnown: hidden(redactKnown(`x ${ANTHROPIC_SHAPED} y`), ANTHROPIC_SHAPED) }).toEqual({ field, redactKnown: true })
      expect({ field, system: hidden(sealSystemText(`x ${ANTHROPIC_SHAPED} y`, 'test'), ANTHROPIC_SHAPED) }).toEqual({ field, system: true })
      expect({ field, tool: hidden(sealToolText(`x ${ANTHROPIC_SHAPED} y`, 'shell'), ANTHROPIC_SHAPED) }).toEqual({ field, tool: true })
    }
    // an upper-cased copy in the model list does not help either
    writeProvidersJson([provider({ apiKey: ANTHROPIC_SHAPED, enabledModels: [ANTHROPIC_SHAPED.toUpperCase()] })])
    expect(hidden(redactKnown(`x ${ANTHROPIC_SHAPED} y`), ANTHROPIC_SHAPED)).toBe(true)
  })

  it('an opaque provider key shaped like a model id stays redacted when it is listed as a model id', () => {
    for (const [field, extra] of modelFieldVariants(PROVIDER_KEY_MODEL_SHAPED)) {
      writeProvidersJson([provider({ apiKey: PROVIDER_KEY_MODEL_SHAPED, ...extra })])
      expect({ field, ok: hidden(sealSystemText(`k=${PROVIDER_KEY_MODEL_SHAPED}`, 'test'), PROVIDER_KEY_MODEL_SHAPED) }).toEqual({ field, ok: true })
    }
  })

  it('a structurally detected key listed as a model id is still sealed (system prompt and tool output)', () => {
    for (const [field, extra] of modelFieldVariants(GITHUB_SHAPED)) {
      writeProvidersJson([provider(extra)])
      expect({ field, system: hidden(sealSystemText(`token ${GITHUB_SHAPED}`, 'test'), GITHUB_SHAPED) }).toEqual({ field, system: true })
      expect({ field, tool: hidden(sealToolText(`token ${GITHUB_SHAPED}`, 'shell'), GITHUB_SHAPED) }).toEqual({ field, tool: true })
    }
  })

  it('a stored handle whose value equals a model id stays redacted', () => {
    writeProvidersJson([provider({ enabledModels: [MODEL_ID] })])
    const slug = sealSecret(MODEL_ID, 'vaultwarden', 'vaultwarden')
    invalidateKnownValues()
    expect(redactKnown(`model=${MODEL_ID}`)).toBe(`model=${secretHandle(slug)}`)
  })
})

describe('finding 2: weak explicit passwords and detector findings are always redacted', () => {
  const WEAK = ['password', '<geheim>', '$PASSWORD', 'aaaaaaaaaaaa', 'postgres', 'admin123']

  it('explicitly stored weak passwords stay redacted (form, vault, chat sources)', () => {
    for (const [i, source] of ['form', 'vaultwarden', 'chat'].entries()) {
      const value = `${WEAK[i]}`
      sealSecret(value, 'password', source)
    }
    for (const value of WEAK.slice(3)) sealSecret(value, 'password', 'form')
    invalidateKnownValues()
    const text = WEAK.map(w => `[${w}]`).join(' ')
    const out = redactKnown(text)
    for (const w of WEAK) expect({ w, hidden: !out.includes(`[${w}]`) }).toEqual({ w, hidden: true })
  })

  it('a stored weak password inside a URL is still sealed in tool output', () => {
    sealSecret('password', 'password', 'form')
    invalidateKnownValues()
    const out = sealToolText('postgres://user:password@db:5432/x', 'shell')
    expect(out.includes(':password@')).toBe(false)
  })

  it('a placeholder url-password typed in chat or in a system prompt is still sealed (no blanket skip after detection)', () => {
    const chat = sealText('postgres://user:password@db/x', { tier: 'strong', source: 'chat' })
    expect(chat.sealed).toHaveLength(1)
    expect(chat.text.includes(':password@')).toBe(false)
    expect(sealSystemText('redis://u:changeme@cache', 'test').includes(':changeme@')).toBe(false)
  })

  it('only a NEW url-password finding from a tool output is skipped, and only for placeholder values', () => {
    expect(skipTrivialAutomaticFinding('password', 'url-password', 'tool:shell')).toBe(true)
    expect(skipTrivialAutomaticFinding('password', 'url-password', 'chat')).toBe(false)
    expect(skipTrivialAutomaticFinding('password', 'url-password', 'system:x')).toBe(false)
    expect(skipTrivialAutomaticFinding('password', 'password', 'tool:shell')).toBe(false)
    expect(skipTrivialAutomaticFinding('aaaaaaaa', 'token', 'tool:shell')).toBe(false)
    expect(skipTrivialAutomaticFinding('Tr0ub4dor&3', 'url-password', 'tool:shell')).toBe(false)
  })

  it('does not create handles for documentation placeholders in tool output', () => {
    const text = 'see postgres://user:password@db:5432/x and redis://:secret@cache:6379'
    const result = sealText(text, { tier: 'strong', source: 'tool:shell' })
    // no lasting handle, but no plaintext either (re-review N1)
    expect(result.text).not.toBe(text)
    expect(result.text.startsWith('see postgres://user:' + REDACTED_HANDLE + '@db:5432/x')).toBe(true)
    expect(result.sealed).toEqual([])
    expect(listSecrets()).toHaveLength(0)
  })

  it('a NEW trivial url-password from a tool output is redacted on the spot without a handle (re-review N1)', () => {
    // Weak but real passwords that the placeholder rules classify as trivial.
    const weak = [
      ['pass', 'word'].join(''),
      ['post', 'gres'].join(''),
      ['admin', 'istrator'].join(''),
      'a'.repeat(12),
      ['chan', 'geme'].join(''),
    ]
    for (const pw of weak) expect({ pw: pw.length, trivial: isTrivialSecretValue(pw) }).toEqual({ pw: pw.length, trivial: true })
    for (const [i, pw] of weak.entries()) {
      const result = sealText(`dsn=postgres://app:${pw}@db.internal:5432/app`, { tier: 'strong', source: 'tool:shell' })
      expect({ i, hidden: !result.text.includes(`:${pw}@`) }).toEqual({ i, hidden: true })
      expect(result.text).toBe(`dsn=postgres://app:${REDACTED_HANDLE}@db.internal:5432/app`)
      expect(result.sealed).toEqual([])
    }
    // the global re-redaction is what is skipped: no handle was stored
    expect(listSecrets()).toHaveLength(0)
  })

  it('still seals a real URL password in tool output', () => {
    const real = ['Hx4', 'q9Lm', '2Wv'].join('')
    const result = sealText(`postgres://user:${real}@db/x`, { tier: 'strong', source: 'tool:shell' })
    expect(result.text.includes(real)).toBe(false)
    expect(result.sealed).toHaveLength(1)
  })

  it('handles of ordinary words resolve and are redacted again (no global word exemption)', () => {
    const slugs = ['secret', 'password', 'complete'].map(word => sealSecret(word, 'url-password', 'tool:shell'))
    invalidateKnownValues()
    const resolved = resolveHandles(slugs.map(secretHandle).join(' '))
    expect(resolved.unknown).toEqual([])
    expect(resolved.text).toBe('secret password complete')
    // still redacted: removing them is a targeted per-slug cleanup, not a value rule
    expect(redactKnown('the password is complete')).toBe(`the ${secretHandle(slugs[1]!)} is ${secretHandle(slugs[2]!)}`)
  })
})

describe('finding 3: no Bitwarden status-line exemption', () => {
  it('a vault handle whose value is an error line with an embedded short password stays redacted', () => {
    const pw = ['Kx9', 'mQ2v'].join('#')
    const line = `error: Invalid master password ${pw} for vault`
    expect(isTrivialSecretValue(line)).toBe(false)
    const slug = sealSecret(line, 'vaultwarden', 'vaultwarden')
    invalidateKnownValues()
    const out = redactKnown(`cli said: ${line}`)
    expect(out.includes(pw)).toBe(false)
    expect(out).toBe(`cli said: ${secretHandle(slug)}`)
  })

  it('short CLI status lines are not trivial any more', () => {
    for (const line of ['You are not logged in.', 'Vault is locked.', 'error: Invalid master password.']) {
      expect(isTrivialSecretValue(line)).toBe(false)
    }
  })
})

describe('secrets.nonSecretEnvKeys: explicit allowlist instead of a *_MODEL* name heuristic', () => {
  function writeEnv(lines: string[], file = 'svc.env'): void {
    fs.writeFileSync(path.join(tmpDir, 'secrets', file), lines.join('\n') + '\n')
    invalidateSecretFilesSignature()
    invalidateKnownValues()
  }
  function writeSettings(settings: unknown): void {
    fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings))
    invalidateKnownValues()
  }

  it('without an allowlist entry a *_MODEL* value in a secret file is redacted (no key-name heuristic)', () => {
    writeEnv([`ANTHROPIC_MODEL_POLISH=${MODEL_ID}`, `TENANT_MODEL=${HANDLE_MODEL_SHAPED}`])
    expect(redactKnown(`${MODEL_ID} ${HANDLE_MODEL_SHAPED}`)).toBe(`${REDACTED_HANDLE} ${REDACTED_HANDLE}`)
    writeSettings({ secrets: { nonSecretEnvKeys: [] } })
    expect(redactKnown(`${MODEL_ID} ${HANDLE_MODEL_SHAPED}`)).toBe(`${REDACTED_HANDLE} ${REDACTED_HANDLE}`)
  })

  it('an allowlisted key is not read as a known value; the API key next to it is', () => {
    writeSettings({ secrets: { nonSecretEnvKeys: ['ANTHROPIC_MODEL_POLISH', 'OPENAI_MODELS'] } })
    writeEnv([`ANTHROPIC_API_KEY=${ANTHROPIC_SHAPED}`, `ANTHROPIC_MODEL_POLISH=${MODEL_ID}`, 'OPENAI_MODELS=gpt-5.5-codex-mini', `TENANT_MODEL=${HANDLE_MODEL_SHAPED}`])
    const out = redactKnown(`echo ${MODEL_ID} gpt-5.5-codex-mini ${ANTHROPIC_SHAPED} ${HANDLE_MODEL_SHAPED}`)
    expect(out).toBe(`echo ${MODEL_ID} gpt-5.5-codex-mini ${REDACTED_HANDLE} ${REDACTED_HANDLE}`)
  })

  it('an allowlisted key stays redacted when a detector fires or the value is known from another source', () => {
    writeProvidersJson([provider({ apiKey: PROVIDER_KEY_MODEL_SHAPED })])
    const slug = sealSecret(HANDLE_MODEL_SHAPED, 'password', 'form')
    const otherFile = ['svc', 'k8m2', 'q7z4'].join('-')
    writeSettings({ secrets: { nonSecretEnvKeys: ['OPENAI_MODEL', 'MODEL', 'TENANT_MODEL', 'FOO_MODEL'] } })
    writeEnv([`OPENAI_MODEL=${GITHUB_SHAPED}`, `MODEL=${PROVIDER_KEY_MODEL_SHAPED}`, `TENANT_MODEL=${HANDLE_MODEL_SHAPED}`, `FOO_MODEL=${otherFile}`])
    writeEnv([`SERVICE_TOKEN=${otherFile}`], 'other.env')
    const out = redactKnown(`${GITHUB_SHAPED} ${PROVIDER_KEY_MODEL_SHAPED} ${HANDLE_MODEL_SHAPED} ${otherFile}`)
    expect(out).toBe(`${REDACTED_HANDLE} ${REDACTED_HANDLE} ${secretHandle(slug)} ${REDACTED_HANDLE}`)
  })

  it('the allowlist matches exact key names only; malformed entries or a corrupt settings.json exempt nothing', () => {
    writeEnv([`ANTHROPIC_MODEL_POLISH=${MODEL_ID}`])
    for (const settings of [
      { secrets: { nonSecretEnvKeys: ['anthropic_model_polish', 'ANTHROPIC_MODEL', '*', 'ANTHROPIC_MODEL_POLISH '] } },
      { secrets: { nonSecretEnvKeys: 'ANTHROPIC_MODEL_POLISH' } },
      { nonSecretEnvKeys: ['ANTHROPIC_MODEL_POLISH'] },
      '{ not json',
    ]) {
      writeSettings(settings)
      expect(redactKnown(MODEL_ID)).toBe(REDACTED_HANDLE)
    }
    writeSettings({ secrets: { nonSecretEnvKeys: ['ANTHROPIC_MODEL_POLISH'] } })
    expect(redactKnown(MODEL_ID)).toBe(MODEL_ID)
  })
})

describe('isTrivialSecretValue (placeholder shapes, used only for new tool findings and the form warning)', () => {
  it('flags placeholder words and shapes', () => {
    for (const v of ['password', 'Secret', ' changeme ', '$PASS', '${DB_PASSWORD}', '<password>', '[hidden]', '{{pw}}', 'xxxxxxxx', '********']) {
      expect(isTrivialSecretValue(v)).toBe(true)
    }
  })

  it('does not flag credentials or model ids', () => {
    for (const v of [ANTHROPIC_SHAPED, GITHUB_SHAPED, MODEL_ID, 'Tr0ub4dor&3', 'correct horse battery staple']) {
      expect(isTrivialSecretValue(v)).toBe(false)
    }
  })

  it('has a lower-case word list', () => {
    for (const word of TRIVIAL_SECRET_WORDS) expect(word).toBe(word.toLowerCase())
  })
})
