import type { ProviderConfig } from './provider-config.js'
import { getApiKeyForProvider, storedToOAuthCredentials } from './provider-config.js'
import type { ProviderQuotaContract, ProviderQuotaWindowContract } from './contracts/providers.js'
import {
  KIMI_CODING_REGIONS,
  kimiCodingRegionForBaseUrl,
  kimiCodingRegionOfCredential,
  type KimiCodingRegion,
} from './kimi-coding-oauth.js'
import {
  normalizeUtilization,
  parseRetryAfterMs,
  type ProviderQuotaFetchResult,
  type QuotaProviderAdapter,
} from './provider-quota.js'

/**
 * Kimi Code subscription usage (`GET {region}/coding/v1/usages`, Bearer).
 *
 * The endpoint is NOT publicly documented — the shape below is what Moonshot's
 * official CLI reads (packages/oauth/src/managed-usage.ts): snake_case
 * `usages.limit_5h | limit_7d | limit_month_total | limit_month_code`, each
 * `{ used_ratio, reset_time }`, plus an optional `boosterWallet`. The parser
 * accepts the camelCase spelling as well and never throws: an unexpected body
 * only means "no quota", it must never affect the provider itself.
 *
 * The CLI only calls it for OAuth sign-ins. For a plan API key it is tried as
 * well; 401/403/404 then quietly reports "not available" and is not retried for
 * a while (no per-minute hammering of an endpoint that will keep refusing).
 */

const REQUEST_TIMEOUT_MS = 8_000
/** How long an API-key provider whose key the endpoint refused is skipped. */
export const KIMI_QUOTA_UNSUPPORTED_RETRY_MS = 6 * 60 * 60 * 1000
export const KIMI_QUOTA_UNAVAILABLE = 'Usage is not available for this Kimi Code API key'

const WINDOW_SPECS: ReadonlyArray<{
  key: string
  label: string
  resetDisplay: 'relative' | 'absolute'
  fields: readonly string[]
}> = [
  { key: 'five_hour', label: '5h', resetDisplay: 'relative', fields: ['limit_5h', 'limit5h'] },
  { key: 'weekly', label: '7d', resetDisplay: 'absolute', fields: ['limit_7d', 'limit7d'] },
  { key: 'month_total', label: 'Month', resetDisplay: 'absolute', fields: ['limit_month_total', 'monthTotal'] },
  { key: 'month_code', label: 'Month (code)', resetDisplay: 'absolute', fields: ['limit_month_code', 'monthCode'] },
]

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

/**
 * `used_ratio` is a fraction (0..1) in the CLI. A value clearly above 1 is
 * read as a percentage, so a server-side switch to percent does not show 100x.
 */
function ratioToPercent(ratio: number): number {
  return normalizeUtilization(ratio > 1.5 ? ratio : ratio * 100)
}

function parseResetAt(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : new Date(ms).toISOString()
  }
  const n = finiteNumber(value)
  if (n === undefined || n <= 0) return null
  // Epoch seconds vs. milliseconds.
  const ms = n < 1e12 ? n * 1000 : n
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function parseWindow(raw: unknown, spec: (typeof WINDOW_SPECS)[number]): ProviderQuotaWindowContract | null {
  if (!isRecord(raw)) return null
  const ratio = finiteNumber(raw.used_ratio ?? raw.usedRatio)
  if (ratio === undefined || ratio < 0) return null
  return {
    key: spec.key,
    label: spec.label,
    utilization: ratioToPercent(ratio),
    resetsAt: parseResetAt(raw.reset_time ?? raw.resetAt ?? raw.reset_at),
    resetDisplay: spec.resetDisplay,
  }
}

/** Booster wallet ("extra usage") as a short plan suffix, or null. */
function parseExtraUsage(payload: Record<string, unknown>): string | null {
  const wallet = payload.boosterWallet ?? payload.booster_wallet ?? payload.extraUsage
  if (!isRecord(wallet)) return null
  const balance = isRecord(wallet.balance) ? wallet.balance : null
  if (balance) {
    // CLI: amounts are fixed-point (1e6 per cent).
    const amount = finiteNumber(balance.amount)
    const left = finiteNumber(balance.amountLeft ?? balance.amount_left)
    if (amount === undefined || amount <= 0 || left === undefined) return null
    const pctLeft = Math.max(0, Math.min(100, Math.round((left / amount) * 100)))
    return `Booster ${pctLeft}% left`
  }
  const balanceCents = finiteNumber(wallet.balanceCents)
  const totalCents = finiteNumber(wallet.totalCents)
  if (balanceCents === undefined || totalCents === undefined || totalCents <= 0) return null
  return `Booster ${Math.max(0, Math.min(100, Math.round((balanceCents / totalCents) * 100)))}% left`
}

