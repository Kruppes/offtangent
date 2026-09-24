import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Api, Model, ModelAuth, OAuthAuth, OAuthCredential, Transport } from '@earendil-works/pi-ai'
import { streamSimple } from './pi-models.js'
import { getBuiltinModels as getPiAiModels } from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { getConfigDir, ensureConfigTemplates, loadConfig } from './config.js'
import { encrypt, decrypt, isEncrypted, maskApiKey } from './encryption.js'
import { loadHeuristics } from './heuristics.js'
import {
  applySystemPromptCacheBreakpoint,
  isAnthropicMessagesApi,
  loadPromptCacheSettings,
  splitSystemPromptAtCacheMarker,
} from './prompt-cache.js'
import type { PromptCacheSettings } from './prompt-cache.js'

/**
 * Claude Code CLI version to advertise in the user-agent header for Anthropic
 * requests. This ensures Anthropic treats requests as coming from a Claude Code
 * client; the API rejects too-old versions with HTTP 400
 * `claude_code_version_too_old` (e.g. `claude-fable-5-1` requires >= 2.1.251).
 *
 * MUST stay in sync with pi-ai's `dist/api/anthropic-messages.js`
 * `claudeCodeVersion` — pi-ai does not export the value, so we duplicate it
 * here and guard the duplication with a drift test
 * (provider-config.claude-version.test.ts). Re-check on every pi-ai bump.
 */
export const CLAUDE_CODE_VERSION = '2.1.280'

/**
 * Supported provider types with presets
 */
export type ProviderType =
  | 'openai' | 'anthropic' | 'mistral' | 'ollama' | 'openrouter' | 'deepseek' | 'kimi' | 'kimi-coding' | 'minimax' | 'zai' | 'zai-coding' | 'xai' | 'opencode-go' | 'opencode-zen' | 'openai-compatible' | 'google'
  // Legacy aliases kept for migration
  | 'ollama-local' | 'ollama-cloud'
  | 'openai-codex' | 'github-copilot' | 'anthropic-oauth'

export type AuthMethod = 'api-key' | 'oauth'
export type TextVerbosity = 'low' | 'medium' | 'high'
export type ProviderTransport = Transport

/**
 * System-prompt size profile for a provider.
 *
 * - `'full'` (default): the complete system prompt — identical to the
 *   behavior before this field existed. Absent field ≡ `'full'`.
 * - `'slim'`: a reduced prompt for slow/local providers (e.g. an Ollama
 *   server whose prompt evaluation runs at a few hundred tokens per second).
 *   Slim keeps all core knowledge (SOUL.md, AGENTS.md, MEMORY.md, user
 *   profile, tools overview) but only injects 1 recent daily file instead of
 *   3 and drops the wiki page listing and the docs discovery block.
 */
export type PromptProfile = 'full' | 'slim'

/**
 * Prompt-assembly knobs derived from a {@link PromptProfile}. Consumed by
 * `AgentRuntime.buildSystemPrompt()` and forwarded to `assembleSystemPrompt`.
 */
export interface PromptProfileOptions {
  /** Number of recent daily memory files injected into the prompt. */
  recentDays: number
  /** Whether the `<wiki_pages>` listing is included. */
  includeWikiPages: boolean
  /** Whether the `<axiom_docs>` discovery block is included. */
  includeAxiomDocs: boolean
}

/**
 * Map a provider's `promptProfile` to concrete prompt-assembly options.
 * `undefined` and `'full'` both resolve to the historical defaults, so
 * providers without the field keep producing a byte-identical prompt.
 */
export function resolvePromptProfileOptions(profile?: PromptProfile): PromptProfileOptions {
  if (profile === 'slim') {
    return { recentDays: 1, includeWikiPages: false, includeAxiomDocs: false }
  }
  // The lookback window is a heuristic (`heuristics.recentMemory.days`) so it
  // can be lowered without a deploy. The token cost of the block is bounded by
  // `heuristics.recentMemory.maxChars` regardless of this value.
  return {
    recentDays: loadHeuristics().recentMemory.days,
    includeWikiPages: true,
    includeAxiomDocs: true,
  }
}

export interface ProviderTypePreset {
  type: ProviderType
  label: string
  description?: string
  apiType: string // pi-ai API type (used for api-key providers)
  providerName: string
  baseUrl: string
  requiresApiKey: boolean
  urlEditable: boolean
  piAiProvider: string | null // maps to pi-ai KnownProvider for model lookup
  authMethod: AuthMethod
  oauthProviderId?: string // pi-ai OAuth provider ID
  /**
   * Provider-specific extra configuration fields beyond the common ones
   * (name/apiKey/baseUrl/models). Declared per preset so new providers can
   * add bespoke inputs (e.g. OpenCode Go's quota-dashboard credentials)
   * without growing `ProviderConfig` with provider-specific properties. The
   * values are stored in `ProviderConfig.extraFields`; fields marked `secret`
   * are encrypted at rest and never returned to the client.
   */
  extraFields?: ProviderExtraFieldDef[]
  /**
   * When true, `buildModel()` returns the pi-ai catalog model verbatim
   * (per-model `api`, `baseUrl`, cost, limits) instead of the generic build
   * that pins every model to the preset's single `apiType`. Required for
   * gateways like OpenCode Zen/Go whose models span multiple wire APIs
   * (openai-completions, anthropic-messages, google, responses) under one
   * provider entry.
   */
  resolveModelsFromCatalog?: boolean
  /**
   * Display-only hint: group this preset under "Subscription / OAuth" in the
   * UI even though it authenticates with an API key (e.g. OpenCode Go is a
   * flat-fee subscription that issues an API key rather than using OAuth).
   * Does not affect the auth flow — `authMethod` still drives that.
   */
  subscription?: boolean
  /**
   * When true, the Add Model dialog lists models fetched live from the
   * provider's own `/models` endpoint (using the stored baseUrl + apiKey)
   * instead of the static pi-ai catalog. The live list replaces the curated
   * one; the curated `getAvailableModels()` result is only used as an offline
   * fallback when the live fetch fails. Suitable for gateways whose catalog
   * changes frequently and is authoritative at the source (e.g. OpenRouter).
   */
  dynamicCatalog?: boolean
}

export interface AvailableModel {
  id: string
  name: string
  contextWindow?: number
  /** USD per 1M tokens. */
  cost?: { input: number; output: number }
}

/**
 * Declarative definition of one provider-specific extra configuration field.
 * Rendered generically by the UI and persisted into `ProviderConfig.extraFields`.
 */
export interface ProviderExtraFieldDef {
  /** Stable key within the provider type (also the storage key). */
  key: string
  /** Default English label (UIs may localize via an i18n override). */
  label: string
  /** Encrypt at rest and never return the value to the client. */
  secret?: boolean
  required?: boolean
  placeholder?: string
  hint?: string
}

