import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KIMI_CODE_CLIENT_ID,
  KIMI_CODING_REGIONS,
  KimiCodingReloginRequiredError,
  createKimiCodingOAuth,
  kimiCliIdentityHeaders,
  kimiCodingRegionForBaseUrl,
  kimiCodingRegionOfCredential,
  pollKimiDeviceToken,
  redactSecrets,
  refreshKimiToken,
  requireKimiCodingRegionOfCredential,
  startKimiDeviceAuthorization,
  type KimiCodingRegion,
} from './kimi-coding-oauth.js'

const ACCESS = 'access-token-value-should-never-leak'
const REFRESH = 'refresh-token-value-should-never-leak'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface Call { url: string; body: URLSearchParams; headers: Record<string, string> }

/** Scripted fetch: answers in order and records url + form body. */
function scriptedFetch(responses: Array<Response | Error>) {
  const calls: Call[] = []
  const fn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: new URLSearchParams(String(init?.body ?? '')),
      headers: { ...(init?.headers as Record<string, string>) },
    })
    const next = responses.shift()
    if (!next) throw new Error('unexpected request')
    if (next instanceof Error) throw next
    return next
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

const noSleep = vi.fn(async () => {})
const signal = () => new AbortController().signal

const REGIONS: Array<[KimiCodingRegion, string, string]> = [
  ['cn', 'https://auth.kimi.com', 'https://api.kimi.com/coding'],
  ['intl', 'https://auth.kimi.ai', 'https://api.kimi.ai/coding'],
]

describe('region table (auth host and API base stay consistent)', () => {
  it.each(REGIONS)('%s: auth host %s belongs to API base %s', (region, authHost, apiBase) => {
    const info = KIMI_CODING_REGIONS[region]
    expect(info.authHost).toBe(authHost)
    expect(info.apiBaseUrl).toBe(apiBase)
    expect(info.managementBaseUrl).toBe(`${apiBase}/v1`)
    // Same registrable domain for every endpoint of one region.
    const domain = (url: string) => new URL(url).hostname.split('.').slice(-2).join('.')
    expect(domain(info.authHost)).toBe(domain(info.apiBaseUrl))
    expect(domain(info.managementBaseUrl)).toBe(domain(info.apiBaseUrl))
  })

  it('derives the region from a base URL; unknown or missing URLs fall back to China', () => {
    expect(kimiCodingRegionForBaseUrl('https://api.kimi.ai/coding')).toBe('intl')
    expect(kimiCodingRegionForBaseUrl('https://api.kimi.com/coding')).toBe('cn')
    expect(kimiCodingRegionForBaseUrl(undefined)).toBe('cn')
    expect(kimiCodingRegionForBaseUrl('not a url')).toBe('cn')
    expect(kimiCodingRegionForBaseUrl('https://kimi.ai.evil.example/coding')).toBe('cn')
  })

  it('the credential region is authoritative; a missing/unknown one is never guessed', () => {
    expect(kimiCodingRegionOfCredential({ region: 'intl' })).toBe('intl')
    expect(kimiCodingRegionOfCredential({ region: 'cn' })).toBe('cn')
    // Review finding 5: no fallback to the (editable) base URL.
    expect(kimiCodingRegionOfCredential({ region: 'mars' })).toBeNull()
    expect(kimiCodingRegionOfCredential({})).toBeNull()
    expect(kimiCodingRegionOfCredential(undefined)).toBeNull()
    expect(() => requireKimiCodingRegionOfCredential({})).toThrow(KimiCodingReloginRequiredError)
    expect(() => requireKimiCodingRegionOfCredential({})).toThrow(/no region.*Renew token/)
    expect(requireKimiCodingRegionOfCredential({ region: 'intl' })).toBe('intl')
  })
})

