/**
 * Kimi Code (subscription) OAuth login, region aware.
 *
 * pi-ai ships a Kimi Code device flow, but it is pinned to the China auth host
 * (`auth.kimi.com`, overridable only through a process-wide env var), so it
 * cannot serve an international account next to a China one. This module is a
 * small RFC 8628 device authorization grant with the same wire contract as
 * pi-ai's flow (and Moonshot's official CLI), parameterised by region:
 *
 *   China          auth.kimi.com   →  api.kimi.com/coding
 *   International  auth.kimi.ai    →  api.kimi.ai/coding
 *
 * The region is chosen once at login and stored inside the (encrypted)
 * credential, so a token refresh always goes back to the host that issued the
 * token, and the provider's API base is derived from the same region entry.
 *
 * The access token authenticates as `Authorization: Bearer` against the
 * Anthropic-messages endpoint `/coding` (the same wire the plan API key uses),
 * exactly like pi-ai's `kimi-coding` provider. See `pi-models.ts` for how the
 * token is moved from `apiKey` into that header.
 *
 * Never log token material: errors carry status codes and OAuth error codes
 * only, never response bodies.
 */
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'

/**
 * Client id of Moonshot's official Kimi Code CLI — the same public client id
 * pi-ai's own Kimi flow uses. Kimi does not register third-party clients;
 * using it is a deliberate operator decision (see docs/guide/models.md).
 */
export const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098' // gitleaks:allow -- public OAuth client id, not a secret

export type KimiCodingRegion = 'cn' | 'intl'

/**
 * `model.provider` of Kimi Code OAuth models. Distinct from pi-ai's
 * `kimi-coding` so pi-models.ts can send the token as a Bearer header while
 * API-key `kimi-coding` providers keep sending `x-api-key` unchanged.
 */
export const KIMI_CODING_OAUTH_MODEL_PROVIDER = 'kimi-coding-oauth'

export interface KimiCodingRegionInfo {
  region: KimiCodingRegion
  /** OAuth host (device authorization + token endpoint). */
  authHost: string
  /** Anthropic-messages base URL of the coding plan (the provider baseUrl). */
  apiBaseUrl: string
  /** Management base (OpenAI-style `/coding/v1`), used for the usage endpoint. */
  managementBaseUrl: string
}

/** Single source of truth: auth host and API base always come from one entry. */
export const KIMI_CODING_REGIONS: Readonly<Record<KimiCodingRegion, KimiCodingRegionInfo>> = {
  cn: {
    region: 'cn',
    authHost: 'https://auth.kimi.com',
    apiBaseUrl: 'https://api.kimi.com/coding',
    managementBaseUrl: 'https://api.kimi.com/coding/v1',
  },
  intl: {
    region: 'intl',
    authHost: 'https://auth.kimi.ai',
    apiBaseUrl: 'https://api.kimi.ai/coding',
    managementBaseUrl: 'https://api.kimi.ai/coding/v1',
  },
}

/** Default region: China, matching the API-key preset's historical default. */
export const DEFAULT_KIMI_CODING_REGION: KimiCodingRegion = 'cn'

