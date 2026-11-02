/**
 * One refresh per refresh TOKEN, not only per provider id (review 2026-11,
 * finding BLOCKER): two provider entries holding the same stored OAuth
 * credential must never present the same rotating refresh token twice —
 * neither in parallel nor one after the other. The second entry adopts the
 * successor the first refresh received. No real network: every refresh() is a
 * controlled mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import {
  addOAuthProvider,
  loadProvidersDecrypted,
  refreshOAuthCredentialsLocked,
} from './provider-config.js'
import type { ProviderType } from './provider-config.js'

const HOUR = 3_600_000

let tmpDir: string
const originalDataDir = process.env.DATA_DIR

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-shared-refresh-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify({ providers: [] }), 'utf-8')
  process.env.DATA_DIR = tmpDir
})

afterEach(() => {
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

/**
 * A rotating issuer: each refresh token is valid exactly once and yields a new
 * pair; presenting a used token is recorded as a reuse (what revokes the token
 * family at Anthropic / OpenAI). `gate` pauses every refresh until released.
 */
function rotatingIssuer(name: string, options: { paused?: boolean, rotate?: boolean, expiresIn?: number } = {}) {
  const used = new Set<string>()
  const presented: string[] = []
  const reuses: string[] = []
  let counter = 0
  let release!: () => void
  const gate = options.paused ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const refresh = vi.fn(async (credential: OAuthCredential): Promise<OAuthCredential> => {
    presented.push(credential.refresh)
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
    }
  })
  // Two distinct objects with the same issuer name: the lock must not depend
  // on object identity (each call site resolves its own OAuthAuth).
  const make = () => ({ name, refresh, toAuth: async (c: OAuthCredential) => ({ apiKey: c.access }) }) as unknown as OAuthAuth
  return { authA: make(), authB: make(), refresh, presented, reuses, started, release: () => release?.() }
}

function addShared(providerType: ProviderType, name: string, access: string, refresh: string, expires = 0) {
  return addOAuthProvider({ name, providerType, enabledModels: [], oauthCredentials: { access, refresh, expires } })
}

const cred = (access: string, refresh: string, expires = 0): OAuthCredential => ({ type: 'oauth', access, refresh, expires })

