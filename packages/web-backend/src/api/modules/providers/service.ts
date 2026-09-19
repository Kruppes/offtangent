import crypto from 'node:crypto'
import { URL } from 'node:url'
import {
  addOAuthProvider,
  addProvider as addProviderConfig,
  clearFallbackProvider,
  deleteProvider as deleteProviderConfig,
  getAvailableModels,
  isDynamicCatalogProvider,
  getFallbackModelId,
  getProviderDefaultModel,
  loadProviders,
  loadProvidersDecrypted,
  loadProvidersMasked,
  performProviderHealthCheck,
  PROVIDER_TYPE_PRESETS,
  setActiveProvider,
  setFallbackProvider,
  updateOAuthCredentials,
  updateProvider as updateProviderConfig,
  updateProviderModel as updateProviderModelConfig,
  updateProviderStatus,
  ProviderNotFoundError,
} from '@axiom/core'
import type { AvailableModel, ProviderConfig, ProviderType, ProvidersFile } from '@axiom/core'
import type {
  OAuthLoginResponseContract,
  ProviderCreatePayloadContract,
  ProviderFallbackUpdatePayloadContract,
  ProviderModelSelectionPayloadContract,
  ProviderModelUpdatePayloadContract,
  ProviderOAuthLoginStartPayloadContract,
  ProviderUpdatePayloadContract,
} from '@axiom/core/contracts'
import { getPiOAuthAuth } from '@axiom/core'
import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth'

/**
 * Whether an OAuth flow binds a local callback server (with manual code
 * paste as fallback). pi-ai < 0.80.8 exposed this as
 * `OAuthProvider.usesCallbackServer`; the reworked `OAuthAuth` interface
 * signals a manual-code step only mid-flow (via a `manual_code` prompt), so
 * the values are pinned here for the upfront UI contract.
 */
const OAUTH_USES_CALLBACK_SERVER: Record<string, boolean> = {
  'anthropic': true,
  'openai-codex': true,
  'github-copilot': false,
}
import {
  normalizeOllamaBaseUrl,
  OLLAMA_REQUEST_TIMEOUT_MS,
  validateOllamaUrl,
} from './schema.js'
import type {
  OllamaTagsResponse,
  PendingOAuthLogin,
  ProvidersRouterOptions,
} from './types.js'

export class ProvidersValidationError extends Error {}
export class ProvidersNotFoundError extends Error {}
export class ProvidersRuntimeError extends Error {}
export class ProvidersExternalError extends Error {}

export interface ProvidersService {
  listProviders: () => { masked: ProvidersFile; decrypted: ProvidersFile }
  getModelsByProviderType: (providerType: string) => AvailableModel[]
  getLiveModels: (providerId: string) => Promise<AvailableModel[]>
  setFallback: (payload: ProviderFallbackUpdatePayloadContract) => { fallbackProvider: string | null; fallbackModel: string | null }
  startOAuthLogin: (payload: ProviderOAuthLoginStartPayloadContract) => Promise<OAuthLoginResponseContract>
  getOAuthStatus: (loginId: string) => Promise<
    | { status: 'pending' }
    | { status: 'error'; error?: string }
    | { status: 'completed'; provider: ProviderConfig }
  >
  submitOAuthCode: (loginId: string, code: string) => void
  createProvider: (payload: ProviderCreatePayloadContract) => ProviderConfig
  updateProvider: (id: string, payload: ProviderUpdatePayloadContract) => ProviderConfig
  updateProviderModel: (providerId: string, modelId: string, payload: ProviderModelUpdatePayloadContract) => ProviderConfig
  deleteProvider: (id: string) => void
  testProvider: (
    id: string,
    payload: ProviderModelSelectionPayloadContract,
  ) => Promise<{
    success: boolean
    message?: string
    error?: string
    latencyMs?: number
    status?: string
    modelId: string
  }>
  activateProvider: (id: string, payload: ProviderModelSelectionPayloadContract) => { activeProvider: string; activeModel: string | null }
  probeOpenAiCompatibleModels: (baseUrl: string, apiKey?: string) => Promise<AvailableModel[]>
  probeOllamaModels: (baseUrl: string) => Promise<OllamaTagsResponse>
  listOllamaModels: (providerId: string) => Promise<OllamaTagsResponse>
  requestOllamaProbePull: (baseUrl: string, modelName: string, signal: AbortSignal) => Promise<Response>
  requestOllamaPull: (providerId: string, modelName: string, signal: AbortSignal) => Promise<Response>
  deleteOllamaModel: (providerId: string, modelName: string) => Promise<void>
}

