import type { ProviderType } from '../provider-config.js'

export type ProviderStatusContract = 'connected' | 'error' | 'untested'

/** Provider families that expose a subscriber usage quota endpoint. */
export type ProviderQuotaKindContract = 'anthropic' | 'openai-codex' | 'opencode-go' | 'zai'

/**
 * A single normalized usage window, provider-agnostic. Each window carries its
 * own display hints so the UI can render any provider's quota without knowing
 * the provider's bucket naming.
 */
export interface ProviderQuotaWindowContract {
  /** Stable identifier within the provider (e.g. 'five_hour', 'primary'). */
  key: string
  /** Short display label (e.g. '5h', '7d', 'Opus'). */
  label: string
  /** Integer 0–100 percentage of the window consumed. */
  utilization: number
  /** ISO-8601 timestamp when the window resets, or null if unknown. */
  resetsAt: string | null
  /** Preferred reset rendering: relative countdown or absolute weekday/time. */
  resetDisplay: 'relative' | 'absolute'
}

export interface ProviderQuotaContract {
  kind: ProviderQuotaKindContract
  /** Normalized usage windows in display order. */
  windows: ProviderQuotaWindowContract[]
  /** Optional human-readable plan label (e.g. 'Plus', 'Pro', 'Max'). */
  plan?: string | null
  fetchedAt: string
  error?: string
}
export type ProviderAuthMethodContract = 'api-key' | 'oauth'
export type ProviderTextVerbosityContract = 'low' | 'medium' | 'high'
export type ProviderTransportContract = 'sse' | 'websocket' | 'websocket-cached' | 'auto'
/**
 * System-prompt size profile. `'full'` (default) keeps the complete prompt;
 * `'slim'` reduces it for slow/local providers (1 daily file instead of 3,
 * no wiki listing, no docs block). Core memory files are always included.
 */
export type ProviderPromptProfileContract = 'full' | 'slim'

export interface ProviderContract {
  id: string
  name: string
  type: string
  providerType: ProviderType | string
  provider: string
  baseUrl: string
  apiKey: string
  apiKeyMasked: string
  enabledModels?: string[]
  degradedThresholdMs?: number
  healthCheckTimeoutMs?: number
  textVerbosity?: ProviderTextVerbosityContract
  transport?: ProviderTransportContract
  promptProfile?: ProviderPromptProfileContract
  status?: ProviderStatusContract
  modelStatuses?: Record<string, ProviderStatusContract>
  authMethod?: ProviderAuthMethodContract
  oauthCredentials?: { expires: number }
  cost?: { input: number; output: number } | null
  modelCosts?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>
  /** Per-model user overrides (description, cost, limits). Not masked. */
  models?: ProviderModelContract[]
  /** True when this provider exposes a subscriber usage quota endpoint. */
  supportsQuota?: boolean
  /** Subscriber usage snapshot (only for quota-capable OAuth providers). */
  quota?: ProviderQuotaContract | null
  /** Non-secret provider-specific extra field values (secret values are omitted). */
  extraFields?: Record<string, string>
  /** Presence flags for secret extra fields (the values themselves are never returned). */
  extraFieldsSet?: Record<string, boolean>
}

/**
 * Per-model user override entry stored in `ProviderConfig.models[]`. Exposed
 * via the API so the UI can edit a model's description and cost.
 */