/**
 * Parse a `/usages` body into normalized windows. Never throws; returns null
 * when nothing usable is in it.
 */
export function parseKimiUsagePayload(payload: unknown, now: Date = new Date()): ProviderQuotaContract | null {
  try {
    if (!isRecord(payload)) return null
    const usages = isRecord(payload.usages) ? payload.usages : payload
    const windows: ProviderQuotaWindowContract[] = []
    for (const spec of WINDOW_SPECS) {
      const raw = spec.fields.map(field => usages[field]).find(value => value !== undefined)
      const window = parseWindow(raw, spec)
      if (window) windows.push(window)
    }
    if (windows.length === 0) return null
    return {
      kind: 'kimi-coding',
      windows,
      plan: parseExtraUsage(payload),
      fetchedAt: now.toISOString(),
    }
  } catch {
    return null
  }
}

/** Every Kimi Code subscription provider: OAuth sign-in or plan API key. */
export function isKimiCodingQuotaProvider(provider: ProviderConfig): boolean {
  if (provider.providerType === 'kimi-coding-oauth') {
    return provider.authMethod === 'oauth' && !!provider.oauthCredentials
  }
  return provider.providerType === 'kimi-coding' && provider.authMethod !== 'oauth' && !!provider.apiKey
}

/** Region of the provider: OAuth follows the credential, API key the base URL. */
export function kimiQuotaRegion(provider: ProviderConfig): KimiCodingRegion {
  if (provider.providerType === 'kimi-coding-oauth' && provider.oauthCredentials) {
    try {
      return kimiCodingRegionOfCredential(
        storedToOAuthCredentials(provider.oauthCredentials) as { region?: unknown },
        provider.baseUrl,
      )
    } catch {
      // fall through to the base URL
    }
  }
  return kimiCodingRegionForBaseUrl(provider.baseUrl)
}

export function kimiUsageUrl(region: KimiCodingRegion): string {
  return `${KIMI_CODING_REGIONS[region].managementBaseUrl}/usages`
}

export async function fetchKimiUsage(
  region: KimiCodingRegion,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  try {
    const response = await fetchImpl(kimiUsageUrl(region), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
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
      return { quota: null, status: response.status, error: 'Kimi Code usage API returned no JSON' }
    }
    const quota = parseKimiUsagePayload(body)
    if (!quota) {
      return { quota: null, status: response.status, error: 'Kimi Code usage API returned no usable windows' }
    }
    return { quota, status: response.status }
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Network error' }
  }
}

/** provider id → time until which an API key the endpoint refused is skipped. */
const unsupportedUntil = new Map<string, number>()

/** Test hook. */
export function resetKimiQuotaState(): void {
  unsupportedUntil.clear()
}

export async function getKimiCodingQuotaForProvider(
  provider: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ProviderQuotaFetchResult> {
  if (!isKimiCodingQuotaProvider(provider)) {
    return { quota: null, error: 'Provider is not a Kimi Code subscriber' }
  }
  const isApiKey = provider.providerType === 'kimi-coding'
  const skippedUntil = unsupportedUntil.get(provider.id)
  if (isApiKey && skippedUntil !== undefined && now() < skippedUntil) {
    return { quota: null, error: KIMI_QUOTA_UNAVAILABLE }
  }

  let token: string
  try {
    // OAuth: refreshes an expiring token like a normal turn would.
    token = await getApiKeyForProvider(provider)
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Failed to resolve credentials' }
  }
  if (!token) return { quota: null, error: 'No credentials available' }

  const result = await fetchKimiUsage(kimiQuotaRegion(provider), token, fetchImpl)
  if (isApiKey && (result.status === 401 || result.status === 403 || result.status === 404)) {
    unsupportedUntil.set(provider.id, now() + KIMI_QUOTA_UNSUPPORTED_RETRY_MS)
    return { quota: null, status: result.status, error: KIMI_QUOTA_UNAVAILABLE }
  }
  if (result.quota) unsupportedUntil.delete(provider.id)
  return result
}

export const kimiCodingQuotaAdapter: QuotaProviderAdapter = {
  kind: 'kimi-coding',
  matches: isKimiCodingQuotaProvider,
  fetch: (provider, fetchImpl) => getKimiCodingQuotaForProvider(provider, fetchImpl),
}
