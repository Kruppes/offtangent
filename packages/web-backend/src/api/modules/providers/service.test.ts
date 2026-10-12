import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addOAuthProvider, addProvider, getAvailableModels } from '@axiom/core'
import {
  createProvidersService,
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
