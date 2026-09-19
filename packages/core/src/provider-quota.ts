import type { ProviderQuotaContract } from './contracts/providers.js'
import type { ProviderConfig } from './provider-config.js'

/**
 * Result of fetching a single provider's subscriber usage quota.
 *
 * `status` / `retryAfterMs` are surfaced so the background monitor can apply
 * per-provider rate-limit backoff; `error` is a short human-readable summary
 * shown in the UI when no usable snapshot exists yet.
 */
export interface ProviderQuotaFetchResult {
  quota: ProviderQuotaContract | null
  status?: number
  retryAfterMs?: number
  error?: string
}

/**
 * Pluggable per-provider-family quota adapter. Adding a new subscriber quota
 * source means implementing one of these and registering it in
 * `quota-registry.ts` — the monitor, HTTP layer, and UI stay untouched.
 */
export interface QuotaProviderAdapter {
  kind: ProviderQuotaContract['kind']
  /** Whether this adapter handles the given provider. */
  matches: (provider: ProviderConfig) => boolean
  /** Resolve credentials, fetch, and normalize the provider's usage quota. */
  fetch: (provider: ProviderConfig, fetchImpl?: typeof fetch) => Promise<ProviderQuotaFetchResult>
}

/**
 * Parse an HTTP `Retry-After` header (seconds or HTTP-date) into milliseconds.
 * Returns undefined when the header is absent or unparseable.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined

  const seconds = Number(header)
  if (!Number.isNaN(seconds) && seconds > 0) {
    return Math.round(seconds * 1000)
  }

  const retryAt = new Date(header).getTime()
  if (!Number.isNaN(retryAt)) {
    const diff = retryAt - Date.now()
    if (diff > 0) return diff
  }

  return undefined
}

/** Clamp a raw utilization value to an integer percentage in [0, 100]. */
export function normalizeUtilization(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

/**
 * Turn a rate-limit window length (in seconds) into a short label such as
 * `5h`, `7d`, `30m`. The two common ChatGPT windows (`18000` = 5h, `604800`
 * = 7d) are special-cased so rounding never drifts them off the canonical
 * label.
 */
export function limitWindowLabel(seconds: number): string {
  if (seconds === 18_000) return '5h'
  if (seconds === 604_800) return '7d'
  if (seconds % 86_400 === 0) return `${Math.round(seconds / 86_400)}d`
  if (seconds % 3_600 === 0) return `${Math.round(seconds / 3_600)}h`
  return `${Math.round(seconds / 60)}m`
}
