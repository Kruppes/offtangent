/**
 * ollama-tag-cache.ts: the hosting truth for Ollama models.
 *
 * Ollama can serve two very different things through ONE endpoint: weights
 * that run on the box in this network, and models that the daemon proxies to
 * ollama.com. `GET /api/tags` says which is which — a proxied entry carries a
 * `remote_host` field:
 *
 *   { "name": "kimi-k2.5:cloud", "remote_host": "https://ollama.com:443", … }
 *   { "name": "qwen3.8:27b-mlx", … }                      // no remote_host
 *
 * That flag is authoritative and beats every name heuristic: a model name may
 * look local (`mymodel:latest`) and still be proxied. The data-policy gate
 * (`data-policy.ts`) must stay synchronous and cheap — it runs on every
 * automatic model choice — so it never talks to the network itself. It reads
 * the metadata this module cached from the `/api/tags` calls the app already
 * makes, and falls back to the `-cloud` / `:cloud` name markers when nothing
 * was cached yet.
 *
 * The cache lives in the process only (no new file in `/data`, no DB table).
 * It is kept warm by {@link createOllamaTagWarmup}: one boot run for every
 * configured Ollama provider plus a background interval, so the gate is not
 * left guessing in the minutes after a restart.
 *
 * Age matters in ONE direction (T1c): an entry older than
 * {@link OLLAMA_TAG_MAX_AGE_MS} may still confirm "this is proxied" — that is
 * the fail-closed answer — but it may no longer certify "this runs on the
 * box", because the model could have been replaced by a proxied one since.
 */

/** One model as `/api/tags` reported it, reduced to what the gate needs. */
export interface OllamaTagMeta {
  /** Model id exactly as Ollama spells it, e.g. `kimi-k2.5:cloud`. */
  name: string
  /** `remote_host` of `/api/tags`; `null` when the entry runs on the box. */
  remoteHost: string | null
}

/** Where a model runs according to the cached `/api/tags` answers. */
export type OllamaHostingVerdict = 'remote' | 'local' | 'unverified'

/** Which Ollama endpoint the metadata belongs to. At least one field is needed. */
export interface OllamaTagSource {
  providerId?: string | null
  baseUrl?: string | null
}

