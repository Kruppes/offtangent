/**
 * Review round 2 (2026-11, NO-GO) of the shared OAuth refresh path: the
 * per-token lock and the hand-over of a rotated token must be bound to the
 * issuer, must never leak a token of any hop in an error, must not overwrite a
 * newer credential of another entry and must not wedge when a provider ignores
 * the abort signal. Plus the regression guard: single sign-ins behave exactly
 * as on main (one presentation of the stored credential, one write, nobody
 * else touched). No real network: every refresh() is a controlled mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import {
  addOAuthProvider,
  loadProviders,
  loadProvidersDecrypted,
  OAUTH_REFRESH_TIMEOUT_MS,
  refreshOAuthCredentialsLocked,
} from './provider-config.js'
import type { ProviderType } from './provider-config.js'

const HOUR = 3_600_000
const INTL = 'https://api.kimi.ai/coding'
const CN = 'https://api.kimi.com/coding'

let tmpDir: string
const originalDataDir = process.env.DATA_DIR

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-oauth-issuer-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify({ providers: [] }), 'utf-8')
  process.env.DATA_DIR = tmpDir
})

afterEach(() => {
  vi.useRealTimers()
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

/** The stored (encrypted) credential field, byte for byte. */
function rawStored(id: string): string {
  return JSON.stringify(loadProviders().providers.find(p => p.id === id)?.oauthCredentials)
}

/**
 * A rotating issuer: each refresh token is valid exactly once; presenting a
 * used token is recorded as a reuse. `paused` holds every refresh until
 * `release()`. `extra` is merged into every issued credential (Kimi region).
 */
function issuer(name: string, options: { paused?: boolean, rotate?: boolean, expiresIn?: number, extra?: Record<string, unknown> } = {}) {
  const used = new Set<string>()
  const presented: OAuthCredential[] = []
  const reuses: string[] = []
  let counter = 0
  let release!: () => void
  const gate = options.paused ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const refresh = vi.fn(async (credential: OAuthCredential): Promise<OAuthCredential> => {
    presented.push({ ...credential })
    if (used.has(credential.refresh)) reuses.push(credential.refresh)
    used.add(credential.refresh)
    entered()
    await gate
    counter += 1
    return {
      type: 'oauth',
      access: `${name}_ACCESS_${counter}`,
      refresh: options.rotate === false ? credential.refresh : `${name}_REFRESH_${counter}`,
      expires: Date.now() + (options.expiresIn ?? HOUR),
      ...(options.extra ?? {}),
    } as OAuthCredential
  })
  const auth = { name, refresh, toAuth: async (c: OAuthCredential) => ({ apiKey: c.access }) } as unknown as OAuthAuth
  return { auth, refresh, presented, reuses, started, release: () => release?.() }
}

function add(providerType: ProviderType, name: string, creds: { access: string, refresh: string, expires?: number, region?: string }, baseUrl?: string) {
  return addOAuthProvider({
    name,
    providerType,
    enabledModels: [],
    baseUrl,
    oauthCredentials: { expires: 0, ...creds } as { access: string, refresh: string, expires: number },
  })
}

const cred = (access: string, refresh: string, expires = 0, extra: Record<string, unknown> = {}): OAuthCredential =>
  ({ type: 'oauth', access, refresh, expires, ...extra }) as OAuthCredential

/** Every string an error exposes through message, stack and the cause chain. */
function errorTexts(err: unknown, depth = 0): string[] {
  if (depth > 5 || err == null) return []
  if (typeof err !== 'object') return [String(err)]
  const e = err as { message?: unknown, stack?: unknown, cause?: unknown }
  return [String(e.message ?? ''), String(e.stack ?? ''), ...errorTexts(e.cause, depth + 1)]
}

/** Fails if any 8-character window of any token appears in the error. */
function expectNoTokenFragment(err: unknown, tokens: string[]) {
  const texts = errorTexts(err).join('\n')
  for (const token of tokens) {
    for (let i = 0; i + 8 <= token.length; i++) {
      const fragment = token.slice(i, i + 8)
      expect(texts.includes(fragment), `token fragment "${fragment}" of ${token} leaked`).toBe(false)
    }
  }
}

