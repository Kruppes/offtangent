import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { ProviderQuotaContract } from './contracts/providers.js'

/** Minimum spacing between two tool-initiated live fetches of the same provider. */
const REFRESH_MIN_INTERVAL_MS = 60_000

export interface QuotaServiceLike {
  getSnapshot(): Record<string, ProviderQuotaContract>
  refreshProvider(providerId: string): Promise<ProviderQuotaContract | null>
}

export interface ProviderQuotaToolOptions {
  quotaService: QuotaServiceLike
  /**
   * Returns false when the calling chat user must not see provider quota.
   * Quota is admin-only on the HTTP API, so the tool must not widen it.
   */
  isAuthorized?: () => boolean
  now?: () => number
}

export function createProviderQuotaTool(options: ProviderQuotaToolOptions): AgentTool {
  const now = options.now ?? (() => Date.now())
  const lastRefreshAt = new Map<string, number>()

  // refreshProvider() forces a fetch that bypasses the quota monitor's 429
  // backoff (it exists for a deliberate click in the UI). Throttling here keeps
  // an agent retry loop from hammering the provider's usage endpoint.
  const claimRefreshSlot = (providerId: string): boolean => {
    const last = lastRefreshAt.get(providerId)
    const current = now()
    if (last !== undefined && current - last < REFRESH_MIN_INTERVAL_MS) return false
    lastRefreshAt.set(providerId, current)
    return true
  }

  return {
    name: 'provider_quota',
    label: 'Provider Quota',
    description:
      'Check the current subscriber usage quota for LLM providers (Anthropic Claude Pro/Max, ChatGPT Codex, OpenCode, etc.). ' +
      'Returns normalized usage windows with utilization percentages and reset times. ' +
      'Use this to answer questions about remaining quota, rate limits, or usage consumption per provider. ' +
      'Only available to admin users.',
    parameters: Type.Object({
      providerId: Type.Optional(
        Type.String({
          description: 'A specific provider id to check. Omit to get quota for all providers.',
        }),
      ),
      refresh: Type.Optional(
        Type.Boolean({
          description:
            'Force a live quota fetch before returning (default: false). Applies to the selected provider, or to every provider when providerId is omitted. ' +
            'A provider refreshed within the last minute keeps serving cached data.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { providerId, refresh = false } = params as { providerId?: string; refresh?: boolean }

      if (options.isAuthorized && !options.isAuthorized()) {
        return textResult('Provider quota is only available to admin users.', { error: true, providerId, forbidden: true })
      }

      try {
        const snapshot = options.quotaService.getSnapshot()
        const targetIds = providerId
          ? (refresh || snapshot[providerId] ? [providerId] : [])
          : Object.keys(snapshot)

        const { results, throttled, missing, refreshed } = await collectQuotas({
          targetIds,
          snapshot,
          refresh,
          claimRefreshSlot,
          refreshProvider: id => options.quotaService.refreshProvider(id),
        })

        if (results.length === 0) return formatNoQuotaData(providerId, refresh && missing)

        const blocks = results.map(({ id, quota }) => formatProviderQuota(id, quota))
        if (throttled.length > 0) {
          blocks.push(`Note: live refresh skipped for ${throttled.join(', ')} (refreshed less than a minute ago) — showing cached data.`)
        }

        return textResult(blocks.join('\n\n'), {
          providerId,
          refreshed,
          throttled,
          count: results.length,
          snapshot: Object.fromEntries(results.map(({ id, quota }) => [id, quota])),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return textResult(`Error fetching quota data: ${message}`, { error: true, providerId })
      }
    },
  }
}

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], details }
}

function formatNoQuotaData(providerId: string | undefined, unknownProvider: boolean) {
  const scope = providerId ? ` for provider "${providerId}"` : ''
  const reason = unknownProvider
    ? 'The provider may not exist or may not support quota monitoring.'
    : 'No quota-capable providers are configured, or no data has been fetched yet.'
  return textResult(`No quota data available${scope}. ${reason}`, { providerId, count: 0, error: unknownProvider })
}

interface CollectQuotasOptions {
  targetIds: string[]
  snapshot: Record<string, ProviderQuotaContract>
  refresh: boolean
  claimRefreshSlot: (providerId: string) => boolean
  refreshProvider: (providerId: string) => Promise<ProviderQuotaContract | null>
}

interface CollectQuotasResult {
  results: { id: string; quota: ProviderQuotaContract }[]
  throttled: string[]
  missing: boolean
  refreshed: boolean
}

async function collectQuotas(options: CollectQuotasOptions): Promise<CollectQuotasResult> {
  const results: { id: string; quota: ProviderQuotaContract }[] = []
  const throttled: string[] = []
  let missing = false
  let refreshed = false

  for (const id of options.targetIds) {
    let quota: ProviderQuotaContract | null = options.snapshot[id] ?? null

    if (options.refresh) {
      if (options.claimRefreshSlot(id)) {
        quota = await options.refreshProvider(id)
        refreshed = true
      } else {
        throttled.push(id)
      }
    }

    if (quota) results.push({ id, quota })
    else missing = true
  }

  return { results, throttled, missing, refreshed }
}

function formatProviderQuota(providerId: string, quota: ProviderQuotaContract): string {
  const header = quota.plan
    ? `**${providerId}** (${quota.kind}, plan: ${quota.plan})`
    : `**${providerId}** (${quota.kind})`
  if (quota.error) {
    return `${header}\nError: ${quota.error}\nFetched: ${quota.fetchedAt}`
  }

  if (!quota.windows || quota.windows.length === 0) {
    return `${header}\nNo usage windows available.\nFetched: ${quota.fetchedAt}`
  }

  const lines = quota.windows.map(w => {
    const pct = `${w.utilization}%`
    const reset = w.resetsAt ? ` (resets ${w.resetsAt})` : ''
    return `  - ${w.label}: ${pct} used${reset}`
  })

  return [header, ...lines, `Fetched: ${quota.fetchedAt}`].join('\n')
}
