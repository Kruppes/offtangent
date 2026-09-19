import type { ProviderConfig } from './provider-config.js'
import { getApiKeyForProvider } from './provider-config.js'
import type { ProviderQuotaWindowContract } from './contracts/providers.js'
import {
  normalizeUtilization,
  parseRetryAfterMs,
  type ProviderQuotaFetchResult,
  type QuotaProviderAdapter,
} from './provider-quota.js'

const QUOTA_ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit'

// z.ai quota "unit" discriminators from the GLM Coding Plan dashboard API.
// unit 5 (monthly MCP-tool allowance) is intentionally ignored.
const UNIT_FIVE_HOUR = 3
const UNIT_WEEKLY = 6

interface RawZaiQuotaLimit {
  type?: string
  unit?: number
  percentage?: number
  /** Epoch ms when the window resets. */
  nextResetTime?: number
}

/** Shape returned by /api/monitor/usage/quota/limit (only the fields we consume). */
interface RawZaiQuotaResponse {
  code?: number
  data?: {
    limits?: RawZaiQuotaLimit[]
    level?: string
  }
}

/**
 * Only the GLM Coding Plan (subscription) token can read the monitoring
 * endpoint — the pay-per-token `zai` General API key returns no usable quota.
 * So quota is enabled only for the `zai-coding` provider type with a key set.
 */
export function isZaiQuotaProvider(provider: ProviderConfig): boolean {
  return (
    provider.providerType === 'zai-coding' &&
    provider.authMethod !== 'oauth' &&
    !!provider.apiKey
  )
}

function capitalizeFirst(value: string): string {
  return value.length ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function toWindow(
  key: string,
  label: string,
  resetDisplay: 'relative' | 'absolute',
  limit: RawZaiQuotaLimit | undefined,
): ProviderQuotaWindowContract | null {
  if (!limit || typeof limit.percentage !== 'number') return null
  const resetsAt =
    typeof limit.nextResetTime === 'number' && limit.nextResetTime > 0
      ? new Date(limit.nextResetTime).toISOString()
      : null
  return {
    key,
    label,
    utilization: normalizeUtilization(limit.percentage),
    resetsAt,
    resetDisplay,
  }
}

/**
 * Fetch GLM Coding Plan usage using the subscription API key. Mirrors the
 * `pi-glm-usage` extension: the key is sent as a bearer token to the z.ai
 * monitoring endpoint, which returns per-window percentages and reset times.
 */
export async function fetchZaiQuota(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  try {
    const response = await fetchImpl(QUOTA_ENDPOINT, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    })

    if (!response.ok) {
      return {
        quota: null,
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        error: `HTTP ${response.status}`,
      }
    }

    const data = (await response.json()) as RawZaiQuotaResponse
    if (data.code !== 200 || !data.data || !Array.isArray(data.data.limits)) {
      return {
        quota: null,
        status: response.status,
        error: `z.ai quota API returned code ${data.code ?? 'unknown'}`,
      }
    }

    const limits = data.data.limits
    const windows = [
      toWindow('five_hour', '5h', 'relative', limits.find((limit) => limit.unit === UNIT_FIVE_HOUR)),
      toWindow('weekly', '7d', 'absolute', limits.find((limit) => limit.unit === UNIT_WEEKLY)),
    ].filter((window): window is ProviderQuotaWindowContract => window !== null)

    if (windows.length === 0) {
      return {
        quota: null,
        status: response.status,
        error: 'z.ai quota API returned no usable windows',
      }
    }

    return {
      quota: {
        kind: 'zai',
        windows,
        plan: data.data.level ? capitalizeFirst(data.data.level) : null,
        fetchedAt: new Date().toISOString(),
      },
      status: response.status,
    }
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Network error' }
  }
}

/**
 * Resolve the subscription API key for a z.ai GLM Coding Plan provider and
 * fetch its usage. Works regardless of whether the provider is the active one
 * — the monitoring endpoint is read-only.
 */
export async function getZaiQuotaForProvider(
  provider: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  if (!isZaiQuotaProvider(provider)) {
    return { quota: null, error: 'Provider is not a z.ai GLM Coding Plan subscriber' }
  }

  let apiKey: string
  try {
    apiKey = await getApiKeyForProvider(provider)
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Failed to resolve API key' }
  }

  if (!apiKey) {
    return { quota: null, error: 'No API key available' }
  }

  return fetchZaiQuota(apiKey, fetchImpl)
}

export const zaiQuotaAdapter: QuotaProviderAdapter = {
  kind: 'zai',
  matches: isZaiQuotaProvider,
  fetch: getZaiQuotaForProvider,
}
