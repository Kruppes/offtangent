import type {
  ProviderCreatePayloadContract,
  ProviderModelUpdatePayloadContract,
  ProviderUpdatePayloadContract,
} from '@axiom/core/contracts'
import { useProvidersApi } from '~/api/providers'
import type {
  AvailableModel,
  OAuthLoginResponse,
  OAuthStatusResponse,
  OllamaModel,
  OllamaPullEvent,
  Provider,
  ProviderTypePreset,
} from '~/api/providers'

export type {
  AvailableModel,
  OAuthLoginResponse,
  OAuthStatusResponse,
  OllamaModel,
  OllamaPullEvent,
  Provider,
  ProviderTypePreset,
} from '~/api/providers'

export function useProviders() {
  const providersApi = useProvidersApi()

  const providers = useState<Provider[]>('providers_list', () => [])
  const activeProviderId = useState<string | null>('active_provider', () => null)
  const activeModelId = useState<string | null>('active_model', () => null)
  const fallbackProviderId = useState<string | null>('fallback_provider', () => null)
  const fallbackModelId = useState<string | null>('fallback_model', () => null)
  const presets = useState<Record<string, ProviderTypePreset>>('provider_presets', () => ({}))
  const loading = useState<boolean>('providers_loading', () => false)
  const error = useState<string | null>('providers_error', () => null)
  const testingId = useState<string | null>('providers_testing', () => null)

  async function fetchProviders(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const data = await providersApi.getProviders()
      providers.value = data.providers
      activeProviderId.value = data.activeProvider
      activeModelId.value = data.activeModel
      fallbackProviderId.value = data.fallbackProvider
      fallbackModelId.value = data.fallbackModel
      presets.value = data.presets
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function addProvider(input: ProviderCreatePayloadContract): Promise<Provider | null> {
    error.value = null
    try {
      const data = await providersApi.createProvider(input)
      await fetchProviders()
      return data.provider
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function updateProvider(id: string, input: ProviderUpdatePayloadContract): Promise<Provider | null> {
    error.value = null
    try {
      const data = await providersApi.updateProvider(id, input)
      await fetchProviders()
      return data.provider
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function updateProviderModel(
    providerId: string,
    modelId: string,
    input: ProviderModelUpdatePayloadContract,
  ): Promise<Provider | null> {
    error.value = null
    try {
      const data = await providersApi.updateProviderModel(providerId, modelId, input)
      await fetchProviders()
      return data.provider
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function deleteProvider(id: string): Promise<boolean> {
    error.value = null
    try {
      await providersApi.removeProvider(id)
      await fetchProviders()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function testProvider(id: string, modelId?: string): Promise<{ success: boolean; message?: string; error?: string }> {
    testingId.value = modelId ? `${id}:${modelId}` : id
    try {
      const result = await providersApi.testProvider(id, modelId)
      await fetchProviders()
      return result
    } catch (err) {
      return { success: false, error: (err as Error).message }
    } finally {
      testingId.value = null
    }
  }

  async function refreshQuota(id: string): Promise<boolean> {
    error.value = null
    try {
      await providersApi.refreshQuota(id)
      await fetchProviders()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function activateProvider(id: string, modelId?: string): Promise<boolean> {
    error.value = null
    try {
      const result = await providersApi.activateProvider(id, modelId)
      activeProviderId.value = result.activeProvider
      activeModelId.value = result.activeModel
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function setFallbackProvider(providerId: string | null, modelId?: string | null): Promise<boolean> {
    error.value = null
    try {
      const result = await providersApi.setFallbackProvider(providerId, modelId)
      fallbackProviderId.value = result.fallbackProvider
      fallbackModelId.value = result.fallbackModel
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function fetchModels(providerType: string): Promise<AvailableModel[]> {
    const data = await providersApi.getModels(providerType)
    return data.models
  }

  async function fetchLiveModels(providerId: string): Promise<AvailableModel[]> {
    const data = await providersApi.getLiveModels(providerId)
    return data.models
  }

  async function fetchOllamaModels(providerId: string): Promise<OllamaModel[]> {
    const data = await providersApi.getOllamaModels(providerId)
    return data.models
  }

  async function probeOpenAiCompatibleModels(baseUrl: string, apiKey: string | undefined, providerType: string): Promise<AvailableModel[]> {
    const data = await providersApi.probeOpenAiCompatibleModels(baseUrl, apiKey, providerType)
    return data.models
  }

  async function probeOllamaModels(baseUrl: string, providerType: string): Promise<OllamaModel[]> {
    const data = await providersApi.probeOllamaModels(baseUrl, providerType)
    return data.models
  }

  async function pullOllamaModel(
    providerId: string,
    modelName: string,
    onProgress: (event: OllamaPullEvent) => void,
  ): Promise<void> {
    await providersApi.pullOllamaModel(providerId, modelName, { onProgress })
  }

  async function probeOllamaPull(
    baseUrl: string,
    providerType: string,
    modelName: string,
    onProgress: (event: OllamaPullEvent) => void,
  ): Promise<void> {
    await providersApi.pullOllamaProbeModel(baseUrl, providerType, modelName, { onProgress })
  }

  async function deleteOllamaModel(providerId: string, modelName: string): Promise<void> {
    await providersApi.deleteOllamaModel(providerId, modelName)
  }

  async function startOAuthLogin(input: {
    providerType: string
    name: string
    enabledModels: string[]
    providerId?: string
    textVerbosity?: 'low' | 'medium' | 'high' | null
    transport?: 'sse' | 'websocket' | 'websocket-cached' | 'auto' | null
  }): Promise<OAuthLoginResponse> {
    return providersApi.startOAuthLogin(input)
  }

  async function pollOAuthStatus(loginId: string): Promise<OAuthStatusResponse> {
    return providersApi.pollOAuthStatus(loginId)
  }

  async function submitOAuthCode(loginId: string, code: string): Promise<void> {
    await providersApi.submitOAuthCode(loginId, code)
  }

  return {
    providers,
    activeProviderId,
    activeModelId,
    fallbackProviderId,
    fallbackModelId,
    presets,
    loading,
    error,
    testingId,
    fetchProviders,
    fetchModels,
    fetchLiveModels,
    fetchOllamaModels,
    probeOpenAiCompatibleModels,
    probeOllamaModels,
    pullOllamaModel,
    probeOllamaPull,
    deleteOllamaModel,
    addProvider,
    updateProvider,
    updateProviderModel,
    deleteProvider,
    testProvider,
    activateProvider,
    refreshQuota,
    setFallbackProvider,
    startOAuthLogin,
    pollOAuthStatus,
    submitOAuthCode,
  }
}
