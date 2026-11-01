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
 * whose refresh is serialized per provider and per refresh token. Never refresh here — a rotated
 * refresh token presented twice revokes the whole token family (incident
 * 2026-07-22).
 */
import crypto from 'node:crypto'
import {
  buildModel,
  getApiKeyForProvider,
  getAvailableModels,
  getOAuthCredentialGeneration,
  loadProviders,
  loadProvidersDecrypted,
  PROVIDER_TYPE_PRESETS,
  resolveEffectiveBaseUrl,
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
export function syncLiveModelIds(
  providerId: string,
  liveIds: string[],
  expectedSource?: string,
): { newlyKnown: string[], enabled: string[] } {
  // Fresh load, compare and save without any await in between: no other write
  // of this process can interleave, and the answer is only applied to the
  // entry it was fetched for (`expectedSource`).
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === providerId)
  if (!provider || liveIds.length === 0) return { newlyKnown: [], enabled: [] }
  if (expectedSource !== undefined && liveModelSourceKey(provider) !== expectedSource) {
    throw new StaleLiveModelAnswerError()
  }

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

/**
 * Identity of what a live list answer belongs to: provider type, auth method,
 * effective base URL (Kimi region) and the credential generation — the stored
 * API key (its ciphertext hash, never the key) or the OAuth sign-in generation.
 * A plain OAuth token rotation keeps the key; a new key, a new sign-in, a
 * region or type switch changes it. Built from the raw (encrypted) entry, so
 * it never needs to decrypt anything.
 */
export function liveModelSourceKey(provider: Pick<ProviderConfig, 'id' | 'providerType' | 'authMethod' | 'baseUrl' | 'apiKey' | 'oauthCredentials'>): string {
  const credential = provider.authMethod === 'oauth'
    ? `oauth:${provider.oauthCredentials ? getOAuthCredentialGeneration(provider.id) : 'none'}`
    : `key:${crypto.createHash('sha256').update(provider.apiKey ?? '').digest('hex')}`
  return JSON.stringify([provider.providerType, provider.authMethod ?? '', resolveEffectiveBaseUrl(provider.providerType, provider.baseUrl), credential])
}

/** The provider changed (type, region, key, sign-in) while its list was fetched. */
export class StaleLiveModelAnswerError extends Error {
  constructor() {
    super('provider changed during the request (type, region, key or sign-in); answer discarded')
    this.name = 'StaleLiveModelAnswerError'
  }
}

/** Running refresh per provider id, bound to the source it was started for. */
const inflight = new Map<string, { source: string, job: Promise<LiveModelRefreshResult> }>()

function failedResult(providerId: string, providerName: string, error: string): LiveModelRefreshResult {
  return { providerId, providerName, ok: false, listed: [], newlyKnown: [], enabled: [], missing: [], error }
}

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split('\n')[0]
}

/**
 * Fetch, cache and sync the live list of one provider. Concurrent calls for
 * the same provider AND the same source (type, region, credential generation)
 * share one request; after a key / region / sign-in change a new request
 * starts instead of joining the old one, whose answer is then discarded.
 * Never throws.
 */
export function refreshProviderLiveModels(
  providerId: string,
  options: LiveModelRefreshOptions = {},
): Promise<LiveModelRefreshResult> {
  let raw: ProviderConfig | undefined
  try {
    raw = loadProviders().providers.find(p => p.id === providerId)
  } catch (err) {
    const message = firstLine(err)
    options.logger?.warn(`[axiom] Live model refresh for provider ${providerId} could not read the providers, keeping the current list: ${message}`)
    return Promise.resolve(failedResult(providerId, providerId, message))
  }
  if (!raw || !hasLiveModels(raw.providerType)) {
    return Promise.resolve(failedResult(providerId, raw?.name ?? providerId, 'provider has no live model list'))
  }
  const source = liveModelSourceKey(raw)
  const running = inflight.get(providerId)
  if (running && running.source === source) return running.job
  const job: Promise<LiveModelRefreshResult> = runRefresh(providerId, source, raw.name, options).finally(() => {
    if (inflight.get(providerId)?.job === job) inflight.delete(providerId)
  })
  inflight.set(providerId, { source, job })
  return job
}

async function runRefresh(
  providerId: string,
  source: string,
  providerName: string,
  options: LiveModelRefreshOptions,
): Promise<LiveModelRefreshResult> {
  const base = { providerId, providerName, listed: [], newlyKnown: [], enabled: [], missing: [] }
  try {
    // Inside the try: an unreadable providers.json is one warning, not a
    // rejected promise.
    const provider = loadProvidersDecrypted().providers.find(p => p.id === providerId)
    if (!provider || !hasLiveModels(provider.providerType)) {
      return { ...base, ok: false, error: 'provider has no live model list' }
    }
    const models = await fetchKimiCodeLiveModels(provider, options)
    const listed = models.map(m => m.id)
    // Re-check the source right before writing (no await from here on): an
    // answer for an old type / region / key / sign-in is discarded and
    // touches neither the cache nor providers.json.
    const current = loadProviders().providers.find(p => p.id === providerId)
    if (!current || liveModelSourceKey(current) !== source) throw new StaleLiveModelAnswerError()
    const { newlyKnown, enabled } = syncLiveModelIds(providerId, listed, source)
    const missing = setLiveModels(providerId, models, options.now)
    if (newlyKnown.length > 0) {
      options.logger?.log(`[axiom] Provider "${providerName}": new live models ${newlyKnown.join(', ')}${enabled.length > 0 ? ` (auto-enabled: ${enabled.join(', ')})` : ''}`)
    }
    if (missing.length > 0) {
      options.logger?.warn(`[axiom] Provider "${providerName}": no longer listed by the provider (kept): ${missing.join(', ')}`)
    }
    return { ...base, ok: true, listed, newlyKnown, enabled, missing }
  } catch (err) {
    const message = firstLine(err)
    options.logger?.warn(`[axiom] Live model refresh for provider "${providerName}" failed, keeping the current list: ${message}`)
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
