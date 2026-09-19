import {
  createModels,
  createProvider,
  envApiKeyAuth,
} from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  MutableModels,
  ProviderStreams,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { mistralConversationsApi } from '@earendil-works/pi-ai/api/mistral-conversations.lazy'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

/**
 * Replacement for the deprecated `@earendil-works/pi-ai/compat` free functions
 * `streamSimple`/`completeSimple`. That entrypoint is explicitly temporary
 * ("This module is deleted with the coding-agent ModelManager migration"), so
 * every streaming/completion call site goes through the shared `Models`
 * collection built here instead.
 *
 * Invariants — do not break these:
 *
 *  1. `createModels()` is called WITHOUT `credentials`, `modelsStore` or
 *     `authContext`. The shared instance must never own credentials. With an
 *     empty (default in-memory) credential store, the SDK-internal OAuth
 *     refresh path (`resolveStoredOAuth`) is unreachable dead code, so it can
 *     never race our own serialised refresh in
 *     `provider-config.ts#refreshOAuthCredentialsLocked`. Handing this instance
 *     a credential store would resurrect that path and re-open the rotating
 *     refresh-token reuse-detection failure mode.
 *  2. OAuth lives exclusively in `provider-config.ts`. Credentials are resolved
 *     there (async, from the encrypted `providers.json`) and handed in per
 *     request.
 *  3. Every call site MUST pass a non-empty `options.apiKey`. `resolveProviderAuth`
 *     short-circuits on an explicit `apiKey` before touching the credential
 *     store, and `applyAuth` forwards it verbatim. Keyless providers (local
 *     Ollama) pass the `'no-key'` dummy from `getApiKeyForProvider`. Without a
 *     key the request surfaces as `stopReason: 'error'` with
 *     "Provider is not configured: <id>" rather than reaching the network.
 *
 * Setup failures are turned into an assistant message carrying
 * `stopReason: 'error'` + `errorMessage` (see `api/lazy.js`); they are neither
 * thrown nor swallowed, so call sites keep their existing error handling.
 */

/**
 * Wire-API implementations we can reach. Covers every `apiType` used by
 * `PROVIDER_TYPE_PRESETS` (`openai-completions`, `anthropic-messages`,
 * `mistral-conversations`, `google-generative-ai`, `openai-codex-responses`)
 * plus `openai-responses`, which catalog models behind Copilot/OpenCode-style
 * gateways can point at. Deliberately omits `pi-messages`, `google-vertex`,
 * `azure-openai-responses` and `bedrock-converse-stream`: they are unreachable
 * from our presets. Adding one is a single line here.
 *
 * Values are lazy `ProviderStreams` factories, so an API module is only loaded
 * once a request actually dispatches to it.
 */
const API_IMPLEMENTATIONS: Partial<Record<Api, () => ProviderStreams>> = {
  'anthropic-messages': anthropicMessagesApi,
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'openai-codex-responses': openAICodexResponsesApi,
  'google-generative-ai': googleGenerativeAIApi,
  'mistral-conversations': mistralConversationsApi,
}

/**
 * Wire APIs this module can dispatch to. A model whose `api` is missing fails
 * only at request time (as a stream error), so `pi-models.test.ts` locks this
 * set against every reachable preset/catalog api.
 */
export const SUPPORTED_APIS: ReadonlySet<Api> = new Set(Object.keys(API_IMPLEMENTATIONS) as Api[])

function buildApiMap(): Partial<Record<Api, ProviderStreams>> {
  const map: Partial<Record<Api, ProviderStreams>> = {}
  for (const api of Object.keys(API_IMPLEMENTATIONS) as Api[]) {
    map[api] = API_IMPLEMENTATIONS[api]!()
  }
  return map
}

/**
 * Single shared collection reused across every completion/stream call site so
 * provider registration happens once. Carries no credential store by design
 * (see invariant 1 above).
 */
let modelsInstance: MutableModels | undefined

function getModelsInstance(): MutableModels {
  modelsInstance ??= createModels()
  return modelsInstance
}

/**
 * Register a pure api-dispatching provider for `providerId` the first time it
 * is seen. We build our own `Model` objects with arbitrary provider ids and
 * base URLs; `Models` routes each request to the provider registered under
 * `model.provider`, so every distinct id needs a provider entry. Auth is
 * supplied per request through `options.apiKey`, which `Models` forwards
 * verbatim, so the provider's `apiKey` auth only has to honour the passed key
 * (hence the empty env-var list — no silent env fallback).
 */
function ensureProvider(models: MutableModels, providerId: string): void {
  if (models.getProvider(providerId)) return
  models.setProvider(createProvider({
    id: providerId,
    auth: { apiKey: envApiKeyAuth(`${providerId} API key`, []) },
    models: [],
    api: buildApiMap(),
  }))
}

/**
 * Drop-in replacement for the former `@earendil-works/pi-ai/compat`
 * `streamSimple` free function, backed by the shared `Models` instance.
 */
export function streamSimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const models = getModelsInstance()
  ensureProvider(models, model.provider)
  return models.streamSimple(model, context, options)
}

/**
 * Drop-in replacement for the former `@earendil-works/pi-ai/compat`
 * `completeSimple` free function, backed by the shared `Models` instance.
 */
export function completeSimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const models = getModelsInstance()
  ensureProvider(models, model.provider)
  return models.completeSimple(model, context, options)
}