interface CacheEntry {
  /** Lower-cased model name → metadata. */
  models: Map<string, OllamaTagMeta>
  updatedAt: number
  /** Sequence number of the refresh that wrote this entry (F6). */
  seq: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Last sequence number handed out per cache key (F6 of the review triage
 * 2026-09-26 19:25).
 *
 * Two refreshes of the same endpoint can be in flight at once (boot run and a
 * provider save, warm-up interval and the providers page). Without an order
 * the answer that arrives LAST wins, even when it was requested first — a
 * stale model list then overwrites a fresh one and a model silently changes
 * its hosting verdict. Every refresh takes a ticket before it asks, and a
 * write with an older ticket than the stored one is dropped.
 */
const sequence = new Map<string, number>()

/** Provider id → the cache key of its last recorded answer. */
const keyByProvider = new Map<string, string>()

/** Normalised URL → cache key of the last anonymous (id-less) answer. */
const keyByUrl = new Map<string, string>()

/** Last attempt per cache key, so a warm-up cannot hammer a box. */
const lastRefreshAttempt = new Map<string, number>()

/** How often a background warm-up may re-ask one endpoint. */
export const OLLAMA_TAG_REFRESH_THROTTLE_MS = 10 * 60_000

/** Timeout of the warm-up request. A box that does not answer stays unverified. */
export const OLLAMA_TAG_REFRESH_TIMEOUT_MS = 4_000

/**
 * How long a cached `/api/tags` answer may certify that a model is LOCAL.
 * Beyond it the entry is stale: `remote` still counts (fail closed), `local`
 * degrades to `unverified`. The background warm-up runs far more often than
 * this, so a reachable box never goes stale in practice.
 */
export const OLLAMA_TAG_MAX_AGE_MS = 30 * 60_000

/** How often the background warm-up re-asks every configured Ollama provider. */
export const OLLAMA_TAG_WARMUP_INTERVAL_MS = 10 * 60_000

/**
 * Normalised endpoint URL: scheme, host and port, lower-cased, without a
 * trailing slash and without the `/v1` suffix an OpenAI-compatible config
 * carries. `http://BOX:11434/v1/` and `http://box:11434` are the same box.
 */
function normalizeUrl(baseUrl: string | null | undefined): string | null {
  const raw = (baseUrl ?? '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '')
  }
}

/** Old spelling, kept for the log label below. */
function hostKey(baseUrl: string | null | undefined): string | null {
  const url = normalizeUrl(baseUrl)
  if (!url) return null
  return `url:${url.replace(/^[a-z]+:\/\//, '')}`
}

/**
 * THE cache key of one endpoint (F6): provider id plus normalised URL, so two
 * providers pointing at the same box keep their own entry. A source without a
 * provider id (an unsaved provider being probed) is filed under its URL alone
 * and deliberately does not share the entry of a saved provider.
 */
function cacheKey(source: OllamaTagSource): string | null {
  const id = (source.providerId ?? '').trim()
  const url = normalizeUrl(source.baseUrl)
  if (id && url) return `p:${id}|${url}`
  if (id) return keyByProvider.get(id) ?? `p:${id}|`
  if (url) return `u:${url}`
  return null
}

function normalizeTagEntries(payload: unknown): OllamaTagMeta[] {
  const models = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { models?: unknown } | null)?.models)
      ? ((payload as { models: unknown[] }).models)
      : []
  const out: OllamaTagMeta[] = []
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!name) continue
    // Ollama writes snake_case; accept the camelCase spelling too so a mapped
    // contract object can be handed in without a second normalizer.
    const remoteRaw = entry.remote_host ?? entry.remoteHost
    const remoteHost = typeof remoteRaw === 'string' && remoteRaw.trim() ? remoteRaw.trim() : null
    out.push({ name, remoteHost })
  }
  return out
}

/**
 * Store the metadata of one `/api/tags` answer. Called wherever the app
 * already asks Ollama for its model list; adds no request of its own.
 *
 * @returns how many usable entries were stored
 */
export function recordOllamaTags(source: OllamaTagSource, payload: unknown, seq?: number): number {
  const key = cacheKey(source)
  if (!key) return 0
  const entries = normalizeTagEntries(payload)
  if (entries.length === 0) return 0

  // F6: a write without a ticket counts as the newest answer; a write WITH one
  // is dropped when a later refresh already stored its result.
  const ticket = seq ?? beginOllamaTagRefresh(source)
  const existing = cache.get(key)
  if (existing && existing.seq > ticket) return 0

  const models = new Map<string, OllamaTagMeta>()
  for (const entry of entries) models.set(entry.name.toLowerCase(), entry)
  cache.set(key, { models, updatedAt: Date.now(), seq: ticket })

  const id = (source.providerId ?? '').trim()
  if (id) keyByProvider.set(id, key)
  const url = normalizeUrl(source.baseUrl)
  if (url && !id) keyByUrl.set(url, key)
  return entries.length
}

/**
 * Take a ticket for a refresh of this endpoint BEFORE the request goes out
 * (F6). Pass the returned number to {@link recordOllamaTags}; an answer whose
 * ticket is older than the stored one is discarded instead of overwriting the
 * newer model list.
 */
export function beginOllamaTagRefresh(source: OllamaTagSource): number {
  const key = cacheKey(source)
  if (!key) return 0
  const next = (sequence.get(key) ?? 0) + 1
  sequence.set(key, next)
  return next
}

