import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  createOAuthStateStore,
  getConnectorRecord,
  saveConnectorTokens,
  setConnectorClient,
} from '@axiom/core'
import type { ConnectorManifest, OAuthStateStore } from '@axiom/core'
import { createConnectorsRouter } from './route.js'
import { generateAccessToken } from '../../../auth.js'

const CLIENT_SECRET = 'client-secret-0123456789'
const REFRESH_TOKEN = 'refresh-token-abcdefghij'

/**
 * Synthetic connector — never part of the production registry. The upstream is
 * a fake token endpoint served by this test.
 */
function sampleManifest(tokenUrl: string): ConnectorManifest {
  return {
    id: 'sample',
    name: 'Sample service',
    description: 'Synthetic connector for tests.',
    auth: 'oauth2',
    scopes: ['sample.read'],
    dataClass: 'local_only',
    oauth: {
      authorizeUrl: 'https://sample.invalid/oauth/authorize',
      tokenUrl,
      revokeUrl: 'https://sample.invalid/oauth/revoke',
    },
    setup: {
      steps: [
        { id: 'project', url: 'https://console.invalid/projectcreate' },
        { id: 'scopes', copy: 'scopes' },
        { id: 'client', url: 'https://console.invalid/clients', copy: 'redirectUri' },
        { id: 'unsafe', url: 'javascript:alert(1)' },
      ],
    },
    createTools: () => [],
    test: async ctx => ({ ok: (await ctx.getAccessToken()).length > 0, detail: 'sample ok' }),
  }
}

let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined
let previousPublicBaseUrl: string | undefined
let stateStore: OAuthStateStore
let tokenMode: 'ok' | 'invalid_grant' | 'no_refresh_token'
let tokenRequests: Record<string, string>[]
let fakeUpstream: http.Server
let fakeTokenUrl: string

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  previousPublicBaseUrl = process.env.PUBLIC_BASE_URL
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-connectors-route-'))
  process.env.DATA_DIR = tempDataDir
  process.env.PUBLIC_BASE_URL = 'https://instance.example'

  fakeUpstream = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      tokenRequests.push(Object.fromEntries(new URLSearchParams(raw)))
      if (tokenMode === 'invalid_grant') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Stack trace must not leak' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        access_token: 'access-token-from-fake-upstream',
        ...(tokenMode === 'no_refresh_token' ? {} : { refresh_token: 'refresh-token-from-fake-upstream' }),
        expires_in: 3600,
        scope: 'sample.read',
      }))
    })
  })
  await new Promise<void>(resolve => fakeUpstream.listen(0, '127.0.0.1', resolve))
  fakeTokenUrl = `http://127.0.0.1:${(fakeUpstream.address() as { port: number }).port}/oauth/token`

  stateStore = createOAuthStateStore()
  const manifests = [sampleManifest(fakeTokenUrl)]
  const app = express()
  app.use(express.json())
  app.use('/api/connectors', createConnectorsRouter({
    listManifests: () => manifests,
    getManifest: id => manifests.find(entry => entry.id === id) ?? null,
    stateStore,
  }))

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  adminToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await new Promise<void>(resolve => fakeUpstream.close(() => resolve()))
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL
  else process.env.PUBLIC_BASE_URL = previousPublicBaseUrl
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(path.join(tempDataDir, 'config', 'connectors.json'), { force: true })
  tokenMode = 'ok'
  tokenRequests = []
})

afterEach(() => {
  process.env.PUBLIC_BASE_URL = 'https://instance.example'
})

/** Built per call: `adminToken` only exists after `beforeAll`. */
function adminHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }
}

function configureClient(): void {
  setConnectorClient('sample', { clientId: 'client-id-1', clientSecret: CLIENT_SECRET })
}

async function startAuthorization(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/connectors/sample/authorize`, {
    headers: adminHeaders(),
    redirect: 'manual',
  })
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('location')!)
  return location.searchParams.get('state')!
}

describe('connectors API — admin gate', () => {
  it('rejects an unauthenticated list', async () => {
    const response = await fetch(`${baseUrl}/api/connectors`)
    expect(response.status).toBe(401)
  })

  it('rejects a non-admin user on every admin route', async () => {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${userToken}` }
    const calls = [
      fetch(`${baseUrl}/api/connectors`, { headers }),
      fetch(`${baseUrl}/api/connectors/sample/client`, { method: 'PUT', headers, body: JSON.stringify({ clientId: 'x' }) }),
      fetch(`${baseUrl}/api/connectors/sample/authorize`, { headers, redirect: 'manual' }),
      fetch(`${baseUrl}/api/connectors/sample/test`, { method: 'POST', headers }),
      fetch(`${baseUrl}/api/connectors/sample/connection`, { method: 'DELETE', headers }),
    ]
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403)
    }
  })

  it('serves the callback without a token', async () => {
    const response = await fetch(`${baseUrl}/api/connectors/sample/callback?state=nope&code=abc`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/connectors?error=invalid_state')
  })
})

