/**
 * Live model discovery for the Kimi Code plan: a mocked
 * `GET {region}/coding/v1/models` answer flows into knownModels, the live
 * cache and buildModel(); thinking-only models never get "thinking disabled".
 * No real network: every request goes to a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addOAuthProvider,
  buildModel,
  loadProviders,
  loadProvidersDecrypted,
  saveProviders,
  updateProvider,
} from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import { encrypt } from './encryption.js'
import { KIMI_CODING_OAUTH_MODEL_PROVIDER } from './kimi-coding-oauth.js'
import {
  getLiveModelEntry,
  parseKimiModelsResponse,
  resetLiveModelCache,
} from './kimi-live-models.js'
import {
  createLiveModelRefresher,
  listCatalogWithLiveModels,
  refreshProviderLiveModels,
} from './live-model-refresh.js'
import { completeSimple } from './pi-models.js'

const INTL = 'https://api.kimi.ai/coding'
const CN = 'https://api.kimi.com/coding'
const ACCESS = 'kimi-access-token'
const REFRESH = 'kimi-refresh-token'

function liveEntry(id: string, displayName: string, context: number, opts: { only?: boolean, image?: boolean } = {}) {
  return {
    id,
    object: 'model',
    display_name: displayName,
    context_length: context,
    supports_reasoning: true,
    ...(opts.only ? { supports_thinking_type: 'only' } : {}),
    think_efforts: { valid_efforts: ['low', 'high', 'max'], default_effort: 'high' },
    reasoning: { type: 'adaptive', effort: 'high' },
    modalities: { input: opts.image === false ? ['text'] : ['text', 'image'] },
    supports_image_in: opts.image !== false,
    supports_video_in: false,
    limit: { context },
  }
}

/** Shape of the answer seen on 2026-11-01 (intl region). */
const LIVE_ANSWER = {
  object: 'list',
  data: [
    liveEntry('kimi-for-coding', 'K2.8 Preview', 1_048_576),
    liveEntry('kimi-for-coding-highspeed', 'K2.7 Code Highspeed', 262_144),
    liveEntry('k3', 'Kimi K3', 1_048_576),
    liveEntry('k3-256k', 'Kimi K3-256K', 262_144),
    liveEntry('k3.1-pro', 'Kimi K3.1 Pro', 1_048_576, { only: true }),
    liveEntry('k3.1-pro-highspeed', 'Kimi K3.1 Pro Highspeed', 1_048_576, { only: true }),
  ],
}

let tmpDir: string
const originalDataDir = process.env.DATA_DIR

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function modelsFetch(body: unknown = LIVE_ANSWER, status = 200) {
  return vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse(status, body))
}

function silentLogger() {
  return { log: vi.fn(), warn: vi.fn() }
}

function addKimiOAuth(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  const created = addOAuthProvider({
    name: 'Kimi_Subscription', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL,
    oauthCredentials: { access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000, region: 'intl' },
  })
  if (Object.keys(extra).length > 0) {
    const file = loadProviders()
    const entry = file.providers.find(p => p.id === created.id)!
    Object.assign(entry, extra)
    saveProviders(file)
  }
  return created
}

function stored(id: string): ProviderConfig {
  return loadProvidersDecrypted().providers.find(p => p.id === id)!
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-live-models-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify({ providers: [] }), 'utf-8')
  process.env.DATA_DIR = tmpDir
  resetLiveModelCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetLiveModelCache()
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
  else delete process.env.DATA_DIR
})

describe('parseKimiModelsResponse', () => {
  it('maps the live fields (name, context, reasoning, efforts, thinking-only, images)', () => {
    const models = parseKimiModelsResponse(LIVE_ANSWER)
    expect(models.map(m => m.id)).toEqual(LIVE_ANSWER.data.map(d => d.id))
    expect(models.find(m => m.id === 'k3.1-pro')).toEqual({
      id: 'k3.1-pro',
      name: 'Kimi K3.1 Pro',
      contextWindow: 1_048_576,
      reasoning: true,
      thinkingOnly: true,
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      imageInput: true,
    })
    expect(models.find(m => m.id === 'k3')?.thinkingOnly).toBe(false)
  })

  it('throws on a body without a data array and skips malformed entries', () => {
    expect(() => parseKimiModelsResponse({ error: 'nope' })).toThrow(/no data array/)
    const models = parseKimiModelsResponse({ data: [{ id: '' }, null, 'x', { id: 'a' }, { id: 'a' }, { id: 'b', limit: { context: 4096 }, supports_image_in: false }] })
    expect(models).toEqual([
      { id: 'a', name: 'a', contextWindow: undefined, reasoning: false, thinkingOnly: false, imageInput: false },
      { id: 'b', name: 'b', contextWindow: 4096, reasoning: false, thinkingOnly: false, imageInput: false },
    ])
  })
})

