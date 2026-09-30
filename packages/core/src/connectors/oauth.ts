import crypto from 'node:crypto'
import type { ConnectorManifest, ConnectorTokens } from './types.js'

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
/**
 * How many pending authorizations may exist at once. Without a cap an
 * unauthenticated `/authorize` loop grows the map until the process dies; 20
 * open flows are more than any real operator ever has.
 */
export const OAUTH_STATE_MAX_PENDING = 20
/** Deadline for a token or revoke call — a hung endpoint must not block a request. */
export const OAUTH_REQUEST_TIMEOUT_MS = 20_000
/** Refresh this far ahead of the recorded expiry so a call never races it. */
export const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000

export interface PendingAuthorization {
  connectorId: string
  codeVerifier: string
  redirectUri: string
  expiresAt: number
}

export interface CreatedAuthorization {
  state: string
  codeVerifier: string
  codeChallenge: string
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64Url(crypto.randomBytes(32))
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

/**
 * Server-side, in-memory store of pending authorizations. `state` is the CSRF
 * defence of the public callback: it is single use and short lived, so a
 * replayed or guessed callback has nothing to consume. A process restart
 * invalidates every pending flow, which only costs one extra click.
 */
export interface OAuthStateStore {
  create: (connectorId: string, redirectUri: string) => CreatedAuthorization
  consume: (state: string) => PendingAuthorization | null
  pendingCount: () => number
}

export function createOAuthStateStore(
  options: { ttlMs?: number; now?: () => number; maxPending?: number } = {},
): OAuthStateStore {
  const ttlMs = options.ttlMs ?? OAUTH_STATE_TTL_MS
  const maxPending = Math.max(1, options.maxPending ?? OAUTH_STATE_MAX_PENDING)
  const now = options.now ?? (() => Date.now())
  const pending = new Map<string, PendingAuthorization>()

  const prune = (): void => {
    const current = now()
    for (const [state, entry] of pending) {
      if (entry.expiresAt <= current) pending.delete(state)
    }
  }

  return {
    create(connectorId, redirectUri) {
      prune()
      const { codeVerifier, codeChallenge } = createPkcePair()
      const state = base64Url(crypto.randomBytes(32))
      // Bounded: the oldest flows are dropped first. Losing one costs a click,
      // an unbounded map costs the process.
      while (pending.size >= maxPending) {
        const oldest = pending.keys().next()
        if (oldest.done) break
        pending.delete(oldest.value)
      }
      pending.set(state, { connectorId, codeVerifier, redirectUri, expiresAt: now() + ttlMs })
      return { state, codeVerifier, codeChallenge }
    },
    consume(state) {
      prune()
      const entry = pending.get(state)
      if (!entry) return null
      // Single use: delete before returning, so a replay finds nothing.
      pending.delete(state)
      if (entry.expiresAt <= now()) return null
      return entry
    },
    pendingCount() {
      prune()
      return pending.size
    },
  }
}

let sharedStore: OAuthStateStore | null = null

export function getOAuthStateStore(): OAuthStateStore {
  sharedStore ??= createOAuthStateStore()
  return sharedStore
}

export interface AuthorizeUrlInput {
  manifest: ConnectorManifest
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const endpoints = input.manifest.oauth
  if (!endpoints) throw new Error(`Connector "${input.manifest.id}" has no OAuth endpoints`)

  const url = new URL(endpoints.authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  if (input.manifest.scopes.length > 0) url.searchParams.set('scope', input.manifest.scopes.join(' '))
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  for (const [key, value] of Object.entries(endpoints.authorizeParams ?? {})) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

/**
 * Upstream token error. `code` carries the OAuth2 `error` field; `invalid_grant`
 * means the grant is gone for good and the connector needs a fresh consent —
 * never a retry loop.
 */
export class OAuthTokenError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OAuthTokenError'
  }

  get isInvalidGrant(): boolean {
    return this.code === 'invalid_grant'
  }
}

interface TokenResponseBody {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

async function postTokenRequest(
  tokenUrl: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<ConnectorTokens> {
  let response: Response
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const name = (err as Error)?.name ?? ''
    if (name === 'TimeoutError' || name === 'AbortError') throw new OAuthTokenError('timeout', 'timeout')
    throw new OAuthTokenError('network_error', 'network_error')
  }

  const raw = await response.text()
  let parsed: TokenResponseBody = {}
  try {
    parsed = raw ? (JSON.parse(raw) as TokenResponseBody) : {}
  } catch {
    parsed = {}
  }

  if (!response.ok || parsed.error) {
    const code = parsed.error ?? `http_${response.status}`
    // The description is upstream text, not our secret material, but it is
    // kept short so nothing long lands in a status field or a log line.
    const detail = (parsed.error_description ?? '').slice(0, 200)
    throw new OAuthTokenError(code, detail ? `${code}: ${detail}` : code)
  }

  if (!parsed.access_token) throw new OAuthTokenError('invalid_response', 'Token response carried no access token')

  const expiresAt = typeof parsed.expires_in === 'number' && parsed.expires_in > 0
    ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
    : ''

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? '',
    expiresAt,
    scopes: parsed.scope ? parsed.scope.split(/\s+/).filter(Boolean) : [],
  }
}

export interface CodeExchangeInput {
  tokenUrl: string
  clientId: string
  clientSecret: string
  code: string
  codeVerifier: string
  redirectUri: string
  fetchImpl?: typeof fetch
}

export function exchangeAuthorizationCode(input: CodeExchangeInput): Promise<ConnectorTokens> {
  return postTokenRequest(
    input.tokenUrl,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code_verifier: input.codeVerifier,
    },
    input.fetchImpl ?? fetch,
  )
}

export interface RefreshInput {
  tokenUrl: string
  clientId: string
  clientSecret: string
  refreshToken: string
  fetchImpl?: typeof fetch
}

export function refreshAccessToken(input: RefreshInput): Promise<ConnectorTokens> {
  return postTokenRequest(
    input.tokenUrl,
    {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    },
    input.fetchImpl ?? fetch,
  )
}

export interface RevokeInput {
  revokeUrl: string
  clientId: string
  clientSecret: string
  token: string
  fetchImpl?: typeof fetch
}

/**
 * Best-effort revoke. A refused or unreachable revoke endpoint must not keep a
 * connector connected locally, so the caller deletes either way.
 */
export async function revokeToken(input: RevokeInput): Promise<boolean> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(input.revokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
      body: new URLSearchParams({
        token: input.token,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }).toString(),
    })
    return response.ok
  } catch {
    return false
  }
}

export function isTokenExpired(expiresAt: string, now: number = Date.now()): boolean {
  if (!expiresAt) return true
  const parsed = Date.parse(expiresAt)
  if (Number.isNaN(parsed)) return true
  return parsed - TOKEN_REFRESH_LEEWAY_MS <= now
}
