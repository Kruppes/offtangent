/**
 * Refresh of the live model list for providers whose preset sets `liveModels`
 * (Kimi Code plan: `kimi-coding`, `kimi-coding-oauth`).
 *
 * Shape follows the Ollama tag warm-up: one run after the server listens, an
 * `unref`ed interval, a fire-and-forget run when a provider is saved, and an
 * explicit refresh from the Add Model dialog. A failure is logged as one line
 * and leaves both the cached list and providers.json untouched.
 *
 * Token handling: the access token comes ONLY from `getApiKeyForProvider`,
 * whose refresh is serialized per provider. Never refresh here — a rotated
 * refresh token presented twice revokes the whole token family (incident
 * 2026-07-22).
 */
import {
  buildModel,
  getApiKeyForProvider,
  getAvailableModels,
  loadProviders,
  loadProvidersDecrypted,
  PROVIDER_TYPE_PRESETS,
  saveProviders,
} from './provider-config.js'
import type { AvailableModel, ProviderConfig, ProviderType } from './provider-config.js'
import { getLiveModelEntry, parseKimiModelsResponse, setLiveModels } from './kimi-live-models.js'
import type { LiveModelInfo } from './kimi-live-models.js'

/**
 * 6 h: the plan's model list changes every few weeks, the save hook and the
 * dialog's refresh button cover the "I want it now" case, and every run costs
 * an authenticated request (and, with an expired token, the locked refresh).
 */
export const LIVE_MODEL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000

/** Catalog model whose resolved base URL / headers the `/v1/models` call reuses. */
const TEMPLATE_MODEL_ID = 'k3'

export interface LiveModelLogger {
  log(message: string): void
  warn(message: string): void
}

export interface LiveModelRefreshOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  logger?: LiveModelLogger
  now?: Date
}

export interface LiveModelRefreshResult {
  providerId: string
  providerName: string
  ok: boolean
  /** Ids the live list reported (empty on failure). */
  listed: string[]
  /** Ids recorded in knownModels for the first time. */
  newlyKnown: string[]
  /** Ids appended to enabledModels (subset of newlyKnown). */
  enabled: string[]
  /** Ids that dropped out of the live list in this run (kept everywhere). */
  missing: string[]
  error?: string
}

export function hasLiveModels(providerType: string | undefined): boolean {
  return !!providerType && !!PROVIDER_TYPE_PRESETS[providerType as ProviderType]?.liveModels
}