function hostOf(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Region for a provider base URL (`api.kimi.ai` → intl, anything else → cn). */
export function kimiCodingRegionForBaseUrl(baseUrl: string | undefined | null): KimiCodingRegion {
  const host = hostOf(baseUrl)
  if (host === 'kimi.ai' || host?.endsWith('.kimi.ai')) return 'intl'
  return DEFAULT_KIMI_CODING_REGION
}

export function isKimiCodingRegion(value: unknown): value is KimiCodingRegion {
  return value === 'cn' || value === 'intl'
}

/**
 * Region recorded in a credential, or `null` when it carries none. There is
 * deliberately NO fallback to the provider's (editable) base URL: a token
 * belongs to the host that issued it, and guessing that host from a URL the
 * user can change would send it to the wrong region.
 */
export function kimiCodingRegionOfCredential(
  credential: { region?: unknown } | undefined,
): KimiCodingRegion | null {
  if (credential && isKimiCodingRegion(credential.region)) return credential.region
  return null
}

/** Like {@link kimiCodingRegionOfCredential}, but a missing region demands a new sign-in. */
export function requireKimiCodingRegionOfCredential(credential: { region?: unknown } | undefined): KimiCodingRegion {
  const region = kimiCodingRegionOfCredential(credential)
  if (!region) throw new KimiCodingReloginRequiredError('the stored sign-in has no region')
  return region
}

/** Hard cap on a device code's lifetime, whatever the server announces. */
export const KIMI_DEVICE_CODE_MAX_SECONDS = 15 * 60
const DEVICE_CODE_TIMEOUT_SECONDS = KIMI_DEVICE_CODE_MAX_SECONDS
const DEFAULT_POLL_INTERVAL_SECONDS = 5
const REQUEST_TIMEOUT_MS = 30_000
const REFRESH_MAX_RETRIES = 3
/** Refresh this long before the access token expires on paper. */
export const KIMI_TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000

/** Thrown when the refresh token is dead and the user has to sign in again. */
export class KimiCodingReloginRequiredError extends Error {
  readonly reloginRequired = true
  constructor(detail: string) {
    super(`Kimi Code sign-in expired (${detail}). Open Settings → Providers and use "Renew token" to sign in again.`)
    this.name = 'KimiCodingReloginRequiredError'
  }
}

export interface KimiDeviceFlowDeps {
  fetch?: typeof fetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Category of a transport failure (fetch threw). The exception message itself
 * is never passed on: custom fetch implementations, proxies or instrumentation
 * may put the URL, headers or body (token material) into it.
 */
export function kimiTransportErrorCategory(err: unknown): 'timeout' | 'aborted' | 'network error' {
  const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined
  if (name === 'TimeoutError') return 'timeout'
  if (name === 'AbortError') return 'aborted'
  return 'network error'
}

/** fetch with a constant, token-free error on transport failure. */
async function kimiFetch(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await doFetch(url, init)
  } catch (err) {
    throw new Error(`${operation} failed (${kimiTransportErrorCategory(err)})`)
  }
}

/**
 * Defensive redaction: replaces every given secret (access/refresh token, API
 * key) inside a message. Secrets shorter than 8 characters are skipped so a
 * placeholder cannot shred unrelated text.
 */
export function redactSecrets(message: string, secrets: ReadonlyArray<string | undefined | null>): string {
  let out = message
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue
    out = out.split(secret).join('[redacted]')
  }
  return out
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const json: unknown = await response.json()
    return json && typeof json === 'object' ? json as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The verification URI is opened in the user's browser; only https URLs are trusted. */
function trustedHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Only short OAuth error codes are echoed into messages — never bodies. */
function oauthErrorCode(json: Record<string, unknown> | null): string | undefined {
  const code = json?.error
  return typeof code === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : undefined
}

export interface KimiDeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresInSeconds: number
}

export async function startKimiDeviceAuthorization(
  region: KimiCodingRegion,
  signal: AbortSignal,
  deps: KimiDeviceFlowDeps = {},
): Promise<KimiDeviceAuthorization> {
  const doFetch = deps.fetch ?? fetch
  const { authHost } = KIMI_CODING_REGIONS[region]
  const response = await kimiFetch(doFetch, `${authHost}/api/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: KIMI_CODE_CLIENT_ID }).toString(),
    signal: requestSignal(signal),
  }, 'Kimi Code device authorization')
  const json = await readJson(response)
  if (!response.ok) {
    const code = oauthErrorCode(json)
    throw new Error(`Kimi Code device authorization failed (status ${response.status}${code ? `, ${code}` : ''})`)
  }
  const deviceCode = json?.device_code
  const userCode = json?.user_code
  const verificationUri = trustedHttpsUrl(json?.verification_uri_complete) ?? trustedHttpsUrl(json?.verification_uri)
  if (typeof deviceCode !== 'string' || !deviceCode || typeof userCode !== 'string' || !userCode || !verificationUri) {
    throw new Error('Invalid Kimi Code device authorization response')
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    intervalSeconds: positiveNumber(json?.interval, DEFAULT_POLL_INTERVAL_SECONDS),
    expiresInSeconds: Math.min(positiveNumber(json?.expires_in, DEVICE_CODE_TIMEOUT_SECONDS), KIMI_DEVICE_CODE_MAX_SECONDS),
  }
}

export interface KimiTokenSet {
  access: string
  refresh: string
  expires: number
}

function parseTokenResponse(json: Record<string, unknown> | null, operation: string, now: number): KimiTokenSet {
  const access = json?.access_token
  const refresh = json?.refresh_token
  const expiresIn = json?.expires_in
  if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh
    || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    // Field names only: the body may contain token material.
    throw new Error(`Kimi Code token ${operation} response is missing fields`)
  }
  // Refresh a little before the real expiry so no request races the deadline.
  const lifetimeMs = expiresIn * 1000
  const skew = Math.min(KIMI_TOKEN_EXPIRY_SKEW_MS, lifetimeMs / 2)
  return { access, refresh, expires: now + lifetimeMs - skew }
}

export async function pollKimiDeviceToken(
  region: KimiCodingRegion,
  device: KimiDeviceAuthorization,
  signal: AbortSignal,
  deps: KimiDeviceFlowDeps = {},
): Promise<KimiTokenSet> {
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const { authHost } = KIMI_CODING_REGIONS[region]
  const deadline = now() + device.expiresInSeconds * 1000
  let intervalMs = device.intervalSeconds * 1000

  while (now() < deadline) {
    await sleep(intervalMs, signal)
    const response = await kimiFetch(doFetch, `${authHost}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: KIMI_CODE_CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      signal: requestSignal(signal),
    }, 'Kimi Code device token request')
    const json = await readJson(response)
    if (response.ok && typeof json?.access_token === 'string') {
      return parseTokenResponse(json, 'exchange', now())
    }
    const code = oauthErrorCode(json)
    if (code === 'authorization_pending') continue
    if (code === 'slow_down') {
      // RFC 8628 §3.5: add 5 seconds to the interval on every slow_down.
      intervalMs += 5000
      continue
    }
    if (code === 'expired_token') throw new Error('Kimi Code device code expired. Please start the sign-in again.')
    if (code === 'access_denied') throw new Error('Kimi Code sign-in was denied.')
    throw new Error(`Kimi Code device token request failed (status ${response.status}${code ? `, ${code}` : ''})`)
  }
  throw new Error('Kimi Code device code expired. Please start the sign-in again.')
}