export const PROVIDER_TYPE_PRESETS: Record<ProviderType, ProviderTypePreset> = {
  // ── API Key providers ──
  openai: {
    type: 'openai',
    label: 'OpenAI',
    apiType: 'openai-completions',
    providerName: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'openai',
    authMethod: 'api-key',
  },
  anthropic: {
    type: 'anthropic',
    label: 'Anthropic',
    apiType: 'anthropic-messages',
    providerName: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'anthropic',
    authMethod: 'api-key',
  },
  mistral: {
    type: 'mistral',
    label: 'Mistral',
    apiType: 'mistral-conversations',
    providerName: 'mistral',
    baseUrl: 'https://api.mistral.ai',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'mistral',
    authMethod: 'api-key',
  },
  'ollama': {
    type: 'ollama',
    label: 'Ollama',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  // Legacy aliases — map to 'ollama' so existing configs still load
  'ollama-local': {
    type: 'ollama',
    label: 'Ollama',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  'ollama-cloud': {
    type: 'ollama',
    label: 'Ollama',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  openrouter: {
    type: 'openrouter',
    label: 'OpenRouter',
    apiType: 'openai-completions',
    providerName: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'openrouter',
    authMethod: 'api-key',
    dynamicCatalog: true,
  },
  deepseek: {
    type: 'deepseek',
    label: 'DeepSeek',
    apiType: 'openai-completions',
    providerName: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'deepseek',
    authMethod: 'api-key',
  },
  kimi: {
    type: 'kimi',
    label: 'Kimi / Moonshot',
    description: 'Moonshot Platform (pay-as-you-go) — enter your platform API key',
    apiType: 'openai-completions',
    providerName: 'moonshotai',
    baseUrl: 'https://api.moonshot.ai/v1',
    requiresApiKey: true,
    urlEditable: false,
    // First-class: use pi-ai's maintained `moonshotai` catalog so Kimi K3 gets
    // correct thinking-level mapping, pricing, and auto-tracked new models —
    // the same treatment as the coding-plan preset below.
    piAiProvider: 'moonshotai',
    authMethod: 'api-key',
    resolveModelsFromCatalog: true,
  },
  // Kimi Coding plan (subscription). NOTE: despite being a "subscription",
  // Moonshot exposes NO OAuth flow — access is a plan-scoped API key against
  // the dedicated coding endpoint (Anthropic-messages wire API), distinct
  // from the pay-per-token Moonshot Platform (`kimi` preset above). Models
  // (incl. Kimi K3) come from pi-ai's maintained `kimi-coding` catalog.
  'kimi-coding': {
    type: 'kimi-coding',
    label: 'Kimi Coding (Subscription)',
    description: 'Flat-rate Kimi coding plan — enter your plan API key',
    apiType: 'anthropic-messages',
    providerName: 'kimi-coding',
    baseUrl: 'https://api.kimi.com/coding',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'kimi-coding',
    authMethod: 'api-key',
    resolveModelsFromCatalog: true,
    subscription: true,
  },
  minimax: {
    type: 'minimax',
    label: 'MiniMax',
    apiType: 'anthropic-messages',
    providerName: 'minimax',
    baseUrl: 'https://api.minimax.io/anthropic',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'minimax',
    authMethod: 'api-key',
  },
  zai: {
    type: 'zai',
    label: 'z.ai',
    apiType: 'openai-completions',
    providerName: 'zai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'zai',
    authMethod: 'api-key',
  },
  'zai-coding': {
    type: 'zai-coding',
    label: 'z.ai (GLM Coding Plan)',
    description: 'z.ai GLM Coding Plan subscription (flat-fee, API-key based)',
    apiType: 'openai-completions',
    providerName: 'zai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'zai',
    authMethod: 'api-key',
    subscription: true,
  },
  xai: {
    type: 'xai',
    label: 'xAI (Grok)',
    apiType: 'openai-completions',
    providerName: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'xai',
    authMethod: 'api-key',
  },
  'opencode-go': {
    type: 'opencode-go',
    label: 'OpenCode Go',
    apiType: 'openai-completions',
    providerName: 'opencode-go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'opencode-go',
    authMethod: 'api-key',
    resolveModelsFromCatalog: true,
    subscription: true,
    extraFields: [
      {
        key: 'workspaceId',
        label: 'Workspace ID',
        placeholder: 'e.g. 0a1b2c3d',
        hint: 'From your dashboard URL: opencode.ai/workspace/[id]/go',
      },
      {
        key: 'authCookie',
        label: 'Dashboard Auth Cookie',
        secret: true,
        hint: 'The authenticated dashboard cookie (the `auth=` prefix is optional). Used only to read your usage quota.',
      },
    ],
  },
  'opencode-zen': {
    type: 'opencode-zen',
    label: 'OpenCode Zen',
    description: 'Pay-as-you-go AI gateway by the OpenCode team',
    apiType: 'openai-completions',
    providerName: 'opencode',
    baseUrl: 'https://opencode.ai/zen/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'opencode',
    authMethod: 'api-key',
    resolveModelsFromCatalog: true,
  },
  'openai-compatible': {
    type: 'openai-compatible',
    label: 'OpenAI-compatible (custom)',
    description: 'Any OpenAI-compatible API (NVIDIA NIM, LM Studio, vLLM, Cloudflare AI Gateway, …)',
    apiType: 'openai-completions',
    providerName: 'openai-compatible',
    baseUrl: '',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
  },

  google: {
    type: 'google',
    label: 'Google Gemini',
    apiType: 'google-generative-ai',
    providerName: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'google',
    authMethod: 'api-key',
  },

  // ── OAuth / Subscription providers ──
  'openai-codex': {
    type: 'openai-codex',
    label: 'ChatGPT Plus/Pro (Codex)',
    apiType: 'openai-codex-responses',
    providerName: 'openai-codex',
    baseUrl: '',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'openai-codex',
    authMethod: 'oauth',
    oauthProviderId: 'openai-codex',
  },
  'github-copilot': {
    type: 'github-copilot',
    label: 'GitHub Copilot',
    apiType: 'openai-completions',
    providerName: 'github-copilot',
    baseUrl: '',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'github-copilot',
    authMethod: 'oauth',
    oauthProviderId: 'github-copilot',
  },
  'anthropic-oauth': {
    type: 'anthropic-oauth',
    label: 'Anthropic (Claude Pro/Max)',
    apiType: 'anthropic-messages',
    providerName: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'anthropic',
    authMethod: 'oauth',
    oauthProviderId: 'anthropic',
  },
}

/**
 * Local catalog overrides for provider types whose model list is not well
 * represented in pi-ai. Entries here take precedence over pi-ai and also feed
 * buildModel() with metadata (contextWindow, maxTokens, cost, reasoning) so
 * the UI and cost estimation work without requiring users to configure each
 * model manually.
 *
 * Keep this list in sync with the upstream provider's published catalog.
 */
export const PROVIDER_TYPE_MODEL_OVERRIDES: Partial<Record<ProviderType, ProviderModelConfig[]>> = {
  // Anthropic API (https://docs.claude.com) — models newer than the pinned
  // pi-ai release. Remove an entry once pi-ai's generated catalog picks it up.
  anthropic: [
    // Introductory pricing ($2 in / $10 out per MTok) runs through Aug 31, 2026;
    // standard pricing afterwards is $3 in / $15 out (cacheRead $0.30, cacheWrite $3.75).
    // https://docs.claude.com/en/docs/about-claude/pricing#claude-sonnet-5-introductory-pricing
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true,
      cost: { input: 2, output: 10, cacheRead: 0.20, cacheWrite: 2.50 } },
  ],
  // Moonshot Platform API (https://platform.moonshot.ai)
  // Confirmed via GET https://api.moonshot.ai/v1/models and official pricing docs.
  // Fallback catalog only — the `kimi` preset now resolves its model list from
  // pi-ai's maintained `moonshotai` catalog (resolveModelsFromCatalog). Kept for
  // pricing fallback and as documentation of the platform line. The temperature=1
  // constraint for reasoning models is enforced by `kimiModelRequiresTemperatureOne`,
  // not per-entry `fixedTemperature`.
  kimi: [
    // K3 — 1M context, requires temperature: 1 (like the K2 reasoning models).
    { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576, maxTokens: 131_072, reasoning: true,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } },

    // Current K2 family
    // Note: K2 reasoning models only accept `temperature: 1` (the upstream API
    // returns "invalid temperature: only 1 is allowed for this model" otherwise).
    { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 } },
    { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code HighSpeed', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 1.9, output: 8.0, cacheRead: 0.38, cacheWrite: 0 } },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 } },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0 } },
    { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },
    { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 1.15, output: 8.0, cacheRead: 0.15, cacheWrite: 0 } },
    { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo (preview)', contextWindow: 262_144, maxTokens: 262_144, reasoning: false,
      cost: { input: 2.4, output: 10.0, cacheRead: 0.6, cacheWrite: 0 } },
    { id: 'kimi-k2-0905-preview', name: 'Kimi K2 0905 (preview)', contextWindow: 262_144, maxTokens: 262_144, reasoning: false,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },
    { id: 'kimi-k2-0711-preview', name: 'Kimi K2 0711 (preview)', contextWindow: 131_072, maxTokens: 16_384, reasoning: false,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },

    // Convenience alias that always points at the latest stable
    { id: 'kimi-latest', name: 'Kimi Latest', contextWindow: 131_072, maxTokens: 32_768, reasoning: false,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },

    // Legacy moonshot-v1 line (still available on the platform)
    { id: 'moonshot-v1-auto', name: 'Moonshot v1 Auto', contextWindow: 131_072, maxTokens: 8_192, reasoning: false,
      cost: { input: 2.0, output: 5.0 } },
    { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K', contextWindow: 8_192, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.2, output: 1.0 } },
    { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K', contextWindow: 32_768, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.5, output: 1.5 } },
    { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K', contextWindow: 131_072, maxTokens: 8_192, reasoning: false,
      cost: { input: 2.0, output: 5.0 } },
    { id: 'moonshot-v1-8k-vision-preview', name: 'Moonshot v1 8K Vision (preview)', contextWindow: 8_192, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.2, output: 1.0 } },
    { id: 'moonshot-v1-32k-vision-preview', name: 'Moonshot v1 32K Vision (preview)', contextWindow: 32_768, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.5, output: 1.5 } },
    { id: 'moonshot-v1-128k-vision-preview', name: 'Moonshot v1 128K Vision (preview)', contextWindow: 131_072, maxTokens: 8_192, reasoning: false,
      cost: { input: 2.0, output: 5.0 } },
  ],
}

/**
 * Whether a provider type's pi-ai apiType actually consumes the
 * `textVerbosity` stream option. Today only the OpenAI Codex / Responses
 * API honours it; for every other provider the value is silently ignored
 * downstream, so we drop it on persist instead of storing a no-op.
 */
export function presetSupportsTextVerbosity(providerType: ProviderType): boolean {
  const preset = PROVIDER_TYPE_PRESETS[providerType]
  return preset?.apiType === 'openai-codex-responses'
}

/**
 * Whether a provider type's pi-ai apiType actually consumes the `transport`
 * stream option. Today only the OpenAI Codex / Responses API supports the
 * WebSocket / cached-WebSocket transports; every other provider streams over
 * SSE only and the value is silently ignored. We drop the field on persist
 * for unsupported providers so it cannot accidentally diverge from runtime
 * behaviour.
 */
export function presetSupportsTransport(providerType: ProviderType): boolean {
  const preset = PROVIDER_TYPE_PRESETS[providerType]
  return preset?.apiType === 'openai-codex-responses'
}

/**
 * Pure helper: merge the configured `textVerbosity` into a `streamSimple`
 * options object. Returns `opts` unchanged when the provider has no
 * verbosity override. Exported so tests can lock the contract without
 * having to mock pi-ai's streamSimple.
 */
export function applyTextVerbosity<T extends object | undefined>(
  textVerbosity: TextVerbosity | undefined,
  opts: T,
): T {
  if (!textVerbosity) return opts
  return { ...(opts ?? {}), textVerbosity } as T
}

/**
 * Pure helper: merge the configured `transport` into a `streamSimple` options
 * object. Returns `opts` unchanged when the provider has no transport
 * override or when the override is the default `"sse"`. Exported so tests can
 * lock the contract without having to mock pi-ai's streamSimple.
 *
 * The default of `"sse"` is a no-op upstream (pi-ai also defaults to SSE), so
 * we omit it from the spread to keep call paths identity-preserving when no
 * change is requested.
 */
export function applyTransport<T extends object | undefined>(
  transport: ProviderTransport | undefined,
  opts: T,
): T {
  if (!transport || transport === 'sse') return opts
  return { ...(opts ?? {}), transport } as T
}

/**
 * Default HTTP request timeout for LLM stream calls (ms) applied to LOCAL
 * providers (Ollama). The OpenAI SDK — which pi-ai uses for
 * `openai-completions` APIs like Ollama's — defaults to 10 minutes per
 * request, and that clock covers the WHOLE request: prompt-eval wait plus
 * the entire streaming duration. A 27B local model at ~30 tok/s output /
 * ~130 tok/s prompt-eval routinely exceeds 10 minutes on turns with a large
 * context, so the SDK kills the request with "Request timed out." no matter
 * what task-level `maxDurationMinutes` is set to (that is a separate,
 * higher-level watchdog that simply never gets to fire). One hour is
 * effectively "no limit" for local inference: at 30 tok/s it still caps a
 * single turn at ~108k output tokens.
 */
export const LOCAL_REQUEST_TIMEOUT_MS = 3_600_000

/**
 * Request-timeout default by provider type. Local providers (Ollama) get
 * LOCAL_REQUEST_TIMEOUT_MS; everything else returns undefined so the SDK
 * default (10 min for OpenAI/Anthropic) keeps applying unchanged.
 */
export function getDefaultRequestTimeoutMs(providerType: ProviderType | string | undefined): number | undefined {
  if (!providerType) return undefined
  const preset = PROVIDER_TYPE_PRESETS[providerType as ProviderType]
  return preset?.type === 'ollama' ? LOCAL_REQUEST_TIMEOUT_MS : undefined
}