describe('connectors API — list and client configuration', () => {
  it('lists the connector with its status and redirect uri', async () => {
    const response = await fetch(`${baseUrl}/api/connectors`, { headers: adminHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { connectors: Record<string, unknown>[]; baseUrl: string }
    expect(body.baseUrl).toBe('https://instance.example')
    expect(body.connectors).toHaveLength(1)
    expect(body.connectors[0]).toMatchObject({
      id: 'sample',
      status: 'not_configured',
      dataClass: 'local_only',
      redirectUri: 'https://instance.example/api/connectors/sample/callback',
      clientSecretSet: false,
    })
  })

  it('serves the setup steps of the manifest and never a non-http(s) url', async () => {
    const response = await fetch(`${baseUrl}/api/connectors`, { headers: adminHeaders() })
    const body = await response.json() as { connectors: { setupSteps: { id: string; url: string; copy: string }[] }[] }
    expect(body.connectors[0]?.setupSteps).toEqual([
      { id: 'project', url: 'https://console.invalid/projectcreate', copy: '' },
      { id: 'scopes', url: '', copy: 'scopes' },
      { id: 'client', url: 'https://console.invalid/clients', copy: 'redirectUri' },
      { id: 'unsafe', url: '', copy: '' },
    ])
  })

  it('stores the client and never returns the secret in clear text', async () => {
    const response = await fetch(`${baseUrl}/api/connectors/sample/client`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ clientId: 'client-id-1', clientSecret: CLIENT_SECRET }),
    })
    expect(response.status).toBe(200)
    const raw = await response.text()
    expect(raw).not.toContain(CLIENT_SECRET)
    const body = JSON.parse(raw) as { connector: { status: string; clientSecretSet: boolean; clientSecretMasked: string } }
    expect(body.connector.status).toBe('disconnected')
    expect(body.connector.clientSecretSet).toBe(true)
    expect(body.connector.clientSecretMasked).toBe('clie••••••••6789')

    const stored = fs.readFileSync(path.join(tempDataDir, 'config', 'connectors.json'), 'utf-8')
    expect(stored).not.toContain(CLIENT_SECRET)

    const list = await fetch(`${baseUrl}/api/connectors`, { headers: adminHeaders() })
    expect(await list.text()).not.toContain(CLIENT_SECRET)
  })

  it('rejects a client payload without a client id', async () => {
    const response = await fetch(`${baseUrl}/api/connectors/sample/client`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ clientSecret: CLIENT_SECRET }),
    })
    expect(response.status).toBe(400)
  })

  it('answers 404 for an unknown connector', async () => {
    const response = await fetch(`${baseUrl}/api/connectors/unknown/client`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ clientId: 'client-id-1' }),
    })
    expect(response.status).toBe(404)
  })
})

describe('connectors API — authorize', () => {
  it('refuses to start without a configured client', async () => {
    const response = await fetch(`${baseUrl}/api/connectors/sample/authorize`, { headers: adminHeaders(), redirect: 'manual' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'not_configured' })
  })

  it('redirects to the upstream consent screen with state and PKCE', async () => {
    configureClient()
    const response = await fetch(`${baseUrl}/api/connectors/sample/authorize`, { headers: adminHeaders(), redirect: 'manual' })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('https://sample.invalid/oauth/authorize')
    expect(location.searchParams.get('redirect_uri')).toBe('https://instance.example/api/connectors/sample/callback')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9\-_]{43}$/)
    expect(location.searchParams.get('state')).toBeTruthy()
    // The client secret never travels to the browser.
    expect(response.headers.get('location')).not.toContain(CLIENT_SECRET)
  })

  it('hands the url to an xhr that asks for json', async () => {
    configureClient()
    const response = await fetch(`${baseUrl}/api/connectors/sample/authorize`, {
      headers: { ...adminHeaders(), accept: 'application/json' },
      redirect: 'manual',
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { url: string }
    expect(new URL(body.url).searchParams.get('code_challenge_method')).toBe('S256')
  })
})

