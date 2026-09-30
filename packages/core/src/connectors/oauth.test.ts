import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  OAuthTokenError,
  buildAuthorizeUrl,
  createOAuthStateStore,
  OAUTH_STATE_MAX_PENDING,
  createPkcePair,
  exchangeAuthorizationCode,
  isTokenExpired,
  revokeToken,
} from './oauth.js'
import {
  ConnectorReauthRequiredError,
  getConnectorAccessToken,
  disconnectConnector,
  testConnector,
} from './access.js'
import { getConnectorRecord, saveConnectorTokens, setConnectorClient } from './store.js'
import { createTestConnectorManifest } from './test-connector.fixture.js'

interface FakeOAuthServer {
  origin: string
  close: () => Promise<void>
  requests: { path: string; body: Record<string, string> }[]
  /** Next token response: 'ok' | 'invalid_grant' | 'server_error'. */
  mode: 'ok' | 'invalid_grant' | 'server_error'
  revokeStatus: number
}

async function startFakeOAuthServer(): Promise<FakeOAuthServer> {
  const state: FakeOAuthServer = {
    origin: '',
    requests: [],
    mode: 'ok',
    revokeStatus: 200,
    close: async () => {},
  }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = Object.fromEntries(new URLSearchParams(raw))
      state.requests.push({ path: req.url ?? '', body })

      if (req.url === '/oauth/revoke') {
        res.writeHead(state.revokeStatus, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      if (state.mode === 'invalid_grant') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))
        return
      }
      if (state.mode === 'server_error') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'server_error' }))
        return
      }
      const grant = body.grant_type === 'refresh_token' ? 'refreshed' : 'initial'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        access_token: `access-${grant}-${state.requests.length}`,
        refresh_token: grant === 'initial' ? 'refresh-token-from-fake-server' : undefined,
        expires_in: 3600,
        scope: 'sample.read',
        token_type: 'Bearer',
      }))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake OAuth server did not bind a port')
  state.origin = `http://127.0.0.1:${address.port}`
  state.close = () => new Promise<void>(resolve => server.close(() => resolve()))
  return state
}

describe('OAuth state store', () => {
  it('hands out a single-use state', () => {
    const store = createOAuthStateStore()
    const created = store.create('sample', 'https://instance.example/api/connectors/sample/callback')
    expect(store.pendingCount()).toBe(1)

    const first = store.consume(created.state)
    expect(first?.connectorId).toBe('sample')
    expect(first?.codeVerifier).toBe(created.codeVerifier)
    expect(store.consume(created.state)).toBeNull()
    expect(store.pendingCount()).toBe(0)
  })

  it('rejects an unknown state', () => {
    const store = createOAuthStateStore()
    store.create('sample', 'https://instance.example/cb')
    expect(store.consume('not-a-state-we-issued')).toBeNull()
  })

  it('expires a state after its ttl', () => {
    let now = 1_000_000
    const store = createOAuthStateStore({ ttlMs: 600_000, now: () => now })
    const created = store.create('sample', 'https://instance.example/cb')
    now += 600_001
    expect(store.consume(created.state)).toBeNull()
  })

  it('keeps a state valid just before the ttl', () => {
    let now = 1_000_000
    const store = createOAuthStateStore({ ttlMs: 600_000, now: () => now })
    const created = store.create('sample', 'https://instance.example/cb')
    now += 599_000
    expect(store.consume(created.state)?.connectorId).toBe('sample')
  })

  it('caps the number of pending states and drops the oldest first (M6)', () => {
    // An unauthenticated /authorize loop must not grow this map without end.
    const store = createOAuthStateStore({ maxPending: 3 })
    const first = store.create('sample', 'https://instance.example/cb')
    const second = store.create('sample', 'https://instance.example/cb')
    const third = store.create('sample', 'https://instance.example/cb')
    expect(store.pendingCount()).toBe(3)

    const fourth = store.create('sample', 'https://instance.example/cb')
    expect(store.pendingCount()).toBe(3)
    // The oldest one is gone, the newer ones still work.
    expect(store.consume(first.state)).toBeNull()
    expect(store.consume(second.state)?.connectorId).toBe('sample')
    expect(store.consume(third.state)?.connectorId).toBe('sample')
    expect(store.consume(fourth.state)?.connectorId).toBe('sample')
  })

  it('defaults to a bounded store', () => {
    const store = createOAuthStateStore()
    for (let index = 0; index < OAUTH_STATE_MAX_PENDING + 5; index += 1) {
      store.create('sample', 'https://instance.example/cb')
    }
    expect(store.pendingCount()).toBe(OAUTH_STATE_MAX_PENDING)
  })

  it('issues a distinct state and verifier per authorization', () => {
    const store = createOAuthStateStore()
    const a = store.create('sample', 'https://instance.example/cb')
    const b = store.create('sample', 'https://instance.example/cb')
    expect(a.state).not.toBe(b.state)
    expect(a.codeVerifier).not.toBe(b.codeVerifier)
  })
})

