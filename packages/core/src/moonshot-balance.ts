import { createHash } from 'node:crypto'
import type { ProviderConfig } from './provider-config.js'
import { getApiKeyForProvider } from './provider-config.js'
import type { ProviderQuotaBalanceContract, ProviderQuotaContract } from './contracts/providers.js'
import { redactSecrets } from './kimi-coding-oauth.js'
import {
  clampWaitMs,
  parseRetryAfterMs,
  type ProviderQuotaFetchResult,
  type QuotaFetchOptions,
  type QuotaProviderAdapter,
} from './provider-quota.js'

/**
 * Moonshot platform (pay-as-you-go API key, provider type `kimi`) balance.
 *
 * `GET {host}/v1/users/me/balance` with `Authorization: Bearer <key>` answers
 * `{"code":0,"data":{"available_balance":13.5,"voucher_balance":0,
 * "cash_balance":13.5},"scode":"0x0","status":true}`.
 *
 * Region and currency: the international platform (api.moonshot.ai) bills in
 * USD, the China platform (api.moonshot.cn) in CNY. The endpoint does not name
 * the currency, so it is derived from the host of the provider's base URL —
 * an ASSUMPTION based on the platforms' published pricing, not on a field of
 * the response. Only the exact China API host (api.moonshot.cn, compared
 * case-insensitively and without a trailing dot) counts as China; every other
 * host counts as international.
 *
 * The parser never throws: an unexpected body only means "no balance", it must
 * never affect the provider itself. Errors are logged without the key.
 */

export type MoonshotRegion = 'intl' | 'cn'

const REQUEST_TIMEOUT_MS = 8_000

const REGION_ORIGINS: Record<MoonshotRegion, string> = {
  intl: 'https://api.moonshot.ai',
  cn: 'https://api.moonshot.cn',
}

/** Canonical API host → region. Anything not listed is international. */
const KNOWN_REGION_HOSTS: Record<string, MoonshotRegion> = {
  'api.moonshot.cn': 'cn',
  'api.moonshot.ai': 'intl',
}

const REGION_CURRENCY: Record<MoonshotRegion, string> = {
  intl: 'USD',
  cn: 'CNY',
}

/**
 * A key the endpoint refused (401/403/404) is not asked again for this long by
 * the background poll. A manual refresh (`force`) may still ask once.
 */
export const MOONSHOT_BALANCE_REFUSED_RETRY_MS = 6 * 60 * 60 * 1000
/** First pause after a 5xx/network failure; doubles per failure up to the max. */
export const MOONSHOT_BALANCE_INITIAL_BACKOFF_MS = 20 * 60 * 1000
export const MOONSHOT_BALANCE_MAX_BACKOFF_MS = 2 * 60 * 60 * 1000
/**
 * First pause after a 429; doubles per further 429 up to
 * {@link MOONSHOT_BALANCE_MAX_BACKOFF_MS}. A longer Retry-After wins. The
 * pause also holds for a manual refresh.
 */
export const MOONSHOT_BALANCE_RATE_LIMIT_INITIAL_BACKOFF_MS = 20 * 60 * 1000
/**
 * Upper bound for a Retry-After the balance endpoint sends. A broken or
 * hostile header (days, years) must not silence the balance indefinitely.
 */
export const MOONSHOT_BALANCE_MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** Lower case, without trailing dots (`API.Moonshot.CN.` → `api.moonshot.cn`). */
function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '')
}

/** Region of a Moonshot base URL: `cn` for the China API host, otherwise `intl`. */
export function moonshotRegionForBaseUrl(baseUrl: string | undefined | null): MoonshotRegion {
  if (!baseUrl) return 'intl'
  try {
    const host = canonicalHost(new URL(baseUrl).hostname)
    return KNOWN_REGION_HOSTS[host] ?? 'intl'
  } catch {
    return 'intl'
  }
}

export function moonshotBalanceUrl(region: MoonshotRegion): string {
  return `${REGION_ORIGINS[region]}/v1/users/me/balance`
}

/**
 * Parse the balance body. Returns null for anything that is not a successful
 * answer with a numeric balance (`status:false`, a non-zero `code`, missing
 * `data`, no usable number).
 */
export function parseMoonshotBalancePayload(
  payload: unknown,
  region: MoonshotRegion,
): ProviderQuotaBalanceContract | null {
  if (!isRecord(payload)) return null
  if (payload.status === false) return null
  if (payload.code !== undefined && finiteNumber(payload.code) !== 0) return null
  const data = payload.data
  if (!isRecord(data)) return null
  const available = finiteNumber(data.available_balance ?? data.availableBalance)
  const cash = finiteNumber(data.cash_balance ?? data.cashBalance)
  const voucher = finiteNumber(data.voucher_balance ?? data.voucherBalance)
  // Without available_balance the sum is only trusted when both parts are numbers.
  const amount = available ?? (cash !== undefined && voucher !== undefined ? cash + voucher : undefined)
  if (amount === undefined) return null
  return {
    amount,
    currency: REGION_CURRENCY[region],
    cash: cash ?? null,
    voucher: voucher ?? null,
  }
}

