/**
 * Fix 2026-10-19: model ids and ordinary words were rewritten into handles in
 * every tool output, message and system prompt. Causes found on the live
 * store: a `*_MODEL…` line in `<DATA_DIR>/secrets/*.env` (model id as opaque
 * known value), url-password detector hits on documentation placeholders
 * (`://user:password@`, `://user:secret@`) and `bw` output sealed whole as a
 * session value (`finished`). Real credentials must still be redacted.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  invalidateKnownValues,
  providerModelIds,
  REDACTED_HANDLE,
  redactKnown,
  resolveHandles,
  sealText,
  secretHandle,
} from './secret-boundary.js'
import { invalidateSecretFilesSignature, SECRET_FILE_DIRS_ENV, secretFileValues } from './secret-files.js'
import { invalidateSecretHandleCache, listSecrets, sealSecret } from './secret-store.js'
import { isTrivialSecretValue, TRIVIAL_SECRET_WORDS } from './secret-triviality.js'

const MODEL_ID = 'claude-opus-4-6'
const REAL_KEY = 'sk-ant-api03-' + 'EXAMPLE0EXAMPLE1EXAMPLE2EXAMPLE3'

let tmpDir: string
let previous: Record<string, string | undefined> = {}

function writeProviders(models: string[]): void {
  fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify({
    providers: [{
      id: 'p1', name: 'Anthropic', type: 'anthropic-messages', provider: 'anthropic',
      enabledModels: models, models: [{ id: 'model-from-models-array', name: 'x' }],
    }],
  }))
}

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

describe('isTrivialSecretValue', () => {
  it('flags common words and placeholders case-insensitively', () => {
    for (const word of ['secret', 'password', 'Password', 'FINISHED', 'session', 'changeme']) {
      expect(isTrivialSecretValue(word)).toBe(true)
    }
    for (const shape of ['${DB_PASSWORD}', '$TOKEN', '<password>', '[hidden]', '********', 'xxxxxxxx', '{{pw}}']) {
      expect(isTrivialSecretValue(shape)).toBe(true)
    }
  })

  it('flags configured model ids', () => {
    expect(isTrivialSecretValue(MODEL_ID, new Set([MODEL_ID]))).toBe(true)
    expect(isTrivialSecretValue(MODEL_ID)).toBe(false)
  })

  it('keeps real-looking credentials', () => {
    for (const value of [REAL_KEY, 'Tr0ub4dor&3', 'abcdef', 'hunter22', 'secret-Xy9!q', '4711']) {
      expect(isTrivialSecretValue(value)).toBe(false)
    }
  })

  it('has a lower-case word list', () => {
    for (const word of TRIVIAL_SECRET_WORDS) expect(word).toBe(word.toLowerCase())
  })
})

describe('global redaction skips trivial values', () => {
  it('does not redact ordinary words that sit in the store, but their handles still resolve', () => {
    const slugs = ['secret', 'password', 'finished'].map(word => sealSecret(word, 'url-password', 'tool:shell'))
    sealSecret(REAL_KEY, 'api-key', 'tool:shell')
    invalidateKnownValues()

    const text = `the secret password is finished; key ${REAL_KEY}; dir /data/secrets`
    const out = redactKnown(text)
    expect(out).toContain('the secret password is finished;')
    expect(out).toContain('/data/secrets')
    expect(out).not.toContain(REAL_KEY)

    const resolved = resolveHandles(slugs.map(secretHandle).join(' '))
    expect(resolved.unknown).toEqual([])
    expect(resolved.text).toBe('secret password finished')
  })

  it('does not redact a model id from providers.json that also sits in the store', () => {
    writeProviders([MODEL_ID, 'claude-opus-4-8'])
    sealSecret(MODEL_ID, 'vaultwarden', 'vaultwarden')
    invalidateKnownValues()
    expect(providerModelIds().has(MODEL_ID)).toBe(true)
    expect(providerModelIds().has('model-from-models-array')).toBe(true)
    expect(redactKnown(`model=${MODEL_ID}`)).toBe(`model=${MODEL_ID}`)
  })

  it('does not redact a model id from an env file, but redacts the API key next to it', () => {
    fs.writeFileSync(path.join(tmpDir, 'secrets', 'anthropic-samplebot.env'), [
      `ANTHROPIC_API_KEY=${REAL_KEY}`,
      `ANTHROPIC_MODEL_POLISH=${MODEL_ID}`,
      'OPENAI_MODELS=gpt-5.5-codex-mini',
    ].join('\n'))
    invalidateKnownValues()
    const values = secretFileValues({ minLength: 8 })
    expect(values).toContain(REAL_KEY)
    expect(values).not.toContain(MODEL_ID)
    expect(values).not.toContain('gpt-5.5-codex-mini')

    const out = redactKnown(`echo ${MODEL_ID} ${REAL_KEY}`)
    expect(out).toBe(`echo ${MODEL_ID} ${REDACTED_HANDLE}`)
  })

  it('still treats a MODEL key that carries a credential word as secret', () => {
    fs.writeFileSync(path.join(tmpDir, 'secrets', 'svc.env'), 'MODEL_API_KEY=Zq8vT2mL9xR4pW7n\n')
    invalidateKnownValues()
    expect(secretFileValues({ minLength: 8 })).toContain('Zq8vT2mL9xR4pW7n')
  })
})

describe('the url-password detector skips placeholders', () => {
  it('does not seal ://user:password@ or ://user:secret@', () => {
    const text = 'see postgres://user:password@db:5432/x and redis://:secret@cache:6379'
    const result = sealText(text, { tier: 'strong', source: 'tool:shell' })
    expect(result.text).toBe(text)
    expect(result.sealed).toEqual([])
    expect(listSecrets()).toHaveLength(0)
  })

  it('still seals a real URL password', () => {
    const result = sealText('postgres://user:Zq8vT2mL9x@db/x', { tier: 'strong', source: 'tool:shell' })
    expect(result.text).not.toContain('Zq8vT2mL9x')
    expect(result.sealed).toHaveLength(1)
  })
})

describe('Bitwarden CLI status lines', () => {
  it('are trivial, a session key is not', () => {
    for (const line of ['Your vault is locked.', 'You are not logged in.', 'Not found.', 'Session key is invalid.', '? Master password: [hidden]', 'Invalid master password.']) {
      expect(isTrivialSecretValue(line)).toBe(true)
    }
    expect(isTrivialSecretValue('lK3mP9qR2sT7vW1xY5zA8bC4dE6fG0hJ+nO/uI==')).toBe(false)
    expect(isTrivialSecretValue('correct horse battery staple')).toBe(false)
  })
})
