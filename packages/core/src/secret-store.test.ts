import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  sealSecret,
  resolveSecret,
  listSecrets,
  renameSecret,
  removeSecret,
  knownSecretValues,
  secretValueHash,
  invalidateSecretHandleCache,
} from './secret-store.js'
import { loadSecrets, loadSecretsDecrypted, setSecret, injectSecretsIntoEnv } from './secrets-config.js'
import { CORPUS_TOKENS } from './secret-corpus.fixture.js'

let tmpDir: string
let previousDataDir: string | undefined
let previousKey: string | undefined

function secretsPath(): string {
  return path.join(tmpDir, 'config', 'secrets.json')
}

function rawFile(): string {
  return fs.readFileSync(secretsPath(), 'utf-8')
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-store-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previousDataDir = process.env.DATA_DIR
  previousKey = process.env.ENCRYPTION_KEY
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-secret-store-unit-tests'
  invalidateSecretHandleCache()
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousKey
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
})

describe('secret-store — V2 encryption at rest', () => {
  it('never writes a plaintext value to disk', () => {
    const slug = sealSecret(CORPUS_TOKENS.GHP, 'github-token', 'chat')
    expect(slug).toBe('github-token-1')
    const raw = rawFile()
    expect(raw).not.toContain(CORPUS_TOKENS.GHP)
    expect(raw).toContain('github-token-1')
    expect(resolveSecret(slug)).toBe(CORPUS_TOKENS.GHP)
  })

  it('stores the SHA-256 of the value, not the value', () => {
    const slug = sealSecret(CORPUS_TOKENS.ANT_KEY, 'anthropic-key', 'chat')
    const file = loadSecrets()
    const record = file.handles?.[slug]
    expect(record?.hash).toBe(secretValueHash(CORPUS_TOKENS.ANT_KEY))
    expect(record?.value).not.toContain(CORPUS_TOKENS.ANT_KEY)
  })

  it('numbers slugs per kind', () => {
    expect(sealSecret('value-one-1234', 'password', 'chat')).toBe('password-1')
    expect(sealSecret('value-two-1234', 'password', 'chat')).toBe('password-2')
    expect(sealSecret('value-three-12', 'pin', 'chat')).toBe('pin-1')
  })
})

describe('secret-store — dedupe', () => {
  it('returns the existing slug for a known value', () => {
    const first = sealSecret(CORPUS_TOKENS.GLPAT, 'gitlab-token', 'chat')
    const second = sealSecret(CORPUS_TOKENS.GLPAT, 'gitlab-token', 'tool:shell')
    expect(second).toBe(first)
    expect(listSecrets()).toHaveLength(1)
    expect(listSecrets()[0].lastSeenAt).toBeTruthy()
  })

  it('keeps the original source on a dedupe hit', () => {
    sealSecret(CORPUS_TOKENS.AKIA, 'aws-access-key', 'chat')
    sealSecret(CORPUS_TOKENS.AKIA, 'aws-access-key', 'tool:shell')
    expect(listSecrets()[0].source).toBe('chat')
  })
})