describe('PKCE', () => {
  it('derives the challenge as base64url(sha256(verifier))', () => {
    const { codeVerifier, codeChallenge } = createPkcePair()
    const expected = crypto.createHash('sha256').update(codeVerifier).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(codeChallenge).toBe(expected)
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-_]{43}$/)
    expect(codeChallenge).not.toContain('=')
  })

  it('puts state, challenge and S256 into the authorize url', () => {
    const manifest = createTestConnectorManifest()
    const url = new URL(buildAuthorizeUrl({
      manifest,
      clientId: 'client-id-1',
      redirectUri: 'https://instance.example/api/connectors/sample/callback',
      state: 'state-value',
      codeChallenge: 'challenge-value',
    }))
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-id-1')
    expect(url.searchParams.get('redirect_uri')).toBe('https://instance.example/api/connectors/sample/callback')
    expect(url.searchParams.get('scope')).toBe('sample.read')
    expect(url.searchParams.get('state')).toBe('state-value')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('access_type')).toBe('offline')
  })
})

describe('token exchange against a fake OAuth server', () => {
  let server: FakeOAuthServer
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  beforeAll(async () => {
    server = await startFakeOAuthServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(() => {
    server.mode = 'ok'
    server.revokeStatus = 200
    server.requests.length = 0
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-connectors-oauth-'))
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    process.env.DATA_DIR = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function manifestFor(): ReturnType<typeof createTestConnectorManifest> {
    return createTestConnectorManifest({
      oauth: {
        authorizeUrl: `${server.origin}/oauth/authorize`,
        tokenUrl: `${server.origin}/oauth/token`,
        revokeUrl: `${server.origin}/oauth/revoke`,
      },
    })
  }

  it('exchanges the code, sends the verifier and stores the refresh token', async () => {
    const manifest = manifestFor()
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: 'client-secret-0123456789' })
    const store = createOAuthStateStore()
    const created = store.create(manifest.id, 'https://instance.example/api/connectors/sample/callback')
    const pending = store.consume(created.state)!

    const tokens = await exchangeAuthorizationCode({
      tokenUrl: manifest.oauth!.tokenUrl,
      clientId: 'client-id-1',
      clientSecret: 'client-secret-0123456789',
      code: 'code-from-consent',
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
    })
    saveConnectorTokens(manifest.id, tokens)

    expect(server.requests[0]?.body.grant_type).toBe('authorization_code')
    expect(server.requests[0]?.body.code_verifier).toBe(created.codeVerifier)
    expect(server.requests[0]?.body.redirect_uri).toBe('https://instance.example/api/connectors/sample/callback')
    expect(getConnectorRecord(manifest.id).status).toBe('connected')
    expect(await testConnector(manifest)).toEqual({ ok: true, detail: 'sample ok' })
  })

  it('refreshes an expired access token before using it', async () => {
    const manifest = manifestFor()
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: 'client-secret-0123456789' })
    saveConnectorTokens(manifest.id, {
      accessToken: 'access-token-expired',
      refreshToken: 'refresh-token-stored',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      scopes: ['sample.read'],
    })

    const token = await getConnectorAccessToken(manifest)
    expect(token).toContain('access-refreshed')
    expect(server.requests.at(-1)?.body.grant_type).toBe('refresh_token')
    expect(getConnectorRecord(manifest.id).status).toBe('connected')
  })

  it('keeps a still valid access token instead of refreshing', async () => {
    const manifest = manifestFor()
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: 'client-secret-0123456789' })
    saveConnectorTokens(manifest.id, {
      accessToken: 'access-token-fresh',
      refreshToken: 'refresh-token-stored',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ['sample.read'],
    })
    expect(await getConnectorAccessToken(manifest)).toBe('access-token-fresh')
    expect(server.requests).toHaveLength(0)
  })

  it('turns invalid_grant into reauth_required without retrying', async () => {
    const manifest = manifestFor()
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: 'client-secret-0123456789' })
    saveConnectorTokens(manifest.id, {
      accessToken: 'access-token-expired',
      refreshToken: 'refresh-token-revoked',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      scopes: ['sample.read'],
    })
    server.mode = 'invalid_grant'

    await expect(getConnectorAccessToken(manifest)).rejects.toBeInstanceOf(ConnectorReauthRequiredError)
    expect(server.requests).toHaveLength(1)
    const record = getConnectorRecord(manifest.id)
    expect(record.status).toBe('reauth_required')
    expect(record.accessToken).toBe('')
    expect(record.refreshToken).not.toBe('')

    // Second call fails from the persisted status — no further upstream request.
    await expect(getConnectorAccessToken(manifest)).rejects.toBeInstanceOf(ConnectorReauthRequiredError)
    expect(server.requests).toHaveLength(1)
    expect(await testConnector(manifest)).toEqual({ ok: false, detail: 'reauth_required' })
  })

  it('surfaces a transient token error without clearing the connection', async () => {
    const manifest = manifestFor()
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: 'client-secret-0123456789' })
    saveConnectorTokens(manifest.id, {
      accessToken: 'access-token-expired',
      refreshToken: 'refresh-token-stored',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      scopes: ['sample.read'],
    })
    server.mode = 'server_error'

    await expect(getConnectorAccessToken(manifest)).rejects.toBeInstanceOf(OAuthTokenError)
    expect(getConnectorRecord(manifest.id).status).toBe('connected')
  })

  it('revokes on disconnect and deletes locally even when the revoke fails', async () => {
    const manifest = manifestFor()
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: 'client-secret-0123456789' })
    saveConnectorTokens(manifest.id, {
      accessToken: 'access-token-fresh',
      refreshToken: 'refresh-token-stored',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ['sample.read'],
    })

    server.revokeStatus = 400
    const result = await disconnectConnector(manifest)
    expect(result.revoked).toBe(false)
    expect(server.requests.at(-1)?.path).toBe('/oauth/revoke')
    const record = getConnectorRecord(manifest.id)
    expect(record.refreshToken).toBe('')
    expect(record.accessToken).toBe('')
    expect(record.clientId).toBe('client-id-1')
  })

  it('reports a successful revoke', async () => {
    const manifest = manifestFor()
    setConnectorClient(manifest.id, { clientId: 'client-id-1', clientSecret: 'client-secret-0123456789' })
    saveConnectorTokens(manifest.id, {
      accessToken: 'access-token-fresh',
      refreshToken: 'refresh-token-stored',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ['sample.read'],
    })
    expect((await disconnectConnector(manifest)).revoked).toBe(true)
  })

  it('tolerates an unreachable revoke endpoint', async () => {
    expect(await revokeToken({
      revokeUrl: 'http://127.0.0.1:1/oauth/revoke',
      clientId: 'client-id-1',
      clientSecret: 'client-secret-0123456789',
      token: 'refresh-token-stored',
    })).toBe(false)
  })
})

describe('token expiry', () => {
  it('treats a missing or unparsable expiry as expired', () => {
    expect(isTokenExpired('')).toBe(true)
    expect(isTokenExpired('not-a-date')).toBe(true)
  })

  it('refreshes inside the leeway window', () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0)
    expect(isTokenExpired(new Date(now + 30_000).toISOString(), now)).toBe(true)
    expect(isTokenExpired(new Date(now + 300_000).toISOString(), now)).toBe(false)
  })
})
