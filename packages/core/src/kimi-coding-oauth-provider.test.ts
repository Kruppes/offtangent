/**
 * Integration of the Kimi Code OAuth preset with the provider store:
 * region consistency (auth host ↔ API base), encrypted storage, refresh
 * through getApiKeyForProvider, Bearer wiring, and that API-key `kimi-coding`
 * providers stay exactly as they were. No real network: fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROVIDER_TYPE_PRESETS,
  addOAuthProvider,
  addProvider,
  buildModel,
  getApiKeyForProvider,
  getOAuthAuthForLogin,
  getPiOAuthAuth,
  loadProvidersDecrypted,
  matchPresetBaseUrlOption,
} from './provider-config.js'
import { encrypt } from './encryption.js'
import { KIMI_CODING_OAUTH_MODEL_PROVIDER, KIMI_CODING_REGIONS, KimiCodingReloginRequiredError } from './kimi-coding-oauth.js'
import { withBearerAuth } from './pi-models.js'

const CN = 'https://api.kimi.com/coding'
const INTL = 'https://api.kimi.ai/coding'
const ACCESS = 'kimi-access-token-must-not-be-stored-in-clear'
const REFRESH = 'kimi-refresh-token-must-not-be-stored-in-clear'

let tmpDir: string
const originalDataDir = process.env.DATA_DIR

function setup(providers: unknown[] = []): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-kimi-oauth-'))
  const configDir = path.join(tmpDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'providers.json'), JSON.stringify({ providers }, null, 2), 'utf-8')
  process.env.DATA_DIR = tmpDir
}

function rawProvidersFile(): string {
  return fs.readFileSync(path.join(tmpDir, 'config', 'providers.json'), 'utf-8')
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  setup()
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
  else delete process.env.DATA_DIR
})

describe('kimi-coding-oauth preset', () => {
  it('is an OAuth preset with exactly the two regional endpoints, China as default', () => {
    const preset = PROVIDER_TYPE_PRESETS['kimi-coding-oauth']
    expect(preset.authMethod).toBe('oauth')
    expect(preset.oauthProviderId).toBe('kimi-coding')
    expect(preset.apiType).toBe('anthropic-messages')
    expect(preset.requiresApiKey).toBe(false)
    expect(preset.baseUrl).toBe(CN)
    expect(preset.baseUrlOptions?.map(o => o.url)).toEqual([CN, INTL])
    expect(matchPresetBaseUrlOption(preset, `${INTL}/`)).toBeTruthy()
    expect(matchPresetBaseUrlOption(preset, 'https://api.kimi.ai/coding/v1')).toBeFalsy()
  })

  it('the API-key preset is unchanged (no OAuth, own catalog provider id)', () => {
    const preset = PROVIDER_TYPE_PRESETS['kimi-coding']
    expect(preset.authMethod ?? 'api-key').toBe('api-key')
    expect(preset.oauthProviderId).toBeUndefined()
    expect(preset.requiresApiKey).toBe(true)
    expect(preset.baseUrl).toBe(CN)
  })
})

describe('login picks the auth host of the chosen region', () => {
  it.each([
    ['China', CN, 'https://auth.kimi.com'],
    ['International', INTL, 'https://auth.kimi.ai'],
  ])('%s: device authorization goes to %s → %s', async (_label, baseUrl, authHost) => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input))
      return jsonResponse(200, {
        device_code: 'dev', user_code: 'ABCD-1234',
        verification_uri_complete: `${authHost}/device?user_code=ABCD-1234`, interval: 5, expires_in: 600,
      })
    }))
    const auth = getOAuthAuthForLogin('kimi-coding-oauth', baseUrl)
    expect(auth).toBeTruthy()
    const controller = new AbortController()
    const notify = vi.fn(() => controller.abort(new Error('stop after device code')))
    await expect(auth!.login({ notify, prompt: vi.fn(), signal: controller.signal } as never)).rejects.toThrow(/stop after device code/)
    expect(urls).toEqual([`${authHost}/api/oauth/device_authorization`])
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'device_code', userCode: 'ABCD-1234' }))
  })

  it('without a region choice the login uses China', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input))
      return jsonResponse(500, {})
    }))
    await expect(getOAuthAuthForLogin('kimi-coding-oauth')!.login({ notify: vi.fn(), prompt: vi.fn(), signal: new AbortController().signal } as never))
      .rejects.toThrow(/status 500/)
    expect(urls[0]).toBe('https://auth.kimi.com/api/oauth/device_authorization')
  })

  it('other OAuth presets keep the shared pi-ai flow; API-key presets have none', () => {
    expect(getOAuthAuthForLogin('anthropic-oauth')).toBe(getPiOAuthAuth('anthropic'))
    expect(getOAuthAuthForLogin('kimi-coding')).toBeNull()
  })
})

describe('stored provider: region of the credential drives the API base', () => {
  it.each([
    ['cn', CN],
    ['intl', INTL],
  ] as const)('%s: stores encrypted tokens and builds a Bearer model against %s', (region, apiBase) => {
    const created = addOAuthProvider({
      name: `Kimi Code ${region}`,
      providerType: 'kimi-coding-oauth',
      enabledModels: ['k3'],
      baseUrl: apiBase,
      oauthCredentials: { access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000, region },
    })
    expect(created.baseUrl).toBe(apiBase)

    // Encrypted at rest, region included (it lives in the encrypted extra blob).
    const raw = rawProvidersFile()
    expect(raw).not.toContain(ACCESS)
    expect(raw).not.toContain(REFRESH)

    const provider = loadProvidersDecrypted().providers[0]
    const model = buildModel(provider, 'k3')
    expect(model.baseUrl).toBe(apiBase)
    expect(model.baseUrl).toBe(KIMI_CODING_REGIONS[region].apiBaseUrl)
    expect(model.api).toBe('anthropic-messages')
    expect(model.provider).toBe(KIMI_CODING_OAUTH_MODEL_PROVIDER)
    // CLI identity headers are off by default.
    expect(model.headers?.['X-Msh-Platform']).toBeUndefined()

    const opts = withBearerAuth(model, { apiKey: ACCESS })
    expect(opts?.apiKey).toBeUndefined()
    expect(opts?.headers?.Authorization).toBe(`Bearer ${ACCESS}`)
  })

  it('a credential region wins over a diverging region choice (auth and API never split)', () => {
    const created = addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: CN,
      oauthCredentials: { access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000, region: 'intl' },
    })
    expect(created.baseUrl).toBe(INTL)
    const provider = loadProvidersDecrypted().providers[0]
    expect(buildModel({ ...provider, baseUrl: CN }, 'k3').baseUrl).toBe(INTL)
  })

  it('a foreign URL can never become the API base (the token region decides)', () => {
    // The web service rejects a foreign region before the login starts (see
    // providers service); once a token exists, its region is authoritative.
    const created = addOAuthProvider({
      name: 'Bad', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: 'https://proxy.example.invalid/coding',
      oauthCredentials: { access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000, region: 'intl' },
    })
    expect(created.baseUrl).toBe(INTL)
    const provider = loadProvidersDecrypted().providers[0]
    expect(buildModel({ ...provider, baseUrl: 'https://proxy.example.invalid/coding' }, 'k3').baseUrl).toBe(INTL)
  })
})

describe('refresh through getApiKeyForProvider', () => {
  it.each([
    ['cn', 'https://auth.kimi.com'],
    ['intl', 'https://auth.kimi.ai'],
  ] as const)('%s: an expired token is refreshed at %s and re-stored encrypted', async (region, authHost) => {
    addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'],
      baseUrl: KIMI_CODING_REGIONS[region].apiBaseUrl,
      oauthCredentials: { access: 'old-access', refresh: REFRESH, expires: Date.now() - 1000, region },
    })
    const calls: Array<{ url: string; body: URLSearchParams }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? '')) })
      return jsonResponse(200, { access_token: ACCESS, refresh_token: 'rotated-refresh-token', expires_in: 3600 })
    }))

    const provider = loadProvidersDecrypted().providers[0]
    await expect(getApiKeyForProvider(provider)).resolves.toBe(ACCESS)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${authHost}/api/oauth/token`)
    expect(calls[0].body.get('grant_type')).toBe('refresh_token')

    const raw = rawProvidersFile()
    expect(raw).not.toContain(ACCESS)
    expect(raw).not.toContain('rotated-refresh-token')
    const reloaded = loadProvidersDecrypted().providers[0]
    expect(reloaded.baseUrl).toBe(KIMI_CODING_REGIONS[region].apiBaseUrl)
    expect(buildModel(reloaded, 'k3').baseUrl).toBe(KIMI_CODING_REGIONS[region].apiBaseUrl)
  })

  it('a valid token is used without any request', async () => {
    addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL,
      oauthCredentials: { access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000, region: 'intl' },
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(getApiKeyForProvider(loadProvidersDecrypted().providers[0])).resolves.toBe(ACCESS)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a dead refresh token surfaces the re-login hint, without token material', async () => {
    addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL,
      oauthCredentials: { access: 'old-access', refresh: REFRESH, expires: Date.now() - 1000, region: 'intl' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'invalid_grant', error_description: REFRESH })))
    const err = await getApiKeyForProvider(loadProvidersDecrypted().providers[0]).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).toMatch(/Renew token/)
    expect(String((err as Error).message)).not.toContain(REFRESH)
    expect(err instanceof KimiCodingReloginRequiredError || /sign-in expired/.test((err as Error).message)).toBe(true)
  })
})

describe('API-key kimi-coding providers are untouched', () => {
  it.each([CN, INTL])('region %s: x-api-key wire, catalog provider id, no Bearer rewrite', async (baseUrl) => {
    setup([{
      id: 'kc-key', name: 'Kimi Code', type: 'anthropic-messages', providerType: 'kimi-coding', provider: 'kimi-coding',
      baseUrl, apiKey: encrypt('sk-plan-key'), enabledModels: ['k3'], degradedThresholdMs: 5000, status: 'untested', authMethod: 'api-key',
    }])
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const provider = loadProvidersDecrypted().providers[0]
    const model = buildModel(provider, 'k3')
    expect(model.provider).toBe('kimi-coding')
    expect(model.baseUrl).toBe(baseUrl)
    expect(model.api).toBe('anthropic-messages')
    await expect(getApiKeyForProvider(provider)).resolves.toBe('sk-plan-key')
    const opts = { apiKey: 'sk-plan-key' }
    expect(withBearerAuth(model, opts)).toBe(opts)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a fresh API-key provider via addProvider still defaults to China', () => {
    const p = addProvider({ name: 'Kimi Code', providerType: 'kimi-coding', apiKey: 'sk', enabledModels: ['k3'] })
    expect(p.authMethod ?? 'api-key').toBe('api-key')
    expect(p.baseUrl).toBe(CN)
  })
})

describe('captured Kimi coding request (pi-ai 1.5.2 keeps the 1.0.0 Anthropic Messages wire)', () => {
  // No network: the request is captured by an injected fetch and answered
  // with a 400, so nothing reaches api.kimi.com / api.kimi.ai.
  type Captured = { url: string; headers: Headers; body: Record<string, unknown> }
  function capturingFetch(captured: Captured[]): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const raw = init?.body
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array)
      captured.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(text) })
      return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"capture stop"}}', { status: 400 })
    }) as typeof fetch
  }
  async function capture(model: ReturnType<typeof buildModel>, apiKey: string): Promise<Captured> {
    const { streamSimple } = await import('./pi-models.js')
    const captured: Captured[] = []
    const stream = streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] } as never,
      { apiKey, maxRetries: 0, reasoning: 'high', fetch: capturingFetch(captured) } as never)
    for await (const _e of stream as AsyncIterable<unknown>) { /* drain until error */ }
    expect(captured).toHaveLength(1)
    return captured[0]!
  }

  it.each([CN, INTL])('API key %s: POST <region>/v1/messages with x-api-key, adaptive thinking, no OpenAI fields', async (baseUrl) => {
    setup([{
      id: 'kc-key', name: 'Kimi Code', type: 'anthropic-messages', providerType: 'kimi-coding', provider: 'kimi-coding',
      baseUrl, apiKey: encrypt('sk-plan-key'), enabledModels: ['k3'], degradedThresholdMs: 5000, status: 'untested', authMethod: 'api-key',
    }])
    const model = buildModel(loadProvidersDecrypted().providers[0], 'k3')
    const req = await capture(model, 'sk-plan-key')
    // `?beta=true` comes from pi-ai's client.beta.messages.create (1.0.0 and 1.5.2 alike).
    expect(req.url).toBe(`${baseUrl}/v1/messages?beta=true`)
    expect(req.headers.get('x-api-key')).toBe('sk-plan-key')
    expect(req.headers.get('authorization')).toBeNull()
    expect(req.body.model).toBe('k3')
    expect((req.body.thinking as { type?: string } | undefined)?.type).toBe('adaptive')
    expect(req.body).not.toHaveProperty('reasoning_effort')
    expect(req.body).not.toHaveProperty('max_completion_tokens')
  })

  it.each([['cn', CN], ['intl', INTL]] as const)('OAuth %s: POST <credential region>/v1/messages with Bearer, no x-api-key', async (region, apiBase) => {
    addOAuthProvider({
      name: `Kimi Code ${region}`, providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: apiBase,
      oauthCredentials: { access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000, region },
    })
    const model = buildModel(loadProvidersDecrypted().providers[0], 'k3')
    const req = await capture(model, ACCESS)
    expect(req.url).toBe(`${apiBase}/v1/messages?beta=true`)
    expect(req.headers.get('authorization')).toBe(`Bearer ${ACCESS}`)
    expect(req.headers.get('x-api-key')).toBeNull()
    expect((req.body.thinking as { type?: string } | undefined)?.type).toBe('adaptive')
  })
})