describe('secret-store — metadata, rename, remove', () => {
  it('list() returns metadata only, never values', () => {
    sealSecret(CORPUS_TOKENS.SLACK_B, 'slack-token', 'form')
    const [info] = listSecrets()
    expect(info).toMatchObject({ slug: 'slack-token-1', kind: 'slack-token', source: 'form' })
    expect(info.length).toBe(CORPUS_TOKENS.SLACK_B.length)
    expect(JSON.stringify(listSecrets())).not.toContain(CORPUS_TOKENS.SLACK_B)
  })

  it('renames a handle and keeps the value', () => {
    const slug = sealSecret(CORPUS_TOKENS.OAI_KEY, 'openai-key', 'chat')
    renameSecret(slug, 'work-openai')
    expect(resolveSecret(slug)).toBeNull()
    expect(resolveSecret('work-openai')).toBe(CORPUS_TOKENS.OAI_KEY)
  })

  it('rejects an invalid or conflicting slug and an unknown source slug', () => {
    sealSecret(CORPUS_TOKENS.GHO, 'github-token', 'chat')
    sealSecret(CORPUS_TOKENS.GHS, 'github-token', 'chat')
    expect(() => renameSecret('github-token-1', 'Invalid Slug')).toThrow(/invalid slug/)
    expect(() => renameSecret('github-token-1', 'github-token-2')).toThrow(/already exists/)
    expect(() => renameSecret('nope-1', 'other')).toThrow(/unknown slug/)
  })

  it('removes a handle', () => {
    const slug = sealSecret(CORPUS_TOKENS.GHU, 'github-token', 'chat')
    expect(removeSecret(slug)).toBe(true)
    expect(removeSecret(slug)).toBe(false)
    expect(resolveSecret(slug)).toBeNull()
    expect(rawFile()).not.toContain(CORPUS_TOKENS.GHU)
  })

  it('resolve() of an unknown slug returns null', () => {
    expect(resolveSecret('does-not-exist-1')).toBeNull()
  })
})

describe('secret-store — knownValues cache', () => {
  it('invalidates after seal, rename and remove', () => {
    expect(knownSecretValues().size).toBe(0)
    const slug = sealSecret(CORPUS_TOKENS.JWT_HS, 'jwt', 'chat')
    expect(knownSecretValues().get(CORPUS_TOKENS.JWT_HS)).toBe(slug)

    renameSecret(slug, 'session-jwt')
    expect(knownSecretValues().get(CORPUS_TOKENS.JWT_HS)).toBe('session-jwt')

    removeSecret('session-jwt')
    expect(knownSecretValues().size).toBe(0)
  })

  it('picks up an external write to secrets.json', async () => {
    sealSecret(CORPUS_TOKENS.GHP, 'github-token', 'chat')
    expect(knownSecretValues().size).toBe(1)

    // Another process (settings UI, second container) edits the file.
    await new Promise(resolve => setTimeout(resolve, 10))
    const file = loadSecrets()
    delete file.handles!['github-token-1']
    fs.writeFileSync(secretsPath(), JSON.stringify(file, null, 2) + '\n')
    expect(knownSecretValues().size).toBe(0)
  })
})

describe('secret-store — backwards compatibility with the env section', () => {
  it('loads an old secrets.json without a handles section', () => {
    fs.writeFileSync(
      secretsPath(),
      JSON.stringify({ env: { LEGACY_KEY: 'plain-legacy-value' } }, null, 2) + '\n',
    )
    expect(loadSecrets().handles).toBeUndefined()
    expect(listSecrets()).toEqual([])
    expect(loadSecretsDecrypted()).toEqual({ LEGACY_KEY: 'plain-legacy-value' })

    const slug = sealSecret(CORPUS_TOKENS.GHP, 'github-token', 'chat')
    expect(loadSecretsDecrypted()).toEqual({ LEGACY_KEY: 'plain-legacy-value' })
    expect(resolveSecret(slug)).toBe(CORPUS_TOKENS.GHP)
  })

  it('keeps env injection working next to handles', () => {
    setSecret('DEMO_ENV_SECRET', 'env-value-12345')
    sealSecret(CORPUS_TOKENS.GHP, 'github-token', 'chat')
    injectSecretsIntoEnv()
    try {
      expect(process.env.DEMO_ENV_SECRET).toBe('env-value-12345')
      expect(rawFile()).not.toContain('env-value-12345')
      expect(listSecrets()).toHaveLength(1)
    } finally {
      delete process.env.DEMO_ENV_SECRET
    }
  })

  it('does not lose handles when an env secret is written afterwards', () => {
    const slug = sealSecret(CORPUS_TOKENS.ASIA, 'aws-access-key', 'chat')
    setSecret('ANOTHER_ENV', 'another-value-1')
    expect(resolveSecret(slug)).toBe(CORPUS_TOKENS.ASIA)
    expect(Object.keys(loadSecrets().env)).toEqual(['ANOTHER_ENV'])
  })
})