function lookupEntries(source: OllamaTagSource): CacheEntry | null {
  const key = cacheKey(source)
  if (key) {
    const hit = cache.get(key)
    if (hit) return hit
  }
  const id = (source.providerId ?? '').trim()
  if (id) {
    // The provider is known but the caller passed a different (or no) URL:
    // fall back to the entry this provider last recorded, never to another
    // provider's entry for the same host.
    const known = keyByProvider.get(id)
    if (known) {
      const hit = cache.get(known)
      if (hit) return hit
    }
    return null
  }
  const url = normalizeUrl(source.baseUrl)
  if (url) {
    const anonymous = keyByUrl.get(url)
    if (anonymous) return cache.get(anonymous) ?? null
  }
  return null
}

function baseName(modelId: string): string {
  const withoutTag = modelId.includes(':') ? modelId.slice(0, modelId.indexOf(':')) : modelId
  return withoutTag
}

/**
 * The cached metadata of one model, or `null` when this endpoint (or this
 * model) was never seen.
 *
 * Matching order: the exact name, then `<id>:latest` (a config usually omits
 * the default tag), then any tag of the same base name. In the last step a
 * PROXIED entry wins over a local one — if `kimi-k2.5:cloud` is known and the
 * config just says `kimi-k2.5`, the honest answer is "this goes to the cloud".
 */
export function getOllamaTagMeta(source: OllamaTagSource, modelId: string): OllamaTagMeta | null {
  const wanted = (modelId ?? '').trim().toLowerCase()
  if (!wanted) return null
  const entry = lookupEntries(source)
  if (!entry) return null

  const exact = entry.models.get(wanted)
  if (exact) return exact
  const latest = entry.models.get(`${wanted}:latest`)
  if (latest) return latest

  if (!wanted.includes(':')) {
    let fallback: OllamaTagMeta | null = null
    for (const meta of entry.models.values()) {
      if (baseName(meta.name.toLowerCase()) !== wanted) continue
      if (meta.remoteHost) return meta
      fallback ??= meta
    }
    return fallback
  }
  return null
}

/**
 * Is this model proxied to a remote host?
 *
 * `true` = `/api/tags` reported a `remote_host`, `false` = a FRESH answer
 * reported the model without one, `null` = nothing usable cached (no answer
 * for this endpoint, the model was not in the list, or the answer is too old
 * to certify "local").
 */
export function isOllamaModelRemote(source: OllamaTagSource, modelId: string, now = Date.now()): boolean | null {
  const verdict = getOllamaHostingVerdict(source, modelId, now)
  if (verdict === 'remote') return true
  if (verdict === 'local') return false
  return null
}

/**
 * Where an Ollama model runs, as far as the cached `/api/tags` answers can
 * tell:
 *
 * - `remote`   — the daemon reported a `remote_host` for it (any age).
 * - `local`    — a fresh answer listed it WITHOUT a `remote_host`.
 * - `unverified` — nothing cached for this endpoint, the model is not in the
 *   cached list, or the answer is older than {@link OLLAMA_TAG_MAX_AGE_MS}.
 *
 * `unverified` is deliberately not "local": the gate must never call a model
 * local just because nobody asked the daemon yet (T1c).
 */
export function getOllamaHostingVerdict(
  source: OllamaTagSource,
  modelId: string,
  now = Date.now(),
): OllamaHostingVerdict {
  const entry = lookupEntries(source)
  if (!entry) return 'unverified'
  const meta = getOllamaTagMeta(source, modelId)
  if (!meta) return 'unverified'
  if (meta.remoteHost !== null) return 'remote'
  return now - entry.updatedAt <= OLLAMA_TAG_MAX_AGE_MS ? 'local' : 'unverified'
}

/** How old the cached answer of this endpoint is, or `null` when there is none. */
export function ollamaTagCacheAgeMs(source: OllamaTagSource, now = Date.now()): number | null {
  const entry = lookupEntries(source)
  return entry ? now - entry.updatedAt : null
}

/** Test hook and operator reset. */
export function clearOllamaTagCache(): void {
  cache.clear()
  lastRefreshAttempt.clear()
  sequence.clear()
  keyByProvider.clear()
  keyByUrl.clear()
}

