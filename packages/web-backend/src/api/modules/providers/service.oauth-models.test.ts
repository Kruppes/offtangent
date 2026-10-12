import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Delegates to the real catalog; single tests override it to simulate a
// preset without any catalog model.
vi.mock('@axiom/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@axiom/core')>()
  return { ...actual, getAvailableModels: vi.fn(actual.getAvailableModels) }
})

import {
  addOAuthProvider,
  getAvailableModels,
  loadProviders,
  PROVIDER_TYPE_PRESETS,
  type ProviderType,
} from '@axiom/core'
import { createProvidersService, ProvidersValidationError } from './service.js'

let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
})

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-providers-oauth-models-'))
  process.env.DATA_DIR = tempDataDir
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(getAvailableModels).mockClear()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

/** Synthetic device-code flow: every request is answered locally. */
function stubDeviceAuth() {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    urls.push(url)
    const host = new URL(url).origin
    const body = url.endsWith('/device_authorization')
      ? { device_code: 'dev', user_code: 'TEST-0001', verification_uri_complete: `${host}/device?user_code=TEST-0001`, interval: 0.001, expires_in: 60 }
      : { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 }
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

describe('new OAuth provider never ends up without models', () => {
  it('every OAuth preset has a catalog model to fall back to', () => {
    const oauthTypes = Object.entries(PROVIDER_TYPE_PRESETS)
      .filter(([, preset]) => preset.authMethod === 'oauth')
      .map(([type]) => type as ProviderType)
    expect(oauthTypes.length).toBeGreaterThan(0)
    for (const type of oauthTypes) {
      expect(getAvailableModels(type).length, type).toBeGreaterThan(0)
    }
  })

  it('a login with an empty model list saves the preset\'s first catalog model', async () => {
    stubDeviceAuth()
    const service = createProvidersService()
    const started = await service.startOAuthLogin({
      providerType: 'kimi-coding-oauth', name: 'Kimi Sub', enabledModels: [], baseUrl: 'https://api.kimi.ai/coding',
    })
    const done = await waitForCompletion(service, started.loginId)
    expect(done.status).toBe('completed')
    if (done.status !== 'completed') return

    const expected = getAvailableModels('kimi-coding-oauth')[0]?.id
    expect(expected).toBeTruthy()
    expect(done.provider.enabledModels).toEqual([expected])
    const saved = loadProviders().providers.find(p => p.id === done.provider.id)
    expect(saved?.enabledModels).toEqual([expected])
  })

  it('a login with chosen models keeps exactly that choice', async () => {
    stubDeviceAuth()
    const service = createProvidersService()
    const started = await service.startOAuthLogin({
      providerType: 'kimi-coding-oauth', name: 'Kimi Sub', enabledModels: ['kimi-for-coding'], baseUrl: 'https://api.kimi.ai/coding',
    })
    const done = await waitForCompletion(service, started.loginId)
    expect(done.status).toBe('completed')
    if (done.status !== 'completed') return
    expect(done.provider.enabledModels).toEqual(['kimi-for-coding'])
  })

  it('without any catalog model the login is refused before a request leaves', async () => {
    const urls = stubDeviceAuth()
    vi.mocked(getAvailableModels).mockReturnValueOnce([])
    await expect(createProvidersService().startOAuthLogin({
      providerType: 'kimi-coding-oauth', name: 'Kimi Sub', enabledModels: [], baseUrl: 'https://api.kimi.ai/coding',
    })).rejects.toBeInstanceOf(ProvidersValidationError)
    expect(urls).toEqual([])
    expect(loadProviders().providers).toEqual([])
  })

  it('"Renew token" with an empty model list leaves the existing models untouched', async () => {
    const existing = addOAuthProvider({
      name: 'Kimi Sub',
      providerType: 'kimi-coding-oauth',
      enabledModels: ['kimi-for-coding', 'k3'],
      baseUrl: 'https://api.kimi.ai/coding',
      oauthCredentials: { access: 'old-access', refresh: 'old-refresh', expires: Date.now() - 1000, region: 'intl' },
    })
    stubDeviceAuth()
    const service = createProvidersService()
    const started = await service.startOAuthLogin({
      providerType: 'kimi-coding-oauth', name: 'Kimi Sub', enabledModels: [], providerId: existing.id,
    })
    expect((await waitForCompletion(service, started.loginId)).status).toBe('completed')
    expect(vi.mocked(getAvailableModels)).not.toHaveBeenCalled()
    const saved = loadProviders().providers.find(p => p.id === existing.id)
    expect(saved?.enabledModels).toEqual(['kimi-for-coding', 'k3'])
  })
})
