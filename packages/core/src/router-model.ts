/**
 * router-model.ts: the `router` role of the model policy (SPEC 4.8,
 * MODEL-POLICY 2). The role is an ordered chain of model entries read from
 * `settings.json` at call time:
 *
 *   "modelPolicy": { "roles": { "router": "claude-sonnet-5, gpt-5.4-nano:0.9, ministral-3:14b" } }
 *
 * An entry is a model id (looked up across every configured provider), a
 * `providerId:modelId` composite, or a provider id or name. An optional
 * trailing `:<threshold>` (a float 0..1) makes the chain move on to the next
 * entry when that model's decision is below the threshold. Entries that do
 * not resolve to a configured provider are skipped with one warning per
 * process and never crash a capture.
 *
 * The chain is read from the policy block only. A global model switch writes
 * `providers.json` (the `default` role) and cannot reach it.
 */
import { loadConfig, warnConfigReadFailed } from './config.js'
import {
  buildModel,
  getApiKeyForProvider,
  loadProvidersDecrypted,
  resolveProviderModelInput,
  type ProviderConfig,
} from './provider-config.js'
import type { Api, Model } from '@earendil-works/pi-ai'

export const DEFAULT_ROUTER_CHAIN = 'claude-sonnet-5, gpt-5.4-nano:0.9, ministral-3:14b'

export interface RouterChainEntry {
  /** The model or provider spec as written in the configuration. */
  spec: string
  /** Move on to the next entry when the decision confidence is below this. */
  threshold: number | null
}

export interface ResolvedRouterModel extends RouterChainEntry {
  providerId: string
  providerName: string
  modelId: string
  /** `providerId:modelId`, what `router_decisions.model` records. */
  composite: string
}

const THRESHOLD_SUFFIX = /:(0(?:\.\d+)?|1(?:\.0+)?)$/

/** Parse `"a, b:0.9, c"` (or an array) into chain entries. */
export function parseRouterChain(raw: unknown): RouterChainEntry[] {
  const parts: string[] = Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === 'string')
    : typeof raw === 'string' ? raw.split(',') : []
  const out: RouterChainEntry[] = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const match = trimmed.match(THRESHOLD_SUFFIX)
    if (match) {
      out.push({ spec: trimmed.slice(0, -match[0].length), threshold: Number(match[1]) })
    } else {
      out.push({ spec: trimmed, threshold: null })
    }
  }
  return out
}

interface ModelPolicyBlock {
  modelPolicy?: { roles?: { router?: unknown } }
}

/** The configured chain, or the default chain when the policy block is absent. */
export function loadRouterChain(): RouterChainEntry[] {
  let raw: unknown
  try {
    raw = loadConfig<ModelPolicyBlock>('settings.json').modelPolicy?.roles?.router
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
  }
  const chain = parseRouterChain(raw)
  return chain.length > 0 ? chain : parseRouterChain(DEFAULT_ROUTER_CHAIN)
}

const warnedEntries = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warnedEntries.has(key)) return
  warnedEntries.add(key)
  console.warn(message)
}

/** Test hook: forget which chain entries have been warned about. */
export function resetRouterModelWarnings(): void {
  warnedEntries.clear()
}

function resolveEntry(entry: RouterChainEntry, providers: ProviderConfig[]): ResolvedRouterModel | null {
  const byModel = resolveProviderModelInput({ model: entry.spec })
  if (byModel.ok) return { ...entry, ...byModel }
  const colon = entry.spec.indexOf(':')
  if (colon > 0) {
    const composite = resolveProviderModelInput({ provider: entry.spec.slice(0, colon), model: entry.spec.slice(colon + 1) })
    if (composite.ok) return { ...entry, ...composite }
  }
  const byProvider = providers.find(p => p.id === entry.spec || p.name.toLowerCase() === entry.spec.toLowerCase())
  if (byProvider) {
    const resolved = resolveProviderModelInput({ provider: byProvider.id })
    if (resolved.ok) return { ...entry, ...resolved }
  }
  return null
}

/**
 * Resolve the chain against `providers.json`. Missing entries are dropped
 * with a warning; the result may be empty, which the router treats as
 * "router unavailable" (capture becomes `unsorted`, SPEC 4.3).
 */
export function resolveRouterChain(chain: RouterChainEntry[] = loadRouterChain()): ResolvedRouterModel[] {
  let providers: ProviderConfig[]
  try {
    providers = loadProvidersDecrypted().providers
  } catch (err) {
    warnOnce('providers', `[router] Cannot read providers: ${(err as Error).message}`)
    return []
  }
  const out: ResolvedRouterModel[] = []
  for (const entry of chain) {
    const resolved = resolveEntry(entry, providers)
    if (!resolved) {
      warnOnce(
        entry.spec,
        `[router] Chain entry "${entry.spec}" is not a configured provider or enabled model on this instance, skipping it`,
      )
      continue
    }
    out.push(resolved)
  }
  if (out.length === 0) {
    warnOnce('empty', '[router] No entry of the router chain is available, captures will land in the unsorted tray')
  }
  return out
}

export interface RouterModelHandle extends ResolvedRouterModel {
  model: Model<Api>
  apiKey: string
  provider: ProviderConfig
}

/** Build the pi-ai model and credentials for one resolved entry. */
export async function buildRouterModel(entry: ResolvedRouterModel): Promise<RouterModelHandle | null> {
  const provider = loadProvidersDecrypted().providers.find(p => p.id === entry.providerId)
  if (!provider) return null
  try {
    return {
      ...entry,
      provider,
      model: buildModel(provider, entry.modelId),
      apiKey: await getApiKeyForProvider(provider),
    }
  } catch (err) {
    warnOnce(`build:${entry.composite}`, `[router] Cannot build model ${entry.composite}: ${(err as Error).message}`)
    return null
  }
}
