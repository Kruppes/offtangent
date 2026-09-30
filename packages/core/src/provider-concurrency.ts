/**
 * Per-provider concurrency limiter (Offtangent strand isolation, goal 4).
 *
 * Strand isolation removes the persona-wide turn lock, so several strands of
 * one persona now hit the SAME provider account at the same time. Subscription
 * providers (Anthropic OAuth in particular) answer a burst of parallel agent
 * sessions with rate-limit / overloaded errors instead of serving them, so the
 * number of in-flight calls per credential has to stay bounded.
 *
 * Shape of the guarantee:
 *  - one semaphore per provider id (a provider id is one credential here),
 *  - over the limit a caller WAITS, it is never rejected, and it can surface
 *    that wait to the user through the `onWait` callback,
 *  - counters per provider so the wait behaviour is observable in logs and
 *    over an admin endpoint.
 *
 * Defaults (see {@link defaultLimitFor}):
 *  - subscription / OAuth providers: 4 concurrent calls. Rationale: the
 *    Anthropic apps themselves run one interactive session plus a couple of
 *    background calls; 4 leaves room for a chat turn, a task and a summary
 *    without looking like a scraper. It is a guess on the safe side, tune it
 *    in settings once the counters show waits.
 *  - paid API-key providers: NO limit. Those are billed per token and have
 *    their own server-side rate limits; an artificial client-side cap would
 *    only slow the user down.
 *
 * Config (`settings.json`):
 *   "concurrency": { "perProvider": { "default": 0, "anthropic-oauth": 4 } }
 * `0` (or a negative number) means unlimited. A provider without an entry
 * falls back to `default`, and without that to {@link defaultLimitFor}.
 */
import { loadConfig } from './config.js'

/**
 * The few `ProviderConfig` fields the limiter reads. Kept structural so tests
 * and callers do not have to build a full provider config.
 */
export interface ProviderShape {
  id?: string
  authMethod?: string
  providerType?: string
  type?: string
  oauthCredentials?: unknown
  oauth?: unknown
}

export interface ProviderConcurrencyStats {
  providerId: string
  /** Configured limit, or null for unlimited. */
  limit: number | null
  /** Calls holding a slot right now. */
  active: number
  /** Callers waiting for a slot right now. */
  waiting: number
  /** Calls that had to wait at least once. */
  waited: number
  /** Total time spent waiting, milliseconds. */
  waitedMs: number
  /** Highest number of simultaneous waiters seen. */
  peakWaiting: number
  /** Slots handed out in total. */
  acquired: number
}

/**
 * A provider that authenticates with a subscription instead of a paid key.
 * `authMethod: 'oauth'` is the authoritative field (`ProviderConfig`); the
 * type/credential checks catch configs written before it existed.
 */
function isSubscriptionProvider(provider?: ProviderShape | null): boolean {
  if (!provider) return false
  if (provider.authMethod === 'oauth') return true
  if (provider.oauthCredentials || provider.oauth) return true
  const kinds = `${provider.type ?? ''} ${provider.providerType ?? ''}`
  return /oauth|codex|copilot/i.test(kinds)
}

/**
 * The limit used when `settings.json` says nothing. Subscription credentials
 * get a conservative cap, paid API keys stay unlimited (no artificial limits
 * on paid APIs).
 */
export function defaultLimitFor(provider?: ProviderShape | null): number {
  return isSubscriptionProvider(provider) ? 4 : 0
}

interface Slot {
  active: number
  waiters: Array<() => void>
  stats: ProviderConcurrencyStats
}

export interface AcquireOptions {
  /**
   * Called once when the call has to wait, before it blocks. Used to emit the
   * "waiting for a free slot" status into the strand.
   */
  onWait?: (info: { providerId: string; waiting: number; limit: number }) => void
  /** Called once the slot was handed over after a wait. */
  onResume?: (info: { providerId: string; waitedMs: number }) => void
}

export class ProviderConcurrencyLimiter {
  private slots: Map<string, Slot> = new Map()
  /** Limits injected by the caller (tests / explicit config) override settings. */
  private overrides: Map<string, number> = new Map()

  constructor(overrides?: Record<string, number>) {
    if (overrides) {
      for (const [providerId, limit] of Object.entries(overrides)) this.overrides.set(providerId, limit)
    }
  }

  /** Effective limit for a provider: override > settings > default. `null` = unlimited. */
  limitFor(providerId: string, provider?: ProviderShape | null): number | null {
    const override = this.overrides.get(providerId)
    const configured = override ?? this.fromSettings(providerId)
    const limit = configured ?? defaultLimitFor(provider ? { id: providerId, ...provider } : null)
    return Number.isFinite(limit) && limit > 0 ? limit : null
  }

  private fromSettings(providerId: string): number | undefined {
    try {
      const config = loadConfig<{ concurrency?: { perProvider?: Record<string, number> } }>('settings.json')
      const perProvider = config?.concurrency?.perProvider
      if (!perProvider) return undefined
      const specific = perProvider[providerId]
      if (typeof specific === 'number') return specific
      const fallback = perProvider.default
      return typeof fallback === 'number' ? fallback : undefined
    } catch {
      return undefined
    }
  }

  private slotFor(providerId: string, limit: number | null): Slot {
    let slot = this.slots.get(providerId)
    if (!slot) {
      slot = {
        active: 0,
        waiters: [],
        stats: { providerId, limit, active: 0, waiting: 0, waited: 0, waitedMs: 0, peakWaiting: 0, acquired: 0 },
      }
      this.slots.set(providerId, slot)
    }
    slot.stats.limit = limit
    return slot
  }