describe('finding 1: the shared-token lock and hand-over are bound to the issuer', () => {
  it('anthropic-oauth and openai-codex with the same fixture refresh token never exchange credentials (sequential)', async () => {
    const anth = add('anthropic-oauth', 'Anthropic', { access: 'FIXTURE_ACCESS', refresh: 'FIXTURE_REFRESH' })
    const codex = add('openai-codex', 'Codex', { access: 'FIXTURE_ACCESS', refresh: 'FIXTURE_REFRESH' })
    const anthIssuer = issuer('anthropic')
    const codexIssuer = issuer('codex')
    const codexBefore = rawStored(codex.id)

    await refreshOAuthCredentialsLocked(anth.id, anthIssuer.auth, cred('FIXTURE_ACCESS', 'FIXTURE_REFRESH'))
    // The Anthropic result must not land in the Codex entry.
    expect(rawStored(codex.id)).toBe(codexBefore)
    expect(reload(codex.id).oauthCredentials?.access).toBe('FIXTURE_ACCESS')

    const cc = await refreshOAuthCredentialsLocked(codex.id, codexIssuer.auth, cred('FIXTURE_ACCESS', 'FIXTURE_REFRESH'))
    expect(codexIssuer.presented.map(c => c.refresh)).toEqual(['FIXTURE_REFRESH'])
    expect(cc.access).toBe('codex_ACCESS_1')
    expect(reload(codex.id).oauthCredentials?.access).toBe('codex_ACCESS_1')
    expect(reload(anth.id).oauthCredentials?.access).toBe('anthropic_ACCESS_1')
  })

  it('anthropic-oauth and openai-codex with the same fixture refresh token refreshed in parallel each ask their own issuer', async () => {
    const anth = add('anthropic-oauth', 'Anthropic', { access: 'FIXTURE_ACCESS', refresh: 'FIXTURE_REFRESH' })
    const codex = add('openai-codex', 'Codex', { access: 'FIXTURE_ACCESS', refresh: 'FIXTURE_REFRESH' })
    const anthIssuer = issuer('anthropic', { paused: true })
    const codexIssuer = issuer('codex', { paused: true })
    const ra = refreshOAuthCredentialsLocked(anth.id, anthIssuer.auth, cred('FIXTURE_ACCESS', 'FIXTURE_REFRESH'))
    const rc = refreshOAuthCredentialsLocked(codex.id, codexIssuer.auth, cred('FIXTURE_ACCESS', 'FIXTURE_REFRESH'))
    await anthIssuer.started
    anthIssuer.release()
    const ca = await ra
    codexIssuer.release()
    const cc = await rc

    expect(anthIssuer.refresh).toHaveBeenCalledTimes(1)
    expect(codexIssuer.refresh).toHaveBeenCalledTimes(1)
    expect(ca.access).toBe('anthropic_ACCESS_1')
    expect(cc.access).toBe('codex_ACCESS_1')
    expect(reload(anth.id).oauthCredentials?.access).toBe('anthropic_ACCESS_1')
    expect(reload(codex.id).oauthCredentials?.access).toBe('codex_ACCESS_1')
  })

  it('two Kimi entries of different regions with the same refresh token do not join each other', async () => {
    const cn = add('kimi-coding-oauth', 'Kimi CN', { access: 'KIMI_FIXTURE_ACCESS', refresh: 'KIMI_FIXTURE_REFRESH', region: 'cn' }, CN)
    const intl = add('kimi-coding-oauth', 'Kimi INTL', { access: 'KIMI_FIXTURE_ACCESS', refresh: 'KIMI_FIXTURE_REFRESH', region: 'intl' }, INTL)
    const cnIssuer = issuer('kimicn', { paused: true, extra: { region: 'cn' } })
    const intlIssuer = issuer('kimiintl', { paused: true, extra: { region: 'intl' } })
    const rcn = refreshOAuthCredentialsLocked(cn.id, cnIssuer.auth, cred('KIMI_FIXTURE_ACCESS', 'KIMI_FIXTURE_REFRESH', 0, { region: 'cn' }))
    const rintl = refreshOAuthCredentialsLocked(intl.id, intlIssuer.auth, cred('KIMI_FIXTURE_ACCESS', 'KIMI_FIXTURE_REFRESH', 0, { region: 'intl' }))
    await cnIssuer.started
    cnIssuer.release()
    await rcn
    intlIssuer.release()
    const ci = await rintl

    expect(intlIssuer.refresh).toHaveBeenCalledTimes(1)
    expect(ci.access).toBe('kimiintl_ACCESS_1')
    expect(reload(intl.id).oauthCredentials?.access).toBe('kimiintl_ACCESS_1')
    expect(reload(cn.id).oauthCredentials?.access).toBe('kimicn_ACCESS_1')
  })
})