export async function refreshKimiToken(
  region: KimiCodingRegion,
  refreshToken: string,
  signal: AbortSignal,
  deps: KimiDeviceFlowDeps = {},
): Promise<KimiTokenSet> {
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const { authHost } = KIMI_CODING_REGIONS[region]
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1), signal)
    if (signal.aborted) throw new Error('Kimi Code token refresh aborted')
    let response: Response
    try {
      response = await doFetch(`${authHost}/api/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: KIMI_CODE_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        signal: requestSignal(signal),
      })
    } catch (err) {
      // Category only: the exception message may carry the refresh token.
      lastError = new Error(`Kimi Code token refresh failed (${kimiTransportErrorCategory(err)})`)
      continue
    }
    const json = await readJson(response)
    if (response.ok) return parseTokenResponse(json, 'refresh', now())
    const code = oauthErrorCode(json)
    if (response.status === 401 || response.status === 403 || code === 'invalid_grant') {
      throw new KimiCodingReloginRequiredError(`status ${response.status}${code ? `, ${code}` : ''}`)
    }
    if ((response.status === 429 || response.status >= 500) && attempt < REFRESH_MAX_RETRIES) {
      lastError = new Error(`Kimi Code token refresh failed (status ${response.status})`)
      continue
    }
    throw new Error(`Kimi Code token refresh failed (status ${response.status}${code ? `, ${code}` : ''})`)
  }
  throw lastError ?? new Error('Kimi Code token refresh failed')
}

/**
 * The pi-ai `OAuthAuth` for one region. `refresh()` follows the region stored
 * in the credential (a credential always returns to the host that issued it);
 * the factory region only applies to `login()`.
 */
export function createKimiCodingOAuth(
  loginRegion: KimiCodingRegion = DEFAULT_KIMI_CODING_REGION,
  deps: KimiDeviceFlowDeps = {},
): OAuthAuth {
  return {
    name: 'Kimi Code (subscription)',
    isSubscription: true,
    loginLabel: 'Sign in with Kimi Code',
    async login(interaction) {
      const device = await startKimiDeviceAuthorization(loginRegion, interaction.signal, deps)
      interaction.notify({
        type: 'device_code',
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        intervalSeconds: device.intervalSeconds,
        expiresInSeconds: device.expiresInSeconds,
      })
      const token = await pollKimiDeviceToken(loginRegion, device, interaction.signal, deps)
      return { type: 'oauth', ...token, region: loginRegion }
    },
    async refresh(credential: OAuthCredential, signal: AbortSignal) {
      // The issuing region is authoritative; without one, sign in again.
      const region = requireKimiCodingRegionOfCredential(credential as { region?: unknown })
      const token = await refreshKimiToken(region, credential.refresh, signal, deps)
      return { ...credential, type: 'oauth', ...token, region }
    },
    async toAuth(credential: OAuthCredential) {
      // No region → no token: the API host would be a guess.
      requireKimiCodingRegionOfCredential(credential as { region?: unknown })
      // Returned as apiKey so the existing OAuth plumbing (getApiKeyForProvider,
      // agent getApiKey callbacks) carries it; pi-models.ts sends it as Bearer.
      return { apiKey: credential.access }
    },
  }
}

/**
 * Optional, default-OFF CLI identity headers. Moonshot's official CLI sends
 * `User-Agent: kimi-code-cli/<version>` plus `X-Msh-Platform`, `X-Msh-Version`,
 * `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Os-Version` and
 * `X-Msh-Device-Id`. pi-ai sends none of these and Offtangent follows pi-ai by
 * default. Only if the coding endpoint starts rejecting OAuth requests without
 * them, setting `KIMI_CODING_CLI_HEADERS=1` adds a minimal, non-identifying
 * subset (no hostname, no device model, no OS version, no device id).
 */
export const KIMI_CLI_HEADERS_ENV = 'KIMI_CODING_CLI_HEADERS'
export const KIMI_CLI_HEADER_VERSION = '1.0.0'

export function kimiCliIdentityHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const flag = env[KIMI_CLI_HEADERS_ENV]?.trim().toLowerCase()
  if (flag !== '1' && flag !== 'true') return {}
  return {
    'User-Agent': `kimi-code-cli/${KIMI_CLI_HEADER_VERSION}`,
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': KIMI_CLI_HEADER_VERSION,
  }
}
