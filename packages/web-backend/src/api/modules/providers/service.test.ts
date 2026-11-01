import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addOAuthProvider, addProvider, getAvailableModels, loadProvidersDecrypted, updateProvider } from '@axiom/core'
import {
  createProvidersService,
  DEFAULT_PENDING_OAUTH_LOGIN_TTL_MS,
  pendingOAuthLoginTtlMs,
  ProvidersNotFoundError,
  ProvidersValidationError,
} from './service.js'
import { mapProvidersListResponse } from './mapper.js'

let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
})

afterAll(() => {
  if (previousDataDir === undefined) {
    delete process.env.DATA_DIR
  } else {
    process.env.DATA_DIR = previousDataDir
  }
})

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-providers-service-'))
  process.env.DATA_DIR = tempDataDir
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

describe('getLiveModels (dynamic catalog)', () => {
  function createOpenRouterProvider() {
    return addProvider({
      name: 'OpenRouter',
      providerType: 'openrouter',
      apiKey: 'sk-openrouter-test',
      enabledModels: [],
    })
  }

  it('returns the live /models list, sorted and deduped, replacing the curated catalog', async () => {
    const provider = createOpenRouterProvider()

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'z/model-two' }, { id: 'a/model-one' }, { id: 'a/model-one' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const service = createProvidersService()
    const models = await service.getLiveModels(provider.id)

    expect(models).toEqual([
      { id: 'a/model-one', name: 'a/model-one' },
      { id: 'z/model-two', name: 'z/model-two' },
    ])
  })

  it('maps display name, context window and per-1M-token cost from the live response', async () => {
    const provider = createOpenRouterProvider()

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'a/model-one',
              name: 'Model One',
              context_length: 1048576,
              pricing: { prompt: '0.0000001', completion: '0.0000004' },
            },
            { id: 'b/no-metadata', pricing: { prompt: '-1', completion: '-1' } },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const service = createProvidersService()
    const models = await service.getLiveModels(provider.id)

    expect(models).toEqual([
      {
        id: 'a/model-one',
        name: 'Model One',
        contextWindow: 1048576,
        cost: { input: 0.1, output: 0.4 },
      },
      { id: 'b/no-metadata', name: 'b/no-metadata' },
    ])
  })

  it('falls back to the curated catalog when the live fetch fails', async () => {
    const provider = createOpenRouterProvider()

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    const service = createProvidersService()
    const models = await service.getLiveModels(provider.id)

    expect(models).toEqual(getAvailableModels('openrouter'))
    expect(models.length).toBeGreaterThan(0)
  })

  it('rejects provider types that do not use a dynamic catalog', async () => {
    const provider = addProvider({
      name: 'OpenAI',
      providerType: 'openai',
      apiKey: 'sk-openai-test',
      enabledModels: [],
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const service = createProvidersService()

    await expect(service.getLiveModels(provider.id)).rejects.toBeInstanceOf(ProvidersValidationError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects an unknown provider id', async () => {
    const service = createProvidersService()
    await expect(service.getLiveModels('does-not-exist')).rejects.toBeInstanceOf(ProvidersNotFoundError)
  })
})

describe('getLiveModels (Kimi Code live model list)', () => {
  const INTL = 'https://api.kimi.ai/coding'
  const liveAnswer = {
    data: [
      { id: 'k3', display_name: 'Kimi K3', context_length: 1048576, supports_reasoning: true, think_efforts: { valid_efforts: ['low', 'high', 'max'] } },
      {
        id: 'k3.1-pro', display_name: 'Kimi K3.1 Pro', context_length: 1048576, supports_reasoning: true,
        supports_thinking_type: 'only', think_efforts: { valid_efforts: ['low', 'high', 'max'], default_effort: 'high' },
        modalities: { input: ['text', 'image'] }, supports_image_in: true,
      },
    ],
  }

  function createKimiOAuthProvider() {
    return addOAuthProvider({
      name: 'Kimi_Subscription', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL,
      oauthCredentials: { access: 'kimi-access', refresh: 'kimi-refresh', expires: Date.now() + 3_600_000, region: 'intl' },
    })
  }

  it('refreshes the live list with the stored token and returns catalog + live-only models', async () => {
    const provider = createKimiOAuthProvider()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(liveAnswer), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    const models = await createProvidersService().getLiveModels(provider.id)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${INTL}/v1/models`)
    const ids = models.map(m => m.id)
    expect(ids).toEqual(expect.arrayContaining([...getAvailableModels('kimi-coding-oauth').map(m => m.id), 'k3.1-pro']))
    expect(new Set(ids).size).toBe(ids.length)
    expect(models.find(m => m.id === 'k3.1-pro')).toMatchObject({ name: 'Kimi K3.1 Pro', contextWindow: 1048576 })
    expect(loadProvidersDecrypted().providers[0].knownModels).toContain('k3.1-pro')
  })

  it('a failing live request keeps the catalog list and does not throw', async () => {
    const provider = createKimiOAuthProvider()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 502 }))

    const models = await createProvidersService().getLiveModels(provider.id)

    expect(models.map(m => m.id)).toEqual(getAvailableModels('kimi-coding-oauth').map(m => m.id))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(loadProvidersDecrypted().providers[0].knownModels).toBeUndefined()
  })

  it('the providers list marks the Kimi Code presets as live-model presets', () => {
    const empty = { providers: [], activeProvider: null, activeModel: null } as never
    const response = mapProvidersListResponse(empty, empty)
    expect(response.presets?.['kimi-coding-oauth']?.liveModels).toBe('kimi-coding')
    expect(response.presets?.['kimi-coding']?.liveModels).toBe('kimi-coding')
    expect(response.presets?.['kimi']?.liveModels).toBeUndefined()
  })
})

// GPT-6.1 Sol is newer than the pinned pi-ai catalog and reaches the picker
// through PROVIDER_TYPE_MODEL_OVERRIDES (openai + openai-codex).
describe('GPT-6.1 Sol in the model picker', () => {
  it.each(['openai', 'openai-codex'])('lists it for %s in the Add Model catalog', (providerType) => {
    const models = createProvidersService().getModelsByProviderType(providerType)
    expect(models.find(m => m.id === 'gpt-6.1-sol')).toMatchObject({ name: 'GPT-6.1 Sol', contextWindow: 272_000 })
  })

  it('reports its per-token prices once it is enabled on a ChatGPT provider', () => {
    const provider = addProvider({
      name: 'ChatGPT',
      providerType: 'openai-codex',
      apiKey: '',
      enabledModels: ['gpt-6-sol', 'gpt-6.1-sol'],
    })
    const { masked, decrypted } = createProvidersService().listProviders()
    const listed = mapProvidersListResponse(masked, decrypted).providers.find(p => p.id === provider.id)
    expect(listed?.modelCosts?.['gpt-6.1-sol']).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 })
    expect(listed?.modelCosts?.['gpt-6-sol']).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
  })
})

describe('Kimi Code OAuth device login (region aware)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubKimiAuth() {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      urls.push(url)
      const host = new URL(url).origin
      const body = url.endsWith('/device_authorization')
        ? { device_code: 'dev', user_code: 'WXYZ-0001', verification_uri_complete: `${host}/device?user_code=WXYZ-0001`, interval: 0.001, expires_in: 60 }
        : { access_token: 'kimi-access', refresh_token: 'kimi-refresh', expires_in: 3600 }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    return urls
  }

  async function waitForCompletion(service: ReturnType<typeof createProvidersService>, loginId: string) {
    for (let i = 0; i < 200; i++) {
      const status = await service.getOAuthStatus(loginId)
      if (status.status !== 'pending') return status
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('login did not complete')
  }

  it.each([
    ['China', 'https://api.kimi.com/coding', 'https://auth.kimi.com'],
    ['International', 'https://api.kimi.ai/coding', 'https://auth.kimi.ai'],
  ])('%s: device code from the regional auth host, provider on the matching API base', async (_label, baseUrl, authHost) => {
    const urls = stubKimiAuth()
    const service = createProvidersService()
    const started = await service.startOAuthLogin({
      providerType: 'kimi-coding-oauth', name: 'Kimi Code', enabledModels: ['k3'], baseUrl,
    })
    expect(started.authUrl).toBe(`${authHost}/device?user_code=WXYZ-0001`)
    expect(started.instructions).toBe('WXYZ-0001')
    expect(started.usesCallbackServer).toBe(false)

    const done = await waitForCompletion(service, started.loginId)
    expect(done.status).toBe('completed')
    if (done.status !== 'completed') return
    expect(done.provider.providerType).toBe('kimi-coding-oauth')
    expect(done.provider.authMethod).toBe('oauth')
    expect(done.provider.baseUrl).toBe(baseUrl)
    expect(urls.every(url => url.startsWith(`${authHost}/`))).toBe(true)
    expect(urls.some(url => url.endsWith('/api/oauth/token'))).toBe(true)
  })

  it('"Renew token" signs in again in the region the provider already uses', async () => {
    const existing = addOAuthProvider({
      name: 'Kimi Intl',
      providerType: 'kimi-coding-oauth',
      enabledModels: ['k3'],
      baseUrl: 'https://api.kimi.ai/coding',
      oauthCredentials: { access: 'old-access', refresh: 'old-refresh', expires: Date.now() - 1000, region: 'intl' },
    })
    const urls = stubKimiAuth()
    const service = createProvidersService()
    const started = await service.startOAuthLogin({
      providerType: 'kimi-coding-oauth', name: 'Kimi Intl', enabledModels: ['k3'], providerId: existing.id,
    })
    expect(started.authUrl).toBe('https://auth.kimi.ai/device?user_code=WXYZ-0001')
    // Let the background poll finish while fetch is still stubbed.
    expect((await waitForCompletion(service, started.loginId)).status).toBe('completed')
    expect(urls.length).toBeGreaterThan(1)
    expect(urls.every(url => url.startsWith('https://auth.kimi.ai/'))).toBe(true)
  })

  it('rejects a region that is not one of the two official endpoints, before any request', async () => {
    const urls = stubKimiAuth()
    await expect(createProvidersService().startOAuthLogin({
      providerType: 'kimi-coding-oauth', name: 'Kimi Code', enabledModels: ['k3'], baseUrl: 'https://proxy.example.invalid/coding',
    })).rejects.toBeInstanceOf(ProvidersValidationError)
    expect(urls).toEqual([])
  })

  it('the API-key kimi-coding type has no OAuth login', async () => {
    await expect(createProvidersService().startOAuthLogin({
      providerType: 'kimi-coding', name: 'Kimi Code', enabledModels: ['k3'],
    })).rejects.toBeInstanceOf(ProvidersValidationError)
  })
})

describe('"Renew token" only into an entry of the same type (review finding 2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const ANTHROPIC_ACCESS = 'sk-ant-oat01-svc'

  function anthropicEntry() {
    return addOAuthProvider({
      name: 'Claude', providerType: 'anthropic-oauth', enabledModels: ['claude-sonnet-4-5'],
      oauthCredentials: { access: ANTHROPIC_ACCESS, refresh: 'sk-ant-ort01-refresh', expires: Date.now() + 3_600_000 },
    })
  }

  it('kimi-coding-oauth login with the id of an anthropic-oauth entry is rejected, nothing is requested or written', async () => {
    const target = anthropicEntry()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(createProvidersService().startOAuthLogin({
      providerType: 'kimi-coding-oauth', name: 'Claude', enabledModels: ['k3'], providerId: target.id,
    })).rejects.toBeInstanceOf(ProvidersValidationError)
    expect(fetchSpy).not.toHaveBeenCalled()
    const after = loadProvidersDecrypted().providers.find(p => p.id === target.id)
    expect(after?.providerType).toBe('anthropic-oauth')
    expect(after?.oauthCredentials?.access).toBe(ANTHROPIC_ACCESS)
  })

  it('anthropic-oauth login with the id of a kimi-coding-oauth entry is rejected as well', async () => {
    const target = addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: 'https://api.kimi.com/coding',
      oauthCredentials: { access: 'kimi-access', refresh: 'kimi-refresh', expires: Date.now() + 3_600_000, region: 'cn' },
    })
    await expect(createProvidersService().startOAuthLogin({
      providerType: 'anthropic-oauth', name: 'Kimi Code', enabledModels: ['claude-sonnet-4-5'], providerId: target.id,
    })).rejects.toThrow(/is of type kimi-coding-oauth, not anthropic-oauth/)
  })

  it('an unknown provider id is a not-found, not a silent new entry', async () => {
    await expect(createProvidersService().startOAuthLogin({
      providerType: 'kimi-coding-oauth', name: 'Kimi Code', enabledModels: ['k3'], providerId: 'does-not-exist',
    })).rejects.toBeInstanceOf(ProvidersNotFoundError)
  })

  it('a type change while the login runs discards the new token instead of writing it into the changed entry', async () => {
    const target = addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: 'https://api.kimi.com/coding',
      oauthCredentials: { access: 'old', refresh: 'old-r', expires: Date.now() - 1000, region: 'cn' },
    })
    let releaseToken!: () => void
    const tokenGate = new Promise<void>(resolve => { releaseToken = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.endsWith('/device_authorization')) {
        return new Response(JSON.stringify({ device_code: 'dev', user_code: 'U-1', verification_uri: 'https://auth.kimi.com/device', interval: 0.001, expires_in: 60 }), { status: 200 })
      }
      await tokenGate
      return new Response(JSON.stringify({ access_token: 'new-kimi-access', refresh_token: 'new-kimi-refresh', expires_in: 3600 }), { status: 200 })
    }))
    const service = createProvidersService()
    const started = await service.startOAuthLogin({ providerType: 'kimi-coding-oauth', name: 'Kimi Code', enabledModels: ['k3'], providerId: target.id })
    updateProvider(target.id, { providerType: 'anthropic-oauth' })
    releaseToken()
    let status = await service.getOAuthStatus(started.loginId)
    for (let i = 0; i < 200 && status.status === 'pending'; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
      status = await service.getOAuthStatus(started.loginId)
    }
    expect(status.status).toBe('error')
    const after = loadProvidersDecrypted().providers.find(p => p.id === target.id)
    expect(after?.providerType).toBe('anthropic-oauth')
    expect(after?.oauthCredentials).toBeUndefined()
  })
})

describe('device login lifetime follows the device code (review finding 4)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('pendingOAuthLoginTtlMs: expires_in (capped at 15 min) plus 2 min buffer, never below 10 min', () => {
    expect(pendingOAuthLoginTtlMs()).toBe(DEFAULT_PENDING_OAUTH_LOGIN_TTL_MS)
    expect(pendingOAuthLoginTtlMs(Number.NaN)).toBe(10 * 60_000)
    expect(pendingOAuthLoginTtlMs(0)).toBe(10 * 60_000)
    expect(pendingOAuthLoginTtlMs(60)).toBe(10 * 60_000)
    expect(pendingOAuthLoginTtlMs(600)).toBe(12 * 60_000)
    expect(pendingOAuthLoginTtlMs(900)).toBe(17 * 60_000)
    expect(pendingOAuthLoginTtlMs(86_400)).toBe(17 * 60_000)
  })

  it('a 15-minute device code is still pending after 11 minutes and gone after its lifetime', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'Date'] })
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      const body = url.endsWith('/device_authorization')
        ? { device_code: 'dev', user_code: 'U-2', verification_uri: 'https://auth.kimi.ai/device', interval: 5, expires_in: 900 }
        : { error: 'authorization_pending' }
      return new Response(JSON.stringify(body), { status: url.endsWith('/device_authorization') ? 200 : 400 })
    }))
    const service = createProvidersService()
    const started = await service.startOAuthLogin({ providerType: 'kimi-coding-oauth', name: 'Kimi Code', enabledModels: ['k3'], baseUrl: 'https://api.kimi.ai/coding' })
    expect(started.expiresInSeconds).toBe(900)

    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect((await service.getOAuthStatus(started.loginId)).status).toBe('pending')

    await vi.advanceTimersByTimeAsync(7 * 60_000)
    await expect(service.getOAuthStatus(started.loginId)).rejects.toBeInstanceOf(ProvidersNotFoundError)
  })

  it('a completed login is saved by the server even if nobody polls the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      const body = url.endsWith('/device_authorization')
        ? { device_code: 'dev', user_code: 'U-3', verification_uri: 'https://auth.kimi.com/device', interval: 0.001, expires_in: 900 }
        : { access_token: 'kimi-access-unpolled', refresh_token: 'kimi-refresh-unpolled', expires_in: 3600 }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    const service = createProvidersService()
    await service.startOAuthLogin({ providerType: 'kimi-coding-oauth', name: 'Kimi Unpolled', enabledModels: ['k3'], baseUrl: 'https://api.kimi.com/coding' })
    let saved
    for (let i = 0; i < 200 && !saved; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
      saved = loadProvidersDecrypted().providers.find(p => p.name === 'Kimi Unpolled')
    }
    expect(saved?.providerType).toBe('kimi-coding-oauth')
    expect(saved?.oauthCredentials?.access).toBe('kimi-access-unpolled')
    expect(saved?.baseUrl).toBe('https://api.kimi.com/coding')
  })
})