export function createProvidersService(options: ProvidersRouterOptions = {}): ProvidersService {
  const pendingOAuthLogins = new Map<string, PendingOAuthLogin>()
  let oauthCleanupInterval: ReturnType<typeof setInterval> | null = null

  function stopOAuthCleanupTimer(): void {
    if (!oauthCleanupInterval) return
    clearInterval(oauthCleanupInterval)
    oauthCleanupInterval = null
  }

  function maybeStopOAuthCleanupTimer(): void {
    if (pendingOAuthLogins.size === 0) {
      stopOAuthCleanupTimer()
    }
  }

  function ensureOAuthCleanupTimer(): void {
    if (oauthCleanupInterval) return

    oauthCleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000
      for (const [id, login] of pendingOAuthLogins) {
        if (login.createdAt < cutoff) {
          pendingOAuthLogins.delete(id)
        }
      }

      maybeStopOAuthCleanupTimer()
    }, 60 * 1000)

    oauthCleanupInterval.unref?.()
  }

  function listProviders() {
    return {
      masked: loadProvidersMasked(),
      decrypted: loadProvidersDecrypted(),
    }
  }

  function getModelsByProviderType(providerType: string): AvailableModel[] {
    try {
      return getAvailableModels(providerType as ProviderType)
    } catch (err) {
      throw new ProvidersRuntimeError(`Failed to get models: ${(err as Error).message}`)
    }
  }

  async function getLiveModels(providerId: string): Promise<AvailableModel[]> {
    const provider = requireProvider(providerId)
    if (!isDynamicCatalogProvider(provider.providerType)) {
      throw new ProvidersValidationError('Provider type does not use a dynamic catalog')
    }

    try {
      return await probeOpenAiCompatibleModelsFromBase(provider.baseUrl, provider.apiKey || undefined)
    } catch (err) {
      console.warn(`[axiom] Live model fetch failed for provider "${provider.name}", using bundled catalog: ${(err as Error).message}`)
      return getAvailableModels(provider.providerType as ProviderType)
    }
  }

  function setFallback(payload: ProviderFallbackUpdatePayloadContract) {
    try {
      if (payload.providerId === null || payload.providerId === undefined) {
        clearFallbackProvider()
        options.onFallbackProviderChanged?.()
        return {
          fallbackProvider: null,
          fallbackModel: null,
        }
      }

      setFallbackProvider(payload.providerId, payload.modelId ?? undefined)
      options.onFallbackProviderChanged?.()

      return {
        fallbackProvider: payload.providerId,
        fallbackModel: getFallbackModelId(),
      }
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        throw new ProvidersNotFoundError(message)
      }
      throw new ProvidersValidationError(message)
    }
  }

  async function startOAuthLogin(payload: ProviderOAuthLoginStartPayloadContract): Promise<OAuthLoginResponseContract> {
    const preset = PROVIDER_TYPE_PRESETS[payload.providerType as ProviderType]
    if (preset.authMethod !== 'oauth' || !preset.oauthProviderId) {
      throw new ProvidersValidationError('This provider type does not use OAuth')
    }

    const oauthAuth = getPiOAuthAuth(preset.oauthProviderId)
    if (!oauthAuth) {
      throw new ProvidersValidationError(`OAuth provider "${preset.oauthProviderId}" not found`)
    }
    const usesCallbackServer = OAUTH_USES_CALLBACK_SERVER[preset.oauthProviderId] ?? false

    // Resume an already-running login for the same target instead of starting
    // a second one. Callback-server flows (e.g. Anthropic) bind a fixed local
    // port that stays open until the flow completes; spawning a fresh login
    // while the previous one is still pending would fail with EADDRINUSE. This
    // also lets the UI recover the flow after a page refresh.
    for (const [existingId, existing] of pendingOAuthLogins) {
      const sameTarget = payload.providerId
        ? existing.existingProviderId === payload.providerId
        : existing.existingProviderId == null
          && existing.providerType === payload.providerType
          && existing.name === payload.name
      if (!sameTarget) continue
      if (existing.status === 'pending' && existing.authUrl) {
        return {
          loginId: existingId,
          authUrl: existing.authUrl,
          instructions: existing.instructions,
          usesCallbackServer,
        }
      }
      // Stale completed/errored entry for this target — drop it and start fresh.
      pendingOAuthLogins.delete(existingId)
    }
    maybeStopOAuthCleanupTimer()

    const loginId = crypto.randomUUID()
    const loginState: PendingOAuthLogin = {
      status: 'pending',
      providerType: payload.providerType,
      name: payload.name,
      enabledModels: payload.enabledModels,
      textVerbosity: payload.textVerbosity,
      transport: payload.transport,
      createdAt: Date.now(),
      existingProviderId: payload.providerId,
    }
    pendingOAuthLogins.set(loginId, loginState)
    ensureOAuthCleanupTimer()

    let resolveAuthInfo!: (info: { url: string; instructions?: string }) => void
    const authInfoPromise = new Promise<{ url: string; instructions?: string }>((resolve) => {
      resolveAuthInfo = resolve
    })

    // pi-ai ≥ 0.80.8 AuthInteraction contract: flow events arrive via
    // `notify()`, user input is pulled via `prompt()`. Mapping mirrors the
    // pre-0.80.8 callback behavior exactly.
    // pi-ai 0.84.1: ProviderAuthInteraction requires a non-optional `signal`
    // that aborts the whole login flow. This headless flow never cancels the
    // outer login, so a bare controller signal satisfies the contract.
    const loginAbort = new AbortController()
    oauthAuth
      .login({
        signal: loginAbort.signal,
        notify: (event) => {
          if (event.type === 'auth_url') {
            loginState.authUrl = event.url
            loginState.instructions = event.instructions
            resolveAuthInfo({ url: event.url, instructions: event.instructions })
          } else if (event.type === 'device_code') {
            loginState.authUrl = event.verificationUri
            loginState.instructions = event.userCode
            resolveAuthInfo({ url: event.verificationUri, instructions: event.userCode })
          }
          // 'info'/'progress' events have no UI surface in this headless flow.
        },
        prompt: (prompt) => {
          if (prompt.type === 'manual_code') {
            // Resolved by submitOAuthCode() when the user pastes the code.
            // Callback-server flows race this against the local redirect
            // catcher; when the server wins, `prompt.signal` aborts and the
            // rejection lets the flow continue with the server's code.
            return new Promise<string>((resolve, reject) => {
              loginState.resolveManualCode = resolve
              prompt.signal?.addEventListener(
                'abort',
                () => {
                  loginState.resolveManualCode = undefined
                  reject(new Error('Manual code entry superseded'))
                },
                { once: true },
              )
            })
          }
          if (prompt.type === 'select') {
            // No interactive selection surface — accept the provider default.
            return Promise.resolve(prompt.options[0]?.id ?? '')
          }
          // text/secret prompts: same non-interactive default as before.
          return Promise.resolve(prompt.placeholder ?? '')
        },
      })
      .then((credential) => {
        loginState.status = 'completed'
        // Strip the credential-store type tag; openagent persists the raw
        // token fields in its own encrypted store.
        const { type: _type, ...credentials } = credential
        loginState.credentials = credentials as OAuthCredentials
      })
      .catch((err: unknown) => {
        loginState.status = 'error'
        loginState.error = (err as Error).message
        resolveAuthInfo({ url: '', instructions: '' })
      })

    const authInfo = await authInfoPromise

    if (loginState.status === 'error') {
      pendingOAuthLogins.delete(loginId)
      maybeStopOAuthCleanupTimer()
      throw new ProvidersRuntimeError(loginState.error ?? 'OAuth login failed')
    }

    // Callback-server flows request a manual-code fallback synchronously after
    // announcing the auth URL, so the resolver is set by the time this awaited
    // continuation runs. Device-code flows never prompt for one.
    return {
      loginId,
      authUrl: authInfo.url,
      instructions: authInfo.instructions,
      usesCallbackServer,
    }
  }

  async function getOAuthStatus(loginId: string): Promise<
    | { status: 'pending' }
    | { status: 'error'; error?: string }
    | { status: 'completed'; provider: ProviderConfig }
  > {
    const loginState = pendingOAuthLogins.get(loginId)
    if (!loginState) {
      throw new ProvidersNotFoundError('Login session not found or expired')
    }

    if (loginState.status === 'completed' && loginState.credentials) {
      try {
        let provider: ProviderConfig

        if (loginState.existingProviderId) {
          updateOAuthCredentials(loginState.existingProviderId, loginState.credentials)
          const file = loadProviders()
          const existing = file.providers.find((entry) => entry.id === loginState.existingProviderId)
          if (!existing) {
            throw new ProvidersNotFoundError('Provider not found')
          }
          provider = existing
        } else {
          const beforeActiveProvider = loadProviders().activeProvider ?? null
          provider = addOAuthProvider({
            name: loginState.name,
            providerType: loginState.providerType as ProviderType,
            enabledModels: loginState.enabledModels,
            textVerbosity: loginState.textVerbosity ?? undefined,
            transport: loginState.transport ?? undefined,
            oauthCredentials: loginState.credentials,
          })
          const afterActiveProvider = loadProviders().activeProvider ?? null

          if (beforeActiveProvider !== afterActiveProvider) {
            options.onActiveProviderChanged?.()
          }
        }

        pendingOAuthLogins.delete(loginId)
        maybeStopOAuthCleanupTimer()

        return {
          status: 'completed',
          provider,
        }
      } catch (err) {
        throw new ProvidersValidationError((err as Error).message)
      }
    }

    if (loginState.status === 'error') {
      pendingOAuthLogins.delete(loginId)
      maybeStopOAuthCleanupTimer()
      return {
        status: 'error',
        error: loginState.error,
      }
    }

    return { status: 'pending' }
  }

  function submitOAuthCode(loginId: string, code: string): void {
    const loginState = pendingOAuthLogins.get(loginId)
    if (!loginState) {
      throw new ProvidersNotFoundError('Login session not found or expired')
    }

    if (!loginState.resolveManualCode) {
      throw new ProvidersValidationError('This login flow does not accept manual code input')
    }

    loginState.resolveManualCode(code)
  }

  function createProvider(payload: ProviderCreatePayloadContract): ProviderConfig {
    try {
      const beforeActiveProvider = loadProviders().activeProvider ?? null

      const provider = addProviderConfig({
        name: payload.name,
        providerType: payload.providerType as ProviderType,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
        enabledModels: payload.enabledModels,
        degradedThresholdMs: payload.degradedThresholdMs,
        healthCheckTimeoutMs: payload.healthCheckTimeoutMs,
        textVerbosity: payload.textVerbosity ?? undefined,
        transport: payload.transport ?? undefined,
        promptProfile: payload.promptProfile ?? undefined,
        extraFields: payload.extraFields,
      })

      const afterActiveProvider = loadProviders().activeProvider ?? null
      if (beforeActiveProvider !== afterActiveProvider) {
        options.onActiveProviderChanged?.()
      }

      return provider
    } catch (err) {
      throw new ProvidersValidationError((err as Error).message)
    }
  }

  function updateProvider(id: string, payload: ProviderUpdatePayloadContract): ProviderConfig {
    try {
      const activeProvider = loadProviders().activeProvider ?? null
      const provider = updateProviderConfig(id, {
        name: payload.name,
        providerType: payload.providerType as ProviderType | undefined,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
        enabledModels: payload.enabledModels,
        degradedThresholdMs: payload.degradedThresholdMs,
        healthCheckTimeoutMs: payload.healthCheckTimeoutMs,
        textVerbosity: payload.textVerbosity,
        transport: payload.transport,
        promptProfile: payload.promptProfile,
        extraFields: payload.extraFields,
      })

      if (activeProvider === id) {
        options.onActiveProviderChanged?.()
      }

      return provider
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        throw new ProvidersNotFoundError(message)
      }
      throw new ProvidersValidationError(message)
    }
  }

  function deleteProvider(id: string): void {
    try {
      deleteProviderConfig(id)
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        throw new ProvidersNotFoundError(message)
      }
      throw new ProvidersValidationError(message)
    }
  }

  function updateProviderModel(providerId: string, modelId: string, payload: ProviderModelUpdatePayloadContract): ProviderConfig {
    try {
      return updateProviderModelConfig(providerId, modelId, payload)
    } catch (err) {
      if (err instanceof ProviderNotFoundError) {
        throw new ProvidersNotFoundError(err.message)
      }
      throw new ProvidersValidationError((err as Error).message)
    }
  }

  async function testProvider(
    id: string,
    payload: ProviderModelSelectionPayloadContract,
  ): Promise<{
    success: boolean
    message?: string
    error?: string
    latencyMs?: number
    status?: string
    modelId: string
  }> {
    const data = loadProvidersDecrypted()
    const provider = data.providers.find((entry) => entry.id === id)
    if (!provider) {
      throw new ProvidersNotFoundError('Provider not found')
    }

    const modelId = payload.modelId
    const testProviderConfig = modelId ? { ...provider, enabledModels: [modelId] } : provider
    const testModelId = modelId ?? getProviderDefaultModel(provider)

    const result = await performProviderHealthCheck(testProviderConfig, {
      // Hosted "free" endpoints (notably NVIDIA NIM partner/free models) can
      // cold-start or queue for longer than the regular health-monitor timeout.
      // Manual tests should answer "does this model work?" rather than marking
      // slow-but-valid models as broken after 15s.
      timeoutMs: 60_000,
    })
    const status = result.status === 'down' ? 'error' : 'connected'
    updateProviderStatus(id, status, modelId)

    if (result.status === 'down') {
      return {
        success: false,
        error: result.errorMessage ?? 'Connection failed',
        modelId: testModelId,
      }
    }

    return {
      success: true,
      message:
        result.status === 'degraded'
          ? `Connected, but slow response (${result.latencyMs}ms)`
          : `Connected successfully. Model: ${testModelId}`,
      latencyMs: result.latencyMs ?? undefined,
      status: result.status,
      modelId: testModelId,
    }
  }

  function activateProvider(id: string, payload: ProviderModelSelectionPayloadContract) {
    try {
      const before = loadProviders()
      const beforeActiveProvider = before.activeProvider ?? null
      const beforeActiveModel = before.activeModel ?? null

      setActiveProvider(id, payload.modelId ?? undefined)

      const after = loadProviders()
      const afterActiveProvider = after.activeProvider ?? null
      const afterActiveModel = after.activeModel ?? null

      if (beforeActiveProvider !== afterActiveProvider || beforeActiveModel !== afterActiveModel) {
        options.onActiveProviderChanged?.()
      }

      return {
        activeProvider: id,
        activeModel: afterActiveModel,
      }
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        throw new ProvidersNotFoundError(message)
      }
      throw new ProvidersValidationError(message)
    }
  }

  async function probeOpenAiCompatibleModels(baseUrl: string, apiKey?: string): Promise<AvailableModel[]> {
    return probeOpenAiCompatibleModelsFromBase(baseUrl, apiKey)
  }

  async function probeOllamaModels(baseUrl: string): Promise<OllamaTagsResponse> {
    const ollamaBase = normalizeOllamaBaseUrl(baseUrl)
    validateOllamaUrl(ollamaBase)

    const tagsResp = await fetch(`${ollamaBase}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
    })

    if (!tagsResp.ok) {
      throw new ProvidersExternalError(`Ollama returned HTTP ${tagsResp.status}`)
    }

    return (await tagsResp.json()) as OllamaTagsResponse
  }

  async function listOllamaModels(providerId: string): Promise<OllamaTagsResponse> {
    const provider = requireProvider(providerId)
    if (provider.providerType !== 'ollama') {
      throw new ProvidersValidationError('Not an Ollama provider')
    }

    return probeOllamaModels(provider.baseUrl || 'http://localhost:11434')
  }

  async function requestOllamaProbePull(baseUrl: string, modelName: string, signal: AbortSignal): Promise<Response> {
    const ollamaBase = normalizeOllamaBaseUrl(baseUrl)
    validateOllamaUrl(ollamaBase)

    return requestOllamaPullFromBase(ollamaBase, modelName, signal)
  }

  async function requestOllamaPull(providerId: string, modelName: string, signal: AbortSignal): Promise<Response> {
    const provider = requireProvider(providerId)
    if (provider.providerType !== 'ollama') {
      throw new ProvidersValidationError('Not an Ollama provider')
    }

    const ollamaBase = normalizeOllamaBaseUrl(provider.baseUrl || 'http://localhost:11434')
    validateOllamaUrl(ollamaBase)

    return requestOllamaPullFromBase(ollamaBase, modelName, signal)
  }

  async function deleteOllamaModel(providerId: string, modelName: string): Promise<void> {
    const provider = requireProvider(providerId)
    if (provider.providerType !== 'ollama') {
      throw new ProvidersValidationError('Not an Ollama provider')
    }

    const ollamaBase = normalizeOllamaBaseUrl(provider.baseUrl || 'http://localhost:11434')
    validateOllamaUrl(ollamaBase)

    const deleteResponse = await fetch(`${ollamaBase}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
    })

    if (!deleteResponse.ok) {
      const errorText = await deleteResponse.text().catch(() => '')
      throw new ProvidersExternalError(`Ollama delete failed: HTTP ${deleteResponse.status} ${errorText}`)
    }
  }

  return {
    listProviders,
    getModelsByProviderType,
    getLiveModels,
    setFallback,
    startOAuthLogin,
    getOAuthStatus,
    submitOAuthCode,
    createProvider,
    updateProvider,
    updateProviderModel,
    deleteProvider,
    testProvider,
    activateProvider,
    probeOpenAiCompatibleModels,
    probeOllamaModels,
    listOllamaModels,
    requestOllamaProbePull,
    requestOllamaPull,
    deleteOllamaModel,
  }
}