/**
 * Resolve the effective request timeout: the global env override
 * `AXIOM_LLM_REQUEST_TIMEOUT_MS` wins when set to a positive integer,
 * otherwise the provider-type default. Exported for tests.
 */
export function resolveRequestTimeoutMs(providerType: ProviderType | string | undefined): number | undefined {
  const envRaw = process.env.AXIOM_LLM_REQUEST_TIMEOUT_MS
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return getDefaultRequestTimeoutMs(providerType)
}

/**
 * Pure helper: merge a request timeout into a `streamSimple` options object.
 * The caller's own `timeoutMs` always wins (it knows the concrete call
 * context better than a provider-wide default); when no timeout is
 * resolved, `opts` is returned unchanged (identity, no churn). Exported so
 * tests can lock the contract without mocking pi-ai's streamSimple.
 */
export function applyRequestTimeout<T extends object | undefined>(
  timeoutMs: number | undefined,
  opts: T,
): T {
  if (timeoutMs === undefined) return opts
  if (opts && (opts as { timeoutMs?: number }).timeoutMs !== undefined) return opts
  return { ...(opts ?? {}), timeoutMs } as T
}

/**
 * Build the `streamFn` callback that the agent loop hands to pi-agent-core.
 * Wraps `streamSimple` and forwards the provider's `textVerbosity`,
 * `transport` and request-timeout overrides when configured. Centralising
 * this keeps the cast in one place and makes it impossible to forget the
 * spread at a call site.
 *
 * pi-agent-core also reads `transport` directly from its `Agent` constructor
 * options and forwards it on every loop turn, so a configured non-`sse`
 * transport flows through both code paths.
 *
 * The `streamSimple` argument is injectable purely for testing; production
 * call sites should omit it so the real pi-ai implementation is used.
 *
 * It is also the single place where the prompt-cache controls are applied
 * (token audit 2026-09-17 §2): the system-prompt cache marker is stripped for
 * EVERY provider, and only for Anthropic-API models the marker position is
 * turned into a second `cache_control` breakpoint plus `cacheRetention` /
 * `sessionId`. Ollama & friends see byte-identical requests to before.
 */
export function buildStreamFn(
  provider: Pick<ProviderConfig, 'textVerbosity' | 'transport'> & Partial<Pick<ProviderConfig, 'providerType'>>,
  streamImpl: typeof streamSimple = streamSimple,
  cache?: StreamCacheOptions,
): typeof streamSimple {
  return ((model, context, options) => {
    const withVerbosity = applyTextVerbosity(provider.textVerbosity, options)
    const withTransport = applyTransport(provider.transport, withVerbosity)
    const merged = applyRequestTimeout(
      resolveRequestTimeoutMs(provider.providerType),
      withTransport,
    ) as Parameters<typeof streamSimple>[2]

    const { text, prefixChars } = splitSystemPromptAtCacheMarker(context.systemPrompt)
    const cleanContext = text === context.systemPrompt ? context : { ...context, systemPrompt: text }
    const withCache = applyPromptCacheOptions(model, merged, {
      prefixChars,
      systemPromptLength: text.length,
      sessionId: cache?.getSessionId?.(),
      settings: cache?.settings,
    })

    return streamImpl(model, cleanContext, withCache)
  }) as typeof streamSimple
}

/** Per-call cache context handed to {@link buildStreamFn} by its owner. */
export interface StreamCacheOptions {
  /**
   * Stable id of the current strand / task session, passed to providers that
   * route prompt caches per session. Read per call because a runtime serves
   * many strands over its lifetime.
   */
  getSessionId?: () => string | undefined
  /** Settings injection for tests; production reads `settings.json`. */
  settings?: PromptCacheSettings
}

/**
 * Merge the prompt-cache options into a `streamSimple` options object.
 *
 * No-op for every model that does not speak the Anthropic Messages API, so a
 * local Ollama keeps receiving exactly the request it received before.
 * Exported for tests.
 */
export function applyPromptCacheOptions<T extends object | undefined>(
  model: { api?: unknown } | undefined,
  opts: T,
  input: {
    prefixChars: number | null
    systemPromptLength: number
    sessionId?: string
    settings?: PromptCacheSettings
  },
): T {
  if (!isAnthropicMessagesApi(model?.api)) return opts

  const settings = input.settings ?? loadPromptCacheSettings()
  let out = opts as (object | undefined)
  const changed = () => {
    if (out === opts) out = { ...(opts ?? {}) }
    return out as Record<string, unknown>
  }

  if ((out as { cacheRetention?: unknown } | undefined)?.cacheRetention === undefined) {
    changed().cacheRetention = settings.retention
  }

  if (settings.sessionAffinity && input.sessionId
    && (out as { sessionId?: unknown } | undefined)?.sessionId === undefined) {
    changed().sessionId = input.sessionId
  }

  if (settings.systemBreakpoint && settings.retention !== 'none' && input.prefixChars !== null) {
    const prefixChars = input.prefixChars
    const expectedLength = input.systemPromptLength
    const previous = (opts as { onPayload?: (payload: unknown, model: unknown) => unknown } | undefined)?.onPayload
    changed().onPayload = async (payload: unknown, payloadModel: unknown) => {
      const base = (previous ? await previous(payload, payloadModel) : undefined) ?? payload
      return applySystemPromptCacheBreakpoint(base, prefixChars, expectedLength) ?? base
    }
  }

  return out as T
}

/**
 * Whether a provider type serves its Add Model catalog live from the
 * provider's own `/models` endpoint instead of the static pi-ai catalog.
 */
export function isDynamicCatalogProvider(providerType: ProviderType | string): boolean {
  return Boolean(PROVIDER_TYPE_PRESETS[providerType as ProviderType]?.dynamicCatalog)
}

/**
 * Get available models for a given provider type: pi-ai's generated catalog
 * for the preset's piAiProvider, with PROVIDER_TYPE_MODEL_OVERRIDES entries
 * layered on top (added, or replacing a catalog entry of the same id).
 */
export function getAvailableModels(providerType: ProviderType): AvailableModel[] {
  const preset = PROVIDER_TYPE_PRESETS[providerType]
  const catalogModels: AvailableModel[] = preset?.piAiProvider
    ? (() => {
        try {
          return getPiAiModels(preset.piAiProvider as BuiltinProvider).map(m => toAvailableModel(m.id, m.name, m.contextWindow, m.cost))
        } catch {
          return []
        }
      })()
    : []

  const overrides = PROVIDER_TYPE_MODEL_OVERRIDES[providerType] ?? []
  const merged = new Map(catalogModels.map(m => [m.id, m]))
  for (const override of overrides) {
    merged.set(override.id, toAvailableModel(override.id, override.name ?? override.id, override.contextWindow, override.cost))
  }
  return Array.from(merged.values())
}

export interface CatalogSyncResult {
  providerId: string
  providerName: string
  added: string[]
}

/**
 * Auto-enable models that newly appeared in the pi-ai catalog since the last
 * sync. The catalog only changes with a pi-ai version bump (i.e. a new image),
 * so running this once at startup covers every way new models can arrive.
 *
 * Per configured provider whose type has a real pi-ai catalog:
 * - no `knownModels` yet → record the current catalog as baseline, enable
 *   nothing (first run after upgrade must not flood enabledModels)
 * - otherwise → append catalog ids not in `knownModels` to the END of
 *   `enabledModels` (index 0 stays the default model) and refresh the snapshot.
 *   Ids already known but unchecked by the user are left alone.
 */
export function syncNewCatalogModels(): CatalogSyncResult[] {
  const file = loadProviders()
  const results: CatalogSyncResult[] = []
  let changed = false

  for (const provider of file.providers) {
    const preset = PROVIDER_TYPE_PRESETS[provider.providerType]
    if (!preset?.piAiProvider) continue
    const catalogIds = getAvailableModels(provider.providerType).map(m => m.id)
    if (catalogIds.length === 0) continue

    if (!provider.knownModels) {
      provider.knownModels = catalogIds
      changed = true
      continue
    }

    const known = new Set(provider.knownModels)
    const fresh = catalogIds.filter(id => !known.has(id))
    if (fresh.length === 0) continue

    const enabled = provider.enabledModels ?? []
    const enabledSet = new Set(enabled)
    const toAdd = fresh.filter(id => !enabledSet.has(id))
    if (toAdd.length > 0) {
      provider.enabledModels = [...enabled, ...toAdd]
      results.push({ providerId: provider.id, providerName: provider.name, added: toAdd })
    }
    // Union, not snapshot: a model that leaves the catalog and later returns
    // must not be treated as new again (the user may have unchecked it).
    provider.knownModels = [...provider.knownModels, ...fresh]
    changed = true
  }

  if (changed) saveProviders(file)
  return results
}

// Upstream 0.27.0: catalog models carry optional contextWindow/cost overrides.
function toAvailableModel(
  id: string,
  name: string,
  contextWindow?: number,
  cost?: { input: number; output: number },
): AvailableModel {
  return {
    id,
    name,
    ...(contextWindow ? { contextWindow } : {}),
    ...(cost ? { cost: { input: cost.input, output: cost.output } } : {}),
  }
}

/**
 * Look up an override model config by provider type and model id, if any.
 */
function findOverrideModel(providerType: ProviderType | undefined, modelId: string): ProviderModelConfig | undefined {
  if (!providerType) return undefined
  const overrides = PROVIDER_TYPE_MODEL_OVERRIDES[providerType]
  return overrides?.find(m => m.id === modelId)
}

function findPiAiCatalogModel(providerType: ProviderType | undefined, modelId: string): Model<Api> | undefined {
  if (!providerType) return undefined
  const preset = PROVIDER_TYPE_PRESETS[providerType]
  if (!preset?.piAiProvider) return undefined
  try {
    return (getPiAiModels(preset.piAiProvider as Parameters<typeof getPiAiModels>[0]) as Model<Api>[]).find(m => m.id === modelId)
  } catch {
    return undefined
  }
}

/**
 * Moonshot's Kimi *reasoning* models reject any temperature other than 1
 * (`400 invalid temperature: only 1 is allowed for this model`). This is a
 * property of the MODEL, not the endpoint — so it must hold no matter how the
 * provider is wired: our dedicated `kimi` / `kimi-coding` presets, a generic
 * `openai-compatible` provider pointed at api.moonshot.ai, or the Anthropic-
 * messages coding endpoint. Hence: match by model id, provider-agnostic.
 *
 * Matches the confirmed reasoning families (platform + coding-plan ids); the
 * non-reasoning K2 variants (turbo/0905/0711 previews, `kimi-latest`, the
 * legacy `moonshot-v1-*` line) accept arbitrary temperatures and are excluded.
 */