describe('device authorization (RFC 8628)', () => {
  it.each(REGIONS)('%s: requests the device code from %s with the CLI client id', async (region, authHost) => {
    const { fetch, calls } = scriptedFetch([jsonResponse(200, {
      device_code: 'dev-1', user_code: 'ABCD-EFGH',
      verification_uri: `${authHost}/device`, verification_uri_complete: `${authHost}/device?user_code=ABCD-EFGH`,
      interval: 3, expires_in: 600,
    })])
    const device = await startKimiDeviceAuthorization(region, signal(), { fetch })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${authHost}/api/oauth/device_authorization`)
    expect(calls[0].body.get('client_id')).toBe(KIMI_CODE_CLIENT_ID)
    expect(device).toEqual({
      deviceCode: 'dev-1', userCode: 'ABCD-EFGH',
      verificationUri: `${authHost}/device?user_code=ABCD-EFGH`, intervalSeconds: 3, expiresInSeconds: 600,
    })
  })

  it('caps an announced lifetime at 15 minutes (pending-login TTL builds on it)', async () => {
    const { fetch } = scriptedFetch([jsonResponse(200, {
      device_code: 'dev-1', user_code: 'X', verification_uri: 'https://auth.kimi.com/device', interval: 5, expires_in: 86_400,
    })])
    const device = await startKimiDeviceAuthorization('cn', signal(), { fetch })
    expect(device.expiresInSeconds).toBe(15 * 60)
  })

  it('a transport failure carries only a category, never the request details', async () => {
    const fn = vi.fn(async () => { throw new TypeError(`fetch failed: client_id=${KIMI_CODE_CLIENT_ID} ${REFRESH}`) })
    const err = (await startKimiDeviceAuthorization('cn', signal(), { fetch: fn as unknown as typeof fetch }).catch((e: unknown) => e)) as Error
    expect(err.message).toBe('Kimi Code device authorization failed (network error)')
  })

  it('rejects a non-https verification URI', async () => {
    const { fetch } = scriptedFetch([jsonResponse(200, {
      device_code: 'dev-1', user_code: 'X', verification_uri: 'javascript:alert(1)',
    })])
    await expect(startKimiDeviceAuthorization('cn', signal(), { fetch })).rejects.toThrow(/Invalid Kimi Code device authorization/)
  })

  it('surfaces the HTTP status of a failed authorization request', async () => {
    const { fetch } = scriptedFetch([jsonResponse(400, { error: 'invalid_client' })])
    await expect(startKimiDeviceAuthorization('intl', signal(), { fetch })).rejects.toThrow(/status 400, invalid_client/)
  })

  it.each(REGIONS)('%s: polls %s until the token arrives (pending, slow_down)', async (region, authHost) => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(400, { error: 'slow_down' }),
      jsonResponse(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: 'Bearer' }),
    ])
    const sleep = vi.fn(async () => {})
    const token = await pollKimiDeviceToken(region, {
      deviceCode: 'dev-1', userCode: 'U', verificationUri: `${authHost}/device`, intervalSeconds: 1, expiresInSeconds: 600,
    }, signal(), { fetch, sleep, now: () => 1_000_000 })
    expect(calls.map(c => c.url)).toEqual(Array(3).fill(`${authHost}/api/oauth/token`))
    expect(calls[0].body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(calls[0].body.get('device_code')).toBe('dev-1')
    expect(calls[0].body.get('client_id')).toBe(KIMI_CODE_CLIENT_ID)
    expect(token.access).toBe(ACCESS)
    expect(token.refresh).toBe(REFRESH)
    // Expiry lies a skew before the real expiry (refresh before it runs out).
    expect(token.expires).toBe(1_000_000 + 3600_000 - 5 * 60_000)
    // slow_down raises the poll interval by 5 s.
    const waits = sleep.mock.calls.map(c => (c as unknown[])[0])
    expect(waits[waits.length - 1]).toBeGreaterThan(waits[0] as number)
  })

  it('stops on expired_token and access_denied without leaking anything', async () => {
    for (const [error, pattern] of [['expired_token', /expired/], ['access_denied', /denied/]] as const) {
      const { fetch } = scriptedFetch([jsonResponse(400, { error })])
      await expect(pollKimiDeviceToken('cn', {
        deviceCode: 'dev-1', userCode: 'U', verificationUri: 'https://auth.kimi.com/device', intervalSeconds: 1, expiresInSeconds: 600,
      }, signal(), { fetch, sleep: noSleep })).rejects.toThrow(pattern)
    }
  })

  it('a token response without the required fields fails with field names only', async () => {
    const { fetch } = scriptedFetch([jsonResponse(200, { access_token: ACCESS })])
    const err = (await pollKimiDeviceToken('cn', {
      deviceCode: 'dev-1', userCode: 'U', verificationUri: 'https://auth.kimi.com/device', intervalSeconds: 1, expiresInSeconds: 600,
    }, signal(), { fetch, sleep: noSleep }).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/missing fields/)
    expect(err.message).not.toContain(ACCESS)
  })
})

describe('token refresh', () => {
  it.each(REGIONS)('%s: refreshes against %s', async (region, authHost) => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 900 }),
    ])
    const token = await refreshKimiToken(region, REFRESH, signal(), { fetch, now: () => 0 })
    expect(calls[0].url).toBe(`${authHost}/api/oauth/token`)
    expect(calls[0].body.get('grant_type')).toBe('refresh_token')
    expect(calls[0].body.get('refresh_token')).toBe(REFRESH)
    expect(token).toEqual({ access: 'new-access', refresh: 'new-refresh', expires: 900_000 - 5 * 60_000 })
  })

  it('retries transient 5xx / network errors and then succeeds', async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(503, {}),
      new Error('socket hang up'),
      jsonResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 60 }),
    ])
    const token = await refreshKimiToken('intl', REFRESH, signal(), { fetch, sleep: noSleep, now: () => 0 })
    expect(calls).toHaveLength(3)
    // Short lifetimes: skew is capped at half the lifetime.
    expect(token.expires).toBe(30_000)
  })

  it('a fetch exception that echoes the token never reaches the error (review finding 3)', async () => {
    const echo = vi.fn(async (_url: unknown, init?: RequestInit) => {
      throw new TypeError(`request to https://auth.kimi.ai failed, body=${String(init?.body)} Authorization: Bearer ${ACCESS}`)
    })
    const err = (await refreshKimiToken('intl', REFRESH, signal(), { fetch: echo as unknown as typeof fetch, sleep: noSleep })
      .catch((e: unknown) => e)) as Error
    expect(echo).toHaveBeenCalledTimes(4)
    expect(err.message).toBe('Kimi Code token refresh failed (network error)')
    expect(`${err.message}\n${err.stack ?? ''}`).not.toContain(REFRESH)
    expect(`${err.message}\n${err.stack ?? ''}`).not.toContain(ACCESS)
  })

  it('timeouts are reported as such, still without the exception text', async () => {
    const timeout = vi.fn(async () => { throw new DOMException(`timed out ${REFRESH}`, 'TimeoutError') })
    const err = (await refreshKimiToken('cn', REFRESH, signal(), { fetch: timeout as unknown as typeof fetch, sleep: noSleep })
      .catch((e: unknown) => e)) as Error
    expect(err.message).toBe('Kimi Code token refresh failed (timeout)')
  })

  it('redactSecrets replaces every token occurrence and ignores short/empty values', () => {
    expect(redactSecrets(`a ${ACCESS} b ${REFRESH} c ${ACCESS}`, [ACCESS, REFRESH, '', undefined, 'abc']))
      .toBe('a [redacted] b [redacted] c [redacted]')
  })

  it.each([401, 403])('a dead refresh token (%i) asks for a re-login, without retry and without token material', async (status) => {
    const { fetch, calls } = scriptedFetch([jsonResponse(status, { error: 'invalid_token', refresh_token: REFRESH })])
    const err = (await refreshKimiToken('cn', REFRESH, signal(), { fetch, sleep: noSleep }).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(KimiCodingReloginRequiredError)
    expect((err as KimiCodingReloginRequiredError).reloginRequired).toBe(true)
    expect(err.message).toMatch(/Renew token/)
    expect(err.message).not.toContain(REFRESH)
    expect(calls).toHaveLength(1)
  })

  it('invalid_grant (400) also asks for a re-login', async () => {
    const { fetch } = scriptedFetch([jsonResponse(400, { error: 'invalid_grant' })])
    await expect(refreshKimiToken('intl', REFRESH, signal(), { fetch, sleep: noSleep })).rejects.toBeInstanceOf(KimiCodingReloginRequiredError)
  })
})