async function probeOpenAiCompatibleModelsFromBase(baseUrl: string, apiKey?: string): Promise<AvailableModel[]> {
  validateOpenAiCompatibleUrl(baseUrl)

  const urls = buildOpenAiModelsProbeUrls(baseUrl)
  let lastError = 'No /models endpoint responded successfully'

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        continue
      }

      const body = await response.json() as { data?: ProbedModelEntry[] }
      const seen = new Set<string>()
      const models: AvailableModel[] = []
      for (const entry of body.data ?? []) {
        const id = typeof entry.id === 'string' ? entry.id.trim() : ''
        if (!id || seen.has(id)) continue
        seen.add(id)
        const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id
        const cost = parseProbedModelCost(entry.pricing)
        models.push({
          id,
          name,
          ...(typeof entry.context_length === 'number' && entry.context_length > 0
            ? { contextWindow: entry.context_length }
            : {}),
          ...(cost ? { cost } : {}),
        })
      }
      return models.sort((a, b) => a.id.localeCompare(b.id))
    } catch (err) {
      lastError = (err as Error).message
    }
  }

  throw new ProvidersExternalError(lastError)
}

interface ProbedModelEntry {
  id?: unknown
  name?: unknown
  context_length?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
}

/** OpenRouter reports pricing in USD per token; convert to USD per 1M tokens. */
function parseProbedModelCost(pricing: ProbedModelEntry['pricing']): { input: number; output: number } | undefined {
  const input = Number(pricing?.prompt) * 1_000_000
  const output = Number(pricing?.completion) * 1_000_000
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return undefined
  const round = (value: number) => Math.round(value * 1e6) / 1e6
  return { input: round(input), output: round(output) }
}

