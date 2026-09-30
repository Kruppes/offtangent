import type {
  AvailableModelContract,
  OAuthLoginResponseContract,
  OAuthStatusResponseContract,
  OllamaModelContract,
  OllamaPullEventContract,
  ProviderActivationResponseContract,
  ProviderContract,
  ProviderCreatePayloadContract,
  ProviderFallbackResponseContract,
  ProviderModelUpdatePayloadContract,
  ProviderMutationResponseContract,
  ProviderQuotaRefreshResponseContract,
  ProviderTestResultContract,
  ProviderTypePresetContract,
  ProviderUpdatePayloadContract,
  ProvidersListResponseContract,
} from '@axiom/core/contracts'

export type Provider = ProviderContract
export type OAuthLoginResponse = OAuthLoginResponseContract
export type OAuthStatusResponse = OAuthStatusResponseContract
export type ProviderTypePreset = ProviderTypePresetContract
export type AvailableModel = AvailableModelContract
export type OllamaModel = OllamaModelContract
export type OllamaPullEvent = OllamaPullEventContract

interface PullProgressOptions {
  onProgress: (event: OllamaPullEvent) => void
}

export function useProvidersApi() {
  const { apiFetch, getAuthHeaders } = useApi()
  const config = useRuntimeConfig()

  const getProviders = () => apiFetch<ProvidersListResponseContract>('/api/providers')

  const createProvider = (input: ProviderCreatePayloadContract) =>
    apiFetch<ProviderMutationResponseContract>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    })

  const updateProvider = (id: string, input: ProviderUpdatePayloadContract) =>
    apiFetch<ProviderMutationResponseContract>(`/api/providers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })

  const updateProviderModel = (
    providerId: string,
    modelId: string,
    input: ProviderModelUpdatePayloadContract,
  ) =>
    apiFetch<ProviderMutationResponseContract>(
      `/api/providers/${providerId}/models/${encodeURIComponent(modelId)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )

  const removeProvider = (id: string) =>
    apiFetch(`/api/providers/${id}`, { method: 'DELETE' })

  const testProvider = (id: string, modelId?: string) =>
    apiFetch<ProviderTestResultContract>(`/api/providers/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({ modelId }),
    })

  const activateProvider = (id: string, modelId?: string) =>
    apiFetch<ProviderActivationResponseContract>(`/api/providers/${id}/activate`, {
      method: 'POST',
      body: JSON.stringify({ modelId }),
    })

  const refreshQuota = (id: string) =>
    apiFetch<ProviderQuotaRefreshResponseContract>(`/api/providers/${id}/refresh-quota`, {
      method: 'POST',
    })

  const setFallbackProvider = (providerId: string | null, modelId?: string | null) =>
    apiFetch<ProviderFallbackResponseContract>('/api/providers/fallback', {
      method: 'PUT',
      body: JSON.stringify({ providerId, modelId }),
    })

  const getModels = (providerType: string) =>
    apiFetch<{ models: AvailableModel[] }>(`/api/providers/models/${providerType}`)

  const getLiveModels = (providerId: string) =>
    apiFetch<{ models: AvailableModel[] }>(`/api/providers/${providerId}/live-models`)

  const getOllamaModels = (providerId: string) =>
    apiFetch<{ models: OllamaModel[] }>(`/api/providers/${providerId}/ollama-models`)

  const probeOpenAiCompatibleModels = (baseUrl: string, apiKey: string | undefined, providerType: string) =>
    apiFetch<{ models: AvailableModel[] }>('/api/providers/openai-compatible/models-probe', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, apiKey, providerType }),
    })

  const probeOllamaModels = (baseUrl: string, providerType: string) =>
    apiFetch<{ models: OllamaModel[] }>('/api/providers/ollama-probe', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, providerType }),
    })

  const deleteOllamaModel = (providerId: string, modelName: string) =>
    apiFetch(`/api/providers/${providerId}/ollama-models/${encodeURIComponent(modelName)}`, {
      method: 'DELETE',
    })

  async function pullOllamaModel(providerId: string, modelName: string, options: PullProgressOptions): Promise<void> {
    const response = await fetch(`${config.public.apiBase || ''}/api/providers/${providerId}/ollama-pull`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modelName }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Pull failed' })) as { error?: string }
      throw new Error(err.error || `HTTP ${response.status}`)
    }

    await readSseStream(response, options.onProgress)
  }

  async function pullOllamaProbeModel(
    baseUrl: string,
    providerType: string,
    modelName: string,
    options: PullProgressOptions,
  ): Promise<void> {
    const response = await fetch(`${config.public.apiBase || ''}/api/providers/ollama-probe/pull`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ baseUrl, providerType, modelName }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Pull failed' })) as { error?: string }
      throw new Error(err.error || `HTTP ${response.status}`)
    }

    await readSseStream(response, options.onProgress)
  }

  const startOAuthLogin = (input: {
    providerType: string
    name: string
    enabledModels: string[]
    providerId?: string
    textVerbosity?: 'low' | 'medium' | 'high' | null
    transport?: 'sse' | 'websocket' | 'websocket-cached' | 'auto' | null
  }) =>
    apiFetch<OAuthLoginResponse>('/api/providers/oauth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    })

  const pollOAuthStatus = (loginId: string) => apiFetch<OAuthStatusResponse>(`/api/providers/oauth/status/${loginId}`)

  const submitOAuthCode = (loginId: string, code: string) =>
    apiFetch(`/api/providers/oauth/code/${loginId}`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    })

  return {
    getProviders,
    createProvider,
    updateProvider,
    updateProviderModel,
    removeProvider,
    testProvider,
    activateProvider,
    refreshQuota,
    setFallbackProvider,
    getModels,
    getLiveModels,
    getOllamaModels,
    probeOpenAiCompatibleModels,
    probeOllamaModels,
    deleteOllamaModel,
    pullOllamaModel,
    pullOllamaProbeModel,
    startOAuthLogin,
    pollOAuthStatus,
    submitOAuthCode,
  }
}

async function readSseStream(response: Response, onProgress: (event: OllamaPullEvent) => void): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('No response body')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue

      try {
        const event = JSON.parse(line.slice(6)) as OllamaPullEvent
        onProgress(event)
      } catch {
        console.warn('[ollama-pull] Skipping malformed SSE data:', line.substring(0, 200))
      }
    }
  }
}