describe('createKimiCodingOAuth', () => {
  it.each(REGIONS)('%s: login runs the device flow on %s, reports the code and stores the region', async (region, authHost) => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(200, { device_code: 'dev', user_code: 'WXYZ-1234', verification_uri: `${authHost}/device`, interval: 1, expires_in: 60 }),
      jsonResponse(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }),
    ])
    const auth = createKimiCodingOAuth(region, { fetch, sleep: noSleep, now: () => 0 })
    const notify = vi.fn()
    const credential = await auth.login({ notify, prompt: vi.fn(), signal: signal() } as never)
    expect(calls.every(c => c.url.startsWith(`${authHost}/`))).toBe(true)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      type: 'device_code', userCode: 'WXYZ-1234', verificationUri: `${authHost}/device`,
    }))
    expect(credential).toMatchObject({ type: 'oauth', access: ACCESS, refresh: REFRESH, region })
    expect(await auth.toAuth(credential as never)).toEqual({ apiKey: ACCESS })
    expect(auth.isSubscription).toBe(true)
  })

  it('refresh follows the region of the credential, not the factory default', async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }),
    ])
    const auth = createKimiCodingOAuth('cn', { fetch, now: () => 0 })
    const rotated = await auth.refresh({ type: 'oauth', access: 'a1', refresh: 'r1', expires: 0, region: 'intl' } as never, signal())
    expect(calls[0].url).toBe('https://auth.kimi.ai/api/oauth/token')
    expect(rotated).toMatchObject({ access: 'a2', refresh: 'r2', region: 'intl' })
  })
})