async function requestOllamaPullFromBase(
  ollamaBase: string,
  modelName: string,
  signal: AbortSignal,
): Promise<Response> {
  const pullResponse = await fetch(`${ollamaBase}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelName, stream: true }),
    signal,
  })

  if (!pullResponse.ok) {
    const errorText = await pullResponse.text().catch(() => '')
    throw new ProvidersExternalError(`Ollama pull failed: HTTP ${pullResponse.status} ${errorText}`)
  }

  return pullResponse
}

function validateOpenAiCompatibleUrl(urlStr: string): void {
  let parsed: URL
  try {
    parsed = new URL(urlStr)
  } catch {
    throw new ProvidersValidationError('Invalid base URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProvidersValidationError('Only http/https URLs are allowed')
  }
}

function buildOpenAiModelsProbeUrls(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, '')
  const candidates = [`${normalized}/models`]
  if (!/\/v1$/i.test(normalized)) {
    candidates.push(`${normalized}/v1/models`)
  }
  return [...new Set(candidates)]
}

function requireProvider(providerId: string): ProviderConfig {
  const data = loadProvidersDecrypted()
  const provider = data.providers.find((entry) => entry.id === providerId)
  if (!provider) {
    throw new ProvidersNotFoundError('Provider not found')
  }

  return provider
}
