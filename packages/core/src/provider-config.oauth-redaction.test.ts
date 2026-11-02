/**
 * Review round 3 (2026-11, GO with conditions) of the OAuth error redaction:
 *  1. order: when the access token is a prefix of the refresh token, a fixed
 *     replacement order left a suffix of the refresh token behind — in the
 *     returned error and in the log line of recoverOAuthAfterAuthFailure().
 *  2. deep / cyclic cause chains: a token on cause level 6 (or deeper) and a
 *     token in a cyclic object cause stayed visible.
 * No real network: every refresh() is a controlled mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import {
  addOAuthProvider,
  getPiOAuthAuth,
  recoverOAuthAfterAuthFailure,
  refreshOAuthCredentialsLocked,
} from './provider-config.js'
import { redactSecrets } from './kimi-coding-oauth.js'

let tmpDir: string
const originalDataDir = process.env.DATA_DIR

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-oauth-redaction-'))
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

const PREFIX_ACCESS = 'PFXACCESS_0123456789abcdef'
const PREFIX_REFRESH = `${PREFIX_ACCESS}_REFRESHTAIL_ZYXWVUTS98765`
const DEEP_ACCESS = 'DEEPACCESS_aaaabbbbccccdddd'
const DEEP_REFRESH = 'DEEPREFRESH_eeeeffffgggghhhh'

const cred = (access: string, refresh: string): OAuthCredential =>
  ({ type: 'oauth', access, refresh, expires: 0 }) as OAuthCredential

function add(name: string, access: string, refresh: string) {
  return addOAuthProvider({
    name,
    providerType: 'anthropic-oauth',
    enabledModels: [],
    oauthCredentials: { access, refresh, expires: 0 },
  })
}

function failingAuth(makeError: () => unknown): OAuthAuth {
  const refresh = vi.fn(async (): Promise<OAuthCredential> => { throw makeError() })
  return { name: 'mock', refresh, toAuth: async (c: OAuthCredential) => ({ apiKey: c.access }) } as unknown as OAuthAuth
}

/**
 * Every string reachable from an error: message, stack, and the full cause
 * chain without a depth limit (cycle-safe), including every string inside a
 * plain-object cause.
 */
function allTexts(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return value === undefined ? [] : [String(value)]
  if (seen.has(value)) return []
  seen.add(value)
  const out: string[] = []
  if (value instanceof Error) {
    out.push(String(value.message ?? ''), String(value.stack ?? ''))
    out.push(...allTexts((value as { cause?: unknown }).cause, seen))
    return out
  }
  for (const key of Object.keys(value)) out.push(key, ...allTexts((value as Record<string, unknown>)[key], seen))
  return out
}

/** Fails if any 8-character window of any token appears in `text`. */
function expectNoFragmentIn(text: string, tokens: string[]) {
  for (const token of tokens) {
    for (let i = 0; i + 8 <= token.length; i++) {
      const fragment = token.slice(i, i + 8)
      expect(text.includes(fragment), `token fragment "${fragment}" of ${token} leaked`).toBe(false)
    }
  }
}

const expectNoTokenFragment = (err: unknown, tokens: string[]) => expectNoFragmentIn(allTexts(err).join('\n'), tokens)

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const result = await promise.then(() => null, (e: unknown) => e)
  expect(result).toBeInstanceOf(Error)
  return result as Error
}

