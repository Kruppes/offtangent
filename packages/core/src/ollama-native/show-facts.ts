/**
 * Read-only `/api/show` facts for the native Ollama provider
 * (plan 2026-10-05-ollama-native-context, M2).
 *
 * - `POST <root>/api/show { model }` only. Never `/api/generate`, never a
 *   `keep_alive` or unload, never a prompt: `/api/show` reads the manifest and
 *   does not load the model into memory.
 * - Cached per (base URL, model id). A success is reused for `ttlMs`; a failure
 *   (HTTP error, timeout, garbage) is cached for `failureTtlMs` as EMPTY facts
 *   so the policy reports `baseline_unknown` — never a guessed baseline.
 * - The base URL comes from the configured provider (same trust as the existing
 *   Ollama probe: http/https only), never from a request body.
 */
import { parseOllamaShow, type OllamaModelFacts } from './context-window.js'

export const SHOW_FACTS_TTL_MS = 5 * 60_000
export const SHOW_FACTS_FAILURE_TTL_MS = 30_000
export const SHOW_FACTS_TIMEOUT_MS = 5_000

export interface ShowFactsResult {
  facts: OllamaModelFacts
  /** 'fresh' = fetched now, 'cached' = from cache, 'failed' = fetch failed (facts are empty). */
  source: 'fresh' | 'cached' | 'failed'
  error?: string
}

interface Entry { at: number; ok: boolean; facts: OllamaModelFacts; error?: string }

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<ShowFactsResult>>()

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

export async function getOllamaShowFacts(
  baseUrl: string | undefined,
  modelId: string,
  opts: { fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number; failureTtlMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ShowFactsResult> {
  const root = ollamaRootUrl(baseUrl)
  if (!root || !modelId) return { facts: {}, source: 'failed', error: 'invalid base url or model' }
  const now = opts.now ?? Date.now
  const key = `${root}\u0000${modelId}`
  const hit = cache.get(key)
  if (hit) {
    const ttl = hit.ok ? (opts.ttlMs ?? SHOW_FACTS_TTL_MS) : (opts.failureTtlMs ?? SHOW_FACTS_FAILURE_TTL_MS)
    if (now() - hit.at < ttl) return { facts: { ...hit.facts }, source: hit.ok ? 'cached' : 'failed', ...(hit.error ? { error: hit.error } : {}) }
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
      cache.set(key, { at: now(), ok: true, facts })
      return { facts: { ...facts }, source: 'fresh' }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      // A caller abort says nothing about the server: do not poison the cache.
      if (!opts.signal?.aborted) cache.set(key, { at: now(), ok: false, facts: {}, error })
      return { facts: {}, source: 'failed', error }
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

/**
 * Synchronous read for status endpoints: the cached facts when a fresh entry
 * exists (`known: true`), otherwise `known: false` and a background refresh is
 * started (read-only `/api/show`). Never blocks a status read on the network.
 */
export function peekOllamaShowFacts(baseUrl: string | undefined, modelId: string, opts: { fetchImpl?: typeof fetch; now?: () => number } = {}): { known: boolean; facts: OllamaModelFacts; failed: boolean } {
  const root = ollamaRootUrl(baseUrl)
  if (!root || !modelId) return { known: false, facts: {}, failed: true }
  const now = opts.now ?? Date.now
  const hit = cache.get(`${root}\u0000${modelId}`)
  if (hit) {
    const ttl = hit.ok ? SHOW_FACTS_TTL_MS : SHOW_FACTS_FAILURE_TTL_MS
    if (now() - hit.at < ttl) return { known: hit.ok, facts: { ...hit.facts }, failed: !hit.ok }
  }
  void getOllamaShowFacts(baseUrl, modelId, opts).catch(() => undefined)
  return { known: false, facts: {}, failed: false }
}
