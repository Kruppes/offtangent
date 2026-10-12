/**
 * Credentials are bound to the provider type and (for Kimi Code OAuth) to the
 * region that issued them. Regression tests for review findings 1, 3 and 5
 * (2026-10-12): a type change must never carry an old token to a new host, a
 * token missing its region is never routed by the editable base URL, and
 * transport errors never echo token material. No real network: fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addOAuthProvider,
  addProvider,
  buildModel,
  getApiKeyForProvider,
  loadProvidersDecrypted,
  recoverOAuthAfterAuthFailure,
  updateProvider,
} from './provider-config.js'
import { encrypt } from './encryption.js'
import { KimiCodingReloginRequiredError, createKimiCodingOAuth } from './kimi-coding-oauth.js'
import { getKimiCodingQuotaForProvider, resetKimiQuotaState } from './kimi-coding-quota.js'

const CN = 'https://api.kimi.com/coding'
const INTL = 'https://api.kimi.ai/coding'
const ANTHROPIC_ACCESS = 'sk-' + 'ant-oat01-anthropic-access-token-must-not-travel'
const ANTHROPIC_REFRESH = 'sk-' + 'ant-ort01-anthropic-refresh-token-must-not-travel'
const KIMI_ACCESS = 'kimi-access-token-must-not-travel-anywhere'
const KIMI_REFRESH = 'kimi-refresh-token-must-not-travel-anywhere'
const PLAN_KEY = 'sk-' + 'kimi-plan-key-must-not-travel'

let tmpDir: string
const originalDataDir = process.env.DATA_DIR

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-cred-binding-'))
  const configDir = path.join(tmpDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'providers.json'), JSON.stringify({ providers: [] }, null, 2), 'utf-8')
  process.env.DATA_DIR = tmpDir
  resetKimiQuotaState()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
  else delete process.env.DATA_DIR
})

function reload(id: string) {
  const provider = loadProvidersDecrypted().providers.find(p => p.id === id)
  if (!provider) throw new Error(`provider ${id} missing`)
  return provider
}

/** fetch spy that records every request (URL + Authorization/x-api-key + body). */
function recordingFetch() {
  const seen: string[] = []
  const fn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seen.push([String(input), headers.get('authorization') ?? '', headers.get('x-api-key') ?? '', String(init?.body ?? '')].join(' | '))
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
  })
  return { fn, seen }
}