/**
 * True only when the configured base URL is the official Moonshot API host
 * (`api.moonshot.ai` / `api.moonshot.cn`). A key configured for any other host
 * (proxy, gateway, self-hosted) is never sent to the Moonshot balance endpoint.
 */
export function isOfficialMoonshotBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' && Object.hasOwn(KNOWN_REGION_HOSTS, canonicalHost(url.hostname))
  } catch {
    return false
  }
}

export function isMoonshotBalanceProvider(provider: ProviderConfig): boolean {
  return provider.providerType === 'kimi' && provider.authMethod !== 'oauth' && !!provider.apiKey
    && isOfficialMoonshotBaseUrl(provider.baseUrl)
}

/** Category of a transport failure; the message itself may carry headers. */
function transportErrorCategory(err: unknown): string {
  const name = (err as { name?: unknown })?.name
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  return 'network'
}

export async function fetchMoonshotBalance(
  region: MoonshotRegion,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  try {
    const response = await fetchImpl(moonshotBalanceUrl(region), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      return {
        quota: null,
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        error: `HTTP ${response.status}`,
      }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { quota: null, status: response.status, error: 'Moonshot balance API returned no JSON' }
    }
    const balance = parseMoonshotBalancePayload(body, region)
    if (!balance) {
      return { quota: null, status: response.status, error: 'Moonshot balance API returned no usable balance' }
    }
    const quota: ProviderQuotaContract = {
      kind: 'moonshot',
      windows: [],
      balance,
      plan: null,
      fetchedAt: new Date().toISOString(),
    }
    return { quota, status: response.status }
  } catch (err) {
    return { quota: null, error: `Moonshot balance request failed (${transportErrorCategory(err)})` }
  }
}

type PauseReason = 'refused' | 'rate-limit' | 'error'

interface ProviderPause {
  until: number
  reason: PauseReason
  /** Length of the last pause of this reason, the base for doubling. */
  backoffMs: number
  /** Hash of the key the pause was set for; a new key lifts the pause. */
  keyTag: string
}

function keyTag(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
}

/**
 * Fingerprint of the configured key for the monitor's backoff: the same
 * shortened SHA-256 as the adapter's own pauses, never the key itself.
 */
export function moonshotCredentialFingerprint(provider: ProviderConfig): string | undefined {
  return provider.apiKey ? keyTag(provider.apiKey) : undefined
}

/** provider id → time until which the balance is not requested again. */
const pausedUntil = new Map<string, ProviderPause>()

/**
 * Running requests per `providerId:keyTag` (single flight): a call that comes
 * while a request for the same provider and key is still open waits for that
 * request instead of sending a second one — a forced call included.
 */
const inFlight = new Map<string, Promise<ProviderQuotaFetchResult>>()

/** Test hook. */
export function resetMoonshotBalanceState(): void {
  pausedUntil.clear()
  inFlight.clear()
}

function pauseUntil(nowMs: number, waitMs: number): number {
  return nowMs + clampWaitMs(waitMs, nowMs)
}

/** Answer from a running pause, without a request; null when none applies. */
function answerFromPause(
  providerId: string,
  tag: string,
  nowMs: number,
  force: boolean,
): ProviderQuotaFetchResult | null {
  const pause = pausedUntil.get(providerId)
  if (!pause || pause.keyTag !== tag || nowMs >= pause.until) return null
  if (pause.reason === 'rate-limit') {
    return {
      quota: null,
      status: 429,
      retryAfterMs: pause.until - nowMs,
      error: 'Moonshot balance paused after a rate limit',
    }
  }
  // Only a manual refresh may test a refused key again (one request).
  if (pause.reason === 'refused' && force) return null
  return { quota: null, error: 'Moonshot balance paused after an earlier failure' }
}

function nextBackoff(previous: ProviderPause | undefined, reason: PauseReason, tag: string, initialMs: number): number {
  const prev = previous && previous.keyTag === tag && previous.reason === reason ? previous.backoffMs : undefined
  return prev ? Math.min(prev * 2, MOONSHOT_BALANCE_MAX_BACKOFF_MS) : initialMs
}