describe('refreshProviderLiveModels (kimi-coding-oauth)', () => {
  it('k3.1-pro from a mocked /coding/v1/models lands in knownModels and buildModel returns a thinking-only model', async () => {
    // Existing provider with a baseline: knownModels = the bundled catalog.
    const created = addKimiOAuth({ knownModels: ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'] })
    const fetchImpl = modelsFetch()

    const result = await refreshProviderLiveModels(created.id, { fetchImpl, logger: silentLogger() })

    expect(result.ok).toBe(true)
    // One request, to the region's coding endpoint, with the stored token as Bearer.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${INTL}/v1/models`)
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS}`)

    const provider = stored(created.id)
    expect(provider.knownModels).toEqual(expect.arrayContaining(['k3.1-pro', 'k3.1-pro-highspeed']))
    expect(result.newlyKnown).toEqual(['k3.1-pro', 'k3.1-pro-highspeed'])
    // Nothing copied into provider.models: that stays the user override.
    expect(provider.models ?? []).toEqual([])

    const model = buildModel(provider, 'k3.1-pro') as ReturnType<typeof buildModel> & { thinkingLevelMap?: Record<string, string | null> }
    expect(model.id).toBe('k3.1-pro')
    expect(model.name).toBe('Kimi K3.1 Pro')
    expect(model.provider).toBe(KIMI_CODING_OAUTH_MODEL_PROVIDER)
    expect(model.api).toBe('anthropic-messages')
    expect(model.baseUrl).toBe(INTL)
    expect(model.contextWindow).toBe(1_048_576)
    expect(model.reasoning).toBe(true)
    expect(model.input).toEqual(['text', 'image'])
    expect(model.compat).toMatchObject({ forceAdaptiveThinking: true })
    expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' })
  })

  it('auto-enables new live ids like syncNewCatalogModels (appended, default stays first)', async () => {
    const created = addKimiOAuth({ knownModels: ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'] })
    const result = await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(), logger: silentLogger() })
    expect(result.enabled).toEqual(['k3.1-pro', 'k3.1-pro-highspeed'])
    expect(stored(created.id).enabledModels).toEqual(['k3', 'k3.1-pro', 'k3.1-pro-highspeed'])
  })

  it('without knownModels it only records a baseline and enables nothing (first-seen rule)', async () => {
    const created = addKimiOAuth()
    expect(stored(created.id).knownModels).toBeUndefined()
    const result = await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(), logger: silentLogger() })
    expect(result.enabled).toEqual([])
    const provider = stored(created.id)
    expect(provider.enabledModels).toEqual(['k3'])
    expect(provider.knownModels).toEqual(expect.arrayContaining(['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed', 'k3.1-pro', 'k3.1-pro-highspeed']))
  })

  it('hand-made entries (models + enabledModels + knownModels) stay user overrides, no duplicates', async () => {
    const override = {
      id: 'k3.1-pro', name: 'K3.1 Pro (manual)', reasoning: true, contextWindow: 1_048_576, maxTokens: 131072,
      compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    const created = addKimiOAuth({
      enabledModels: ['kimi-for-coding', 'k3.1-pro', 'k3.1-pro-highspeed'],
      knownModels: ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed', 'k3.1-pro', 'k3.1-pro-highspeed'],
      models: [override, { ...override, id: 'k3.1-pro-highspeed', name: 'K3.1 Pro HS (manual)' }],
    } as Partial<ProviderConfig>)
    const before = stored(created.id)

    const result = await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(), logger: silentLogger() })
    expect(result.ok).toBe(true)
    expect(result.newlyKnown).toEqual([])

    const provider = stored(created.id)
    expect(provider.enabledModels).toEqual(before.enabledModels)
    expect(provider.knownModels).toEqual(before.knownModels)
    expect(provider.models).toEqual(before.models)
    // The override wins over the live metadata.
    const model = buildModel(provider, 'k3.1-pro')
    expect(model.name).toBe('K3.1 Pro (manual)')
    expect(model.provider).toBe(KIMI_CODING_OAUTH_MODEL_PROVIDER)
    expect(model.baseUrl).toBe(INTL)
    expect((model as { thinkingLevelMap?: Record<string, unknown> }).thinkingLevelMap?.off).toBeNull()
  })

  it('catalog metadata wins over live metadata for catalog models', async () => {
    const created = addKimiOAuth({ knownModels: ['k3'] })
    const renamed = { data: [{ ...liveEntry('k3', 'Live K3 name', 4096) }] }
    await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(renamed), logger: silentLogger() })
    const model = buildModel(stored(created.id), 'k3')
    expect(model.name).toBe('Kimi K3')
    expect(model.contextWindow).toBe(1_048_576)
  })

  it('a failed request logs one line and leaves providers.json and the live list unchanged', async () => {
    const created = addKimiOAuth({ knownModels: ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'] })
    await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(), logger: silentLogger() })
    const providersBefore = fs.readFileSync(path.join(tmpDir, 'config', 'providers.json'), 'utf-8')
    const liveBefore = getLiveModelEntry(created.id)

    const logger = silentLogger()
    const result = await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch({ error: 'boom' }, 503), logger })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/HTTP 503/)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0][0])).not.toContain('\n')
    expect(String(logger.warn.mock.calls[0][0])).not.toContain(ACCESS)
    expect(fs.readFileSync(path.join(tmpDir, 'config', 'providers.json'), 'utf-8')).toBe(providersBefore)
    expect(getLiveModelEntry(created.id)).toEqual(liveBefore)

    // A 200 with garbage or an empty list is a failure too.
    expect((await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch({ data: [] }), logger })).ok).toBe(false)
    expect((await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch('nope'), logger })).ok).toBe(false)
    expect(getLiveModelEntry(created.id)).toEqual(liveBefore)
  })

  it('a model that vanishes from the live list is kept everywhere and keeps resolving', async () => {
    const created = addKimiOAuth({ knownModels: ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'] })
    await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(), logger: silentLogger() })
    const without = { data: LIVE_ANSWER.data.filter(d => d.id !== 'k3.1-pro') }
    const logger = silentLogger()
    const result = await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(without), logger })
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual(['k3.1-pro'])
    expect(logger.warn).toHaveBeenCalledTimes(1)

    const provider = stored(created.id)
    expect(provider.knownModels).toContain('k3.1-pro')
    expect(provider.enabledModels).toContain('k3.1-pro')
    expect(getLiveModelEntry(created.id)?.models.find(m => m.id === 'k3.1-pro')?.missingSince).toBeTruthy()
    expect(buildModel(provider, 'k3.1-pro').name).toBe('Kimi K3.1 Pro')

    // It comes back: flag cleared, not "new" again.
    const back = await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(), logger: silentLogger() })
    expect(back.newlyKnown).toEqual([])
    expect(getLiveModelEntry(created.id)?.models.find(m => m.id === 'k3.1-pro')?.missingSince).toBeUndefined()
  })

  it('concurrent refreshes of one provider share one request', async () => {
    const created = addKimiOAuth()
    const fetchImpl = modelsFetch()
    const [a, b] = await Promise.all([
      refreshProviderLiveModels(created.id, { fetchImpl, logger: silentLogger() }),
      refreshProviderLiveModels(created.id, { fetchImpl, logger: silentLogger() }),
    ])
    expect(a).toBe(b)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('an expired token is refreshed only through getApiKeyForProvider (one token request, then /v1/models with the new token)', async () => {
    const created = addOAuthProvider({
      name: 'Kimi', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL,
      oauthCredentials: { access: 'old-access', refresh: REFRESH, expires: Date.now() - 1000, region: 'intl' },
    })
    const tokenFetch = vi.fn(async () => jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer' }))
    vi.stubGlobal('fetch', tokenFetch)
    const fetchImpl = modelsFetch()
    const result = await refreshProviderLiveModels(created.id, { fetchImpl, logger: silentLogger() })
    expect(result.ok).toBe(true)
    expect(tokenFetch).toHaveBeenCalledTimes(1)
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer new-access')
  })

  it('a sign-in that needs renewal fails the refresh in one line, nothing changes', async () => {
    const created = addOAuthProvider({
      name: 'Kimi', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL,
      oauthCredentials: { access: 'old-access', refresh: REFRESH, expires: Date.now() - 1000, region: 'intl' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'invalid_grant' })))
    const fetchImpl = modelsFetch()
    const logger = silentLogger()
    const result = await refreshProviderLiveModels(created.id, { fetchImpl, logger })
    expect(result.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(getLiveModelEntry(created.id)).toBeUndefined()
  })
})

describe('API-key kimi-coding provider', () => {
  it('uses the same endpoint with the plan key as Bearer', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify({ providers: [{
      id: 'kc-key', name: 'Kimi Code', type: 'anthropic-messages', providerType: 'kimi-coding', provider: 'kimi-coding',
      baseUrl: CN, apiKey: encrypt('sk-plan-key'), enabledModels: ['k3'], knownModels: ['k3'], degradedThresholdMs: 5000, status: 'untested', authMethod: 'api-key',
    }] }), 'utf-8')
    const fetchImpl = modelsFetch()
    const result = await refreshProviderLiveModels('kc-key', { fetchImpl, logger: silentLogger() })
    expect(result.ok).toBe(true)
    expect(fetchImpl.mock.calls[0][0]).toBe(`${CN}/v1/models`)
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer sk-plan-key')
    const model = buildModel(stored('kc-key'), 'k3.1-pro')
    expect(model.provider).toBe('kimi-coding')
    expect(model.baseUrl).toBe(CN)
    expect((model as { thinkingLevelMap?: Record<string, unknown> }).thinkingLevelMap?.off).toBeNull()
  })
})

describe('thinking=off on the wire', () => {
  async function captureBody(provider: ProviderConfig, modelId: string): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      return new Response('{"type":"error","error":{"message":"captured"}}', { status: 500, headers: { 'content-type': 'application/json' } })
    }))
    await completeSimple(buildModel(provider, modelId), { messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }] }, { apiKey: ACCESS } as never)
    expect(captured).toBeDefined()
    return captured!
  }

  it('k3 (catalog, off → null) and live k3.1-pro send no thinking field at all', async () => {
    const created = addKimiOAuth({ knownModels: ['k3'] })
    await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(), logger: silentLogger() })
    const provider = stored(created.id)
    expect((await captureBody(provider, 'k3')).thinking).toBeUndefined()
    expect((await captureBody(provider, 'k3.1-pro')).thinking).toBeUndefined()
  })

  it('a hand-made k3.1-pro override without thinkingLevelMap still never sends "disabled"', async () => {
    // `reasoning: true` without a map is exactly what made pi-ai send
    // `thinking: {type: "disabled"}` (see the control case below).
    const created = addKimiOAuth({ models: [{ id: 'k3.1-pro', reasoning: true }, { id: 'some-other-model', reasoning: true }] } as Partial<ProviderConfig>)
    // No live refresh yet: the documented thinking-only family covers it.
    const provider = stored(created.id)
    const model = buildModel(provider, 'k3.1-pro') as ReturnType<typeof buildModel> & { thinkingLevelMap?: Record<string, string | null> }
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap?.off).toBeNull()
    const body = await captureBody(provider, 'k3.1-pro')
    expect(body.thinking).toBeUndefined()
    // Control: a model that is not thinking-only keeps pi-ai's behavior.
    expect((await captureBody(provider, 'some-other-model')).thinking).toEqual({ type: 'disabled' })
  })
})

describe('Add Model dialog list and the periodic refresher', () => {
  it('lists the catalog plus live-only models with their live name and context', async () => {
    const created = addKimiOAuth({ knownModels: ['k3'] })
    await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(), logger: silentLogger() })
    const list = listCatalogWithLiveModels(stored(created.id))
    const ids = list.map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(list.find(m => m.id === 'k3.1-pro')).toEqual({ id: 'k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1_048_576 })
    expect(list.find(m => m.id === 'k3')?.name).toBe('Kimi K3')
  })

  it('refreshNow walks every live-model provider and skips the others', async () => {
    const created = addKimiOAuth({ knownModels: ['k3'] })
    const file = loadProviders()
    file.providers.push({ ...file.providers[0], id: 'other', name: 'Other', providerType: 'anthropic', authMethod: 'api-key' } as ProviderConfig)
    saveProviders(file)
    const fetchImpl = modelsFetch()
    const refresher = createLiveModelRefresher({ fetchImpl, logger: silentLogger(), intervalMs: 60_000 })
    const results = await refresher.refreshNow()
    expect(results.map(r => r.providerId)).toEqual([created.id])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    refresher.stop()
  })
})

/** fetch mock whose answers wait until `release()`; records every call. */
function deferredModelsFetch() {
  const releases: Array<() => void> = []
  let calls = 0
  let notify: (() => void) | null = null
  const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => {
    calls += 1
    notify?.()
    await new Promise<void>(resolve => releases.push(resolve))
    return jsonResponse(200, LIVE_ANSWER)
  })
  const called = (n: number) => new Promise<void>(resolve => {
    const check = () => { if (calls >= n) resolve(); else notify = check }
    check()
  })
  return { fetchImpl, called, releaseAll: () => releases.splice(0).forEach(r => r()) }
}

let keyProviderSeq = 0
function addKimiKey(apiKey: string, baseUrl = CN): string {
  const id = `kc-key-${++keyProviderSeq}`
  const file = loadProviders()
  file.providers.push({
    id, name: `Kimi Code ${id}`, type: 'anthropic-messages', providerType: 'kimi-coding', provider: 'kimi-coding',
    baseUrl, apiKey: encrypt(apiKey), enabledModels: ['k3'], knownModels: ['k3'], degradedThresholdMs: 5000, status: 'untested', authMethod: 'api-key',
  } as ProviderConfig)
  saveProviders(file)
  return id
}

describe('review 2026-11: stale answers, generations, shared refresh tokens', () => {
  it('two Kimi providers with the same stored sign-in, refreshed in parallel, present the refresh token once', async () => {
    const creds = { access: 'twin-old-access', refresh: 'twin-refresh-0', expires: Date.now() - 1000, region: 'intl' as const }
    const a = addOAuthProvider({ name: 'Kimi A', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL, oauthCredentials: { ...creds } })
    const b = addOAuthProvider({ name: 'Kimi B', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL, oauthCredentials: { ...creds } })
    const presented: string[] = []
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      const token = new URLSearchParams(body).get('refresh_token') ?? (body.includes('twin-refresh-0') ? 'twin-refresh-0' : body)
      presented.push(token)
      await new Promise(resolve => setTimeout(resolve, 5))
      n += 1
      return jsonResponse(200, { access_token: `twin-new-access-${n}`, refresh_token: `twin-refresh-${n}`, expires_in: 3600, token_type: 'Bearer' })
    }))
    const fetchImpl = modelsFetch()
    const [ra, rb] = await Promise.all([
      refreshProviderLiveModels(a.id, { fetchImpl, logger: silentLogger() }),
      refreshProviderLiveModels(b.id, { fetchImpl, logger: silentLogger() }),
    ])
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    expect(presented).toEqual(['twin-refresh-0'])
    expect(stored(a.id).oauthCredentials?.refresh).toBe('twin-refresh-1')
    expect(stored(b.id).oauthCredentials?.refresh).toBe('twin-refresh-1')
    const auths = fetchImpl.mock.calls.map(c => (c[1]?.headers as Record<string, string>).Authorization)
    expect(auths).toEqual(['Bearer twin-new-access-1', 'Bearer twin-new-access-1'])
  })

  it('a type switch to anthropic during the request discards the answer (no k3.1-pro in knownModels/enabledModels, no cache)', async () => {
    const created = addKimiOAuth({ knownModels: ['k3'] })
    const deferred = deferredModelsFetch()
    const logger = silentLogger()
    const running = refreshProviderLiveModels(created.id, { fetchImpl: deferred.fetchImpl, logger })
    await deferred.called(1)
    updateProvider(created.id, { providerType: 'anthropic', apiKey: 'sk-ant-test' })
    deferred.releaseAll()
    const result = await running
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/changed during the request/)
    const after = stored(created.id)
    expect(after.providerType).toBe('anthropic')
    expect(after.knownModels ?? []).not.toContain('k3.1-pro')
    expect(after.enabledModels).not.toContain('k3.1-pro')
    expect(getLiveModelEntry(created.id)).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('a key change during a running request starts a new request with the new key; the old answer is discarded', async () => {
    const id = addKimiKey('sk-old-key')
    const deferred = deferredModelsFetch()
    const first = refreshProviderLiveModels(id, { fetchImpl: deferred.fetchImpl, logger: silentLogger() })
    await deferred.called(1)
    updateProvider(id, { apiKey: 'sk-new-key' })
    const second = refreshProviderLiveModels(id, { fetchImpl: deferred.fetchImpl, logger: silentLogger() })
    expect(second).not.toBe(first)
    await deferred.called(2)
    deferred.releaseAll()
    const [r1, r2] = await Promise.all([first, second])
    const auths = deferred.fetchImpl.mock.calls.map(c => (c[1]?.headers as Record<string, string>).Authorization)
    expect(auths).toEqual(['Bearer sk-old-key', 'Bearer sk-new-key'])
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(true)
    expect(stored(id).knownModels).toContain('k3.1-pro')
  })

  it('a region change during a running request asks the new region instead of joining the old request', async () => {
    const id = addKimiKey('sk-plan-key', CN)
    const deferred = deferredModelsFetch()
    const first = refreshProviderLiveModels(id, { fetchImpl: deferred.fetchImpl, logger: silentLogger() })
    await deferred.called(1)
    updateProvider(id, { baseUrl: INTL, apiKey: 'sk-plan-key' })
    const second = refreshProviderLiveModels(id, { fetchImpl: deferred.fetchImpl, logger: silentLogger() })
    await deferred.called(2)
    deferred.releaseAll()
    const [r1, r2] = await Promise.all([first, second])
    expect(deferred.fetchImpl.mock.calls.map(c => c[0])).toEqual([`${CN}/v1/models`, `${INTL}/v1/models`])
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(true)
  })

  it('the same source still shares one request (no regression of the coalescing)', async () => {
    const id = addKimiKey('sk-plan-key')
    const deferred = deferredModelsFetch()
    const first = refreshProviderLiveModels(id, { fetchImpl: deferred.fetchImpl, logger: silentLogger() })
    const second = refreshProviderLiveModels(id, { fetchImpl: deferred.fetchImpl, logger: silentLogger() })
    expect(second).toBe(first)
    await deferred.called(1)
    deferred.releaseAll()
    expect((await first).ok).toBe(true)
    expect(deferred.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('an unreadable providers.json resolves with one warning instead of rejecting', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), '{ not json', 'utf-8')
    const logger = silentLogger()
    const fetchImpl = modelsFetch()
    const result = await refreshProviderLiveModels('whatever', { fetchImpl, logger })
    expect(result.ok).toBe(false)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('metadata precedence contract (docs/guide/models.md "Metadata precedence")', () => {
  it('provider.models is ignored for the catalog id k3 but wins over the live data for the live-only k3.1-pro', async () => {
    const created = addKimiOAuth({
      knownModels: ['k3'],
      models: [
        { id: 'k3', name: 'My K3', contextWindow: 4096 },
        { id: 'k3.1-pro', name: 'My K3.1 Pro', contextWindow: 8192, reasoning: true },
      ],
    } as Partial<ProviderConfig>)
    const result = await refreshProviderLiveModels(created.id, { fetchImpl: modelsFetch(), logger: silentLogger() })
    expect(result.ok).toBe(true)
    const provider = stored(created.id)
    const k3 = buildModel(provider, 'k3')
    expect(k3.name).not.toBe('My K3')
    expect(k3.contextWindow).not.toBe(4096)
    const pro = buildModel(provider, 'k3.1-pro')
    expect(pro.name).toBe('My K3.1 Pro')
    expect(pro.contextWindow).toBe(8192)
    expect(pro.thinkingLevelMap?.off).toBeNull()
  })
})
