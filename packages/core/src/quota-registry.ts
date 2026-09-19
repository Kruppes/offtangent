import type { ProviderConfig } from './provider-config.js'
import type { QuotaProviderAdapter } from './provider-quota.js'
import { anthropicQuotaAdapter } from './anthropic-quota.js'
import { openaiCodexQuotaAdapter } from './openai-codex-quota.js'
import { opencodeGoQuotaAdapter } from './opencode-go-quota.js'
import { zaiQuotaAdapter } from './zai-quota.js'

/**
 * Registered subscriber-quota adapters. To add a new provider family, implement
 * a `QuotaProviderAdapter` and append it here — the background monitor, HTTP
 * layer, and frontend consume this registry generically.
 */
const QUOTA_ADAPTERS: QuotaProviderAdapter[] = [
  anthropicQuotaAdapter,
  openaiCodexQuotaAdapter,
  opencodeGoQuotaAdapter,
  zaiQuotaAdapter,
]

/** Resolve the quota adapter that handles a provider, or null if none does. */
export function getQuotaAdapter(provider: ProviderConfig): QuotaProviderAdapter | null {
  return QUOTA_ADAPTERS.find((adapter) => adapter.matches(provider)) ?? null
}

/** Whether a provider exposes a subscriber usage quota endpoint. */
export function isQuotaProvider(provider: ProviderConfig): boolean {
  return getQuotaAdapter(provider) !== null
}
