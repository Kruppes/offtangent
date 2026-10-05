/**
 * Read-only `/api/show` facts for the native Ollama provider
 * (plan 2026-10-05-ollama-native-context, M2).
 *
 * - `POST <root>/api/show { model }` only. Never `/api/generate`, never a
 *   `keep_alive` or unload, never a prompt: `/api/show` reads the manifest and
 *   does not load the model into memory.
 * - Cached per (base URL, model id). A success is reused for `ttlMs`.
 * - Stale-on-error: when a refresh fails, the LAST GOOD facts keep being
 *   served (source `stale`) for at most `maxStaleMs` after that success, so a
 *   transient `/api/show` timeout cannot flip an MLX model back to a guessed
 *   baseline (false overflow refusal) or drop the native `think` contract.
 *   After `maxStaleMs` (no forever cache) or without any earlier success (cold
 *   failure) the facts are EMPTY (source `failed`) → the policy reports
 *   `baseline_unknown` — never a guessed baseline.
 * - Retries are bounded: a failure is remembered for `failureTtlMs`; within
 *   that window no new request is made (one in-flight fetch per key).
 * - Update rule: an older failure never replaces a newer success.
 * - The base URL comes from the configured provider (same trust as the existing
 *   Ollama probe: http/https only), never from a request body.
 */
import { parseOllamaShow, type OllamaModelFacts } from './context-window.js'

export const SHOW_FACTS_TTL_MS = 5 * 60_000
export const SHOW_FACTS_FAILURE_TTL_MS = 30_000
export const SHOW_FACTS_TIMEOUT_MS = 5_000
/** Longest time the last good facts are served after their fetch while refreshes fail. */
export const SHOW_FACTS_MAX_STALE_MS = 30 * 60_000

export interface ShowFactsResult {
  facts: OllamaModelFacts
  /**
   * 'fresh' = fetched now, 'cached' = within TTL, 'stale' = the latest refresh
   * failed and the last good facts (younger than maxStaleMs) are returned,
   * 'failed' = no usable facts (facts are empty).
   */
  source: 'fresh' | 'cached' | 'stale' | 'failed'
  error?: string
}

interface Good { at: number; facts: OllamaModelFacts }
/** `good` = last successful fetch (kept across failures, bounded by maxStaleMs); `failedAt` = latest failure after it. */
interface Entry { good?: Good; failedAt?: number; error?: string }

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<ShowFactsResult>>()

function usableGood(e: Entry | undefined, nowMs: number, maxStaleMs: number): Good | undefined {
  return e?.good && nowMs - e.good.at < maxStaleMs ? e.good : undefined
}

/** `http://h:11434/v1/` → `http://h:11434`; returns null for non-http(s) or unparsable URLs. */
export function ollamaRootUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/api$/, '').replace(/\/+$/, '')
}

export function resetShowFactsCacheForTest(): void {
  cache.clear()
  inflight.clear()
}

type ShowFactsOpts = { fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number; failureTtlMs?: number; maxStaleMs?: number; timeoutMs?: number; signal?: AbortSignal }

export async function getOllamaShowFacts(
  baseUrl: string | undefined,
  modelId: string,
  opts: ShowFactsOpts = {},
): Promise<ShowFactsResult> {
  const root = ollamaRootUrl(baseUrl)
  if (!root || !modelId) return { facts: {}, source: 'failed', error: 'invalid base url or model' }
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? SHOW_FACTS_TTL_MS
  const failureTtl = opts.failureTtlMs ?? SHOW_FACTS_FAILURE_TTL_MS
  const maxStale = opts.maxStaleMs ?? SHOW_FACTS_MAX_STALE_MS
  const key = `${root}\u0000${modelId}`
  const hit = cache.get(key)
  const t = now()
  if (hit?.good && hit.failedAt === undefined && t - hit.good.at < ttl) return { facts: { ...hit.good.facts }, source: 'cached' }
  if (hit?.failedAt !== undefined && t - hit.failedAt < failureTtl) {
    // Bounded retry: within the failure window no new request.
    const good = usableGood(hit, t, maxStale)
    return good
      ? { facts: { ...good.facts }, source: 'stale', ...(hit.error ? { error: hit.error } : {}) }
      : { facts: {}, source: 'failed', ...(hit.error ? { error: hit.error } : {}) }
  }
  const running = inflight.get(key)
  if (running) return running
  const p = (async (): Promise<ShowFactsResult> => {
    const fetchImpl = opts.fetchImpl ?? fetch
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? SHOW_FACTS_TIMEOUT_MS)
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
    try {
      const res = await fetchImpl(`${root}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
        signal,
      })
      if (!res.ok) throw new Error(`/api/show HTTP ${res.status}`)
      const facts = parseOllamaShow(await res.json())
      cache.set(key, { good: { at: now(), facts } })
      return { facts: { ...facts }, source: 'fresh' }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const at = now()
      const current = cache.get(key)
      // A caller abort says nothing about the server: do not record a failure.
      // Update rule: a failure never replaces a success that is newer than this fetch's start.
      const newerSuccess = current?.good !== undefined && current.good.at > t && current.failedAt === undefined
      if (!opts.signal?.aborted && !newerSuccess) cache.set(key, { ...(current?.good ? { good: current.good } : {}), failedAt: at, error })
      const good = usableGood(cache.get(key), at, maxStale)
      return good ? { facts: { ...good.facts }, source: 'stale', error } : { facts: {}, source: 'failed', error }
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

export type ShowFactsPeek = {
  /** true when facts are usable (fresh, revalidating within maxStale, or stale after a failed refresh). */
  known: boolean
  facts: OllamaModelFacts
  /** true when the latest fetch failed (with `known` → stale facts, without → nothing usable). */
  failed: boolean
  /** true when the facts are the last good ones and the latest refresh FAILED. */
  stale: boolean
}

/**
 * Synchronous read for status endpoints (stale-while-revalidate): the last
 * good facts while they are younger than maxStaleMs, plus a background
 * refresh (read-only `/api/show`) once the TTL / failure window is over.
 * Never blocks a status read on the network. No usable facts → `known: false`.
 */
export function peekOllamaShowFacts(baseUrl: string | undefined, modelId: string, opts: ShowFactsOpts = {}): ShowFactsPeek {
  const root = ollamaRootUrl(baseUrl)
  if (!root || !modelId) return { known: false, facts: {}, failed: true, stale: false }
  const now = opts.now ?? Date.now
  const t = now()
  const hit = cache.get(`${root}\u0000${modelId}`)
  const ttl = opts.ttlMs ?? SHOW_FACTS_TTL_MS
  const failureTtl = opts.failureTtlMs ?? SHOW_FACTS_FAILURE_TTL_MS
  const fresh = hit?.good !== undefined && hit.failedAt === undefined && t - hit.good.at < ttl
  const inFailureWindow = hit?.failedAt !== undefined && t - hit.failedAt < failureTtl
  if (!fresh && !inFailureWindow) void getOllamaShowFacts(baseUrl, modelId, opts).catch(() => undefined)
  const failed = hit?.failedAt !== undefined
  const good = usableGood(hit, t, opts.maxStaleMs ?? SHOW_FACTS_MAX_STALE_MS)
  if (good) return { known: true, facts: { ...good.facts }, failed, stale: failed }
  return { known: false, facts: {}, failed, stale: false }
}
