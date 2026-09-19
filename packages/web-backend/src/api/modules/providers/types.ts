import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth'
import type { ProviderQuotaContract } from '@axiom/core/contracts'

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
  authUrl?: string
  instructions?: string
  credentials?: OAuthCredentials
  error?: string
  resolveManualCode?: (code: string) => void
  createdAt: number
  existingProviderId?: string
}

export interface OllamaTagsResponse {
  models?: Array<{
    name: string
    size: number
    details?: {
      parameter_size?: string
      quantization_level?: string
      family?: string
    }
  }>
}