describe('connectors API — callback', () => {
  it('exchanges the code and stores the refresh token encrypted', async () => {
    configureClient()
    const state = await startAuthorization()

    const response = await fetch(`${baseUrl}/api/connectors/sample/callback?state=${state}&code=code-from-consent`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/connectors?connected=sample')
    expect(tokenRequests[0]?.grant_type).toBe('authorization_code')
    expect(tokenRequests[0]?.code_verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/)

    const record = getConnectorRecord('sample')
    expect(record.status).toBe('connected')
    const stored = fs.readFileSync(path.join(tempDataDir, 'config', 'connectors.json'), 'utf-8')
    expect(stored).not.toContain('refresh-token-from-fake-upstream')
  })

  it('rejects a replayed state', async () => {
    configureClient()
    const state = await startAuthorization()
    await fetch(`${baseUrl}/api/connectors/sample/callback?state=${state}&code=code-from-consent`, { redirect: 'manual' })

    const replay = await fetch(`${baseUrl}/api/connectors/sample/callback?state=${state}&code=code-from-consent`, { redirect: 'manual' })
    expect(replay.headers.get('location')).toBe('/connectors?error=invalid_state')
    expect(tokenRequests).toHaveLength(1)
  })

  it('rejects an unknown state without calling upstream', async () => {
    configureClient()
    const response = await fetch(`${baseUrl}/api/connectors/sample/callback?state=forged-state&code=code-from-consent`, { redirect: 'manual' })
    expect(response.headers.get('location')).toBe('/connectors?error=invalid_state')
    expect(tokenRequests).toHaveLength(0)
  })

  it('rejects an expired state', async () => {
    configureClient()
    let now = Date.UTC(2026, 8, 26, 22, 0, 0)
    const expiring = createOAuthStateStore({ ttlMs: 600_000, now: () => now })
    const manifests = [sampleManifest(fakeTokenUrl)]
    const app = express()
    app.use(express.json())
    app.use('/api/connectors', createConnectorsRouter({
      listManifests: () => manifests,
      getManifest: id => manifests.find(entry => entry.id === id) ?? null,
      stateStore: expiring,
    }))
    const local = http.createServer(app)
    await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve))
    const localBase = `http://127.0.0.1:${(local.address() as { port: number }).port}`

    const authorize = await fetch(`${localBase}/api/connectors/sample/authorize`, { headers: adminHeaders(), redirect: 'manual' })
    const state = new URL(authorize.headers.get('location')!).searchParams.get('state')!
    now += 600_001

    const response = await fetch(`${localBase}/api/connectors/sample/callback?state=${state}&code=code-from-consent`, { redirect: 'manual' })
    expect(response.headers.get('location')).toBe('/connectors?error=invalid_state')
    expect(tokenRequests).toHaveLength(0)
    await new Promise<void>(resolve => local.close(() => resolve()))
  })

  it('reports a denied consent without upstream detail', async () => {
    configureClient()
    const state = await startAuthorization()
    const response = await fetch(`${baseUrl}/api/connectors/sample/callback?state=${state}&error=access_denied`, { redirect: 'manual' })
    expect(response.headers.get('location')).toBe('/connectors?error=denied')
  })

  it('leaks no upstream detail or stack trace when the exchange fails', async () => {
    configureClient()
    tokenMode = 'invalid_grant'
    const state = await startAuthorization()
    const response = await fetch(`${baseUrl}/api/connectors/sample/callback?state=${state}&code=code-from-consent`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    const location = response.headers.get('location')!
    expect(location).toBe('/connectors?error=exchange_failed')
    const body = await response.text()
    expect(body).not.toContain('Stack trace must not leak')
    expect(body).not.toContain('OAuthTokenError')
    expect(body).not.toContain('at ')
  })

  it('refuses a grant that carries no refresh token', async () => {
    configureClient()
    tokenMode = 'no_refresh_token'
    const state = await startAuthorization()
    const response = await fetch(`${baseUrl}/api/connectors/sample/callback?state=${state}&code=code-from-consent`, { redirect: 'manual' })
    expect(response.headers.get('location')).toBe('/connectors?error=exchange_failed')
    expect(getConnectorRecord('sample').refreshToken).toBe('')
  })
})