describe('finding 2: no token of any hop in the refresh chain leaks into an error', () => {
  it('the second hop (expired successor) fails with invalid_grant token=SUCCESSOR_FAKE_REFRESH: redacted in message, stack and cause', async () => {
    const a = add('anthropic-oauth', 'A', { access: 'ORIGINAL_FAKE_ACCESS', refresh: 'ORIGINAL_FAKE_REFRESH' })
    const b = add('anthropic-oauth', 'B', { access: 'ORIGINAL_FAKE_ACCESS', refresh: 'ORIGINAL_FAKE_REFRESH' })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const refresh = vi.fn(async (credential: OAuthCredential): Promise<OAuthCredential> => {
      if (credential.refresh === 'ORIGINAL_FAKE_REFRESH') {
        entered()
        await gate
        // Successor that is already expired: the joined caller continues the chain.
        return { type: 'oauth', access: 'SUCCESSOR_FAKE_ACCESS', refresh: 'SUCCESSOR_FAKE_REFRESH', expires: Date.now() - 1000 }
      }
      const cause = new Error(`upstream said: refresh_token=${credential.refresh} access=${credential.access}`)
      throw new Error(`invalid_grant token=${credential.refresh}`, { cause })
    })
    const auth = { name: 'anthropic', refresh, toAuth: async (c: OAuthCredential) => ({ apiKey: c.access }) } as unknown as OAuthAuth

    const ra = refreshOAuthCredentialsLocked(a.id, auth, cred('ORIGINAL_FAKE_ACCESS', 'ORIGINAL_FAKE_REFRESH'))
    await started
    const rb = refreshOAuthCredentialsLocked(b.id, auth, cred('ORIGINAL_FAKE_ACCESS', 'ORIGINAL_FAKE_REFRESH'))
    // Let B reach the per-token lock and join A's running refresh.
    await new Promise(resolve => setTimeout(resolve, 10))
    release()
    await ra
    const err = await rb.then(() => null, (e: unknown) => e)

    expect(refresh.mock.calls.map(c => (c[0] as OAuthCredential).refresh)).toEqual(['ORIGINAL_FAKE_REFRESH', 'SUCCESSOR_FAKE_REFRESH'])
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/invalid_grant/)
    expectNoTokenFragment(err, ['SUCCESSOR_FAKE_REFRESH', 'SUCCESSOR_FAKE_ACCESS', 'ORIGINAL_FAKE_REFRESH', 'ORIGINAL_FAKE_ACCESS'])
  })

  it('a single sign-in whose refresh echoes its token: redacted in message, stack and cause', async () => {
    const a = add('openai-codex', 'Codex', { access: 'SINGLE_FAKE_ACCESS', refresh: 'SINGLE_FAKE_REFRESH' })
    const refresh = vi.fn(async (credential: OAuthCredential): Promise<OAuthCredential> => {
      throw new Error(`invalid_grant token=${credential.refresh}`, { cause: `bearer ${credential.access}` })
    })
    const auth = { name: 'openai-codex', refresh, toAuth: async (c: OAuthCredential) => ({ apiKey: c.access }) } as unknown as OAuthAuth
    const err = await refreshOAuthCredentialsLocked(a.id, auth, cred('SINGLE_FAKE_ACCESS', 'SINGLE_FAKE_REFRESH')).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toMatch(/invalid_grant/)
    expectNoTokenFragment(err, ['SINGLE_FAKE_REFRESH', 'SINGLE_FAKE_ACCESS'])
  })
})

