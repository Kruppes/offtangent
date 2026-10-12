import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import type { ProviderConfig } from '@axiom/core'

export interface ProvidersRouterOptions {
  onActiveProviderChanged?: () => void
  onFallbackProviderChanged?: () => void
  getQuotaSnapshot?: () => Record<string, ProviderQuotaContract>
  refreshQuota?: (providerId: string) => Promise<ProviderQuotaContract | null>
}

export interface PendingOAuthLogin {
  status: 'pending' | 'completed' | 'error'
  providerType: string
  name: string
  enabledModels: string[]
  textVerbosity?: 'low' | 'medium' | 'high' | null
  transport?: 'sse' | 'websocket' | 'websocket-cached' | 'auto' | null
  /** Region choice of a multi-region OAuth preset (validated before login). */
  baseUrl?: string
  authUrl?: string
  instructions?: string
  credentials?: OAuthCredentials
  /** Saved provider, set by the server as soon as the login completes. */
  provider?: ProviderConfig
  error?: string
  resolveManualCode?: (code: string) => void
  createdAt: number
  /** Dropped from memory after this instant (see `pendingOAuthLoginTtlMs`). */
  expiresAt: number
  /** Device-code lifetime announced by the auth server, if any. */
  expiresInSeconds?: number
  existingProviderId?: string
  /**
   * Stored base URL (Kimi Code: region) of the existing provider when the
   * re-login started. The credential is only written if it is unchanged.
   */
  existingBaseUrl?: string | null
}

export interface OllamaTagsResponse {
  models?: Array<{
    name: string
    size: number
    /**
     * Set by Ollama when the daemon PROXIES this model to a remote endpoint
     * (e.g. `https://ollama.com:443` for `kimi-k2.5:cloud`). Absent for weights
     * that run on the box. The authoritative hosting signal for the
     * data-policy gate, see `ollama-tag-cache.ts`.
     */
    remote_host?: string
    details?: {
      parameter_size?: string
      quantization_level?: string
      family?: string
    }
  }>
}