/** What is cached right now (for diagnostics, never a model list for the UI). */
export function ollamaTagCacheStats(): Array<{ key: string; models: number; remote: number; updatedAt: string }> {
  return [...cache.entries()].map(([key, entry]) => ({
    key,
    models: entry.models.size,
    remote: [...entry.models.values()].filter(m => m.remoteHost !== null).length,
    updatedAt: new Date(entry.updatedAt).toISOString(),
  }))
}

/** The bit of `console` this module uses. Never gets a URL with credentials. */
export interface OllamaTagLogger {
  warn: (message: string) => void
}

export interface RefreshOllamaTagsOptions extends OllamaTagSource {
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Failures are swallowed; with a logger they leave one sanitized line. */
  logger?: OllamaTagLogger
}

/**
 * `host:port` of an endpoint, never userinfo, path or query — the only part
 * of a base URL that is safe to put in a log line.
 */
function endpointLabel(baseUrl: string): string {
  const key = hostKey(baseUrl)
  return key ? key.slice('url:'.length) : 'unknown'
}

/**
 * Ask one Ollama endpoint for `/api/tags` and cache the result. Best effort:
 * every failure is swallowed (the gate then uses the name heuristic) and
 * reported as `0` stored entries.
 */
export async function refreshOllamaTags(options: RefreshOllamaTagsOptions): Promise<number> {
  const base = (options.baseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  if (!base) return 0
  const doFetch = options.fetchImpl ?? fetch
  const key = cacheKey(options)
  if (key) lastRefreshAttempt.set(key, Date.now())
  // F6: the ticket is taken before the request, so the order of the ANSWERS
  // cannot reorder the cache.
  const ticket = beginOllamaTagRefresh(options)
  try {
    const response = await doFetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? OLLAMA_TAG_REFRESH_TIMEOUT_MS),
    })
    if (!response.ok) {
      options.logger?.warn(`[privacy] Ollama tag refresh for ${endpointLabel(base)} returned HTTP ${response.status}`)
      return 0
    }
    const payload = await response.json()
    return recordOllamaTags(options, payload, ticket)
  } catch (err) {
    options.logger?.warn(
      `[privacy] Ollama tag refresh for ${endpointLabel(base)} failed: ${(err as Error)?.message ?? 'unknown error'}`,
    )
    return 0
  }
}

/** Should a warm-up ask this endpoint again? */
function refreshDue(source: OllamaTagSource, now: number): boolean {
  const key = cacheKey(source)
  if (!key) return false
  const last = lastRefreshAttempt.get(key)
  return last === undefined || now - last >= OLLAMA_TAG_REFRESH_THROTTLE_MS
}

export interface OllamaProviderView {
  id?: string
  providerType?: string
  baseUrl?: string
}

/**
 * Fire-and-forget warm-up for every Ollama provider, throttled per endpoint.
 * Called from paths that are already about providers (listing them, probing
 * them), never from the gate itself — the gate must not do I/O.
 *
 * Skipped under vitest (`process.env.VITEST`) so unit tests never reach for a
 * network; `refreshOllamaTags` with an injected `fetchImpl` is the tested path.
 */
export function scheduleOllamaTagRefresh(providers: readonly OllamaProviderView[]): void {
  if (process.env.VITEST) return
  const now = Date.now()
  for (const provider of providers) {
    if (provider.providerType !== 'ollama' && provider.providerType !== 'ollama-local' && provider.providerType !== 'ollama-native') continue
    const baseUrl = (provider.baseUrl ?? '').trim()
    if (!baseUrl) continue
    const source: OllamaTagSource = { providerId: provider.id ?? null, baseUrl }
    if (!refreshDue(source, now)) continue
    void refreshOllamaTags({ ...source, baseUrl }).catch(() => {})
  }
}

// ── Warm-up service ───────────────────────────────────────────────────

