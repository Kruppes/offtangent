import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { FcmClient, FcmConfigError, resolveServiceAccountFile } from './fcm-client.js'

let tempDir: string
let accountFile: string
let publicKey: crypto.KeyObject

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offtangent-fcm-'))
  const { privateKey, publicKey: pub } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  publicKey = pub
  accountFile = path.join(tempDir, 'service-account.json')
  fs.writeFileSync(accountFile, JSON.stringify({
    type: 'service_account',
    project_id: 'offtangent-test',
    client_email: 'sender@offtangent-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth2.test/token',
  }))
})

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.restoreAllMocks()
})

function tokenResponse(value = 'access-1', expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: value, expires_in: expiresIn }), { status: 200 })
}

describe('FcmClient', () => {
  it('reports a missing service account instead of throwing on construction', () => {
    const client = new FcmClient({ serviceAccountFile: path.join(tempDir, 'nope.json') })
    expect(client.isConfigured()).toBe(false)
    expect(() => client.projectId).toThrow(FcmConfigError)
  })

  it('signs the assertion with the service account key and sends a data only message', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      if (String(input).includes('oauth2.test')) return tokenResponse()
      return new Response(JSON.stringify({ name: 'projects/offtangent-test/messages/1' }), { status: 200 })
    }) as unknown as typeof fetch

    const client = new FcmClient({ serviceAccountFile: accountFile, fetchImpl, now: () => 1_700_000_000_000 })
    const result = await client.send({
      token: 'tok-a',
      data: { kind: 'turn_done', strandId: 's-1' },
      priority: 'high',
      ttlSeconds: 600,
      collapseKey: 's-1',
    })

    expect(result).toEqual({ ok: true, status: 200, name: 'projects/offtangent-test/messages/1' })

    // The grant is a real RS256 JWT for the right audience and scope.
    const form = new URLSearchParams(String(calls[0].init.body))
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const assertion = form.get('assertion')!
    const [header, claims, signature] = assertion.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const parsedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString())
    expect(parsedClaims.aud).toBe('https://oauth2.test/token')
    expect(parsedClaims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging')
    expect(crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${claims}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    )).toBe(true)

    // The message envelope: data only, no notification block.
    expect(calls[1].url).toBe('https://fcm.googleapis.com/v1/projects/offtangent-test/messages:send')
    const body = JSON.parse(String(calls[1].init.body))
    expect(body.message.notification).toBeUndefined()
    expect(body.message.android).toEqual({ priority: 'HIGH', ttl: '600s', collapse_key: 's-1' })
    expect(body.message.data).toEqual({ kind: 'turn_done', strandId: 's-1' })
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer access-1')
  })

  it('reuses the access token until it is nearly expired', async () => {
    let clock = 1_700_000_000_000
    let tokenExchanges = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('oauth2.test')) {
        tokenExchanges += 1
        return tokenResponse(`access-${tokenExchanges}`, 3600)
      }
      return new Response(JSON.stringify({ name: 'projects/p/messages/1' }), { status: 200 })
    }) as unknown as typeof fetch

    const client = new FcmClient({ serviceAccountFile: accountFile, fetchImpl, now: () => clock })
    const message = { token: 'tok-a', data: { kind: 'turn_done' }, priority: 'normal' as const, ttlSeconds: 600 }

    await client.send(message)
    await client.send(message)
    expect(tokenExchanges).toBe(1)

    clock += 3_600_000
    await client.send(message)
    expect(tokenExchanges).toBe(2)
  })

  it('reports the FCM error status for a dead token', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('oauth2.test')) return tokenResponse()
      return new Response(JSON.stringify({
        error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
      }), { status: 404 })
    }) as unknown as typeof fetch

    const client = new FcmClient({ serviceAccountFile: accountFile, fetchImpl })
    const result = await client.send({ token: 'gone', data: {}, priority: 'normal', ttlSeconds: 600 })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
    expect(result.errorCode).toBe('NOT_FOUND')
  })
})

describe('resolveServiceAccountFile', () => {
  it('prefers FCM_SERVICE_ACCOUNT_FILE over the default', () => {
    expect(resolveServiceAccountFile({ FCM_SERVICE_ACCOUNT_FILE: '/tmp/sa.json' })).toBe('/tmp/sa.json')
    expect(resolveServiceAccountFile({})).toBe('/data/secrets/firebase/service-account.json')
    expect(resolveServiceAccountFile({ FCM_SERVICE_ACCOUNT_FILE: '  ' })).toBe('/data/secrets/firebase/service-account.json')
  })
})
