/**
 * Live model discovery for the Kimi Code plan (`kimi-coding`,
 * `kimi-coding-oauth`).
 *
 * pi-ai's bundled `kimi-coding` catalog only changes with a library bump and
 * lags behind the plan (e.g. K3.1 Pro). Kimi serves the authoritative list at
 * `GET {region}/coding/v1/models`. This module holds the pure parts: parsing
 * that answer, a small persisted cache (`live-models.json` next to
 * providers.json, so models resolve right after a restart before the first
 * refresh), turning a live entry into a pi-ai model, and the thinking-only
 * guard buildModel applies so `thinking=off` never sends "thinking disabled"
 * to a model that rejects it.
 *
 * It deliberately imports nothing from provider-config.ts (buildModel reads
 * from here); the refresh orchestration lives in live-model-refresh.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getConfigDir } from './config.js'

/** Normalized metadata of one model from a provider's live `/models` answer. */
export interface LiveModelInfo {
  id: string
  name: string
  contextWindow?: number
  reasoning: boolean
  /** The model rejects requests with thinking disabled (Kimi: `supports_thinking_type: "only"`). */
  thinkingOnly: boolean
  /** Valid reasoning efforts as reported by the API (e.g. low/high/max). */
  efforts?: string[]
  /** Default reasoning effort as reported by the API. */
  defaultEffort?: string
  imageInput: boolean
  /**
   * Set when the model was listed before but is missing from the latest
   * answer. The entry is kept (an enabled model must keep resolving with its
   * metadata); nothing is removed from knownModels or enabledModels.
   */
  missingSince?: string
}

export interface LiveModelCacheEntry {
  fetchedAt: string
  models: LiveModelInfo[]
}

export type LiveModelCacheFile = Record<string, LiveModelCacheEntry>

const CACHE_FILE = 'live-models.json'
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * Parse Kimi's `/coding/v1/models` answer (OpenAI-style `{ data: [...] }`).
 * Unknown or malformed entries are skipped; a body without a `data` array
 * throws so the caller keeps its previous list.
 */
export function parseKimiModelsResponse(body: unknown): LiveModelInfo[] {
  const data = asRecord(body)?.data
  if (!Array.isArray(data)) throw new Error('unexpected /models answer: no data array')
  const out: LiveModelInfo[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    const entry = asRecord(raw)
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (!entry || !id || seen.has(id)) continue
    seen.add(id)
    const think = asRecord(entry.think_efforts)
    const efforts = Array.isArray(think?.valid_efforts)
      ? think.valid_efforts.filter((e): e is string => typeof e === 'string' && e.length > 0)
      : undefined
    const defaultEffort = typeof think?.default_effort === 'string'
      ? think.default_effort
      : (typeof asRecord(entry.reasoning)?.effort === 'string' ? asRecord(entry.reasoning)!.effort as string : undefined)
    const modalities = asRecord(entry.modalities)
    const inputModalities = Array.isArray(modalities?.input) ? modalities.input : []
    const limitContext = positiveInt(asRecord(entry.limit)?.context)
    const thinkingOnly = entry.supports_thinking_type === 'only'
    out.push({
      id,
      name: typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name.trim() : id,
      contextWindow: positiveInt(entry.context_length) ?? limitContext,
      reasoning: entry.supports_reasoning === true || thinkingOnly || (efforts?.length ?? 0) > 0,
      thinkingOnly,
      ...(efforts && efforts.length > 0 && { efforts }),
      ...(defaultEffort && { defaultEffort }),
      imageInput: entry.supports_image_in === true || inputModalities.includes('image'),
    })
  }
  return out
}

/**
 * pi-ai thinking-level map for a live model, in the style of the bundled
 * Kimi catalog: levels the API names are passed through, all others are
 * `null` (hidden). `off` is always `null` for reasoning models, which keeps
 * pi-ai from sending `thinking: {type: "disabled"}`.
 */
export function liveThinkingLevelMap(info: LiveModelInfo): Record<string, string | null> | undefined {
  if (!info.reasoning) return undefined
  const efforts = new Set(info.efforts ?? [])
  if (efforts.size === 0) return { off: null }
  const map: Record<string, string | null> = { off: null }
  for (const level of THINKING_LEVELS) map[level] = efforts.has(level) ? level : null
  return map
}

/**
 * Build a pi-ai model for a live entry that has no catalog entry and no user
 * override, using a catalog model of the same provider as the wire template
 * (api, compat flags, image limits). The template's per-model metadata (name,
 * context, thinking map, price) is replaced by the live data; price is 0
 * (flat-rate plan, the API reports none).
 */
export function buildLiveModel(info: LiveModelInfo, template: Model<Api>): Model<Api> {
  const thinkingLevelMap = liveThinkingLevelMap(info)
  const contextWindow = info.contextWindow ?? template.contextWindow
  const model = {
    ...template,
    id: info.id,
    name: info.name,
    reasoning: info.reasoning,
    input: info.imageInput ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(template.maxTokens, contextWindow),
  } as Model<Api> & { thinkingLevelMap?: Record<string, string | null> }
  if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap
  else delete model.thinkingLevelMap
  return model
}