describe('round 3 / point 1: redaction order (access token is a prefix of the refresh token)', () => {
  it('redactSecrets leaves no fragment of the longer secret, whatever the order; short and empty values are ignored', () => {
    const text = `a=${PREFIX_ACCESS} r=${PREFIX_REFRESH} end`
    for (const order of [[PREFIX_ACCESS, PREFIX_REFRESH], [PREFIX_REFRESH, PREFIX_ACCESS], [PREFIX_ACCESS, PREFIX_ACCESS, PREFIX_REFRESH]]) {
      const out = redactSecrets(text, [...order, '', 'abc', 'e', undefined, null])
      expect(out).toBe('a=[redacted] r=[redacted] end')
      expectNoFragmentIn(out, [PREFIX_ACCESS, PREFIX_REFRESH])
    }
    // Short / empty values never cause a mass replacement.
    expect(redactSecrets('a e i o u', ['', 'e', 'a e'])).toBe('a e i o u')
  })

  it('the error returned by refreshOAuthCredentialsLocked carries no fragment of either token', async () => {
    const p = add('Anthropic', PREFIX_ACCESS, PREFIX_REFRESH)
    const auth = failingAuth(() => new Error(`invalid_grant access=${PREFIX_ACCESS} refresh=${PREFIX_REFRESH}`, {
      cause: new Error(`body: {"refresh_token":"${PREFIX_REFRESH}","access_token":"${PREFIX_ACCESS}"}`),
    }))
    const err = await rejection(refreshOAuthCredentialsLocked(p.id, auth, cred(PREFIX_ACCESS, PREFIX_REFRESH)))
    expect(err.message).toContain('invalid_grant')
    expectNoTokenFragment(err, [PREFIX_ACCESS, PREFIX_REFRESH])
  })

  it('recoverOAuthAfterAuthFailure: the logged line carries no fragment of either token', async () => {
    const p = add('Anthropic', PREFIX_ACCESS, PREFIX_REFRESH)
    const shared = getPiOAuthAuth('anthropic')
    expect(shared).not.toBeNull()
    vi.spyOn(shared!, 'refresh').mockImplementation(async () => {
      throw new Error(`invalid_grant access=${PREFIX_ACCESS} refresh=${PREFIX_REFRESH}`)
    })
    const logs: string[] = []
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    }
    await expect(recoverOAuthAfterAuthFailure(p.id)).resolves.toBe(true)
    expect(shared!.refresh).toHaveBeenCalledTimes(1)
    const joined = logs.join('\n')
    expect(joined).toContain('Forced OAuth refresh')
    expect(joined).toContain('invalid_grant')
    expectNoFragmentIn(joined, [PREFIX_ACCESS, PREFIX_REFRESH])
  })
})

/** Error chain whose cause on `level` (top error = level 0) carries both tokens. */
function chainWithTokenAt(level: number): Error {
  let node: Error = new Error(`level ${level} refresh=${DEEP_REFRESH} access=${DEEP_ACCESS}`)
  for (let l = level - 1; l >= 0; l--) node = new Error(`level ${l}`, { cause: node })
  return node
}

describe('round 3 / point 2: deep and cyclic cause chains', () => {
  for (const level of [6, 10]) {
    it(`a token on cause level ${level} is not visible anywhere in the chain, and nothing throws`, async () => {
      const p = add(`Deep ${level}`, DEEP_ACCESS, DEEP_REFRESH)
      const auth = failingAuth(() => chainWithTokenAt(level))
      const err = await rejection(refreshOAuthCredentialsLocked(p.id, auth, cred(DEEP_ACCESS, DEEP_REFRESH)))
      expect(err.message).toBe('level 0')
      expectNoTokenFragment(err, [DEEP_ACCESS, DEEP_REFRESH])
    })
  }

  it('a cyclic plain-object cause carrying a token is redacted, nothing throws', async () => {
    const p = add('Cyclic object', DEEP_ACCESS, DEEP_REFRESH)
    const auth = failingAuth(() => {
      const body: Record<string, unknown> = { refresh_token: DEEP_REFRESH, access_token: DEEP_ACCESS }
      body.self = body
      return new Error('invalid_grant', { cause: { response: body } })
    })
    const err = await rejection(refreshOAuthCredentialsLocked(p.id, auth, cred(DEEP_ACCESS, DEEP_REFRESH)))
    expect(err.message).toBe('invalid_grant')
    expectNoTokenFragment(err, [DEEP_ACCESS, DEEP_REFRESH])
  })

  it('a cyclic error chain (cause points back to the top error) is redacted, nothing throws', async () => {
    const p = add('Cyclic error', DEEP_ACCESS, DEEP_REFRESH)
    const auth = failingAuth(() => {
      const top = new Error(`top refresh=${DEEP_REFRESH}`)
      const inner = new Error(`inner access=${DEEP_ACCESS}`, { cause: top })
      ;(top as { cause?: unknown }).cause = inner
      return top
    })
    const err = await rejection(refreshOAuthCredentialsLocked(p.id, auth, cred(DEEP_ACCESS, DEEP_REFRESH)))
    expect(err.message).toBe('top refresh=[redacted]')
    expectNoTokenFragment(err, [DEEP_ACCESS, DEEP_REFRESH])
  })

  it('a string cause carrying a token is redacted, nothing throws', async () => {
    const p = add('String cause', DEEP_ACCESS, DEEP_REFRESH)
    const auth = failingAuth(() => new Error('invalid_grant', { cause: `refresh_token=${DEEP_REFRESH}&access_token=${DEEP_ACCESS}` }))
    const err = await rejection(refreshOAuthCredentialsLocked(p.id, auth, cred(DEEP_ACCESS, DEEP_REFRESH)))
    expect(err.message).toBe('invalid_grant')
    expect((err as { cause?: unknown }).cause).toBe('refresh_token=[redacted]&access_token=[redacted]')
    expectNoTokenFragment(err, [DEEP_ACCESS, DEEP_REFRESH])
  })
})