function kimiModelRequiresTemperatureOne(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return id === 'kimi-k3' || /^kimi-k3[.-]/.test(id) || id === 'k3'   // K3 (platform + coding)
    || /^kimi-k2-thinking/.test(id)                                    // K2 thinking (+turbo)
    || id === 'kimi-k2.5' || id === 'kimi-k2.6'                        // K2.5 / K2.6 reasoning
}

function catalogModelRequiresTemperatureOne(providerType: ProviderType | undefined, modelId: string): boolean {
  if (kimiModelRequiresTemperatureOne(modelId)) return true
  // Autodetect future Kimi reasoning models from catalog metadata so a new
  // `kimi-k*` reasoning id is covered before it's added to the list above.
  const catalogModel = findPiAiCatalogModel(providerType, modelId)
  return Boolean(catalogModel?.reasoning && /^kimi-k[0-9]/.test(catalogModel.id))
}

/**
 * Resolve the effective sampling temperature for a given provider+model.
 *
 * Some upstream APIs reject any temperature other than a specific value (for
 * example, Moonshot's Kimi K2 thinking models only accept `temperature: 1`).
 * Callers should route their desired temperature through this helper so such
 * constraints are honored without scattering model-specific knowledge across
 * the codebase.
 *
 * Resolution order for the constraint:
 *   1. `provider.models[].fixedTemperature` (per-provider user override)
 *   2. `PROVIDER_TYPE_MODEL_OVERRIDES[...].fixedTemperature` (local catalog)
 *   3. pi-ai catalog metadata for known Kimi K2 reasoning models
 *
 * If no constraint applies, the `requested` value is returned unchanged.
 */
export function resolveModelTemperature(
  provider: Pick<ProviderConfig, 'providerType' | 'models'>,
  modelId: string,
  requested: number,
): number {
  const configured = provider.models?.find(m => m.id === modelId)
  if (configured?.fixedTemperature !== undefined) {
    return configured.fixedTemperature
  }
  const override = findOverrideModel(provider.providerType, modelId)
  if (override?.fixedTemperature !== undefined) {
    return override.fixedTemperature
  }
  if (catalogModelRequiresTemperatureOne(provider.providerType, modelId)) {
    return 1
  }
  return requested
}

/** Default hard abort timeout for automated provider health checks (ms). */
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 15000

/**
 * Health-check timeout applied to newly created LOCAL providers (Ollama and
 * its legacy aliases). A model cold start (VRAM eviction, model reload) can
 * easily take 30–60 s; the regular 15 s default would misclassify a merely
 * cold provider as down.
 */
export const LOCAL_HEALTH_CHECK_TIMEOUT_MS = 60000

/**
 * Creation-time default for `ProviderConfig.healthCheckTimeoutMs`.
 * Only affects NEWLY created providers — existing configs without the field
 * keep resolving to DEFAULT_HEALTH_CHECK_TIMEOUT_MS in the health check.
 */
export function getDefaultHealthCheckTimeoutMs(providerType: ProviderType): number {
  const preset = PROVIDER_TYPE_PRESETS[providerType]
  return preset?.type === 'ollama' ? LOCAL_HEALTH_CHECK_TIMEOUT_MS : DEFAULT_HEALTH_CHECK_TIMEOUT_MS
}

/**
 * Provider configuration as stored in providers.json
 */
export interface ProviderConfig {
  id: string
  name: string
  type: string // e.g., 'openai-completions', 'anthropic-messages'
  providerType: ProviderType // e.g., 'openai', 'anthropic', 'ollama'
  provider: string // e.g., 'openai', 'anthropic', 'xai'
  baseUrl: string
  apiKey: string // encrypted at rest
  enabledModels?: string[] // list of model IDs enabled for this provider; first entry is the default/primary model
  degradedThresholdMs?: number
  /**
   * Hard abort timeout for automated health checks (ms). Absent → the
   * health check falls back to DEFAULT_HEALTH_CHECK_TIMEOUT_MS (15000), so
   * existing provider configs keep their exact pre-existing behavior.
   * Local providers (Ollama) get LOCAL_HEALTH_CHECK_TIMEOUT_MS (60000) on
   * creation because a model cold start (VRAM eviction + reload) routinely
   * exceeds 15 s and must not be classified as "down".
   */
  healthCheckTimeoutMs?: number
  textVerbosity?: TextVerbosity
  transport?: ProviderTransport
  /**
   * System-prompt size profile for this provider. Absent or `'full'` → the
   * complete prompt (historical behavior). `'slim'` → reduced prompt for
   * slow/local providers: 1 daily file instead of 3, no wiki page listing,
   * no docs discovery block. Core knowledge (SOUL.md, AGENTS.md, MEMORY.md,
   * user profile, tools) is always included. Only `'slim'` is persisted —
   * `'full'` is dropped on save since it is the default.
   */
  promptProfile?: PromptProfile
  models?: ProviderModelConfig[]
  status?: 'connected' | 'error' | 'untested'
  modelStatuses?: Record<string, 'connected' | 'error' | 'untested'>
  authMethod?: AuthMethod
  oauthCredentials?: OAuthCredentialsStored // encrypted at rest
  /**
   * Provider-specific extra field values (see `ProviderTypePreset.extraFields`).
   * Values for fields declared `secret` are encrypted at rest.
   */
  extraFields?: Record<string, string>
  /**
   * Every pi-ai catalog model id ever seen by `syncNewCatalogModels()`
   * (grow-only union). Absence means "never synced": the next sync only
   * records the baseline and must NOT auto-enable anything, otherwise the
   * whole catalog would flood enabledModels on upgrade. Models the user
   * deliberately unchecked stay in this list, so they are never re-added.
   */
  knownModels?: string[]
}

/**
 * OAuth credentials as stored in providers.json (encrypted)
 */
export interface OAuthCredentialsStored {
  refresh: string // encrypted
  access: string // encrypted
  expires: number
  extra?: string // encrypted JSON of additional fields
}

export interface ProviderModelConfig {
  id: string
  name?: string
  /**
   * Free-form note describing what this model is suited for. Surfaced in the
   * system prompt's `<available_providers>` block so the agent can route
   * background tasks to it. A model without a description (and that is not
   * the active/task default) is hidden from the agent's routing list.
   */
  description?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  /**
   * Maps Axiom's thinking levels onto the effort values the upstream API
   * expects. Only needed for OpenAI-compatible endpoints outside pi-ai's
   * catalog (e.g. a local Ollama server), where pi-ai has no built-in map.
   * Without an `off` entry pi-ai omits `reasoning_effort` entirely on `off`,
   * so a reasoning-capable model keeps thinking on every request.
   */
  thinkingLevelMap?: Record<string, string | null>
  /**
   * If set, the upstream API only accepts this exact `temperature` value and
   * rejects any other value (e.g. Moonshot's Kimi K2 thinking models require
   * `temperature: 1`). Callers should pass the requested value through
   * `resolveModelTemperature()` so this constraint is honored.
   */
  fixedTemperature?: number
  cost?: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
  }
}

export interface ProvidersFile {
  providers: ProviderConfig[]
  activeProvider?: string
  activeModel?: string // model ID within the active provider
  fallbackProvider?: string
  fallbackModel?: string // model ID within the fallback provider
  _comment?: string
}

/**
 * Price table for common models (cost per million tokens in USD)
 * Used as fallback when pi-mono cost data is not available
 */
export type TokenPriceTable = Record<string, { input: number; output: number }>

export const DEFAULT_PRICE_TABLE: TokenPriceTable = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
}

/**
 * Extra-field definitions declared by a provider type's preset (empty when none).
 */
export function getProviderExtraFieldDefs(providerType: ProviderType | string): ProviderExtraFieldDef[] {
  return PROVIDER_TYPE_PRESETS[providerType as ProviderType]?.extraFields ?? []
}

function secretExtraFieldKeys(providerType: ProviderType | string): Set<string> {
  return new Set(getProviderExtraFieldDefs(providerType).filter(f => f.secret).map(f => f.key))
}

/**
 * Decrypt the secret entries of a stored `extraFields` record, leaving
 * non-secret values untouched. Returns `undefined`/the input as-is when empty.
 */
function decryptExtraFields(
  providerType: ProviderType | string,
  extraFields: Record<string, string> | undefined,
  providerName: string,
): Record<string, string> | undefined {
  if (!extraFields) return extraFields
  const secrets = secretExtraFieldKeys(providerType)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(extraFields)) {
    out[key] = secrets.has(key)
      ? (tryDecryptField(value, `extra field "${key}" for provider "${providerName}"`) ?? value)
      : value
  }
  return out
}

/**
 * Encrypt + sanitize an incoming `extraFields` record for storage: drops empty
 * values and unknown keys, encrypts fields declared `secret`. Returns
 * `undefined` when nothing remains.
 */