/**
 * Pauses (all bound to the hash of the key, a new key lifts them):
 * - 401/403/404: {@link MOONSHOT_BALANCE_REFUSED_RETRY_MS}; a manual refresh
 *   (`options.force`) sends exactly one request anyway.
 * - 429: 20 min doubling to 2 h, or the Retry-After when that is longer. Holds
 *   for a manual refresh too; while it runs the result is a 429 carrying the
 *   remaining pause as `retryAfterMs`, so the monitor keeps the last good value.
 * - 5xx / network / unusable body: 20 min doubling to 2 h.
 */
export async function getMoonshotBalanceForProvider(
  provider: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  logger: Pick<typeof console, 'warn'> = console,
  options: QuotaFetchOptions = {},
): Promise<ProviderQuotaFetchResult> {
  if (!isMoonshotBalanceProvider(provider)) {
    return { quota: null, error: 'Provider is not a Moonshot platform API key' }
  }
  let apiKey: string
  try {
    apiKey = await getApiKeyForProvider(provider)
  } catch (err) {
    const message = redactSecrets((err as Error).message || 'Failed to resolve credentials', [provider.apiKey])
    return { quota: null, error: message }
  }
  if (!apiKey) return { quota: null, error: 'No credentials available' }

  const tag = keyTag(apiKey)
  const flightKey = `${provider.id}:${tag}`
  const running = inFlight.get(flightKey)
  if (running) {
    const shared = await running
    // Same result; after a 429 the joined call is answered from the new pause.
    if (shared.status === 429) return answerFromPause(provider.id, tag, now(), false) ?? shared
    return shared
  }

  const paused = answerFromPause(provider.id, tag, now(), !!options.force)
  if (paused) return paused

  const flight = requestAndPause(provider, apiKey, tag, fetchImpl, now, logger)
  inFlight.set(flightKey, flight)
  try {
    return await flight
  } finally {
    if (inFlight.get(flightKey) === flight) inFlight.delete(flightKey)
  }
}

async function requestAndPause(
  provider: ProviderConfig,
  apiKey: string,
  tag: string,
  fetchImpl: typeof fetch,
  now: () => number,
  logger: Pick<typeof console, 'warn'>,
): Promise<ProviderQuotaFetchResult> {
  const region = moonshotRegionForBaseUrl(provider.baseUrl)
  const result = await fetchMoonshotBalance(region, apiKey, fetchImpl)
  if (result.quota) {
    pausedUntil.delete(provider.id)
    return result
  }

  // Read after the answer: the pause may have changed while the request ran.
  const pause = pausedUntil.get(provider.id)
  const status = result.status
  const error = redactSecrets(result.error ?? 'Failed to fetch balance', [apiKey, provider.apiKey])
  // Provider name and region only — never the key or the request headers.
  logger.warn(`[axiom] Moonshot balance for "${provider.name}" (${region}) unavailable: ${error}`)
  const nowMs = now()
  if (status === 401 || status === 403 || status === 404) {
    pausedUntil.set(provider.id, {
      until: pauseUntil(nowMs, MOONSHOT_BALANCE_REFUSED_RETRY_MS),
      reason: 'refused',
      backoffMs: MOONSHOT_BALANCE_REFUSED_RETRY_MS,
      keyTag: tag,
    })
  } else if (status === 429) {
    const backoffMs = nextBackoff(pause, 'rate-limit', tag, MOONSHOT_BALANCE_RATE_LIMIT_INITIAL_BACKOFF_MS)
    const retryAfterMs = result.retryAfterMs
    const validRetryAfter = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    const boundedRetryAfter = validRetryAfter ? Math.min(retryAfterMs, MOONSHOT_BALANCE_MAX_RETRY_AFTER_MS) : 0
    const waitMs = clampWaitMs(Math.max(backoffMs, boundedRetryAfter), nowMs)
    pausedUntil.set(provider.id, { until: nowMs + waitMs, reason: 'rate-limit', backoffMs, keyTag: tag })
    // The monitor's own 429 backoff follows the same pause.
    return { ...result, retryAfterMs: waitMs, error }
  } else {
    // 5xx / network / timeout / unusable body: exponential backoff.
    const backoffMs = nextBackoff(pause, 'error', tag, MOONSHOT_BALANCE_INITIAL_BACKOFF_MS)
    pausedUntil.set(provider.id, { until: pauseUntil(nowMs, backoffMs), reason: 'error', backoffMs, keyTag: tag })
  }
  return { ...result, error }
}

export const moonshotBalanceAdapter: QuotaProviderAdapter = {
  kind: 'moonshot',
  quietErrors: true,
  matches: isMoonshotBalanceProvider,
  credentialFingerprint: moonshotCredentialFingerprint,
  fetch: (provider, fetchImpl, options) => getMoonshotBalanceForProvider(provider, fetchImpl, Date.now, console, options),
}
