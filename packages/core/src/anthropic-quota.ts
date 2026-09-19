import type { ProviderConfig } from './provider-config.js'
import { CLAUDE_CODE_VERSION, getApiKeyForProvider } from './provider-config.js'
import type { ProviderQuotaWindowContract } from './contracts/providers.js'
import {
  normalizeUtilization,
  parseRetryAfterMs,
  type ProviderQuotaFetchResult,
  type QuotaProviderAdapter,
} from './provider-quota.js'

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'

// OAuth beta header expected by the Anthropic usage endpoint (matches the
// header pi-ai sends for OAuth inference requests).
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

interface RawUsageBucket {
  utilization: number
  resets_at: string | null
}

/** Shape returned by /api/oauth/usage (only the fields we consume). */
interface RawUsageLimits {
  five_hour?: RawUsageBucket | null
  seven_day?: RawUsageBucket | null
  seven_day_opus?: RawUsageBucket | null
  seven_day_sonnet?: RawUsageBucket | null
}

/** Only Anthropic subscriber (OAuth) credentials can query the usage endpoint. */
export function isAnthropicOAuthProvider(provider: ProviderConfig): boolean {
  return (
    provider.providerType === 'anthropic-oauth' &&
    provider.authMethod === 'oauth' &&
    !!provider.oauthCredentials
  )
}

function toWindow(
  key: string,
  label: string,
  resetDisplay: 'relative' | 'absolute',
  bucket: RawUsageBucket | null | undefined,
  options: { hideWhenZero?: boolean } = {},
): ProviderQuotaWindowContract | null {
  if (!bucket || typeof bucket.utilization !== 'number') return null
  const utilization = normalizeUtilization(bucket.utilization)
  // Model-specific 7d windows (Opus/Sonnet) only exist on some plans and are
  // pure noise at 0% — drop them unless they carry real usage.
  if (options.hideWhenZero && utilization === 0) return null
  return {
    key,
    label,
    utilization,
    resetsAt: bucket.resets_at ?? null,
    resetDisplay,
  }
}

/**
 * Fetch Anthropic usage limits using a raw OAuth access token.
 *
 * Headers mirror what pi-ai sends for OAuth Anthropic requests so the usage
 * call is attributed to the same client identity as inference and token
 * refresh — a single consistent caller for Anthropic.
 */
export async function fetchAnthropicQuota(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  try {
    const response = await fetchImpl(USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-app': 'cli',
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

    const data = (await response.json()) as RawUsageLimits
    const windows = [
      toWindow('five_hour', '5h', 'relative', data.five_hour),
      toWindow('seven_day', '7d', 'absolute', data.seven_day),
      toWindow('seven_day_opus', 'Opus', 'absolute', data.seven_day_opus, { hideWhenZero: true }),
      toWindow('seven_day_sonnet', 'Sonnet', 'absolute', data.seven_day_sonnet, { hideWhenZero: true }),
    ].filter((window): window is ProviderQuotaWindowContract => window !== null)

    return {
      quota: {
        kind: 'anthropic',
        windows,
        plan: null,
        fetchedAt: new Date().toISOString(),
      },
      status: response.status,
    }
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Network error' }
  }
}

/**
 * Resolve an OAuth access token for an Anthropic subscriber provider and fetch
 * its usage. Works regardless of whether the provider is the active one — the
 * usage endpoint is read-only and does not affect provider activation.
 */
export async function getAnthropicQuotaForProvider(
  provider: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  if (!isAnthropicOAuthProvider(provider)) {
    return { quota: null, error: 'Provider is not an Anthropic OAuth subscriber' }
  }

  let accessToken: string
  try {
    accessToken = await getApiKeyForProvider(provider)
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Failed to resolve OAuth token' }
  }

  if (!accessToken) {
    return { quota: null, error: 'No OAuth access token available' }
  }

  return fetchAnthropicQuota(accessToken, fetchImpl)
}

export const anthropicQuotaAdapter: QuotaProviderAdapter = {
  kind: 'anthropic',
  matches: isAnthropicOAuthProvider,
  fetch: getAnthropicQuotaForProvider,
}