// ── Persisted cache ─────────────────────────────────────────────────────────

let cache: LiveModelCacheFile | null = null
/** mtime of the file `cache` was read from; another process may write it. */
let cacheMtimeMs = -1
let cacheFile = ''

function cachePath(): string {
  return path.join(getConfigDir(), CACHE_FILE)
}

function fileMtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Read the cache, re-reading the file when its mtime changed (the backend
 * refresh may run in another process than the one building the model).
 */
function loadCache(): LiveModelCacheFile {
  const file = cachePath()
  const mtime = fileMtimeMs(file)
  if (cache && file === cacheFile && mtime === cacheMtimeMs) return cache
  try {
    const parsed = mtime > 0 ? JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown : {}
    cache = (asRecord(parsed) as LiveModelCacheFile | undefined) ?? {}
  } catch {
    cache = {}
  }
  cacheMtimeMs = mtime
  cacheFile = file
  rebuildThinkingOnly()
  return cache
}

/** Test hook: forget the in-memory cache so the next read hits the file again. */
export function resetLiveModelCache(): void {
  cache = null
  cacheMtimeMs = -1
  thinkingOnly.clear()
}

export function getLiveModelEntry(providerId: string): LiveModelCacheEntry | undefined {
  return loadCache()[providerId]
}

export function getLiveModelInfo(providerId: string, modelId: string): LiveModelInfo | undefined {
  return getLiveModelEntry(providerId)?.models.find(m => m.id === modelId)
}

/**
 * Store a fresh live list for a provider. Entries listed before but missing
 * now are kept with `missingSince` (first time seen missing); a model that
 * comes back loses the flag. Returns the ids that newly went missing.
 */
export function setLiveModels(providerId: string, models: LiveModelInfo[], now = new Date()): string[] {
  const current = loadCache()
  const listed = new Set(models.map(m => m.id))
  const previous = current[providerId]?.models ?? []
  const missing = previous
    .filter(m => !listed.has(m.id))
    .map(m => (m.missingSince ? m : { ...m, missingSince: now.toISOString() }))
  const newlyMissing = previous.filter(m => !listed.has(m.id) && !m.missingSince).map(m => m.id)
  const file = { ...current, [providerId]: { fetchedAt: now.toISOString(), models: [...models, ...missing] } }
  writeCache(file)
  return newlyMissing
}

function writeCache(file: LiveModelCacheFile): void {
  const dir = getConfigDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const target = cachePath()
  const tmp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, target)
  cache = file
  cacheMtimeMs = fileMtimeMs(target)
  cacheFile = target
  rebuildThinkingOnly()
}

export function deleteLiveModels(providerId: string): void {
  const current = loadCache()
  if (!(providerId in current)) return
  const { [providerId]: _removed, ...rest } = current
  writeCache(rest)
}

// ── Thinking-only registry ──────────────────────────────────────────────────

/** Thinking-only model ids (unique across the Kimi Code plan regions). */
const thinkingOnly = new Map<string, LiveModelInfo>()

/**
 * Model ids documented as thinking-only before the live list confirms them
 * (Kimi Code docs: "K3.1 Pro models only support thinking mode; requests with
 * thinking disabled are rejected (HTTP 400)"). Covers hand-made overrides of
 * these ids on a fresh install whose cache is still empty.
 */
const DOCUMENTED_THINKING_ONLY = /^k3\.1-pro(?:-|$)/

function rebuildThinkingOnly(): void {
  thinkingOnly.clear()
  for (const entry of Object.values(cache ?? {})) {
    for (const m of entry?.models ?? []) if (m.thinkingOnly) thinkingOnly.set(m.id, m)
  }
}

/**
 * Whether a Kimi Code model only runs with thinking enabled (K3.1 Pro: HTTP
 * 400 for `thinking: {type: "disabled"}`), from the live list of any Kimi Code
 * provider or, before the first refresh, from the documented id family.
 */
export function isThinkingOnlyModel(modelId: string): boolean {
  loadCache()
  return thinkingOnly.has(modelId) || DOCUMENTED_THINKING_ONLY.test(modelId)
}

/**
 * Make a thinking-only model safe for `thinking=off`: pi-ai's
 * anthropic-messages wire sends `thinking: {type: "disabled"}` unless
 * `thinkingLevelMap.off` is `null`; with `null` it sends no thinking field and
 * Kimi applies the model default (high). Applies to every source (user
 * override, catalog, live), so a hand-made override without a map is covered.
 */
export function enforceThinkingOnly<T extends Pick<Model<Api>, 'id' | 'reasoning'> & { thinkingLevelMap?: Record<string, string | null> }>(model: T): T {
  if (!isThinkingOnlyModel(model.id)) return model
  if (model.reasoning && model.thinkingLevelMap?.off === null) return model
  const map = model.thinkingLevelMap ?? { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' }
  return { ...model, reasoning: true, thinkingLevelMap: { ...map, off: null } }
}