describe('finding 1: a providerType change drops credentials of the old type', () => {
  it('anthropic-oauth → kimi-coding-oauth: no Anthropic token reaches any request', async () => {
    const created = addOAuthProvider({
      name: 'Claude', providerType: 'anthropic-oauth', enabledModels: ['claude-sonnet-4-5'],
      oauthCredentials: { access: ANTHROPIC_ACCESS, refresh: ANTHROPIC_REFRESH, expires: Date.now() + 3_600_000 },
    })
    const updated = updateProvider(created.id, { providerType: 'kimi-coding-oauth', baseUrl: CN, enabledModels: ['k3'] })
    expect(updated?.oauthCredentials).toBeUndefined()
    expect(updated?.authMethod).toBe('oauth')

    const { fn, seen } = recordingFetch()
    vi.stubGlobal('fetch', fn)
    const provider = reload(created.id)
    expect(provider.oauthCredentials).toBeUndefined()
    await expect(getApiKeyForProvider(provider)).rejects.toThrow(/not signed in|Renew token/)
    await getKimiCodingQuotaForProvider(provider, fn as unknown as typeof fetch)
    expect(await recoverOAuthAfterAuthFailure(created.id)).toBe(false)
    expect(seen.join('\n')).not.toContain(ANTHROPIC_ACCESS)
    expect(seen.join('\n')).not.toContain(ANTHROPIC_REFRESH)
    expect(fs.readFileSync(path.join(tmpDir, 'config', 'providers.json'), 'utf-8')).not.toContain('"oauthCredentials"')
  })

  it('kimi-coding-oauth → anthropic-oauth: no Kimi token reaches any request', async () => {
    const created = addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL,
      oauthCredentials: { access: KIMI_ACCESS, refresh: KIMI_REFRESH, expires: Date.now() - 1000, region: 'intl' },
    })
    updateProvider(created.id, { providerType: 'anthropic-oauth', enabledModels: ['claude-sonnet-4-5'] })

    const { fn, seen } = recordingFetch()
    vi.stubGlobal('fetch', fn)
    const provider = reload(created.id)
    expect(provider.providerType).toBe('anthropic-oauth')
    expect(provider.oauthCredentials).toBeUndefined()
    // Expired Kimi token would otherwise be "refreshed" against Anthropic.
    await expect(getApiKeyForProvider(provider)).rejects.toThrow(/not signed in/)
    expect(fn).not.toHaveBeenCalled()
    expect(seen.join('\n')).not.toContain(KIMI_ACCESS)
    expect(seen.join('\n')).not.toContain(KIMI_REFRESH)
  })

  it('kimi-coding (API key) → kimi-coding-oauth: the plan key is dropped, not sent as Bearer', async () => {
    const created = addProvider({ name: 'Kimi Code', providerType: 'kimi-coding', apiKey: PLAN_KEY, enabledModels: ['k3'] })
    updateProvider(created.id, { providerType: 'kimi-coding-oauth', baseUrl: CN })

    const { fn, seen } = recordingFetch()
    vi.stubGlobal('fetch', fn)
    const provider = reload(created.id)
    expect(provider.apiKey).toBe('')
    expect(provider.authMethod).toBe('oauth')
    await expect(getApiKeyForProvider(provider)).rejects.toThrow(/not signed in/)
    const quota = await getKimiCodingQuotaForProvider(provider, fn as unknown as typeof fetch)
    expect(quota.quota).toBeNull()
    expect(fn).not.toHaveBeenCalled()
    expect(seen.join('\n')).not.toContain(PLAN_KEY)
  })

  it('a type change may bring its own API key; an unchanged type keeps credentials', () => {
    const created = addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: CN,
      oauthCredentials: { access: KIMI_ACCESS, refresh: KIMI_REFRESH, expires: Date.now() + 3_600_000, region: 'cn' },
    })
    // Same type, other fields: credentials stay.
    updateProvider(created.id, { name: 'Kimi Code (renamed)', providerType: 'kimi-coding-oauth' })
    expect(reload(created.id).oauthCredentials?.access).toBe(KIMI_ACCESS)

    updateProvider(created.id, { providerType: 'kimi-coding', apiKey: 'sk-new-plan-key' })
    const provider = reload(created.id)
    expect(provider.oauthCredentials).toBeUndefined()
    expect(provider.apiKey).toBe('sk-new-plan-key')
    expect(provider.authMethod ?? 'api-key').toBe('api-key')
  })
})

describe('finding 5: the token region is authoritative, never the editable URL', () => {
  function storeWithoutRegion(baseUrl: string): string {
    // Legacy/foreign credential without region in the encrypted extra blob.
    const id = 'kimi-no-region'
    fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify({ providers: [{
      id, name: 'Kimi Code', type: 'anthropic-messages', providerType: 'kimi-coding-oauth', provider: 'kimi-coding-oauth',
      baseUrl, apiKey: '', enabledModels: ['k3'], degradedThresholdMs: 5000, status: 'untested', authMethod: 'oauth',
      oauthCredentials: { access: encrypt(KIMI_ACCESS), refresh: encrypt(KIMI_REFRESH), expires: Date.now() + 3_600_000 },
    }] }, null, 2), 'utf-8')
    return id
  }

  it.each([CN, INTL])('a credential without region demands a re-login (URL %s is not used to guess)', async (baseUrl) => {
    const id = storeWithoutRegion(baseUrl)
    const { fn, seen } = recordingFetch()
    vi.stubGlobal('fetch', fn)
    const err = await getApiKeyForProvider(reload(id)).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(KimiCodingReloginRequiredError)
    expect((err as Error).message).toMatch(/no region/)
    expect((err as Error).message).toMatch(/Renew token/)
    const quota = await getKimiCodingQuotaForProvider(reload(id), fn as unknown as typeof fetch)
    expect(quota).toMatchObject({ quota: null })
    expect(quota.error).toMatch(/Renew token/)
    expect(fn).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('refresh of a credential without region throws instead of picking a host', async () => {
    const auth = createKimiCodingOAuth('intl', { fetch: vi.fn() as unknown as typeof fetch })
    await expect(auth.refresh({ type: 'oauth', access: 'a', refresh: KIMI_REFRESH, expires: 0 }, new AbortController().signal))
      .rejects.toBeInstanceOf(KimiCodingReloginRequiredError)
    await expect(auth.toAuth({ type: 'oauth', access: KIMI_ACCESS, refresh: KIMI_REFRESH, expires: Date.now() + 1000 }))
      .rejects.toBeInstanceOf(KimiCodingReloginRequiredError)
  })

  it('a region change of a signed-in entry drops the token (no cross-region token)', async () => {
    const created = addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: CN,
      oauthCredentials: { access: KIMI_ACCESS, refresh: KIMI_REFRESH, expires: Date.now() + 3_600_000, region: 'cn' },
    })
    updateProvider(created.id, { baseUrl: INTL })
    const provider = reload(created.id)
    expect(provider.baseUrl).toBe(INTL)
    expect(provider.oauthCredentials).toBeUndefined()
    await expect(getApiKeyForProvider(provider)).rejects.toThrow(/not signed in/)
    expect(buildModel(provider, 'k3').baseUrl).toBe(INTL)
  })

  it('saving the same region (or a trailing slash) keeps the token', () => {
    const created = addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL,
      oauthCredentials: { access: KIMI_ACCESS, refresh: KIMI_REFRESH, expires: Date.now() + 3_600_000, region: 'intl' },
    })
    updateProvider(created.id, { baseUrl: `${INTL}/` })
    updateProvider(created.id, { baseUrl: INTL, name: 'still intl' })
    expect(reload(created.id).oauthCredentials?.access).toBe(KIMI_ACCESS)
  })
})