function sanitizeExtraFieldsForStorage(
  providerType: ProviderType | string,
  extraFields: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!extraFields) return undefined
  const defs = getProviderExtraFieldDefs(providerType)
  const knownKeys = new Set(defs.map(f => f.key))
  const secrets = new Set(defs.filter(f => f.secret).map(f => f.key))
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(extraFields)) {
    if (!knownKeys.has(key)) continue
    const trimmed = (raw ?? '').trim()
    if (!trimmed) continue
    out[key] = secrets.has(key) ? encrypt(trimmed) : trimmed
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Merge incoming extra-field edits into the currently-stored record. Secret
 * fields left blank keep their existing (encrypted) value; non-secret fields
 * set to blank are cleared. Unknown keys are pruned.
 */
function mergeExtraFieldsForUpdate(
  providerType: ProviderType | string,
  current: Record<string, string> | undefined,
  incoming: Record<string, string>,
): Record<string, string> | undefined {
  const defs = getProviderExtraFieldDefs(providerType)
  const knownKeys = new Set(defs.map(f => f.key))
  const secrets = new Set(defs.filter(f => f.secret).map(f => f.key))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(current ?? {})) {
    if (knownKeys.has(key)) out[key] = value
  }
  for (const [key, raw] of Object.entries(incoming)) {
    if (!knownKeys.has(key)) continue
    const trimmed = (raw ?? '').trim()
    if (secrets.has(key)) {
      if (trimmed) out[key] = encrypt(trimmed)
    } else if (trimmed) {
      out[key] = trimmed
    } else {
      delete out[key]
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Produce a client-safe view of a provider's extra fields: non-secret values
 * pass through, secret values are omitted and reported as a presence boolean
 * in `extraFieldsSet`. Expects the decrypted record.
 */
export function maskProviderExtraFields(
  providerType: ProviderType | string,
  extraFields: Record<string, string> | undefined,
): { extraFields: Record<string, string>; extraFieldsSet: Record<string, boolean> } {
  const defs = getProviderExtraFieldDefs(providerType)
  const knownKeys = new Set(defs.map(f => f.key))
  const secrets = new Set(defs.filter(f => f.secret).map(f => f.key))
  const masked: Record<string, string> = {}
  const set: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(extraFields ?? {})) {
    if (!knownKeys.has(key)) continue
    if (secrets.has(key)) set[key] = Boolean(value)
    else masked[key] = value
  }
  return { extraFields: masked, extraFieldsSet: set }
}

/**
 * Load providers.json from config directory
 */
export function loadProviders(): ProvidersFile {
  const configDir = getConfigDir()
  const filePath = path.join(configDir, 'providers.json')

  if (!fs.existsSync(filePath)) {
    return { providers: [] }
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const data = JSON.parse(content) as ProvidersFile

  // Migrate legacy ollama-local / ollama-cloud → ollama
  let migrated = false
  for (const p of data.providers) {
    if (p.providerType === 'ollama-local' || p.providerType === 'ollama-cloud') {
      p.providerType = 'ollama' as ProviderType
      p.type = 'openai-completions'
      p.provider = 'ollama'
      migrated = true
    }

    // Migrate legacy `defaultModel` into enabledModels. The dedicated field is
    // gone; the default is now enabledModels[0]. Older configs may store the
    // default at a non-zero index (or omit enabledModels entirely), so fold it
    // to the front to preserve the previously selected default.
    const legacy = p as ProviderConfig & { defaultModel?: string }
    if (legacy.defaultModel !== undefined) {
      const defaultModel = legacy.defaultModel
      const rest = (legacy.enabledModels ?? []).filter(m => m !== defaultModel)
      legacy.enabledModels = defaultModel ? [defaultModel, ...rest] : rest
      delete legacy.defaultModel
      migrated = true
    }
  }
  if (migrated) {
    // Persist the migration so it only runs once
    const outPath = path.join(configDir, 'providers.json')
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  }

  return data
}

/**
 * Save providers.json to config directory
 */
export function saveProviders(data: ProvidersFile): void {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  const filePath = path.join(configDir, 'providers.json')
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/**
 * Get providers with API keys decrypted
 */
export function loadProvidersDecrypted(): ProvidersFile {
  const file = loadProviders()
  return {
    ...file,
    providers: file.providers.map(p => {
      // Sync fixed URLs from presets (handles preset URL changes)
      const preset = PROVIDER_TYPE_PRESETS[p.providerType]
      const baseUrl = (preset && !preset.urlEditable) ? preset.baseUrl : p.baseUrl

      const decryptedApiKey = tryDecryptField(p.apiKey, `API key for provider "${p.name}"`) ?? p.apiKey
      const decryptedExtraFields = decryptExtraFields(p.providerType, p.extraFields, p.name)

      let decryptedOAuth: OAuthCredentialsStored | undefined
      if (p.oauthCredentials) {
        try {
          decryptedOAuth = decryptOAuthCredentials(p.oauthCredentials)
        } catch (err) {
          console.warn(`[axiom] Skipping OAuth credentials for provider "${p.name}": ${(err as Error).message}`)
          decryptedOAuth = undefined
        }
      }

      return {
        ...p,
        baseUrl,
        apiKey: decryptedApiKey,
        extraFields: decryptedExtraFields,
        oauthCredentials: decryptedOAuth,
      }
    }),
  }
}

/**
 * Get providers with API keys masked for display
 */
export type MaskedProviderConfig = ProviderConfig & {
  apiKeyMasked: string
  extraFieldsSet: Record<string, boolean>
}

export type MaskedProvidersFile = Omit<ProvidersFile, 'providers'> & {
  providers: MaskedProviderConfig[]
}

export function loadProvidersMasked(): MaskedProvidersFile {
  const file = loadProvidersDecrypted() // Already syncs URLs from presets
  return {
    ...file,
    providers: file.providers.map(p => {
      const { extraFields, extraFieldsSet } = maskProviderExtraFields(p.providerType, p.extraFields)
      return {
        ...p,
        apiKey: '', // Never send real key to frontend
        apiKeyMasked: p.apiKey ? maskApiKey(p.apiKey) : '',
        extraFields,
        extraFieldsSet,
        oauthCredentials: p.oauthCredentials ? { refresh: '', access: '', expires: p.oauthCredentials.expires } : undefined,
      }
    }),
  }
}

/**
 * Encrypt OAuth credentials for storage
 */
export function encryptOAuthCredentials(creds: OAuthCredentials): OAuthCredentialsStored {
  const { refresh, access, expires, ...extra } = creds
  return {
    refresh: encrypt(refresh),
    access: encrypt(access),
    expires,
    extra: Object.keys(extra).length > 0 ? encrypt(JSON.stringify(extra)) : undefined,
  }
}

/**
 * Attempt to decrypt a single encrypted field, returning `undefined` on
 * failure (logs a warning). Lets callers skip unreadable fields instead of
 * bringing down the entire server when e.g. the encryption key rotated.
 */
function tryDecryptField(value: string | undefined, label: string): string | undefined {
  if (!value) return value
  if (!isEncrypted(value)) return value
  try {
    return decrypt(value)
  } catch (err) {
    console.warn(`[axiom] Failed to decrypt ${label}: ${(err as Error).message}. Field will be treated as absent. Set ENCRYPTION_KEY correctly or re-enter the value via the web UI.`)
    return undefined
  }
}

/**
 * Decrypt OAuth credentials from storage. Individual fields that fail to
 * decrypt are dropped with a warning rather than throwing — this keeps the
 * server booting even when a stale `providers.json` has credentials
 * encrypted under a previous key.
 */
function decryptOAuthCredentials(stored: OAuthCredentialsStored): OAuthCredentialsStored {
  return {
    refresh: tryDecryptField(stored.refresh, 'OAuth refresh token') ?? stored.refresh,
    access: tryDecryptField(stored.access, 'OAuth access token') ?? stored.access,
    expires: stored.expires,
    extra: stored.extra ? (tryDecryptField(stored.extra, 'OAuth extra payload') ?? stored.extra) : stored.extra,
  }
}

/**
 * Convert stored OAuth credentials to pi-ai OAuthCredentials format
 */
export function storedToOAuthCredentials(stored: OAuthCredentialsStored): OAuthCredentials {
  const base: OAuthCredentials = {
    refresh: stored.refresh,
    access: stored.access,
    expires: stored.expires,
  }
  if (stored.extra) {
    try {
      const extraFields = JSON.parse(stored.extra) as Record<string, unknown>
      Object.assign(base, extraFields)
    } catch {
      // Ignore parse errors
    }
  }
  return base
}

/**
 * Generate a unique provider ID
 */
function generateProviderId(): string {
  return crypto.randomUUID()
}

/**
 * Add a new provider (API key based)
 */
export function addProvider(input: {
  name: string
  providerType: ProviderType
  baseUrl?: string
  apiKey?: string
  enabledModels: string[]
  degradedThresholdMs?: number
  healthCheckTimeoutMs?: number
  textVerbosity?: TextVerbosity
  transport?: ProviderTransport
  promptProfile?: PromptProfile
  extraFields?: Record<string, string>
}): ProviderConfig {
  const preset = PROVIDER_TYPE_PRESETS[input.providerType]
  if (!preset) {
    throw new Error(`Unknown provider type: ${input.providerType}`)
  }

  const file = loadProviders()

  // Check for duplicate name
  if (file.providers.some(p => p.name === input.name)) {
    throw new Error(`Provider with name "${input.name}" already exists`)
  }

  // Models may be added after creation via the "Add Model" flow, so a provider
  // can be created with no enabled models yet.
  const enabledModels = input.enabledModels ?? []

  const provider: ProviderConfig = {
    id: generateProviderId(),
    name: input.name,
    type: preset.apiType,
    providerType: input.providerType,
    provider: preset.providerName,
    baseUrl: input.baseUrl || preset.baseUrl,
    apiKey: input.apiKey ? encrypt(input.apiKey) : '',
    enabledModels,
    degradedThresholdMs: input.degradedThresholdMs ?? 5000,
    healthCheckTimeoutMs: input.healthCheckTimeoutMs ?? getDefaultHealthCheckTimeoutMs(input.providerType),
    ...(input.textVerbosity && presetSupportsTextVerbosity(input.providerType)
      && { textVerbosity: input.textVerbosity }),
    ...(input.transport && input.transport !== 'sse' && presetSupportsTransport(input.providerType)
      && { transport: input.transport }),
    // 'full' is the default — only persist the non-default 'slim' value.
    ...(input.promptProfile === 'slim' && { promptProfile: input.promptProfile }),
    ...((() => {
      const extra = sanitizeExtraFieldsForStorage(input.providerType, input.extraFields)
      return extra ? { extraFields: extra } : {}
    })()),
    status: 'untested',
    authMethod: preset.authMethod,
  }

  file.providers.push(provider)

  // If this is the first provider, make it active
  if (file.providers.length === 1) {
    file.activeProvider = provider.id
    if (enabledModels[0]) file.activeModel = enabledModels[0]
  }

  saveProviders(file)
  return provider
}

/**
 * Add a new OAuth-authenticated provider
 */
export function addOAuthProvider(input: {
  name: string
  providerType: ProviderType
  enabledModels: string[]
  degradedThresholdMs?: number
  healthCheckTimeoutMs?: number
  textVerbosity?: TextVerbosity
  transport?: ProviderTransport
  oauthCredentials: OAuthCredentials
}): ProviderConfig {
  const preset = PROVIDER_TYPE_PRESETS[input.providerType]
  if (!preset) {
    throw new Error(`Unknown provider type: ${input.providerType}`)
  }
  if (preset.authMethod !== 'oauth') {
    throw new Error(`Provider type "${input.providerType}" does not use OAuth`)
  }

  const file = loadProviders()

  // Check for duplicate name
  if (file.providers.some(p => p.name === input.name)) {
    throw new Error(`Provider with name "${input.name}" already exists`)
  }

  const enabledModels = input.enabledModels ?? []

  const provider: ProviderConfig = {
    id: generateProviderId(),
    name: input.name,
    type: preset.apiType,
    providerType: input.providerType,
    provider: preset.providerName,
    baseUrl: preset.baseUrl,
    apiKey: '',
    enabledModels,
    degradedThresholdMs: input.degradedThresholdMs ?? 5000,
    healthCheckTimeoutMs: input.healthCheckTimeoutMs ?? getDefaultHealthCheckTimeoutMs(input.providerType),
    ...(input.textVerbosity && presetSupportsTextVerbosity(input.providerType)
      && { textVerbosity: input.textVerbosity }),
    ...(input.transport && input.transport !== 'sse' && presetSupportsTransport(input.providerType)
      && { transport: input.transport }),
    status: 'untested',
    authMethod: 'oauth',
    oauthCredentials: encryptOAuthCredentials(input.oauthCredentials),
  }

  file.providers.push(provider)

  if (file.providers.length === 1) {
    file.activeProvider = provider.id
    if (enabledModels[0]) file.activeModel = enabledModels[0]
  }

  saveProviders(file)
  return provider
}

/**
 * Update an existing provider
 */
export function updateProvider(id: string, input: {
  name?: string
  providerType?: ProviderType
  baseUrl?: string
  apiKey?: string
  enabledModels?: string[]
  degradedThresholdMs?: number
  healthCheckTimeoutMs?: number
  textVerbosity?: TextVerbosity | null
  transport?: ProviderTransport | null
  promptProfile?: PromptProfile | null
  extraFields?: Record<string, string>
}): ProviderConfig {
  const file = loadProviders()
  const index = file.providers.findIndex(p => p.id === id)
  if (index === -1) {
    throw new Error(`Provider not found: ${id}`)
  }

  const existing = file.providers[index]

  // Check for duplicate name (if name is being changed)
  if (input.name && input.name !== existing.name && file.providers.some(p => p.name === input.name)) {
    throw new Error(`Provider with name "${input.name}" already exists`)
  }

  const providerTypeChanged = Boolean(input.providerType && input.providerType !== existing.providerType)

  // If providerType is being changed, update derived fields
  if (providerTypeChanged && input.providerType) {
    const preset = PROVIDER_TYPE_PRESETS[input.providerType]
    if (!preset) {
      throw new Error(`Unknown provider type: ${input.providerType}`)
    }
    existing.providerType = input.providerType
    existing.type = preset.apiType
    existing.provider = preset.providerName
    existing.authMethod = preset.authMethod
    delete existing.extraFields
    if (!input.baseUrl) {
      existing.baseUrl = preset.baseUrl
    }
  }

  if (input.name !== undefined) existing.name = input.name
  if (input.baseUrl !== undefined) existing.baseUrl = input.baseUrl
  if (input.apiKey !== undefined) existing.apiKey = input.apiKey ? encrypt(input.apiKey) : ''
  if (input.enabledModels !== undefined) {
    existing.enabledModels = input.enabledModels
  }
  if (input.degradedThresholdMs !== undefined) existing.degradedThresholdMs = input.degradedThresholdMs
  if (input.healthCheckTimeoutMs !== undefined) existing.healthCheckTimeoutMs = input.healthCheckTimeoutMs
  if (input.extraFields !== undefined) {
    existing.extraFields = mergeExtraFieldsForUpdate(existing.providerType, existing.extraFields, input.extraFields)
  }
  if (input.textVerbosity !== undefined) {
    if (input.textVerbosity === null || !presetSupportsTextVerbosity(existing.providerType)) {
      // Either the caller explicitly cleared the value or the (possibly
      // newly-changed) provider type does not consume textVerbosity. In
      // both cases we drop it rather than persisting a no-op.
      delete existing.textVerbosity
    } else {
      existing.textVerbosity = input.textVerbosity
    }
  } else if (existing.textVerbosity && !presetSupportsTextVerbosity(existing.providerType)) {
    // Provider type was switched to one that does not support textVerbosity
    // — strip the now-orphaned value so it does not silently persist.
    delete existing.textVerbosity
  }
  if (input.transport !== undefined) {
    if (input.transport === null || input.transport === 'sse' || !presetSupportsTransport(existing.providerType)) {
      // Caller explicitly cleared, asked for the SSE default, or switched to
      // a provider type that does not consume `transport`. In all three
      // cases we drop the field rather than persisting a no-op.
      delete existing.transport
    } else {
      existing.transport = input.transport
    }
  } else if (existing.transport && !presetSupportsTransport(existing.providerType)) {
    // Provider type was switched to one that does not support transport
    // — strip the now-orphaned value so it does not silently persist.
    delete existing.transport
  }
  if (input.promptProfile !== undefined) {
    if (input.promptProfile === null || input.promptProfile === 'full') {
      // Caller explicitly cleared the value or asked for the default — drop
      // the field rather than persisting a no-op.
      delete existing.promptProfile
    } else {
      existing.promptProfile = input.promptProfile
    }
  }

  // For providers with fixed URLs, always sync from preset
  const currentPreset = PROVIDER_TYPE_PRESETS[existing.providerType]
  if (currentPreset && !currentPreset.urlEditable) {
    existing.baseUrl = currentPreset.baseUrl
  }

  // Reset status when config changes
  existing.status = 'untested'

  file.providers[index] = existing
  saveProviders(file)
  return existing
}

/** Thrown when a provider id does not resolve to a configured provider. */
export class ProviderNotFoundError extends Error {
  constructor(providerId: string) {
    super(`Provider not found: ${providerId}`)
    this.name = 'ProviderNotFoundError'
  }
}

/**
 * Patch a single model entry within a provider's `models[]` array, creating
 * the entry on the fly when it does not exist yet. Default metadata
 * (name, context window, reasoning, cost) is populated from the local
 * `PROVIDER_TYPE_MODEL_OVERRIDES` catalog or the pi-ai catalog so a freshly
 * created entry is usable by `buildModel()` immediately; only the fields
 * supplied in `patch` are overwritten.
 */
export function updateProviderModel(
  providerId: string,
  modelId: string,
  patch: {
    name?: string
    description?: string
    contextWindow?: number
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  },
): ProviderConfig {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === providerId)
  if (!provider) {
    throw new ProviderNotFoundError(providerId)
  }

  if (!provider.models) provider.models = []
  let entry = provider.models.find(m => m.id === modelId)
  if (!entry) {
    const override = findOverrideModel(provider.providerType, modelId)
    if (override) {
      entry = { ...override, cost: override.cost ? { ...override.cost } : undefined }
    } else {
      const piModel = findPiAiCatalogModel(provider.providerType, modelId)
      entry = piModel
        ? {
            id: modelId,
            name: piModel.name,
            contextWindow: piModel.contextWindow,
            maxTokens: piModel.maxTokens,
            reasoning: piModel.reasoning,
            cost: {
              input: piModel.cost.input,
              output: piModel.cost.output,
              cacheRead: piModel.cost.cacheRead,
              cacheWrite: piModel.cost.cacheWrite,
            },
          }
        : { id: modelId }
    }
    provider.models.push(entry)
  }

  if (patch.name !== undefined) {
    const trimmed = patch.name.trim()
    entry.name = trimmed ? trimmed : undefined
  }

  if (patch.description !== undefined) {
    const trimmed = patch.description.trim()
    entry.description = trimmed ? trimmed : undefined
  }

  if (patch.contextWindow !== undefined && patch.contextWindow > 0) {
    entry.contextWindow = patch.contextWindow
  }

  if (patch.cost) {
    if (!entry.cost) entry.cost = { input: 0, output: 0 }
    if (patch.cost.input !== undefined) entry.cost.input = patch.cost.input
    if (patch.cost.output !== undefined) entry.cost.output = patch.cost.output
    if (patch.cost.cacheRead !== undefined) entry.cost.cacheRead = patch.cost.cacheRead
    if (patch.cost.cacheWrite !== undefined) entry.cost.cacheWrite = patch.cost.cacheWrite
  }

  saveProviders(file)
  return provider
}

/**
 * Update OAuth credentials for a provider
 */
export function updateOAuthCredentials(id: string, credentials: OAuthCredentials): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) return
  provider.oauthCredentials = encryptOAuthCredentials(credentials)
  saveProviders(file)
}

/**
 * Delete a provider
 */
export function deleteProvider(id: string): void {
  const file = loadProviders()
  const index = file.providers.findIndex(p => p.id === id)
  if (index === -1) {
    throw new Error(`Provider not found: ${id}`)
  }

  // Cannot delete the active provider
  if (file.activeProvider === id) {
    throw new Error('Cannot delete the active provider. Set another provider as active first.')
  }

  // Clean up fallback if it points to this provider
  if (file.fallbackProvider === id) {
    delete file.fallbackProvider
    delete file.fallbackModel
  }

  file.providers.splice(index, 1)
  saveProviders(file)
}

/**
 * Set the active provider
 */
export function setActiveProvider(id: string, modelId?: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) {
    throw new Error(`Provider not found: ${id}`)
  }
  file.activeProvider = id
  if (modelId !== undefined) {
    file.activeModel = modelId
  } else {
    file.activeModel = getProviderDefaultModel(provider)
  }
  saveProviders(file)
}