export interface OllamaTagWarmupOptions {
  /**
   * The providers to keep warm, read fresh on every run so a provider that is
   * added later is picked up without a restart. Only `ollama` types are used.
   */
  listProviders: () => readonly OllamaProviderView[]
  /** Interval between background runs, default {@link OLLAMA_TAG_WARMUP_INTERVAL_MS}. */
  intervalMs?: number
  /** Per-request timeout, default {@link OLLAMA_TAG_REFRESH_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Injected in tests; its presence also allows a run under vitest. */
  fetchImpl?: typeof fetch
  logger?: OllamaTagLogger
}

export interface OllamaTagWarmup {
  /** Boot run (fire-and-forget) plus the background interval. */
  start: () => void
  stop: () => void
  /** One pass over every Ollama provider; resolves when all answers are in. */
  refreshNow: () => Promise<number>
  /** Refresh exactly one provider, e.g. right after it was saved. */
  refreshProvider: (provider: OllamaProviderView) => Promise<number>
}

function isOllamaProvider(provider: OllamaProviderView): boolean {
  return provider.providerType === 'ollama' || provider.providerType === 'ollama-local' || provider.providerType === 'ollama-native'
}

/**
 * Re-ask ONE endpoint right now, fire-and-forget and without the throttle:
 * used when a provider was just saved, where a base URL may have changed and
 * the cached answer belongs to the previous box.
 *
 * No network under vitest (like {@link scheduleOllamaTagRefresh}).
 */
export function scheduleOllamaTagRefreshForProvider(
  provider: OllamaProviderView,
  logger?: OllamaTagLogger,
): void {
  if (process.env.VITEST) return
  if (!isOllamaProvider(provider)) return
  const baseUrl = (provider.baseUrl ?? '').trim()
  if (!baseUrl) return
  void refreshOllamaTags({ providerId: provider.id ?? null, baseUrl, logger }).catch(() => {})
}

/**
 * Keeps the `/api/tags` metadata of every configured Ollama provider fresh.
 *
 * Why this exists: the gate decides per model and fails closed, so a missing
 * cache entry means "not local" — without a warm-up every restart would
 * downgrade all local Ollama models until someone opened the providers page.
 *
 * Shape: one boot run (parallel over the providers, never awaited by the
 * caller, per-request timeout) and an `unref`ed interval. No OS scheduler, no
 * cron. Failures are swallowed and logged as one line without credentials.
 *
 * Under vitest no network is touched unless a `fetchImpl` is injected.
 */
export function createOllamaTagWarmup(options: OllamaTagWarmupOptions): OllamaTagWarmup {
  const intervalMs = options.intervalMs ?? OLLAMA_TAG_WARMUP_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  const networkAllowed = (): boolean => !process.env.VITEST || options.fetchImpl !== undefined

  async function refreshProvider(provider: OllamaProviderView): Promise<number> {
    if (!isOllamaProvider(provider)) return 0
    const baseUrl = (provider.baseUrl ?? '').trim()
    if (!baseUrl) return 0
    if (!networkAllowed()) return 0
    return refreshOllamaTags({
      providerId: provider.id ?? null,
      baseUrl,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      logger: options.logger,
    })
  }

  async function refreshNow(): Promise<number> {
    if (running) return 0
    running = true
    try {
      let providers: readonly OllamaProviderView[] = []
      try {
        providers = options.listProviders()
      } catch (err) {
        options.logger?.warn(`[privacy] Ollama tag warm-up could not read the providers: ${(err as Error)?.message ?? 'unknown error'}`)
        return 0
      }
      const targets = providers.filter(isOllamaProvider)
      if (targets.length === 0) return 0
      const results = await Promise.all(targets.map(provider => refreshProvider(provider).catch(() => 0)))
      return results.reduce((sum, count) => sum + count, 0)
    } finally {
      running = false
    }
  }

  return {
    start() {
      void refreshNow().catch(() => {})
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        void refreshNow().catch(() => {})
      }, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    refreshNow,
    refreshProvider,
  }
}