  /**
   * Take a slot for `providerId`, waiting when the limit is reached. The
   * returned release function is idempotent (several paths release: normal
   * end, abort, error).
   */
  async acquire(
    providerId: string,
    provider?: ProviderShape | null,
    options: AcquireOptions = {},
  ): Promise<() => void> {
    const limit = this.limitFor(providerId, provider)
    const slot = this.slotFor(providerId, limit)
    if (limit === null) {
      slot.active++
      slot.stats.active = slot.active
      slot.stats.acquired++
      let releasedUnlimited = false
      return () => {
        if (releasedUnlimited) return
        releasedUnlimited = true
        slot.active--
        slot.stats.active = slot.active
      }
    }

    if (slot.active < limit) {
      slot.active++
    } else {
      const startedAt = Date.now()
      slot.stats.waited++
      slot.stats.waiting = slot.waiters.length + 1
      slot.stats.peakWaiting = Math.max(slot.stats.peakWaiting, slot.stats.waiting)
      options.onWait?.({ providerId, waiting: slot.stats.waiting, limit })
      console.log(`[provider-concurrency] ${providerId} at limit ${limit}, waiting (${slot.stats.waiting} in line)`)
      await new Promise<void>(resolve => slot.waiters.push(resolve))
      // Handed over an already counted slot: `active` stays as it is.
      const waitedMs = Date.now() - startedAt
      slot.stats.waitedMs += waitedMs
      slot.stats.waiting = slot.waiters.length
      options.onResume?.({ providerId, waitedMs })
    }
    slot.stats.active = slot.active
    slot.stats.acquired++

    let released = false
    return () => {
      if (released) return
      released = true
      const next = slot.waiters.shift()
      if (next) {
        next()
      } else {
        slot.active--
        slot.stats.active = slot.active
      }
      slot.stats.waiting = slot.waiters.length
    }
  }

  /** Counters for every provider that was used at least once. */
  getStats(): ProviderConcurrencyStats[] {
    return [...this.slots.values()].map(slot => ({ ...slot.stats }))
  }

  /** Counters of one provider, or null when it was never used. */
  getStatsFor(providerId: string): ProviderConcurrencyStats | null {
    const slot = this.slots.get(providerId)
    return slot ? { ...slot.stats } : null
  }
}

/** Process-wide limiter: every LLM caller shares one instance. */
let sharedLimiter: ProviderConcurrencyLimiter | null = null

export function getProviderConcurrencyLimiter(): ProviderConcurrencyLimiter {
  if (!sharedLimiter) sharedLimiter = new ProviderConcurrencyLimiter()
  return sharedLimiter
}

/** Tests only: replace the process-wide limiter. */
export function setProviderConcurrencyLimiter(limiter: ProviderConcurrencyLimiter | null): void {
  sharedLimiter = limiter
}

// ---------------------------------------------------------------------------
// Rate-limit classification
// ---------------------------------------------------------------------------

/**
 * A provider-side "too much traffic" answer: HTTP 429, Anthropic
 * `rate_limit_error` / `overloaded_error`, or an explicit concurrency
 * complaint.
 *
 * Deliberately separate from `isAuthError`: a 429 must never invalidate a
 * credential or trigger an OAuth refresh loop, it has to back off and retry.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error) return false
  const status = (error as { status?: number; statusCode?: number }).status
    ?? (error as { statusCode?: number }).statusCode
  if (status === 429 || status === 529) return true
  const text = `${(error as { message?: string }).message ?? ''} ${String(error)}`.toLowerCase()
  if (text.includes('rate_limit_error') || text.includes('rate limit')) return true
  if (text.includes('overloaded_error') || text.includes('overloaded')) return true
  if (text.includes('too many requests')) return true
  if (text.includes('concurrent') && (text.includes('limit') || text.includes('exceeded'))) return true
  return false
}

/**
 * Seconds to wait from a `Retry-After` header or an Anthropic style error
 * body, or null when the provider did not say.
 */
export function retryAfterMsFromError(error: unknown): number | null {
  if (!error) return null
  const headers = (error as { headers?: Record<string, string> | { get?: (k: string) => string | null } }).headers
  let raw: string | null | undefined
  if (headers && typeof (headers as { get?: unknown }).get === 'function') {
    raw = (headers as { get: (k: string) => string | null }).get('retry-after')
  } else if (headers && typeof headers === 'object') {
    const record = headers as Record<string, string>
    raw = record['retry-after'] ?? record['Retry-After']
  }
  if (raw === undefined || raw === null) {
    // Turn errors travel as plain strings through the runner, so read the
    // text form too, not just an Error-shaped object.
    const text = typeof error === 'string' ? error : String((error as { message?: string }).message ?? error)
    const match = /retry[- ]after[":\s]+(\d+(?:\.\d+)?)/i.exec(text)
    raw = match?.[1]
  }
  if (raw === undefined || raw === null) return null
  const seconds = Number.parseFloat(String(raw))
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const asDate = Date.parse(String(raw))
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now())
  return null
}

/**
 * Backoff for the n-th rate-limit retry (0-based), honouring `Retry-After`
 * when the provider sent one. Exponential with a cap, plus jitter so several
 * strands that got throttled together do not retry in lockstep.
 */
export function rateLimitBackoffMs(attempt: number, error?: unknown, options: { baseMs?: number; maxMs?: number; jitter?: () => number } = {}): number {
  const retryAfter = retryAfterMsFromError(error)
  const base = options.baseMs ?? 1000
  const max = options.maxMs ?? 60_000
  if (retryAfter !== null) return Math.min(max, retryAfter)
  const exponential = Math.min(max, base * Math.pow(2, Math.max(0, attempt)))
  const jitter = (options.jitter ?? Math.random)()
  return Math.round(exponential * (0.5 + 0.5 * jitter))
}