/** `GET {region}/coding/v1/models` for a Kimi Code provider; throws on any failure. */
export async function fetchKimiCodeLiveModels(
  provider: ProviderConfig,
  options: Pick<LiveModelRefreshOptions, 'fetchImpl' | 'timeoutMs'> = {},
): Promise<LiveModelInfo[]> {
  // Token first: for OAuth this resolves (and, if expired, refreshes under the
  // per-provider lock) the credential whose region buildModel() then follows.
  const token = await getApiKeyForProvider(provider)
  if (!token) throw new Error('no API key or sign-in')
  const template = buildModel(provider, TEMPLATE_MODEL_ID)
  const url = `${template.baseUrl.replace(/\/+$/, '')}/v1/models`
  const fetchImpl = options.fetchImpl ?? fetch
  const res = await fetchImpl(url, {
    headers: { ...template.headers, Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  const models = parseKimiModelsResponse(await res.json())
  if (models.length === 0) throw new Error(`empty model list from ${url}`)
  return models
}

/**
 * Record live ids in providers.json, mirroring `syncNewCatalogModels`:
 * - no `knownModels` yet → baseline = catalog ∪ live, enable nothing;
 * - otherwise ids not yet known are appended to `knownModels` (union, never
 *   shrinks) and to the END of `enabledModels` (index 0 stays the default).
 * Ids already known (also hand-made entries) are left exactly as they are.
 */
export function syncLiveModelIds(providerId: string, liveIds: string[]): { newlyKnown: string[], enabled: string[] } {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === providerId)
  if (!provider || liveIds.length === 0) return { newlyKnown: [], enabled: [] }

  if (!provider.knownModels) {
    const catalogIds = getAvailableModels(provider.providerType).map(m => m.id)
    provider.knownModels = Array.from(new Set([...catalogIds, ...liveIds]))
    saveProviders(file)
    return { newlyKnown: provider.knownModels.filter(id => liveIds.includes(id) && !catalogIds.includes(id)), enabled: [] }
  }

  const known = new Set(provider.knownModels)
  const fresh = liveIds.filter(id => !known.has(id))
  if (fresh.length === 0) return { newlyKnown: [], enabled: [] }
  const enabledList = provider.enabledModels ?? []
  const enabledSet = new Set(enabledList)
  const toEnable = fresh.filter(id => !enabledSet.has(id))
  provider.enabledModels = [...enabledList, ...toEnable]
  provider.knownModels = [...provider.knownModels, ...fresh]
  saveProviders(file)
  return { newlyKnown: fresh, enabled: toEnable }
}

const inflight = new Map<string, Promise<LiveModelRefreshResult>>()

/**
 * Fetch, cache and sync the live list of one provider. Concurrent calls for
 * the same provider share one request. Never throws.
 */
export function refreshProviderLiveModels(
  providerId: string,
  options: LiveModelRefreshOptions = {},
): Promise<LiveModelRefreshResult> {
  const running = inflight.get(providerId)
  if (running) return running
  const job = runRefresh(providerId, options).finally(() => inflight.delete(providerId))
  inflight.set(providerId, job)
  return job
}

async function runRefresh(providerId: string, options: LiveModelRefreshOptions): Promise<LiveModelRefreshResult> {
  const provider = loadProvidersDecrypted().providers.find(p => p.id === providerId)
  const base = { providerId, providerName: provider?.name ?? providerId, listed: [], newlyKnown: [], enabled: [], missing: [] }
  if (!provider || !hasLiveModels(provider.providerType)) {
    return { ...base, ok: false, error: 'provider has no live model list' }
  }
  try {
    const models = await fetchKimiCodeLiveModels(provider, options)
    const listed = models.map(m => m.id)
    const missing = setLiveModels(providerId, models, options.now)
    const { newlyKnown, enabled } = syncLiveModelIds(providerId, listed)
    if (newlyKnown.length > 0) {
      options.logger?.log(`[axiom] Provider "${provider.name}": new live models ${newlyKnown.join(', ')}${enabled.length > 0 ? ` (auto-enabled: ${enabled.join(', ')})` : ''}`)
    }
    if (missing.length > 0) {
      options.logger?.warn(`[axiom] Provider "${provider.name}": no longer listed by the provider (kept): ${missing.join(', ')}`)
    }
    return { ...base, ok: true, listed, newlyKnown, enabled, missing }
  } catch (err) {
    const message = ((err as Error)?.message ?? String(err)).split('\n')[0]
    options.logger?.warn(`[axiom] Live model refresh for provider "${provider.name}" failed, keeping the current list: ${message}`)
    return { ...base, ok: false, error: message }
  }
}

/**
 * Model list for the Add Model dialog: the bundled catalog plus every live
 * model it lacks (with live name / context window). Catalog entries keep
 * their catalog metadata; nothing is dropped when it leaves the live list.
 */
export function listCatalogWithLiveModels(provider: Pick<ProviderConfig, 'id' | 'providerType'>): AvailableModel[] {
  const catalog = getAvailableModels(provider.providerType)
  const seen = new Set(catalog.map(m => m.id))
  const live = (getLiveModelEntry(provider.id)?.models ?? [])
    .filter(m => !seen.has(m.id))
    .map(m => ({ id: m.id, name: m.name, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) }))
  return [...catalog, ...live]
}

/** Fire-and-forget refresh after a provider was created or saved. No network under vitest. */
export function scheduleLiveModelRefreshForProvider(
  provider: Pick<ProviderConfig, 'id' | 'providerType'>,
  logger?: LiveModelLogger,
): void {
  if (process.env.VITEST) return
  if (!hasLiveModels(provider.providerType)) return
  void refreshProviderLiveModels(provider.id, { logger }).catch(() => {})
}

export interface LiveModelRefresher {
  start(): void
  stop(): void
  refreshNow(): Promise<LiveModelRefreshResult[]>
}

export function createLiveModelRefresher(options: LiveModelRefreshOptions & { intervalMs?: number } = {}): LiveModelRefresher {
  const intervalMs = options.intervalMs ?? LIVE_MODEL_REFRESH_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | null = null

  async function refreshNow(): Promise<LiveModelRefreshResult[]> {
    if (process.env.VITEST && !options.fetchImpl) return []
    let targets: ProviderConfig[]
    try {
      targets = loadProviders().providers.filter(p => hasLiveModels(p.providerType))
    } catch (err) {
      options.logger?.warn(`[axiom] Live model refresh could not read the providers: ${(err as Error)?.message ?? 'unknown error'}`)
      return []
    }
    // Sequential: each provider may need its own (locked) token refresh.
    const results: LiveModelRefreshResult[] = []
    for (const provider of targets) results.push(await refreshProviderLiveModels(provider.id, options))
    return results
  }

  return {
    start() {
      void refreshNow().catch(() => {})
      if (timer) clearInterval(timer)
      timer = setInterval(() => { void refreshNow().catch(() => {}) }, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    refreshNow,
  }
}