describe('finding 3: the hand-over never overwrites a credential that differs from the presented one', () => {
  it('NON_ROTATING_OVERWRITE: B already holds a newer access token for the same refresh token and keeps it', async () => {
    const a = add('anthropic-oauth', 'A', { access: 'A_OLDER_ACCESS', refresh: 'NON_ROTATING_R', expires: 0 })
    const bExpires = Date.now() + 2 * HOUR
    const b = add('anthropic-oauth', 'B', { access: 'B_NEWER_ACCESS', refresh: 'NON_ROTATING_R', expires: bExpires })
    const bBefore = rawStored(b.id)
    const nonRotating = issuer('nonrot', { rotate: false })

    const ca = await refreshOAuthCredentialsLocked(a.id, nonRotating.auth, cred('A_OLDER_ACCESS', 'NON_ROTATING_R'))
    expect(ca.access).toBe('nonrot_ACCESS_1')
    expect(rawStored(b.id)).toBe(bBefore)
    expect(reload(b.id).oauthCredentials?.access).toBe('B_NEWER_ACCESS')
    expect(reload(b.id).oauthCredentials?.expires).toBe(bExpires)
  })

  it('an entry with the same tokens but a different expiry is not touched either', async () => {
    const a = add('anthropic-oauth', 'A', { access: 'SAME_ACCESS', refresh: 'SAME_REFRESH', expires: 0 })
    const b = add('anthropic-oauth', 'B', { access: 'SAME_ACCESS', refresh: 'SAME_REFRESH', expires: 1 })
    const bBefore = rawStored(b.id)
    await refreshOAuthCredentialsLocked(a.id, issuer('exp').auth, cred('SAME_ACCESS', 'SAME_REFRESH'))
    expect(rawStored(b.id)).toBe(bBefore)
  })
})

describe('finding 4: a provider that ignores the abort signal cannot wedge the refresh', () => {
  it('all waiters fail after the deadline, the signal is aborted and both locks are released', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = add('anthropic-oauth', 'A', { access: 'HANG_ACCESS', refresh: 'HANG_REFRESH' })
    const b = add('anthropic-oauth', 'B', { access: 'HANG_ACCESS', refresh: 'HANG_REFRESH' })
    let signal: AbortSignal | undefined
    let hang = true
    const refresh = vi.fn((credential: OAuthCredential, s: AbortSignal): Promise<OAuthCredential> => {
      signal = s
      if (hang) return new Promise<OAuthCredential>(() => {}) // ignores the signal, never settles
      return Promise.resolve({ type: 'oauth', access: 'AFTER_HANG_ACCESS', refresh: `${credential.refresh}_NEXT`, expires: Date.now() + HOUR })
    })
    const auth = { name: 'anthropic', refresh, toAuth: async (c: OAuthCredential) => ({ apiKey: c.access }) } as unknown as OAuthAuth

    const settle = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as Error).message)
    const ra = settle(refreshOAuthCredentialsLocked(a.id, auth, cred('HANG_ACCESS', 'HANG_REFRESH')))
    const ra2 = settle(refreshOAuthCredentialsLocked(a.id, auth, cred('HANG_ACCESS', 'HANG_REFRESH')))
    const rb = settle(refreshOAuthCredentialsLocked(b.id, auth, cred('HANG_ACCESS', 'HANG_REFRESH')))
    await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_TIMEOUT_MS + 1)
    const results = await Promise.all([ra, ra2, rb])

    expect(refresh).toHaveBeenCalledTimes(1)
    for (const r of results) expect(r).toMatch(/timed out/)
    expect(signal?.aborted).toBe(true)

    // Locks released: the next attempt asks the issuer again and succeeds.
    hang = false
    const next = await refreshOAuthCredentialsLocked(a.id, auth, cred('HANG_ACCESS', 'HANG_REFRESH'))
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(next.access).toBe('AFTER_HANG_ACCESS')
  }, 10_000)
})