/**
 * Set the active model ID (within the current active provider).
 */
export function setActiveModel(modelId: string): void {
  const file = loadProviders()
  if (!file.activeProvider) {
    throw new Error('No active provider set')
  }
  const provider = file.providers.find(p => p.id === file.activeProvider)
  if (!provider) {
    throw new Error('Active provider not found')
  }
  const enabled = provider.enabledModels ?? []
  if (!enabled.includes(modelId)) {
    throw new Error(`Model "${modelId}" is not enabled for provider "${provider.name}"`)
  }
  file.activeModel = modelId
  saveProviders(file)
}

/**
 * Get the active model ID.
 */
export function getActiveModelId(): string | null {
  const file = loadProviders()
  if (!file.activeProvider) return null
  const provider = file.providers.find(p => p.id === file.activeProvider)
  if (!provider) return null
  return file.activeModel ?? (getProviderDefaultModel(provider) || null)
}

/**
 * Update a provider's status
 */
export function updateProviderStatus(id: string, status: 'connected' | 'error' | 'untested', modelId?: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) return

  if (modelId) {
    // Update per-model status
    if (!provider.modelStatuses) provider.modelStatuses = {}
    provider.modelStatuses[modelId] = status
    // Also derive overall provider status from model statuses
    const enabled = provider.enabledModels ?? []
    const statuses = enabled.map(m => provider.modelStatuses?.[m] ?? 'untested')
    if (statuses.every(s => s === 'connected')) provider.status = 'connected'
    else if (statuses.some(s => s === 'error')) provider.status = 'error'
    else provider.status = 'untested'
  } else {
    provider.status = status
  }

  saveProviders(file)
}

