/**
 * Compare-and-set for OAuth token refreshes (re-review 2026-10-12, finding
 * HOCH): a refresh that is still running while the provider entry changes
 * (type switch, region switch, credentials removed, new sign-in, deletion)
 * must neither persist nor hand out its rotated token. Every refresh here is a
 * controlled, paused promise; no real network (fetch is stubbed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import {
  OAuthCredentialsChangedError,
  addOAuthProvider,
  buildModel,
  deleteProvider,
  getApiKeyForProvider,
  loadProvidersDecrypted,
  refreshOAuthCredentialsLocked,
  updateOAuthCredentials,
  updateProvider,
} from './provider-config.js'

const CN = 'https://api.kimi.com/coding'
const INTL = 'https://api.kimi.ai/coding'
const HOUR = 3_600_000

let tmpDir: string
const originalDataDir = process.env.DATA_DIR

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-refresh-race-'))
  const configDir = path.join(tmpDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'providers.json'), JSON.stringify({ providers: [] }, null, 2), 'utf-8')
  process.env.DATA_DIR = tmpDir
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

/** An OAuthAuth whose refresh() pauses until `release()` is called. */
function pausedAuth(result: Omit<OAuthCredential, 'type'>) {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const refresh = vi.fn(async (): Promise<OAuthCredential> => {
    entered()
    await gate
    return { type: 'oauth', ...result } as OAuthCredential
  })
  const auth = { refresh, toAuth: async (c: OAuthCredential) => ({ apiKey: c.access }) } as unknown as OAuthAuth
  return { auth, refresh, started, release }
}

/** fetch spy that records every request (URL + Authorization/x-api-key). */
function recordingFetch() {
  const seen: string[] = []
  const fn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seen.push([String(input), headers.get('authorization') ?? '', headers.get('x-api-key') ?? ''].join(' | '))
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
  })
  return { fn, seen }
}

function addKimi(name: string, baseUrl: string, region: 'cn' | 'intl', access: string, expires = 0) {
  return addOAuthProvider({
    name, providerType: 'kimi-coding-oauth', baseUrl, enabledModels: ['k3'],
    oauthCredentials: { access, refresh: `${access}-REFRESH`, expires, region } as never,
  })
}

