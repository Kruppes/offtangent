import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearConnectorConnection,
  connectorsFilePath,
  getConnectorRecord,
  markConnectorError,
  markConnectorReauthRequired,
  resolveConnectorStatus,
  saveConnectorTokens,
  setConnectorApiKey,
  setConnectorClient,
  toSafeConnectorState,
} from './store.js'
import { createTestConnectorManifest } from './test-connector.fixture.js'
import { isEncrypted } from '../encryption.js'

const CLIENT_SECRET = 'client-secret-0123456789'
const REFRESH_TOKEN = 'refresh-token-abcdefghij'
const ACCESS_TOKEN = 'access-token-klmnopqrst'

describe('connector credential store', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-connectors-'))
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    process.env.DATA_DIR = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  const manifest = createTestConnectorManifest()

  function fileContent(): string {
    return fs.readFileSync(connectorsFilePath(), 'utf-8')
  }

  it('encrypts client secret and tokens at rest', () => {
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: CLIENT_SECRET })
    saveConnectorTokens(manifest.id, {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ['sample.read'],
    })

    const raw = fileContent()
    expect(raw).not.toContain(CLIENT_SECRET)
    expect(raw).not.toContain(REFRESH_TOKEN)
    expect(raw).not.toContain(ACCESS_TOKEN)
    // The client id is not a secret and stays readable for support.
    expect(raw).toContain('client-id-1')

    const record = getConnectorRecord(manifest.id)
    expect(isEncrypted(record.clientSecret)).toBe(true)
    expect(isEncrypted(record.refreshToken)).toBe(true)
    expect(isEncrypted(record.accessToken)).toBe(true)
  })

  it('never exposes a secret in the client projection', () => {
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: CLIENT_SECRET })
    saveConnectorTokens(manifest.id, {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: '',
      scopes: ['sample.read'],
    })

    const safe = toSafeConnectorState(manifest, getConnectorRecord(manifest.id), 'https://instance.example/api/connectors/sample/callback')
    const serialized = JSON.stringify(safe)
    expect(serialized).not.toContain(CLIENT_SECRET)
    expect(serialized).not.toContain(REFRESH_TOKEN)
    expect(serialized).not.toContain(ACCESS_TOKEN)
    expect(safe.clientSecretSet).toBe(true)
    expect(safe.clientSecretMasked).toBe('clie••••••••6789')
    expect(safe.status).toBe('connected')
    expect(safe.dataClass).toBe('local_only')
    expect(safe.redirectUri).toBe('https://instance.example/api/connectors/sample/callback')
  })

  it('projects the setup steps of a manifest and strips every non-http(s) url', () => {
    const guided = createTestConnectorManifest({
      setup: {
        steps: [
          { id: 'project' as const, url: 'https://console.invalid/projectcreate' },
          { id: 'client' as const, url: 'http://console.invalid/clients', copy: 'redirectUri' as const },
          { id: 'scopes' as const, copy: 'scopes' as const },
          { id: 'script' as const, url: 'javascript:alert(1)' },
          { id: 'ftp' as const, url: 'ftp://console.invalid/file' },
        ],
      },
    })

    const safe = toSafeConnectorState(guided, getConnectorRecord(guided.id), 'https://instance.example/cb')

    expect(safe.setupSteps).toEqual([
      { id: 'project', url: 'https://console.invalid/projectcreate', copy: '' },
      { id: 'client', url: 'http://console.invalid/clients', copy: 'redirectUri' },
      { id: 'scopes', url: '', copy: 'scopes' },
      { id: 'script', url: '', copy: '' },
      { id: 'ftp', url: '', copy: '' },
    ])
  })

  it('has an empty setup step list when the manifest carries no guide', () => {
    const safe = toSafeConnectorState(manifest, getConnectorRecord(manifest.id), 'https://instance.example/cb')
    expect(safe.setupSteps).toEqual([])
  })

  it('reports the status of an OAuth connector along its lifecycle', () => {
    expect(resolveConnectorStatus(manifest, getConnectorRecord(manifest.id))).toBe('not_configured')

    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: CLIENT_SECRET })
    expect(resolveConnectorStatus(manifest, getConnectorRecord(manifest.id))).toBe('disconnected')

    saveConnectorTokens(manifest.id, { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresAt: '', scopes: [] })
    expect(resolveConnectorStatus(manifest, getConnectorRecord(manifest.id))).toBe('connected')

    markConnectorReauthRequired(manifest.id, 'invalid_grant')
    expect(resolveConnectorStatus(manifest, getConnectorRecord(manifest.id))).toBe('reauth_required')
    expect(getConnectorRecord(manifest.id).accessToken).toBe('')

    markConnectorError(manifest.id, 'upstream unreachable')
    expect(resolveConnectorStatus(manifest, getConnectorRecord(manifest.id))).toBe('error')

    clearConnectorConnection(manifest.id)
    expect(resolveConnectorStatus(manifest, getConnectorRecord(manifest.id))).toBe('disconnected')
    const record = getConnectorRecord(manifest.id)
    expect(record.refreshToken).toBe('')
    expect(record.clientId).toBe('client-id-1')
  })

  it('keeps the stored secret when a client update omits it', () => {
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: CLIENT_SECRET })
    const before = getConnectorRecord(manifest.id).clientSecret
    setConnectorClient(manifest.id, { clientId: 'client-id-2' })
    const after = getConnectorRecord(manifest.id)
    expect(after.clientId).toBe('client-id-2')
    expect(after.clientSecret).toBe(before)
  })

  it('keeps the stored refresh token when a refresh response omits it', () => {
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: CLIENT_SECRET })
    saveConnectorTokens(manifest.id, { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresAt: '', scopes: [] })
    saveConnectorTokens(manifest.id, { accessToken: 'access-token-second', refreshToken: '', expiresAt: '', scopes: [] })
    expect(getConnectorRecord(manifest.id).refreshToken).not.toBe('')
    expect(fileContent()).not.toContain(REFRESH_TOKEN)
  })

  it('treats an apiKey connector as configured once the key is stored', () => {
    const apiKeyManifest = createTestConnectorManifest({ id: 'sample-key', auth: 'apiKey', oauth: undefined })
    expect(resolveConnectorStatus(apiKeyManifest, getConnectorRecord(apiKeyManifest.id))).toBe('not_configured')
    setConnectorApiKey(apiKeyManifest.id, 'api-key-value-1234567890')
    expect(resolveConnectorStatus(apiKeyManifest, getConnectorRecord(apiKeyManifest.id))).toBe('connected')
    expect(fileContent()).not.toContain('api-key-value-1234567890')
  })
})