export interface ProviderModelContract {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
  fixedTemperature?: number
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

/** Declarative definition of one provider-specific extra configuration field. */
export interface ProviderExtraFieldDefContract {
  key: string
  label: string
  secret?: boolean
  required?: boolean
  placeholder?: string
  hint?: string
}

export interface ProviderTypePresetContract {
  type: ProviderType | string
  label: string
  /** Optional human-readable hint shown alongside the label (e.g. for
   *  the generic OpenAI-compatible preset to explain what it covers). */
  description?: string
  apiType: string
  providerName: string
  baseUrl: string
  requiresApiKey: boolean
  urlEditable: boolean
  piAiProvider: string | null
  /**
   * True if the provider type has a known catalog of models (either via
   * pi-ai's registry or via local PROVIDER_TYPE_MODEL_OVERRIDES). The UI
   * uses this to decide whether to render the checkbox list of enabled
   * models instead of a free-text model input.
   */
  hasKnownModels: boolean
  authMethod: ProviderAuthMethodContract
  oauthProviderId?: string
  /**
   * Display-only hint: the UI groups this preset under "Subscription / OAuth"
   * even though it authenticates with an API key (e.g. OpenCode Go).
   */
  subscription?: boolean
  /**
   * True when the Add Model dialog should fetch this provider's model list
   * live from its own `/models` endpoint (via `GET /api/providers/:id/live-models`)
   * instead of the static catalog returned by `hasKnownModels`.
   */
  dynamicCatalog?: boolean
  /** Provider-specific extra fields the UI should render generically. */
  extraFields?: ProviderExtraFieldDefContract[]
}

export interface AvailableModelContract {
  id: string
  name: string
  contextWindow?: number
  /** USD per 1M tokens. */
  cost?: { input: number; output: number }
}

export interface OllamaModelContract {
  name: string
  size: number
  parameterSize: string
  quantization: string
  family: string
}

export interface OllamaPullEventContract {
  status?: string
  total?: number
  completed?: number
  error?: string
  done?: boolean
}

export interface ProvidersListResponseContract {
  providers: ProviderContract[]
  activeProvider: string | null
  activeModel: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
  presets: Record<string, ProviderTypePresetContract>
}

export interface ProviderMutationResponseContract {
  provider: ProviderContract
}

export interface ProviderQuotaRefreshResponseContract {
  quota: ProviderQuotaContract | null
}

export interface ProviderTestResultContract {
  success: boolean
  message?: string
  error?: string
}

export interface ProviderActivationResponseContract {
  activeProvider: string
  activeModel: string | null
}

export interface ProviderFallbackResponseContract {
  fallbackProvider: string | null
  fallbackModel: string | null
}

export interface OAuthLoginResponseContract {
  loginId: string
  authUrl: string
  instructions?: string
  usesCallbackServer: boolean
}

export interface OAuthStatusResponseContract {
  status: 'pending' | 'completed' | 'error'
  provider?: ProviderContract
  error?: string
}

export interface ProviderCreatePayloadContract {
  name: string
  providerType: string
  baseUrl?: string
  apiKey?: string
  enabledModels: string[]
  degradedThresholdMs?: number
  healthCheckTimeoutMs?: number
  textVerbosity?: ProviderTextVerbosityContract | null
  transport?: ProviderTransportContract | null
  promptProfile?: ProviderPromptProfileContract | null
  extraFields?: Record<string, string>
}

export interface ProviderUpdatePayloadContract {
  name?: string
  providerType?: string
  baseUrl?: string
  apiKey?: string
  enabledModels?: string[]
  degradedThresholdMs?: number
  healthCheckTimeoutMs?: number
  textVerbosity?: ProviderTextVerbosityContract | null
  transport?: ProviderTransportContract | null
  promptProfile?: ProviderPromptProfileContract | null
  extraFields?: Record<string, string>
}

export interface ProviderFallbackUpdatePayloadContract {
  providerId?: string | null
  modelId?: string | null
}

export interface ProviderOAuthLoginStartPayloadContract {
  providerType: string
  name: string
  enabledModels: string[]
  providerId?: string
  textVerbosity?: ProviderTextVerbosityContract | null
  transport?: ProviderTransportContract | null
}

export interface ProviderOAuthCodePayloadContract {
  code: string
}

export interface ProviderModelSelectionPayloadContract {
  modelId?: string
}

/**
 * Body for `PATCH /api/providers/:providerId/models/:modelId`. Only the
 * supplied fields are applied; omitted fields keep their existing (or
 * catalog-default) value.
 */
export interface ProviderModelUpdatePayloadContract {
  name?: string
  description?: string
  contextWindow?: number
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

export interface ProviderReferenceContract {
  id: string
  enabledModels?: string[]
}

/**
 * Canonicalize provider selectors to "providerId:modelId" while keeping legacy values valid.
 *
 * Compatibility behavior:
 * - "providerId:modelId" stays unchanged
 * - legacy "providerId" expands to "providerId:<first enabled model>" when provider is known
 * - unknown values are returned unchanged
 */
export function canonicalizeProviderModelRef(
  value: string | null | undefined,
  providers: readonly ProviderReferenceContract[],
): string {
  if (!value) return ''

  const trimmed = value.trim()
  if (!trimmed) return ''

  if (trimmed.includes(':')) {
    return trimmed
  }

  const provider = providers.find((candidate) => candidate.id === trimmed)
  if (!provider) return trimmed

  const firstModel = provider.enabledModels?.[0]
  return firstModel ? `${provider.id}:${firstModel}` : trimmed
}