/**
 * Get the fallback provider configuration (decrypted), or null if not configured.
 */
export function getFallbackProvider(): ProviderConfig | null {
  const file = loadProvidersDecrypted()
  if (!file.fallbackProvider) return null

  const found = file.providers.find(p => p.id === file.fallbackProvider)
  return found ?? null
}

/**
 * Set the fallback provider by ID. Validates that the ID exists and is not the active provider.
 */
export function setFallbackProvider(id: string, modelId?: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) {
    throw new Error(`Provider not found: ${id}`)
  }
  if (file.activeProvider === id) {
    // Only reject if both provider AND model match the active selection
    const activeProviderConfig = file.providers.find(p => p.id === file.activeProvider)
    const activeModel = file.activeModel ?? (activeProviderConfig ? getProviderDefaultModel(activeProviderConfig) : undefined)
    const fbModel = modelId ?? getProviderDefaultModel(provider)
    if (activeModel === fbModel) {
      throw new Error('Fallback cannot be the same provider and model as the active selection')
    }
  }
  file.fallbackProvider = id
  if (modelId !== undefined) {
    file.fallbackModel = modelId
  } else {
    file.fallbackModel = getProviderDefaultModel(provider)
  }
  saveProviders(file)
}

/**
 * Clear the fallback provider setting.
 */
export function clearFallbackProvider(): void {
  const file = loadProviders()
  delete file.fallbackProvider
  delete file.fallbackModel
  saveProviders(file)
}

/**
 * Get the fallback model ID.
 */
export function getFallbackModelId(): string | null {
  const file = loadProviders()
  if (!file.fallbackProvider) return null
  const provider = file.providers.find(p => p.id === file.fallbackProvider)
  if (!provider) return null
  return file.fallbackModel ?? (getProviderDefaultModel(provider) || null)
}

/**
 * Get the active provider configuration
 */
export function getActiveProvider(): ProviderConfig | null {
  const file = loadProvidersDecrypted()
  if (file.providers.length === 0) return null

  if (file.activeProvider) {
    const found = file.providers.find(p => p.id === file.activeProvider)
    if (found) return found
  }

  // Default to first provider
  return file.providers[0]
}

/**
 * Resolve the pi-ai OAuthAuth implementation for one of our supported OAuth
 * provider ids. Since pi-ai 0.80.8 the standalone oauth helper module
 * (`getOAuthProvider`/`getOAuthApiKey`) is gone; each provider object now
 * carries its auth flows under `provider.auth.oauth`.
 */
const PI_OAUTH_PROVIDER_FACTORIES: Record<string, () => { auth?: { oauth?: OAuthAuth } }> = {
  'anthropic': anthropicProvider,
  'github-copilot': githubCopilotProvider,
  'openai-codex': openaiCodexProvider,
}

const piOAuthAuthCache = new Map<string, OAuthAuth | null>()

export function getPiOAuthAuth(oauthProviderId: string): OAuthAuth | null {
  let cached = piOAuthAuthCache.get(oauthProviderId)
  if (cached === undefined) {
    const factory = PI_OAUTH_PROVIDER_FACTORIES[oauthProviderId]
    cached = factory ? factory().auth?.oauth ?? null : null
    piOAuthAuthCache.set(oauthProviderId, cached)
  }
  return cached
}

/**
 * Last request auth resolved per provider id. `OAuthAuth.toAuth()` may carry
 * a per-credential `baseUrl` (GitHub Copilot proxy endpoint) that pi-ai
 * < 0.80.8 applied via the now-removed `modifyModels`; `buildModel` (sync)
 * picks it up from here after `getApiKeyForProvider` (async) resolved it.
 */
const lastResolvedModelAuth = new Map<string, ModelAuth>()

/**
 * In-flight OAuth refresh per provider id. Anthropic (and other providers with
 * rotating refresh tokens) REVOKE the entire token family when an already-
 * rotated refresh token is presented again — so two concurrent turns that both
 * see an expired token and both call `refresh()` with the same stored refresh
 * token trigger a reuse-revocation and lock the account out (incident
 * 2026-07-22, surfaced under heavy parallel load). Coalescing concurrent
 * refreshes into a single call — and re-reading the freshest stored credential
 * inside it — guarantees each rotated refresh token is used exactly once.
 */
const inFlightOAuthRefresh = new Map<string, Promise<OAuthCredential>>()

export async function refreshOAuthCredentialsLocked(
  providerId: string,
  oauthAuth: OAuthAuth,
  fallbackCreds: OAuthCredential,
  options?: { force?: boolean },
): Promise<OAuthCredential> {
  const existing = inFlightOAuthRefresh.get(providerId)
  if (existing) return existing

  const run = (async (): Promise<OAuthCredential> => {
    // Re-read the freshest stored credential: a refresh that JUST completed (in
    // this process) may already have rotated the token, in which case we must
    // not refresh again with the now-stale one.
    let base = fallbackCreds
    try {
      const file = loadProvidersDecrypted()
      const p = file.providers.find(x => x.id === providerId)
      if (p?.oauthCredentials) {
        base = { type: 'oauth', ...storedToOAuthCredentials(p.oauthCredentials) }
      }
    } catch {
      // fall back to the caller's credential
    }
    // `force` (the provider rejected the token before it expired on paper)
    // skips the expiry gate — but only if nobody else rotated in the
    // meantime. A credential that differs from the caller's is already the
    // fresh one, and rotating again would burn a refresh token for nothing.
    if (options?.force) {
      if (base.access !== fallbackCreds.access) return base
    } else if (Date.now() < base.expires) {
      return base
    }

    // pi-ai 0.84.1: OAuthAuth.refresh(credential, signal) requires an AbortSignal.
    // 30s cap mirrors upstream pi-oauth.ts; a hung refresh must not wedge the turn.
    const rotated = await oauthAuth.refresh(base, AbortSignal.timeout(30_000))
    const { type: _type, ...toStore } = rotated
    updateOAuthCredentials(providerId, toStore as OAuthCredentials)
    return rotated
  })()

  inFlightOAuthRefresh.set(providerId, run)
  void run.finally(() => inFlightOAuthRefresh.delete(providerId)).catch(() => {})
  return run
}

/**
 * Forced refreshes per provider id, so a burst of authentication failures
 * (several turns hitting the same rejecting provider) rotates the token once
 * instead of once per turn.
 */
const lastForcedOAuthRefresh = new Map<string, number>()
export const FORCED_OAUTH_REFRESH_MIN_INTERVAL_MS = 60_000

/**
 * Recover from a provider that answered an authentication error: for an OAuth
 * provider the stored credential is refreshed out of band (outside the normal
 * `expires` gate, since the provider just declared the token invalid) and the
 * caller is told that retrying the call is worthwhile.
 *
 * Returns false for API-key providers — a wrong static key stays wrong, and
 * retrying it only doubles the failure.
 *
 * Never throws: a failed refresh still returns true for OAuth providers,
 * because the stored token may be perfectly valid and the 401 spurious
 * (incident 2026-09-24: the very same credential worked one second earlier and
 * one minute later).
 */
export async function recoverOAuthAfterAuthFailure(
  providerId: string,
  now: number = Date.now(),
): Promise<boolean> {
  let provider: ProviderConfig | undefined
  try {
    provider = loadProvidersDecrypted().providers.find(p => p.id === providerId)
  } catch (err) {
    console.warn(`[axiom] Could not read providers while recovering ${providerId}: ${(err as Error).message}`)
    return false
  }
  if (!provider || provider.authMethod !== 'oauth' || !provider.oauthCredentials) return false

  const last = lastForcedOAuthRefresh.get(providerId) ?? 0
  if (now - last < FORCED_OAUTH_REFRESH_MIN_INTERVAL_MS) return true
  lastForcedOAuthRefresh.set(providerId, now)

  const preset = PROVIDER_TYPE_PRESETS[provider.providerType]
  const oauthAuth = preset?.oauthProviderId ? getPiOAuthAuth(preset.oauthProviderId) : null
  if (!oauthAuth) return true

  try {
    const creds: OAuthCredential = { type: 'oauth', ...storedToOAuthCredentials(provider.oauthCredentials) }
    const refreshed = await refreshOAuthCredentialsLocked(provider.id, oauthAuth, creds, { force: true })
    // Never log token material, only the new lifetime.
    console.warn(
      `[axiom] Provider ${providerId} rejected the access token; OAuth credentials re-resolved `
      + `(valid until ${new Date(refreshed.expires).toISOString()}).`,
    )
  } catch (err) {
    // A failed refresh is not a verdict about the stored token: retry anyway.
    console.error(`[axiom] Forced OAuth refresh for ${providerId} failed: ${(err as Error).message}`)
  }
  return true
}

/**
 * Get API key for a provider, handling OAuth token refresh
 */
export async function getApiKeyForProvider(provider: ProviderConfig): Promise<string> {
  // API key providers: return the key directly
  if (provider.authMethod !== 'oauth' || !provider.oauthCredentials) {
    // For providers that don't require an API key (e.g., local Ollama),
    // return a dummy key to satisfy downstream libraries (like the OpenAI SDK)
    // that require a non-empty API key string.
    if (!provider.apiKey) {
      const preset = PROVIDER_TYPE_PRESETS[provider.providerType]
      if (preset && !preset.requiresApiKey) {
        return 'no-key'
      }
    }
    return provider.apiKey
  }

  const preset = PROVIDER_TYPE_PRESETS[provider.providerType]
  if (!preset?.oauthProviderId) {
    return provider.apiKey
  }

  const oauthAuth = getPiOAuthAuth(preset.oauthProviderId)
  if (!oauthAuth) {
    throw new Error(`Unknown OAuth provider: ${preset.oauthProviderId}`)
  }

  // Convert stored credentials to pi-ai format
  let creds: OAuthCredential = { type: 'oauth', ...storedToOAuthCredentials(provider.oauthCredentials) }

  // Refresh when expired — serialized per provider so concurrent turns never
  // present the same rotated refresh token twice (which revokes the whole
  // family; incident 2026-07-22). refresh() surfaces the real failure cause
  // (e.g. `invalid_grant` when the refresh token itself expired and a UI
  // re-login is required) instead of a generic message.
  //
  // NOTE (upstream 0.84.1 merge): upstream replaced this locked path with
  // `getOAuthApiKey()` from pi-oauth.ts, which refreshes WITHOUT a per-provider
  // lock. We keep our serialized refresh deliberately — the SDK helper does not
  // guarantee that two concurrent turns never present the same rotated refresh
  // token (the exact failure that caused 4× Anthropic OAuth revokes in July).
  if (Date.now() >= creds.expires) {
    creds = await refreshOAuthCredentialsLocked(provider.id, oauthAuth, creds)
  }

  const modelAuth = await oauthAuth.toAuth(creds)
  lastResolvedModelAuth.set(provider.id, modelAuth)

  if (!modelAuth.apiKey) {
    throw new Error(`Failed to get API key for OAuth provider ${provider.name}. Re-login may be required.`)
  }

  return modelAuth.apiKey
}