describe('refresh race: provider type change while a refresh is running', () => {
  it('kimi-coding-oauth → anthropic-oauth: nothing written, no Kimi token reaches api.anthropic.com, caller gets an error', async () => {
    const entry = addKimi('race', INTL, 'intl', 'KIMI_OLD_RACE_TOKEN')
    const paused = pausedAuth({ access: 'KIMI_NEW_RACE_TOKEN', refresh: 'KIMI_NEW_RACE_REFRESH', expires: Date.now() + HOUR, region: 'intl' } as never)
    const running = refreshOAuthCredentialsLocked(entry.id, paused.auth,
      { type: 'oauth', access: 'KIMI_OLD_RACE_TOKEN', refresh: 'KIMI_OLD_RACE_TOKEN-REFRESH', expires: 0, region: 'intl' } as OAuthCredential)
    await paused.started
    updateProvider(entry.id, { providerType: 'anthropic-oauth', enabledModels: ['claude-sonnet-4-5'] })
    paused.release()

    await expect(running).rejects.toBeInstanceOf(OAuthCredentialsChangedError)
    const after = reload(entry.id)
    expect(after.providerType).toBe('anthropic-oauth')
    expect(after.oauthCredentials).toBeUndefined()
    expect(JSON.stringify(after)).not.toContain('KIMI_NEW_RACE')

    // The Anthropic entry has no token at all: nothing goes to api.anthropic.com.
    const { fn, seen } = recordingFetch()
    vi.stubGlobal('fetch', fn)
    await expect(getApiKeyForProvider(after)).rejects.toThrow(/not signed in/)
    expect(buildModel(after, 'claude-sonnet-4-5').baseUrl).toContain('api.anthropic.com')
    expect(seen.join('\n')).not.toContain('KIMI_')
  })

  it('anthropic-oauth → kimi-coding-oauth: the rotated Anthropic token is discarded', async () => {
    const entry = addOAuthProvider({
      name: 'race', providerType: 'anthropic-oauth', enabledModels: ['claude-sonnet-4-5'],
      oauthCredentials: { access: 'RACE_ANTHROPIC_OLD_ACCESS', refresh: 'RACE_ANTHROPIC_OLD_REFRESH', expires: 0 },
    })
    const paused = pausedAuth({ access: 'RACE_ANTHROPIC_NEW_ACCESS', refresh: 'RACE_ANTHROPIC_NEW_REFRESH', expires: Date.now() + HOUR })
    const running = refreshOAuthCredentialsLocked(entry.id, paused.auth,
      { type: 'oauth', access: 'RACE_ANTHROPIC_OLD_ACCESS', refresh: 'RACE_ANTHROPIC_OLD_REFRESH', expires: 0 })
    await paused.started
    updateProvider(entry.id, { providerType: 'kimi-coding-oauth', baseUrl: CN, enabledModels: ['k3'] })
    paused.release()

    await expect(running).rejects.toThrow(/changed during the token refresh.*provider type changed/)
    const after = reload(entry.id)
    expect(after.oauthCredentials).toBeUndefined()
    expect(after.baseUrl).toBe(CN)
    expect(JSON.stringify(after)).not.toContain('RACE_ANTHROPIC')
    await expect(getApiKeyForProvider(after)).rejects.toThrow(/not signed in/)
  })

  it('end to end via getApiKeyForProvider: a paused Kimi refresh request yields no token after the switch', async () => {
    const entry = addKimi('e2e', INTL, 'intl', 'KIMI_E2E_OLD_ACCESS')
    const seen: string[] = []
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push(`${String(input)} | ${headers.get('authorization') ?? ''} | ${headers.get('x-api-key') ?? ''}`)
      entered()
      await gate
      return new Response(JSON.stringify({
        access_token: 'KIMI_E2E_NEW_ACCESS_TOKEN_VALUE', refresh_token: 'KIMI_E2E_NEW_REFRESH_TOKEN_VALUE', expires_in: 3600, token_type: 'Bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const pending = getApiKeyForProvider(reload(entry.id))
    await started
    updateProvider(entry.id, { providerType: 'anthropic-oauth', enabledModels: ['claude-sonnet-4-5'] })
    release()

    await expect(pending).rejects.toBeInstanceOf(OAuthCredentialsChangedError)
    const after = reload(entry.id)
    expect(after.oauthCredentials).toBeUndefined()
    await expect(getApiKeyForProvider(after)).rejects.toThrow(/not signed in/)
    // Only the Kimi auth host was contacted; nothing went to Anthropic.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('kimi')
    expect(seen.join('\n')).not.toContain('anthropic.com')
  })
})

describe('refresh race: Kimi region change while a refresh is running', () => {
  it('the dropped token stays dropped and the base URL stays on the new region', async () => {
    const entry = addKimi('region-race', INTL, 'intl', 'INTL_RACE_OLD')
    const paused = pausedAuth({ access: 'INTL_RACE_NEW', refresh: 'INTL_RACE_REFRESH_NEW', expires: Date.now() + HOUR, region: 'intl' } as never)
    const running = refreshOAuthCredentialsLocked(entry.id, paused.auth,
      { type: 'oauth', access: 'INTL_RACE_OLD', refresh: 'INTL_RACE_OLD-REFRESH', expires: 0, region: 'intl' } as OAuthCredential)
    await paused.started
    updateProvider(entry.id, { baseUrl: CN })
    expect(reload(entry.id).oauthCredentials).toBeUndefined()
    paused.release()

    await expect(running).rejects.toThrow(/region or base URL changed/)
    const after = reload(entry.id)
    expect(after.oauthCredentials).toBeUndefined()
    expect(after.baseUrl).toBe(CN)
    expect(buildModel(after, 'k3').baseUrl).toBe(CN)
    expect(JSON.stringify(after)).not.toContain('INTL_RACE')
  })

  it('a late sign-in of the old region does not move the entry back (conditional updateOAuthCredentials)', () => {
    const entry = addKimi('late-login', INTL, 'intl', 'INTL_LOGIN_OLD', Date.now() + HOUR)
    updateProvider(entry.id, { baseUrl: CN })
    expect(() => updateOAuthCredentials(entry.id,
      { access: 'INTL_LATE_LOGIN', refresh: 'INTL_LATE_LOGIN_R', expires: Date.now() + HOUR, region: 'intl' } as never,
      { expectedProviderType: 'kimi-coding-oauth', expectedBaseUrl: INTL })).toThrow(/region .* changed while signing in/)
    // Without the expected state a token of another region is refused, too.
    expect(() => updateOAuthCredentials(entry.id,
      { access: 'INTL_LATE_LOGIN', refresh: 'INTL_LATE_LOGIN_R', expires: Date.now() + HOUR, region: 'intl' } as never)).toThrow(/another region/)
    const after = reload(entry.id)
    expect(after.baseUrl).toBe(CN)
    expect(after.oauthCredentials).toBeUndefined()
  })

  it('"Renew token" in another region still moves the entry when nothing changed meanwhile', () => {
    const entry = addKimi('renew', CN, 'cn', 'CN_RENEW_OLD', Date.now() + HOUR)
    updateOAuthCredentials(entry.id,
      { access: 'INTL_RENEW_NEW', refresh: 'INTL_RENEW_NEW_R', expires: Date.now() + HOUR, region: 'intl' } as never,
      { expectedProviderType: 'kimi-coding-oauth', expectedBaseUrl: CN })
    const after = reload(entry.id)
    expect(after.baseUrl).toBe(INTL)
    expect(after.oauthCredentials?.access).toBe('INTL_RENEW_NEW')
  })

  it('a late sign-in after a type change is discarded', () => {
    const entry = addKimi('late-type', CN, 'cn', 'CN_TYPE_OLD', Date.now() + HOUR)
    updateProvider(entry.id, { providerType: 'anthropic-oauth', enabledModels: ['claude-sonnet-4-5'] })
    expect(() => updateOAuthCredentials(entry.id,
      { access: 'CN_TYPE_LATE', refresh: 'CN_TYPE_LATE_R', expires: Date.now() + HOUR, region: 'cn' } as never,
      { expectedProviderType: 'kimi-coding-oauth', expectedBaseUrl: CN })).toThrow(/no longer of type/)
    expect(reload(entry.id).oauthCredentials).toBeUndefined()
  })
})

describe('refresh race: credentials removed or replaced while a refresh is running', () => {
  it('provider deleted: the rotated token is not written anywhere', async () => {
    addOAuthProvider({
      name: 'active', providerType: 'anthropic-oauth', enabledModels: [],
      oauthCredentials: { access: 'ACTIVE_ACCESS', refresh: 'ACTIVE_REFRESH', expires: Date.now() + HOUR },
    })
    const entry = addOAuthProvider({
      name: 'gone', providerType: 'openai-codex', enabledModels: [],
      oauthCredentials: { access: 'GONE_OLD_ACCESS', refresh: 'GONE_OLD_REFRESH', expires: 0 },
    })
    const paused = pausedAuth({ access: 'GONE_NEW_ACCESS', refresh: 'GONE_NEW_REFRESH', expires: Date.now() + HOUR })
    const running = refreshOAuthCredentialsLocked(entry.id, paused.auth,
      { type: 'oauth', access: 'GONE_OLD_ACCESS', refresh: 'GONE_OLD_REFRESH', expires: 0 })
    await paused.started
    deleteProvider(entry.id)
    paused.release()
    await expect(running).rejects.toThrow(/provider deleted/)
    const raw = fs.readFileSync(path.join(tmpDir, 'config', 'providers.json'), 'utf-8')
    expect(loadProvidersDecrypted().providers.map(p => p.id)).not.toContain(entry.id)
    expect(raw).not.toContain('GONE_')
  })

  it('credentials dropped by a region change before the refresh starts: the stale copy is not refreshed', async () => {
    const entry = addKimi('stale', INTL, 'intl', 'STALE_OLD_ACCESS')
    const staleCopy = reload(entry.id)
    updateProvider(entry.id, { baseUrl: CN })
    const paused = pausedAuth({ access: 'STALE_NEW', refresh: 'STALE_NEW_R', expires: Date.now() + HOUR, region: 'intl' } as never)
    paused.release()
    await expect(getApiKeyForProvider(staleCopy)).rejects.toThrow(/credentials removed/)
    await expect(refreshOAuthCredentialsLocked(entry.id, paused.auth,
      { type: 'oauth', access: 'STALE_OLD_ACCESS', refresh: 'x', expires: 0, region: 'intl' } as OAuthCredential)).rejects.toThrow(/credentials removed/)
    expect(paused.refresh).not.toHaveBeenCalled()
    expect(reload(entry.id).oauthCredentials).toBeUndefined()
  })

  it('new sign-in during the refresh: the new credentials win, the late rotation is discarded', async () => {
    const entry = addOAuthProvider({
      name: 'relogin', providerType: 'anthropic-oauth', enabledModels: ['claude-sonnet-4-5'],
      oauthCredentials: { access: 'RELOGIN_OLD_ACCESS', refresh: 'RELOGIN_OLD_REFRESH', expires: 0 },
    })
    const paused = pausedAuth({ access: 'RELOGIN_ROTATED_ACCESS', refresh: 'RELOGIN_ROTATED_REFRESH', expires: Date.now() + HOUR })
    const running = refreshOAuthCredentialsLocked(entry.id, paused.auth,
      { type: 'oauth', access: 'RELOGIN_OLD_ACCESS', refresh: 'RELOGIN_OLD_REFRESH', expires: 0 })
    await paused.started
    updateOAuthCredentials(entry.id, { access: 'RELOGIN_FRESH_ACCESS', refresh: 'RELOGIN_FRESH_REFRESH', expires: Date.now() + HOUR },
      { expectedProviderType: 'anthropic-oauth', expectedBaseUrl: null })
    paused.release()
    await expect(running).rejects.toThrow(/credentials replaced/)
    expect(reload(entry.id).oauthCredentials?.access).toBe('RELOGIN_FRESH_ACCESS')
  })

  it('a waiter arriving after the type change does not join the detached old refresh', async () => {
    const entry = addOAuthProvider({
      name: 'detach', providerType: 'openai-codex', enabledModels: [],
      oauthCredentials: { access: 'DETACH_OLD_ACCESS', refresh: 'DETACH_OLD_REFRESH', expires: 0 },
    })
    const first = pausedAuth({ access: 'DETACH_NEW_ACCESS', refresh: 'DETACH_NEW_REFRESH', expires: Date.now() + HOUR })
    const running = refreshOAuthCredentialsLocked(entry.id, first.auth,
      { type: 'oauth', access: 'DETACH_OLD_ACCESS', refresh: 'DETACH_OLD_REFRESH', expires: 0 })
    await first.started
    updateProvider(entry.id, { providerType: 'anthropic-oauth', enabledModels: ['claude-sonnet-4-5'] })
    // A second caller with its stale copy: must not receive the old run's token.
    const second = pausedAuth({ access: 'SECOND', refresh: 'SECOND_R', expires: Date.now() + HOUR })
    second.release()
    const late = refreshOAuthCredentialsLocked(entry.id, second.auth,
      { type: 'oauth', access: 'DETACH_OLD_ACCESS', refresh: 'DETACH_OLD_REFRESH', expires: 0 })
    first.release()
    await expect(late).rejects.toBeInstanceOf(OAuthCredentialsChangedError)
    await expect(running).rejects.toBeInstanceOf(OAuthCredentialsChangedError)
    expect(second.refresh).not.toHaveBeenCalled()
    expect(reload(entry.id).oauthCredentials).toBeUndefined()
  })
})

describe('undisturbed refresh keeps working', () => {
  const cases = [
    { providerType: 'kimi-coding-oauth' as const, baseUrl: INTL, region: 'intl' as const },
    { providerType: 'anthropic-oauth' as const },
    { providerType: 'openai-codex' as const },
  ]
  for (const c of cases) {
    it(`${c.providerType}: the rotated token is stored, the base URL is untouched`, async () => {
      const entry = addOAuthProvider({
        name: `ok-${c.providerType}`, providerType: c.providerType, baseUrl: c.baseUrl, enabledModels: [],
        oauthCredentials: { access: 'OK_OLD_ACCESS', refresh: 'OK_OLD_REFRESH', expires: 0, ...(c.region && { region: c.region }) } as never,
      })
      const before = reload(entry.id).baseUrl
      const paused = pausedAuth({ access: 'OK_NEW_ACCESS', refresh: 'OK_NEW_REFRESH', expires: Date.now() + HOUR, ...(c.region && { region: c.region }) } as never)
      const running = refreshOAuthCredentialsLocked(entry.id, paused.auth,
        { type: 'oauth', access: 'OK_OLD_ACCESS', refresh: 'OK_OLD_REFRESH', expires: 0, ...(c.region && { region: c.region }) } as OAuthCredential)
      await paused.started
      paused.release()
      const rotated = await running
      expect(rotated.access).toBe('OK_NEW_ACCESS')
      const after = reload(entry.id)
      expect(after.providerType).toBe(c.providerType)
      expect(after.oauthCredentials?.access).toBe('OK_NEW_ACCESS')
      expect(after.oauthCredentials?.refresh).toBe('OK_NEW_REFRESH')
      expect(after.baseUrl).toBe(before)
    })
  }

  it('two parallel requests still share exactly one refresh', async () => {
    const entry = addKimi('parallel', CN, 'cn', 'PAR_OLD_ACCESS')
    const paused = pausedAuth({ access: 'PAR_NEW_ACCESS', refresh: 'PAR_NEW_REFRESH', expires: Date.now() + HOUR, region: 'cn' } as never)
    const creds = { type: 'oauth', access: 'PAR_OLD_ACCESS', refresh: 'PAR_OLD_ACCESS-REFRESH', expires: 0, region: 'cn' } as OAuthCredential
    const a = refreshOAuthCredentialsLocked(entry.id, paused.auth, creds)
    const b = refreshOAuthCredentialsLocked(entry.id, paused.auth, creds)
    await paused.started
    paused.release()
    const [ra, rb] = await Promise.all([a, b])
    expect(paused.refresh).toHaveBeenCalledTimes(1)
    expect(ra.access).toBe('PAR_NEW_ACCESS')
    expect(rb.access).toBe('PAR_NEW_ACCESS')
    expect(reload(entry.id).oauthCredentials?.access).toBe('PAR_NEW_ACCESS')
  })
})
