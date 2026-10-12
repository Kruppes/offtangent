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

export interface QuotaFetchOptions {
  /**
   * Set for an explicit manual refresh. Adapters that keep their own pauses
   * may use it to bypass a pause that only the user can resolve (e.g. a
   * refused key); adapters without own state ignore it.
   */
  force?: boolean
}

/**
 * Pluggable per-provider-family quota adapter. Adding a new subscriber quota
 * source means implementing one of these and registering it in
 * `quota-registry.ts` — the monitor, HTTP layer, and UI stay untouched.
 */
export interface QuotaProviderAdapter {
  kind: ProviderQuotaContract['kind']
  /**
   * Failures are not shown: the monitor stores no error entry for this
   * adapter (a balance is a nice-to-have, not something the user must fix).
   */
  quietErrors?: boolean
  /** Whether this adapter handles the given provider. */
  matches: (provider: ProviderConfig) => boolean
  /**
   * Optional non-reversible fingerprint of the credential the adapter uses
   * (e.g. a shortened SHA-256 of the API key). The monitor binds its
   * rate-limit backoff to it and drops the backoff when it changes, so a new
   * key is asked right away. Adapters without it (OAuth, subscriptions) keep
   * a backoff bound to the provider id only.
   */
  credentialFingerprint?: (provider: ProviderConfig) => string | undefined
  /** Resolve credentials, fetch, and normalize the provider's usage quota. */
  fetch: (provider: ProviderConfig, fetchImpl?: typeof fetch, options?: QuotaFetchOptions) => Promise<ProviderQuotaFetchResult>
}

/**
 * Parse an HTTP `Retry-After` header (seconds or HTTP-date) into milliseconds.
 * Returns undefined when the header is absent, unparseable, not positive, or
 * not a finite number of milliseconds (e.g. `1e309`, `-5`, `NaN`, a date in
 * the past). Callers fall back to their own backoff then.
 */
export function parseRetryAfterMs(header: string | null, nowMs: number = Date.now()): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (!trimmed) return undefined

  const seconds = Number(trimmed)
  if (!Number.isNaN(seconds)) {
    // A numeric header is never read as a date, even when it is unusable.
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined
    const ms = seconds * 1000
    if (!Number.isFinite(ms)) return undefined
    const rounded = Math.round(ms)
    return rounded > 0 ? rounded : undefined
  }

  const retryAt = new Date(trimmed).getTime()
  if (Number.isFinite(retryAt)) {
    const diff = retryAt - nowMs
    if (Number.isFinite(diff) && diff > 0) return diff
  }

  return undefined
}

/**
 * Wait time that can be added to `nowMs` without leaving the safe integer
 * range: non-finite or negative values become 0, huge ones are capped so that
 * `nowMs + result <= Number.MAX_SAFE_INTEGER`.
 */
export function clampWaitMs(waitMs: number, nowMs: number): number {
  if (Number.isNaN(waitMs) || waitMs <= 0) return 0
  return Math.min(waitMs, Math.max(0, Number.MAX_SAFE_INTEGER - nowMs))
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
