import { createHash } from 'node:crypto'
import type { ProviderConfig } from './provider-config.js'
import { getApiKeyForProvider } from './provider-config.js'
import type { ProviderQuotaBalanceContract, ProviderQuotaContract } from './contracts/providers.js'
import { redactSecrets } from './kimi-coding-oauth.js'
import { parseRetryAfterMs, type ProviderQuotaFetchResult, type QuotaProviderAdapter } from './provider-quota.js'

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
 * the response. Anything that is not a moonshot.cn host counts as
 * international.
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

const REGION_CURRENCY: Record<MoonshotRegion, string> = {
  intl: 'USD',
  cn: 'CNY',
}

/** A key the endpoint refused (401/403/404) is not asked again for this long. */
export const MOONSHOT_BALANCE_REFUSED_RETRY_MS = 6 * 60 * 60 * 1000
/** First pause after a 5xx/network failure; doubles per failure up to the max. */
export const MOONSHOT_BALANCE_INITIAL_BACKOFF_MS = 20 * 60 * 1000
export const MOONSHOT_BALANCE_MAX_BACKOFF_MS = 2 * 60 * 60 * 1000

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

/** Region of a Moonshot base URL: `cn` for a moonshot.cn host, otherwise `intl`. */
export function moonshotRegionForBaseUrl(baseUrl: string | undefined | null): MoonshotRegion {
  if (!baseUrl) return 'intl'
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'moonshot.cn' || host.endsWith('.moonshot.cn') ? 'cn' : 'intl'
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
  const amount = available ?? (cash !== undefined || voucher !== undefined ? (cash ?? 0) + (voucher ?? 0) : undefined)
  if (amount === undefined) return null
  return {
    amount,
    currency: REGION_CURRENCY[region],
    cash: cash ?? null,
    voucher: voucher ?? null,
  }
}

export function isMoonshotBalanceProvider(provider: ProviderConfig): boolean {
  return provider.providerType === 'kimi' && provider.authMethod !== 'oauth' && !!provider.apiKey
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

interface ProviderPause {
  until: number
  backoffMs: number
  /** Hash of the key the pause was set for; a new key lifts the pause. */
  keyTag: string
}

function keyTag(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
}

/** provider id → time until which the balance is not requested again. */
const pausedUntil = new Map<string, ProviderPause>()

/** Test hook. */
export function resetMoonshotBalanceState(): void {
  pausedUntil.clear()
}

export async function getMoonshotBalanceForProvider(
  provider: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  logger: Pick<typeof console, 'warn'> = console,
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
  const pause = pausedUntil.get(provider.id)
  if (pause && pause.keyTag === tag && now() < pause.until) {
    return { quota: null, error: 'Moonshot balance paused after an earlier failure' }
  }

  const region = moonshotRegionForBaseUrl(provider.baseUrl)
  const result = await fetchMoonshotBalance(region, apiKey, fetchImpl)
  if (result.quota) {
    pausedUntil.delete(provider.id)
    return result
  }

  const status = result.status
  const error = redactSecrets(result.error ?? 'Failed to fetch balance', [apiKey, provider.apiKey])
  // Provider name and region only — never the key or the request headers.
  logger.warn(`[axiom] Moonshot balance for "${provider.name}" (${region}) unavailable: ${error}`)
  if (status === 401 || status === 403 || status === 404) {
    pausedUntil.set(provider.id, { until: now() + MOONSHOT_BALANCE_REFUSED_RETRY_MS, backoffMs: MOONSHOT_BALANCE_REFUSED_RETRY_MS, keyTag: tag })
  } else if (status !== 429) {
    // 5xx / network / timeout / unusable body: exponential backoff. 429 is
    // left to the quota monitor's Retry-After backoff.
    const previous = pause?.keyTag === tag ? pause.backoffMs : undefined
    const backoffMs = previous && previous < MOONSHOT_BALANCE_REFUSED_RETRY_MS
      ? Math.min(previous * 2, MOONSHOT_BALANCE_MAX_BACKOFF_MS)
      : MOONSHOT_BALANCE_INITIAL_BACKOFF_MS
    pausedUntil.set(provider.id, { until: now() + backoffMs, backoffMs, keyTag: tag })
  }
  return { ...result, error }
}

export const moonshotBalanceAdapter: QuotaProviderAdapter = {
  kind: 'moonshot',
  quietErrors: true,
  matches: isMoonshotBalanceProvider,
  fetch: (provider, fetchImpl) => getMoonshotBalanceForProvider(provider, fetchImpl),
}
