import { buildModel, getProviderDefaultModel, isQuotaProvider, maskProviderExtraFields, PROVIDER_TYPE_MODEL_OVERRIDES, PROVIDER_TYPE_PRESETS } from '@axiom/core'
import type {
  ProviderConfig,
  ProviderType,
  ProvidersFile,
} from '@axiom/core'
import type {
  ProviderQuotaContract,
  OllamaModelContract,
  ProviderActivationResponseContract,
  ProviderContract,
  ProviderFallbackResponseContract,
  ProviderMutationResponseContract,
  ProvidersListResponseContract,
} from '@axiom/core/contracts'
import { getBuiltinModels as getPiAiModels } from '@earendil-works/pi-ai/providers/all'
import type { OllamaTagsResponse } from './types.js'

function maskApiKey(apiKey: string): string {
  return `${apiKey.slice(0, 4)}••••••••${apiKey.slice(-4)}`
}

function resolveModelCost(provider: ProviderConfig, modelId: string): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
  try {
    const model = buildModel(provider, modelId)
    if (model.cost.input > 0 || model.cost.output > 0) {
      const cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number } = {
        input: model.cost.input,
        output: model.cost.output,
      }
      if (model.cost.cacheRead > 0) cost.cacheRead = model.cost.cacheRead
      if (model.cost.cacheWrite > 0) cost.cacheWrite = model.cost.cacheWrite
      return cost
    }
  } catch {
    // ignore and try registry fallback
  }

  const preset = PROVIDER_TYPE_PRESETS[provider.providerType as ProviderType]
  if (!preset?.piAiProvider) {
    return null
  }

  try {
    const models = getPiAiModels(preset.piAiProvider as Parameters<typeof getPiAiModels>[0])
    const match = models.find((entry) => entry.id === modelId)
    if (match && (match.cost.input > 0 || match.cost.output > 0)) {
      const cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number } = {
        input: match.cost.input,
        output: match.cost.output,
      }
      if (match.cost.cacheRead > 0) cost.cacheRead = match.cost.cacheRead
      if (match.cost.cacheWrite > 0) cost.cacheWrite = match.cost.cacheWrite
      return cost
    }
  } catch {
    // ignore lookup errors
  }

  return null
}

export function mapProvidersListResponse(
  masked: ProvidersFile,
  decrypted: ProvidersFile,
  quotaSnapshot?: Record<string, ProviderQuotaContract>,
): ProvidersListResponseContract {
  const providers = masked.providers.map((provider) => {
    const fullProvider = decrypted.providers.find((candidate) => candidate.id === provider.id)
    let cost: { input: number; output: number } | null = null
    const modelCosts: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {}

    if (fullProvider) {
      cost = resolveModelCost(fullProvider, getProviderDefaultModel(fullProvider))

      const enabledModels = fullProvider.enabledModels ?? []
      for (const modelId of enabledModels) {
        const modelCost = resolveModelCost(fullProvider, modelId)
        if (modelCost) {
          modelCosts[modelId] = modelCost
        }
      }
    }

    return {
      ...provider,
      apiKeyMasked: (provider as unknown as { apiKeyMasked?: string }).apiKeyMasked ?? provider.apiKey,
      cost,
      modelCosts,
      supportsQuota: fullProvider ? isQuotaProvider(fullProvider) : false,
      quota: quotaSnapshot?.[provider.id] ?? null,
    } as ProviderContract
  })

  const presets = Object.fromEntries(
    Object.entries(PROVIDER_TYPE_PRESETS)
      .filter(([key]) => key !== 'ollama-local' && key !== 'ollama-cloud')
      .map(([key, preset]) => {
        const overrides = PROVIDER_TYPE_MODEL_OVERRIDES[key as ProviderType]
        const hasKnownModels = preset.piAiProvider != null || (overrides?.length ?? 0) > 0
        return [key, { ...preset, hasKnownModels }]
      }),
  )

  return {
    providers,
    activeProvider: masked.activeProvider ?? null,
    activeModel: masked.activeModel ?? null,
    fallbackProvider: masked.fallbackProvider ?? null,
    fallbackModel: masked.fallbackModel ?? null,
    presets,
  }
}

export function mapCreatedProviderResponse(provider: ProviderConfig, rawApiKey?: string): ProviderMutationResponseContract {
  const { extraFields, extraFieldsSet } = maskProviderExtraFields(provider.providerType, provider.extraFields)
  return {
    provider: {
      ...provider,
      apiKey: '',
      apiKeyMasked: rawApiKey ? maskApiKey(rawApiKey) : '',
      extraFields,
      extraFieldsSet,
    } as ProviderContract,
  }
}

export function mapUpdatedProviderResponse(provider: ProviderConfig, rawApiKey?: string): ProviderMutationResponseContract {
  const { extraFields, extraFieldsSet } = maskProviderExtraFields(provider.providerType, provider.extraFields)
  return {
    provider: {
      ...provider,
      apiKey: '',
      apiKeyMasked: rawApiKey ? maskApiKey(rawApiKey) : '(unchanged)',
      extraFields,
      extraFieldsSet,
    } as ProviderContract,
  }
}

export function mapOAuthProviderResponse(provider: ProviderConfig): ProviderMutationResponseContract {
  return {
    provider: {
      ...provider,
      apiKey: '',
      apiKeyMasked: '',
    } as ProviderContract,
  }
}

export function mapProviderActivationResponse(
  activeProvider: string,
  activeModel: string | null,
): ProviderActivationResponseContract & { message: string } {
  return {
    message: 'Provider activated',
    activeProvider,
    activeModel,
  }
}

export function mapFallbackSetResponse(
  fallbackProvider: string | null,
  fallbackModel: string | null,
): ProviderFallbackResponseContract & { message: string } {
  return {
    message: fallbackProvider ? 'Fallback set' : 'Fallback provider cleared',
    fallbackProvider,
    fallbackModel,
  }
}

export function mapOllamaModelsResponse(data: OllamaTagsResponse): { models: OllamaModelContract[] } {
  const models: OllamaModelContract[] = (data.models ?? []).map((entry) => ({
    name: entry.name,
    size: entry.size,
    parameterSize: entry.details?.parameter_size ?? '',
    quantization: entry.details?.quantization_level ?? '',
    family: entry.details?.family ?? '',
  }))

  return { models }
}