describe('one refresh per refresh token across providers', () => {
  for (const providerType of ['anthropic-oauth', 'openai-codex'] as const) {
    it(`${providerType}: two entries with the same credential refreshed in parallel present the refresh token once`, async () => {
      const a = addShared(providerType, 'A', 'OLD_ACCESS', 'SHARED_R0')
      const b = addShared(providerType, 'B', 'OLD_ACCESS', 'SHARED_R0')
      const issuer = rotatingIssuer(providerType, { paused: true })
      const ra = refreshOAuthCredentialsLocked(a.id, issuer.authA, cred('OLD_ACCESS', 'SHARED_R0'))
      const rb = refreshOAuthCredentialsLocked(b.id, issuer.authB, cred('OLD_ACCESS', 'SHARED_R0'))
      await issuer.started
      issuer.release()
      const [ca, cb] = await Promise.all([ra, rb])

      expect(issuer.refresh).toHaveBeenCalledTimes(1)
      expect(issuer.reuses).toEqual([])
      expect(ca.access).toBe(`${providerType}_ACCESS_1`)
      expect(cb.access).toBe(`${providerType}_ACCESS_1`)
      // Both entries now hold the successor, so neither will present R0 again.
      expect(reload(a.id).oauthCredentials?.refresh).toBe(`${providerType}_REFRESH_1`)
      expect(reload(b.id).oauthCredentials?.refresh).toBe(`${providerType}_REFRESH_1`)
    })

    it(`${providerType}: an entry still holding the already-rotated token adopts the successor instead of presenting it again`, async () => {
      const a = addShared(providerType, 'A', 'OLD_ACCESS', 'SEQ_R0')
      const b = addShared(providerType, 'B', 'OLD_ACCESS', 'SEQ_R0')
      const issuer = rotatingIssuer(providerType)
      await refreshOAuthCredentialsLocked(a.id, issuer.authA, cred('OLD_ACCESS', 'SEQ_R0'))
      const cb = await refreshOAuthCredentialsLocked(b.id, issuer.authB, cred('OLD_ACCESS', 'SEQ_R0'))

      expect(issuer.presented).toEqual(['SEQ_R0'])
      expect(issuer.reuses).toEqual([])
      expect(cb.access).toBe(`${providerType}_ACCESS_1`)
      expect(reload(b.id).oauthCredentials?.access).toBe(`${providerType}_ACCESS_1`)
      expect(reload(b.id).oauthCredentials?.refresh).toBe(`${providerType}_REFRESH_1`)
    })
  }

  it('an adopted successor that already expired is refreshed with ITS refresh token, never the old one', async () => {
    const a = addShared('anthropic-oauth', 'A', 'OLD_ACCESS', 'CHAIN_R0')
    const b = addShared('anthropic-oauth', 'B', 'OLD_ACCESS', 'CHAIN_R0')
    // The issuer hands out access tokens that are already expired.
    const issuer = rotatingIssuer('chain', { expiresIn: -1000 })
    await refreshOAuthCredentialsLocked(a.id, issuer.authA, cred('OLD_ACCESS', 'CHAIN_R0'))
    const cb = await refreshOAuthCredentialsLocked(b.id, issuer.authB, cred('OLD_ACCESS', 'CHAIN_R0'))

    expect(issuer.presented).toEqual(['CHAIN_R0', 'chain_REFRESH_1'])
    expect(issuer.reuses).toEqual([])
    expect(cb.refresh).toBe('chain_REFRESH_2')
    expect(reload(b.id).oauthCredentials?.refresh).toBe('chain_REFRESH_2')
  })

  it('a forced refresh (token rejected) of the second entry also adopts the successor', async () => {
    // One expiry for both entries: the hand-over only targets an entry whose
    // stored credential is EXACTLY the presented one (access, refresh, expiry),
    // so separate Date.now() calls made this test flaky when the clock ticked.
    const expires = Date.now() + HOUR
    const a = addShared('openai-codex', 'A', 'OLD_ACCESS', 'FORCE_R0', expires)
    const b = addShared('openai-codex', 'B', 'OLD_ACCESS', 'FORCE_R0', expires)
    const issuer = rotatingIssuer('force')
    await refreshOAuthCredentialsLocked(a.id, issuer.authA, cred('OLD_ACCESS', 'FORCE_R0', expires), { force: true })
    const cb = await refreshOAuthCredentialsLocked(b.id, issuer.authB, cred('OLD_ACCESS', 'FORCE_R0', expires), { force: true })

    expect(issuer.presented).toEqual(['FORCE_R0'])
    expect(cb.access).toBe('force_ACCESS_1')
    expect(reload(b.id).oauthCredentials?.access).toBe('force_ACCESS_1')
  })

  it('a non-rotating issuer (same refresh token back) is not short-circuited on the next expiry', async () => {
    const a = addShared('anthropic-oauth', 'A', 'OLD_ACCESS', 'STATIC_R')
    const issuer = rotatingIssuer('static', { rotate: false, expiresIn: -1000 })
    await refreshOAuthCredentialsLocked(a.id, issuer.authA, cred('OLD_ACCESS', 'STATIC_R'))
    const second = await refreshOAuthCredentialsLocked(a.id, issuer.authA, cred('static_ACCESS_1', 'STATIC_R'))
    expect(issuer.refresh).toHaveBeenCalledTimes(2)
    expect(second.access).toBe('static_ACCESS_2')
  })

  it('different refresh tokens of different entries still refresh independently', async () => {
    const a = addShared('anthropic-oauth', 'A', 'A_ACCESS', 'IND_RA')
    const b = addShared('anthropic-oauth', 'B', 'B_ACCESS', 'IND_RB')
    const issuer = rotatingIssuer('ind')
    await Promise.all([
      refreshOAuthCredentialsLocked(a.id, issuer.authA, cred('A_ACCESS', 'IND_RA')),
      refreshOAuthCredentialsLocked(b.id, issuer.authB, cred('B_ACCESS', 'IND_RB')),
    ])
    expect(issuer.presented.sort()).toEqual(['IND_RA', 'IND_RB'])
    expect(reload(a.id).oauthCredentials?.access).not.toBe(reload(b.id).oauthCredentials?.access)
  })
})