describe('regression: single sign-ins behave exactly as on main', () => {
  function addThree() {
    const codex = add('openai-codex', 'OpenAI', { access: 'CODEX_OWN_ACCESS', refresh: 'CODEX_OWN_REFRESH' })
    const anth = add('anthropic-oauth', 'Anthropic', { access: 'ANTH_OWN_ACCESS', refresh: 'ANTH_OWN_REFRESH' })
    const kimi = add('kimi-coding-oauth', 'Kimi_Subscription', { access: 'KIMI_OWN_ACCESS', refresh: 'KIMI_OWN_REFRESH', region: 'intl' }, INTL)
    return { codex, anth, kimi }
  }

  it('three OAuth providers with their own tokens, refreshed in parallel: one presentation of the stored credential and one write each', async () => {
    const { codex, anth, kimi } = addThree()
    const ic = issuer('codex')
    const ia = issuer('anth')
    const ik = issuer('kimi', { extra: { region: 'intl' } })
    const providersJson = path.join(tmpDir, 'config', 'providers.json')
    const write = vi.spyOn(fs, 'writeFileSync')

    const [cc, ca, ck] = await Promise.all([
      refreshOAuthCredentialsLocked(codex.id, ic.auth, cred('CODEX_OWN_ACCESS', 'CODEX_OWN_REFRESH')),
      refreshOAuthCredentialsLocked(anth.id, ia.auth, cred('ANTH_OWN_ACCESS', 'ANTH_OWN_REFRESH')),
      refreshOAuthCredentialsLocked(kimi.id, ik.auth, cred('KIMI_OWN_ACCESS', 'KIMI_OWN_REFRESH', 0, { region: 'intl' })),
    ])

    expect(ic.presented).toEqual([{ type: 'oauth', access: 'CODEX_OWN_ACCESS', refresh: 'CODEX_OWN_REFRESH', expires: 0 }])
    expect(ia.presented).toEqual([{ type: 'oauth', access: 'ANTH_OWN_ACCESS', refresh: 'ANTH_OWN_REFRESH', expires: 0 }])
    expect(ik.presented).toEqual([{ type: 'oauth', access: 'KIMI_OWN_ACCESS', refresh: 'KIMI_OWN_REFRESH', expires: 0, region: 'intl' }])
    expect([cc.access, ca.access, ck.access]).toEqual(['codex_ACCESS_1', 'anth_ACCESS_1', 'kimi_ACCESS_1'])
    expect(reload(codex.id).oauthCredentials?.refresh).toBe('codex_REFRESH_1')
    expect(reload(anth.id).oauthCredentials?.refresh).toBe('anth_REFRESH_1')
    expect(reload(kimi.id).oauthCredentials?.refresh).toBe('kimi_REFRESH_1')
    expect(write.mock.calls.filter(c => c[0] === providersJson)).toHaveLength(3)
  })

  it('refreshing one of them leaves the other two byte-identical; a valid token is not refreshed at all', async () => {
    const { codex, anth, kimi } = addThree()
    const anthBefore = rawStored(anth.id)
    const kimiBefore = rawStored(kimi.id)
    const ic = issuer('codex')
    await refreshOAuthCredentialsLocked(codex.id, ic.auth, cred('CODEX_OWN_ACCESS', 'CODEX_OWN_REFRESH'))
    expect(rawStored(anth.id)).toBe(anthBefore)
    expect(rawStored(kimi.id)).toBe(kimiBefore)

    // Now valid: the next call returns the stored credential without asking.
    const again = await refreshOAuthCredentialsLocked(codex.id, ic.auth, cred('CODEX_OWN_ACCESS', 'CODEX_OWN_REFRESH'))
    expect(ic.refresh).toHaveBeenCalledTimes(1)
    expect(again.access).toBe('codex_ACCESS_1')
  })
})