describe('finding 3: transport errors never carry token material', () => {
  function tokenEchoingFetch() {
    return vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      // A proxy/instrumented fetch that puts request details into the error.
      throw new TypeError(`fetch failed: ${headers.get('authorization') ?? ''} body=${String(init?.body ?? '')} ${KIMI_ACCESS} ${KIMI_REFRESH}`)
    })
  }

  it('refresh via getApiKeyForProvider: neither the error nor any log line contains a token', async () => {
    const created = addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: INTL,
      oauthCredentials: { access: KIMI_ACCESS, refresh: KIMI_REFRESH, expires: Date.now() - 1000, region: 'intl' },
    })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      vi.stubGlobal('fetch', tokenEchoingFetch())
      const logs: string[] = []
      for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
      }
      const pending = getApiKeyForProvider(reload(created.id)).catch((e: unknown) => e as Error)
      await vi.runAllTimersAsync()
      const err = await pending
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/network error/)
      expect((err as Error).message).not.toContain(KIMI_ACCESS)
      expect((err as Error).message).not.toContain(KIMI_REFRESH)
      expect(String((err as Error).stack ?? '')).not.toContain(KIMI_REFRESH)

      const recover = recoverOAuthAfterAuthFailure(created.id)
      await vi.runAllTimersAsync()
      await expect(recover).resolves.toBe(true)
      const joined = logs.join('\n')
      expect(joined).toContain('Forced OAuth refresh')
      expect(joined).not.toContain(KIMI_ACCESS)
      expect(joined).not.toContain(KIMI_REFRESH)
    } finally {
      vi.useRealTimers()
    }
  })

  it('quota: a fetch exception with the token in its message yields only a category', async () => {
    const created = addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: CN,
      oauthCredentials: { access: KIMI_ACCESS, refresh: KIMI_REFRESH, expires: Date.now() + 3_600_000, region: 'cn' },
    })
    const result = await getKimiCodingQuotaForProvider(reload(created.id), tokenEchoingFetch() as unknown as typeof fetch)
    expect(result.quota).toBeNull()
    expect(result.error).toMatch(/network error/)
    expect(JSON.stringify(result)).not.toContain(KIMI_ACCESS)
    expect(JSON.stringify(result)).not.toContain(KIMI_REFRESH)
  })

  it('quota: a credential error that echoes the token is redacted at the boundary', async () => {
    const created = addOAuthProvider({
      name: 'Kimi Code', providerType: 'kimi-coding-oauth', enabledModels: ['k3'], baseUrl: CN,
      oauthCredentials: { access: KIMI_ACCESS, refresh: KIMI_REFRESH, expires: Date.now() - 1000, region: 'cn' },
    })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      vi.stubGlobal('fetch', tokenEchoingFetch())
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const pending = getKimiCodingQuotaForProvider(reload(created.id), tokenEchoingFetch() as unknown as typeof fetch)
      await vi.runAllTimersAsync()
      const result = await pending
      expect(result.quota).toBeNull()
      expect(JSON.stringify(result)).not.toContain(KIMI_ACCESS)
      expect(JSON.stringify(result)).not.toContain(KIMI_REFRESH)
    } finally {
      vi.useRealTimers()
    }
  })
})