describe('optional CLI identity headers', () => {
  it('are OFF by default', () => {
    expect(kimiCliIdentityHeaders({})).toEqual({})
    expect(kimiCliIdentityHeaders({ KIMI_CODING_CLI_HEADERS: '0' })).toEqual({})
  })

  it('send only a minimal, non-identifying subset when switched on', () => {
    const headers = kimiCliIdentityHeaders({ KIMI_CODING_CLI_HEADERS: '1' })
    expect(Object.keys(headers).sort()).toEqual(['User-Agent', 'X-Msh-Platform', 'X-Msh-Version'])
    expect(headers).not.toHaveProperty('X-Msh-Device-Id')
    expect(headers).not.toHaveProperty('X-Msh-Device-Name')
  })
})

describe('client id drift', () => {
  it('is the client id pi-ai ships for the Kimi Code CLI flow', () => {
    // Walk up to the installed pi-ai package (workspace hoisting may vary).
    const relative = path.join('node_modules', '@earendil-works', 'pi-ai', 'dist', 'auth', 'oauth', 'kimi-coding.js')
    let dir = path.dirname(fileURLToPath(import.meta.url))
    while (!fs.existsSync(path.join(dir, relative)) && path.dirname(dir) !== dir) dir = path.dirname(dir)
    const source = fs.readFileSync(path.join(dir, relative), 'utf-8')
    const match = /CLIENT_ID\s*=\s*["']([^"']+)["']/.exec(source)
    expect(match?.[1]).toBe(KIMI_CODE_CLIENT_ID)
  })
})