/**
 * Build a pi-ai Model object from a provider config
 */
export function getConfiguredPriceTable(): TokenPriceTable {
  try {
    ensureConfigTemplates()
    const settings = loadConfig<{ tokenPriceTable?: TokenPriceTable }>('settings.json')
    return {
      ...DEFAULT_PRICE_TABLE,
      ...(settings.tokenPriceTable ?? {}),
    }
  } catch {
    return { ...DEFAULT_PRICE_TABLE }
  }
}

/**
 * The provider's default/primary model id. Historically a dedicated
 * `defaultModel` field; now derived as the first enabled model.
 */
export function getProviderDefaultModel(provider: Pick<ProviderConfig, 'enabledModels'>): string {
  return provider.enabledModels?.[0] ?? ''
}

/** Copilot token format: `tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...` */
function copilotBaseUrlFromToken(token: string): string | undefined {
  const proxyHost = token.match(/proxy-ep=([^;]+)/)?.[1]
  return proxyHost ? `https://${proxyHost.replace(/^proxy\./, 'api.')}` : undefined
}

export function buildModel(provider: ProviderConfig, modelId?: string): Model<Api> {
  const id = modelId ?? getProviderDefaultModel(provider)
  const preset = PROVIDER_TYPE_PRESETS[provider.providerType]

  // Look up the model from pi-ai to get the correct per-model api type and
  // metadata. This path covers OAuth providers as well as api-key gateways
  // (OpenCode Zen/Go) whose catalog spans multiple wire APIs under one entry.
  if (preset?.piAiProvider && (preset.authMethod === 'oauth' || preset.resolveModelsFromCatalog)) {
    try {
      const piAiModels = getPiAiModels(preset.piAiProvider as Parameters<typeof getPiAiModels>[0])

      // GitHub Copilot routes each account through its own proxy endpoint,
      // encoded in the access token; the catalog only carries the default one.
      // Derive the baseUrl eagerly from the token (upstream 0.84.1) so it is
      // correct even before the first request populates lastResolvedModelAuth.
      let models: Model<Api>[] = piAiModels as Model<Api>[]
      if (preset.oauthProviderId === 'github-copilot' && provider.oauthCredentials) {
        const baseUrl = copilotBaseUrlFromToken(
          storedToOAuthCredentials(provider.oauthCredentials).access,
        )
        if (baseUrl) models = models.map(m => ({ ...m, baseUrl }))
      }

      // `let` (not const): the resolvedAuth.baseUrl override below reassigns it.
      let piModel = models.find(m => m.id === id)

      if (piModel) {
        // Per-credential endpoint rewriting (GitHub Copilot proxy baseUrl)
        // moved from the removed `modifyModels` hook into `OAuthAuth.toAuth()`
        // in pi-ai 0.80.8. Apply the last resolved request auth for this
        // provider; `getApiKeyForProvider` populates it before any request.
        const resolvedAuth = lastResolvedModelAuth.get(provider.id)
        if (resolvedAuth?.baseUrl) {
          piModel = { ...piModel, baseUrl: resolvedAuth.baseUrl }
        }

        // For Anthropic OAuth, inject the Claude Code CLI user-agent header
        if (provider.providerType === 'anthropic-oauth') {
          return {
            ...piModel,
            headers: {
              ...piModel.headers,
              'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
            },
          }
        }
        return piModel
      }
    } catch {
      // Fall through to generic build
    }
  }

  // Generic build for API key providers or fallback.
  // Resolution for per-model metadata: provider.models (user override) → local
  // PROVIDER_TYPE_MODEL_OVERRIDES catalog → configured price table → zero.
  const modelConfig = provider.models?.find(m => m.id === id)
    ?? findOverrideModel(provider.providerType, id)
  const priceFallback = getConfiguredPriceTable()[id] ?? { input: 0, output: 0 }

  // For Anthropic providers, set the user-agent header to advertise as Claude Code CLI
  const isAnthropicProvider = provider.providerType === 'anthropic' || provider.providerType === 'anthropic-oauth'
  const headers = isAnthropicProvider ? { 'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}` } : undefined

  return {
    id,
    name: modelConfig?.name ?? id,
    api: provider.type as Api,
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    reasoning: modelConfig?.reasoning ?? false,
    ...(modelConfig?.thinkingLevelMap && { thinkingLevelMap: modelConfig.thinkingLevelMap }),
    input: ['text', 'image'],
    cost: {
      input: modelConfig?.cost?.input ?? priceFallback.input,
      output: modelConfig?.cost?.output ?? priceFallback.output,
      cacheRead: modelConfig?.cost?.cacheRead ?? 0,
      cacheWrite: modelConfig?.cost?.cacheWrite ?? 0,
    },
    contextWindow: modelConfig?.contextWindow ?? 128000,
    maxTokens: modelConfig?.maxTokens ?? 16384,
    ...(headers && { headers }),
  }
}

/**
 * Parse a composite provider:model ID string into its parts.
 * Supports formats:
 *   - "providerId:modelId" → { providerId, modelId }
 *   - "providerId"         → { providerId, modelId: undefined }
 *   - "" / undefined        → { providerId: '', modelId: undefined }
 *
 * When modelId is undefined, callers should fall back to the provider's default model (the first enabled model).
 */
export function parseProviderModelId(value?: string): { providerId: string; modelId?: string } {
  if (!value) return { providerId: '' }
  const colonIdx = value.indexOf(':')
  if (colonIdx === -1) return { providerId: value }
  return {
    providerId: value.slice(0, colonIdx),
    modelId: value.slice(colonIdx + 1) || undefined,
  }
}

/**
 * Resolve a composite provider:model ID to a provider config and model.
 * Returns null if the provider is not found.
 */
export function resolveProviderModelId(value?: string): {
  provider: ProviderConfig
  modelId?: string
} | null {
  const { providerId, modelId } = parseProviderModelId(value)
  if (!providerId) return null
  const file = loadProvidersDecrypted()
  const provider = file.providers.find(p => p.id === providerId)
  if (!provider) return null
  return { provider, modelId }
}

/**
 * Resolve a user-friendly `(provider, model)` pair into a concrete provider
 * and model id. Used by agent tools like `create_cronjob`, `edit_cronjob`,
 * and `create_task` where the user may specify any combination of:
 *
 *   - both provider + model   → validate the model is enabled for that provider
 *   - provider only           → use the provider's default model
 *   - model only              → search providers for one whose enabledModels
 *                               contains the model; unique match wins
 *   - neither                 → `{ ok: false, error: 'none-specified' }`
 *
 * Provider lookup is case-insensitive on both `id` and `name`, matching the
 * pattern used by `resolveProvider` in runtime-composition.
 */
export function resolveProviderModelInput(input: {
  provider?: string | null
  model?: string | null
}): { ok: true; providerId: string; providerName: string; modelId: string; composite: string } | { ok: false; error: string } {
  const providerKey = input.provider?.trim() || ''
  const modelKey = input.model?.trim() || ''

  if (!providerKey && !modelKey) {
    return { ok: false, error: 'No provider or model specified.' }
  }

  const providers = loadProvidersDecrypted().providers

  // Case 1 & 2: provider (with or without model) given
  if (providerKey) {
    const match = providers.find(
      p => p.id === providerKey || p.name.toLowerCase() === providerKey.toLowerCase(),
    )
    if (!match) {
      return { ok: false, error: `Provider "${providerKey}" not found. Available providers: ${providers.map(p => p.name).join(', ') || '(none)'}.` }
    }

    const enabledModels = match.enabledModels ?? []

    let modelId: string
    if (modelKey) {
      const modelMatch = enabledModels.find(m => m.toLowerCase() === modelKey.toLowerCase())
      if (!modelMatch) {
        return { ok: false, error: `Model "${modelKey}" is not enabled for provider "${match.name}". Enabled models: ${enabledModels.join(', ')}.` }
      }
      modelId = modelMatch
    } else {
      modelId = getProviderDefaultModel(match)
    }

    return { ok: true, providerId: match.id, providerName: match.name, modelId, composite: `${match.id}:${modelId}` }
  }

  // Case 3: model only — search all providers for any enabled model that matches
  const hits: Array<{ provider: ProviderConfig; modelId: string }> = []
  for (const p of providers) {
    const enabledModels = p.enabledModels ?? []
    const modelMatch = enabledModels.find(m => m.toLowerCase() === modelKey.toLowerCase())
    if (modelMatch) hits.push({ provider: p, modelId: modelMatch })
  }

  if (hits.length === 0) {
    return { ok: false, error: `Model "${modelKey}" not found in any configured provider. Configured providers: ${providers.map(p => `${p.name} (${(p.enabledModels ?? []).join(', ')})`).join('; ') || '(none)'}.` }
  }
  if (hits.length > 1) {
    return { ok: false, error: `Model "${modelKey}" is ambiguous — enabled in multiple providers: ${hits.map(h => h.provider.name).join(', ')}. Specify the provider explicitly.` }
  }

  const { provider: match, modelId } = hits[0]!
  return { ok: true, providerId: match.id, providerName: match.name, modelId, composite: `${match.id}:${modelId}` }
}

/**
 * Estimate cost from token counts using price table or model cost data
 */
export function estimateCost(
  model: Model<Api>,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  // Model cost is per million tokens. `cost` can be absent on a partially
  // built Model (e.g. the placeholder used on the task resume path, or a model
  // the registry has no pricing for) — treat a missing entry as zero instead of
  // throwing, so accounting never kills a running task.
  const cost = model.cost
  const inputCost = (promptTokens / 1_000_000) * (cost?.input ?? 0)
  const outputCost = (completionTokens / 1_000_000) * (cost?.output ?? 0)
  const cacheReadCost = (cacheReadTokens / 1_000_000) * (cost?.cacheRead ?? 0)
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (cost?.cacheWrite ?? 0)
  return inputCost + outputCost + cacheReadCost + cacheWriteCost
}
