/**
 * The local model the connector sub-agent runs on (plan 2026-09-26, P2).
 *
 * `settings.json` › `connectors.localModel` = `{ providerId, modelId }`. When
 * nothing is configured, the default is the first Ollama provider that has
 * {@link DEFAULT_CONNECTOR_LOCAL_MODEL_ID} among its enabled models — and
 * nothing at all when no provider offers it. An unset setting is not a
 * fallback: the tool then returns a clear error instead of asking any other
 * model (fail closed).
 *
 * Writing the setting is only allowed for a pair that satisfies
 * `isStrictlyLocalModel`, so the strict-local invariant cannot be configured
 * away through the admin API.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureConfigTemplates, getConfigDir, loadConfig, warnConfigReadFailed } from '../config.js'
import { isStrictlyLocalModel } from '../data-policy.js'
import { refreshOllamaTags } from '../ollama-tag-cache.js'
import { loadProviders } from '../provider-config.js'
import type { ProviderConfig } from '../provider-config.js'

/** Which model the sub-agent is allowed to use. */
export interface ConnectorLocalModelRef {
  providerId: string
  modelId: string
}

/** Preferred default model, used when a provider offers it. */
export const DEFAULT_CONNECTOR_LOCAL_MODEL_ID = 'qwen3.8:27b-mlx'

/** Provider types that can serve a model from a box on this network. */
const OLLAMA_PROVIDER_TYPES = new Set(['ollama', 'ollama-local'])

interface ConnectorsSettingsBlock {
  connectors?: { localModel?: { providerId?: unknown; modelId?: unknown } }
}

function normalizeRef(value: unknown): ConnectorLocalModelRef | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { providerId?: unknown; modelId?: unknown }
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : ''
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : ''
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}

/** The configured pair, or `null` when the setting is absent or malformed. */
export function loadConnectorLocalModelSetting(): ConnectorLocalModelRef | null {
  try {
    const settings = loadConfig<ConnectorsSettingsBlock>('settings.json')
    return normalizeRef(settings.connectors?.localModel)
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
    return null
  }
}

function loadProviderList(): ProviderConfig[] {
  try {
    return loadProviders().providers
  } catch (err) {
    warnConfigReadFailed('providers.json', err)
    return []
  }
}

/** First Ollama provider with {@link DEFAULT_CONNECTOR_LOCAL_MODEL_ID} enabled. */
export function defaultConnectorLocalModel(providers?: readonly ProviderConfig[]): ConnectorLocalModelRef | null {
  const list = providers ?? loadProviderList()
  for (const provider of list) {
    if (!OLLAMA_PROVIDER_TYPES.has(provider.providerType)) continue
    const enabled = provider.enabledModels ?? []
    if (!enabled.includes(DEFAULT_CONNECTOR_LOCAL_MODEL_ID)) continue
    return { providerId: provider.id, modelId: DEFAULT_CONNECTOR_LOCAL_MODEL_ID }
  }
  return null
}

/** The setting when present, otherwise the derived default, otherwise `null`. */
export function resolveConnectorLocalModel(providers?: readonly ProviderConfig[]): ConnectorLocalModelRef | null {
  return loadConnectorLocalModelSetting() ?? defaultConnectorLocalModel(providers)
}

export class ConnectorLocalModelRejected extends Error {
  constructor(readonly ref: ConnectorLocalModelRef) {
    super(`Model "${ref.modelId}" of provider "${ref.providerId}" is not strictly local`)
    this.name = 'ConnectorLocalModelRejected'
  }
}

/**
 * Persist `connectors.localModel`. Read-modify-write of the whole settings
 * file, like the settings service does, so unrelated keys survive.
 *
 * @throws ConnectorLocalModelRejected when the pair is not strictly local.
 */
export function setConnectorLocalModel(input: ConnectorLocalModelRef): ConnectorLocalModelRef {
  const ref = normalizeRef(input)
  if (!ref) throw new Error('providerId and modelId are required')
  if (!isStrictlyLocalModel(ref.providerId, ref.modelId)) throw new ConnectorLocalModelRejected(ref)

  ensureConfigTemplates()
  const filePath = path.join(getConfigDir(), 'settings.json')
  const settings = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  const connectors = (typeof settings.connectors === 'object' && settings.connectors !== null
    ? settings.connectors
    : {}) as Record<string, unknown>
  connectors.localModel = { providerId: ref.providerId, modelId: ref.modelId }
  settings.connectors = connectors
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  return ref
}

/** Every strictly local provider/model pair the instance could be pointed at. */
export function listStrictlyLocalModels(providers?: readonly ProviderConfig[]): ConnectorLocalModelRef[] {
  const out: ConnectorLocalModelRef[] = []
  for (const provider of providers ?? loadProviderList()) {
    for (const modelId of provider.enabledModels ?? []) {
      if (isStrictlyLocalModel(provider.id, modelId)) out.push({ providerId: provider.id, modelId })
    }
  }
  return out
}

/** What the `/connectors` page shows in its one status line. */
export interface ConnectorLocalModelStatus {
  configured: boolean
  /** True when the pair comes from the setting, false when it is the default. */
  fromSetting: boolean
  providerId: string
  modelId: string
  providerName: string
  strictlyLocal: boolean
  /** `null` = not checked (nothing configured, or no endpoint to probe). */
  reachable: boolean | null
}

export interface ConnectorLocalModelStatusOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Skip the network probe (used by the cheap render path in tests). */
  probe?: boolean
}

/**
 * Cheap status of the configured local model. The reachability probe is one
 * `GET /api/tags` with a short timeout — the same call that keeps the hosting
 * cache warm, so the strict-local answer afterwards is based on fresh data.
 */
export async function getConnectorLocalModelStatus(
  options: ConnectorLocalModelStatusOptions = {},
): Promise<ConnectorLocalModelStatus> {
  const providers = loadProviderList()
  const setting = loadConnectorLocalModelSetting()
  const ref = setting ?? defaultConnectorLocalModel(providers)
  if (!ref) {
    return {
      configured: false,
      fromSetting: false,
      providerId: '',
      modelId: '',
      providerName: '',
      strictlyLocal: false,
      reachable: null,
    }
  }

  const provider = providers.find(p => p.id === ref.providerId) ?? null
  let reachable: boolean | null = null
  if (options.probe !== false && provider?.baseUrl && OLLAMA_PROVIDER_TYPES.has(provider.providerType)) {
    reachable = await isOllamaEndpointReachable(provider, options)
  }

  return {
    configured: true,
    fromSetting: setting !== null,
    providerId: ref.providerId,
    modelId: ref.modelId,
    providerName: provider?.name ?? '',
    strictlyLocal: isStrictlyLocalModel(ref.providerId, ref.modelId),
    reachable,
  }
}

/**
 * One `/api/tags` probe against an Ollama endpoint. Returns false on any
 * failure (timeout, refused, HTTP error) and refreshes the hosting cache as a
 * side effect.
 */
export async function isOllamaEndpointReachable(
  provider: Pick<ProviderConfig, 'id' | 'baseUrl' | 'providerType'>,
  options: ConnectorLocalModelStatusOptions = {},
): Promise<boolean> {
  if (!provider.baseUrl) return false
  const stored = await refreshOllamaTags({
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 5_000,
  })
  return stored > 0
}

/** True when this provider type exposes `/api/tags` and can be probed. */
export function isOllamaProviderType(providerType: string | undefined): boolean {
  return !!providerType && OLLAMA_PROVIDER_TYPES.has(providerType)
}
