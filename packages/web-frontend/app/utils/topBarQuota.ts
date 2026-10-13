import type { ProviderQuotaBalanceContract, ProviderQuotaContract } from '@axiom/core/contracts'

/** One provider's subscriber quota as the top bar renders it. */
export interface TopBarQuotaSource {
  providerId: string | null
  /** Short label shown in front of the windows so it is clear whose quota it is. */
  providerName: string | null
  quota: ProviderQuotaContract | null
}

/** Provider of the strand that is open right now, as its header resolved it. */
export interface ActiveStrandProvider {
  strandId: string
  providerId: string
}

/** The fields of `/api/models` entries the top bar needs. */
export interface ProviderQuotaEntry {
  providerId: string
  providerName: string
  quota: ProviderQuotaContract | null
}

/**
 * Index the per-model list of `/api/models` by provider. Every model of a
 * provider carries the same provider quota, so the first entry wins.
 */
export function quotaByProvider(models: readonly ProviderQuotaEntry[]): Record<string, TopBarQuotaSource> {
  const out: Record<string, TopBarQuotaSource> = {}
  for (const model of models) {
    if (out[model.providerId]) continue
    out[model.providerId] = { providerId: model.providerId, providerName: model.providerName, quota: model.quota ?? null }
  }
  return out
}

/** `/strands/:id` (and nothing else) is a strand page; returns its id. */
export function strandIdOfRoute(path: string, params: Record<string, unknown>): string | null {
  if (!/^\/strands\/[^/]+/.test(path)) return null
  const id = params.id
  return typeof id === 'string' && id ? id : null
}

/**
 * Which quota the top bar shows.
 *
 * Outside a strand: the global default provider's quota, as before. On a
 * strand page: ONLY the quota of the provider that strand runs on. While that
 * provider is still unknown, or when it has no subscriber quota (plain API
 * provider) or its quota failed to load, nothing is shown: falling back to
 * another provider's quota would name a subscription the strand does not use.
 */
export function resolveTopBarQuota(input: {
  routeStrandId: string | null
  activeStrand: ActiveStrandProvider | null
  strandQuotas: Record<string, TopBarQuotaSource>
  global: TopBarQuotaSource
}): TopBarQuotaSource | null {
  const usable = (source: TopBarQuotaSource | null | undefined): TopBarQuotaSource | null => {
    // Empty windows are passed on: the bar renders nothing for them by itself,
    // and a prepaid balance quota may carry no windows at all.
    if (!source?.quota || source.quota.error) return null
    return source
  }
  if (!input.routeStrandId) return usable(input.global)
  const active = input.activeStrand
  if (!active || active.strandId !== input.routeStrandId) return null
  return usable(input.strandQuotas[active.providerId])
}

/**
 * The prepaid balance the top bar shows for a resolved source (pay-as-you-go
 * keys such as the Moonshot platform), or null. Only a balance-only quota
 * (no usage windows) shows its balance; a quota with windows shows the
 * windows. It reads exclusively the given source, so on a strand page it is
 * always the strand provider's own balance and never another provider's.
 */
export function topBarBalanceOf(source: TopBarQuotaSource | null | undefined): ProviderQuotaBalanceContract | null {
  const quota = source?.quota
  if (!quota || quota.error || quota.windows.length > 0) return null
  return quota.balance ?? null
}