describe('connectors API — test and disconnect', () => {
  it('reports not_connected before a connection exists', async () => {
    configureClient()
    const response = await fetch(`${baseUrl}/api/connectors/sample/test`, { method: 'POST', headers: adminHeaders() })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, detail: 'not_connected' })
  })

  it('tests a connected connector', async () => {
    configureClient()
    saveConnectorTokens('sample', {
      accessToken: 'access-token-stored',
      refreshToken: REFRESH_TOKEN,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ['sample.read'],
    })
    const response = await fetch(`${baseUrl}/api/connectors/sample/test`, { method: 'POST', headers: adminHeaders() })
    expect(await response.json()).toEqual({ ok: true, detail: 'sample ok' })
  })

  it('reports reauth_required instead of retrying an invalid grant', async () => {
    configureClient()
    saveConnectorTokens('sample', {
      accessToken: 'access-token-expired',
      refreshToken: REFRESH_TOKEN,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      scopes: ['sample.read'],
    })
    tokenMode = 'invalid_grant'

    const response = await fetch(`${baseUrl}/api/connectors/sample/test`, { method: 'POST', headers: adminHeaders() })
    expect(await response.json()).toEqual({ ok: false, detail: 'reauth_required' })
    expect(tokenRequests).toHaveLength(1)

    const list = await fetch(`${baseUrl}/api/connectors`, { headers: adminHeaders() })
    const body = await list.json() as { connectors: { status: string }[] }
    expect(body.connectors[0]?.status).toBe('reauth_required')

    // A second test must not hammer the upstream again.
    await fetch(`${baseUrl}/api/connectors/sample/test`, { method: 'POST', headers: adminHeaders() })
    expect(tokenRequests).toHaveLength(1)
  })

  it('disconnects and keeps the configured client', async () => {
    configureClient()
    saveConnectorTokens('sample', {
      accessToken: 'access-token-stored',
      refreshToken: REFRESH_TOKEN,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ['sample.read'],
    })
    const response = await fetch(`${baseUrl}/api/connectors/sample/connection`, { method: 'DELETE', headers: adminHeaders() })
    expect(response.status).toBe(200)
    const body = await response.json() as { connector: { status: string; clientId: string } }
    expect(body.connector.status).toBe('disconnected')
    expect(body.connector.clientId).toBe('client-id-1')
    expect(getConnectorRecord('sample').refreshToken).toBe('')
  })
})

describe('connectors API — redirect uri derivation (OAUTH-1)', () => {
  it('derives NOTHING from the request host when no public base url is configured', async () => {
    // Reversed on purpose (review 2026-09-26, OAUTH-1/N4): the request host is
    // attacker controlled, so a missing PUBLIC_BASE_URL must produce an empty
    // redirect URI and a clear error — never a guess.
    delete process.env.PUBLIC_BASE_URL
    const response = await fetch(`${baseUrl}/api/connectors`, { headers: adminHeaders() })
    const body = await response.json() as { connectors: { redirectUri: string }[]; baseUrl: string }
    expect(body.baseUrl).toBe('')
    expect(body.connectors[0]?.redirectUri).toBe('')
  })

  it('refuses /authorize with public_base_url_missing instead of using the host header', async () => {
    delete process.env.PUBLIC_BASE_URL
    const response = await fetch(`${baseUrl}/api/connectors/sample/authorize`, {
      headers: { ...adminHeaders(), accept: 'application/json' },
      redirect: 'manual',
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'public_base_url_missing' })
  })

  it('ignores a forged X-Forwarded-Host and never builds a foreign redirect uri', async () => {
    delete process.env.PUBLIC_BASE_URL
    const forged = {
      ...adminHeaders(),
      accept: 'application/json',
      'x-forwarded-host': 'evil.example.net',
      'x-forwarded-proto': 'https',
      host: 'evil.example.net',
    }
    const authorize = await fetch(`${baseUrl}/api/connectors/sample/authorize`, { headers: forged, redirect: 'manual' })
    expect(authorize.status).toBe(409)
    expect(await authorize.json()).toEqual({ error: 'public_base_url_missing' })

    const list = await fetch(`${baseUrl}/api/connectors`, { headers: forged })
    const body = await list.json() as { connectors: { redirectUri: string }[]; baseUrl: string }
    expect(JSON.stringify(body)).not.toContain('evil.example.net')
  })

  it('uses ONLY the configured public base url, even with a forged host header', async () => {
    process.env.PUBLIC_BASE_URL = 'https://instance.example'
    const list = await fetch(`${baseUrl}/api/connectors`, {
      headers: { ...adminHeaders(), 'x-forwarded-host': 'evil.example.net' },
    })
    const body = await list.json() as { connectors: { redirectUri: string }[]; baseUrl: string }
    expect(body.baseUrl).toBe('https://instance.example')
    expect(body.connectors[0]?.redirectUri).toBe('https://instance.example/api/connectors/sample/callback')
  })
})
