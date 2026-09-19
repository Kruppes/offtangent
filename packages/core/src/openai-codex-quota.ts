import type { ProviderConfig } from './provider-config.js'
import { getApiKeyForProvider } from './provider-config.js'
import type { ProviderQuotaWindowContract } from './contracts/providers.js'
import {
  limitWindowLabel,
  normalizeUtilization,
  parseRetryAfterMs,
  type ProviderQuotaFetchResult,
  type QuotaProviderAdapter,
} from './provider-quota.js'

const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'

// The OAuth access token is a JWT whose ChatGPT account id lives under this
// namespaced claim. The usage endpoint requires the account id alongside the
// bearer token.
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

interface RawUsageWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
  /** Unix seconds when the window resets. */
  reset_at?: number
}

interface RawRateLimitInfo {
  primary_window?: RawUsageWindow | null
  secondary_window?: RawUsageWindow | null
}

/** Shape returned by /backend-api/wham/usage (only the fields we consume). */
interface RawCodexUsage {
  plan_type?: string
  rate_limit?: RawRateLimitInfo | null
}

/** Only ChatGPT (Codex) subscriber OAuth credentials can query the endpoint. */
export function isOpenAiCodexOAuthProvider(provider: ProviderConfig): boolean {
  return (
    provider.providerType === 'openai-codex' &&
    provider.authMethod === 'oauth' &&
    !!provider.oauthCredentials
  )
}

/**
 * Extract the ChatGPT account id from a Codex OAuth access token (JWT). The id
 * is stable across token refreshes, so deriving it from the current access
 * token avoids depending on a separately-stored copy.
 */
export function extractCodexAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.')
    if (parts.length !== 3) return null

    const payloadBase64 = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')

    const payloadText = Buffer.from(payloadBase64, 'base64').toString('utf-8')
    const payload = JSON.parse(payloadText) as {
      [JWT_CLAIM_PATH]?: { chatgpt_account_id?: string }
    }

    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : null
  } catch {
    return null
  }
}

function capitalizeFirst(value: string): string {
  return value.length ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function windowResetIso(window: RawUsageWindow, now: number): string | null {
  if (typeof window.reset_at === 'number' && window.reset_at > 0) {
    return new Date(window.reset_at * 1000).toISOString()
  }
  if (typeof window.reset_after_seconds === 'number' && window.reset_after_seconds > 0) {
    return new Date(now + window.reset_after_seconds * 1000).toISOString()
  }
  return null
}

function toWindow(
  key: string,
  resetDisplay: 'relative' | 'absolute',
  window: RawUsageWindow | null | undefined,
  now: number,
): ProviderQuotaWindowContract | null {
  if (!window || typeof window.used_percent !== 'number') return null
  const label =
    typeof window.limit_window_seconds === 'number'
      ? limitWindowLabel(window.limit_window_seconds)
      : key
  return {
    key,
    label,
    utilization: normalizeUtilization(window.used_percent),
    resetsAt: windowResetIso(window, now),
    resetDisplay,
  }
}

/**
 * Fetch ChatGPT (Codex) usage using a raw OAuth access token and account id.
 */
export async function fetchOpenAiCodexQuota(
  accessToken: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  try {
    const response = await fetchImpl(CODEX_USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
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

    const data = (await response.json()) as RawCodexUsage
    const now = Date.now()
    const windows = [
      toWindow('primary', 'relative', data.rate_limit?.primary_window, now),
      toWindow('secondary', 'absolute', data.rate_limit?.secondary_window, now),
    ].filter((window): window is ProviderQuotaWindowContract => window !== null)

    return {
      quota: {
        kind: 'openai-codex',
        windows,
        plan: data.plan_type ? capitalizeFirst(data.plan_type) : null,
        fetchedAt: new Date().toISOString(),
      },
      status: response.status,
    }
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Network error' }
  }
}

/**
 * Resolve an OAuth access token (auto-refreshing) for a Codex subscriber
 * provider, derive its account id, and fetch usage. Works regardless of
 * whether the provider is the active one — the endpoint is read-only.
 */
export async function getOpenAiCodexQuotaForProvider(
  provider: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  if (!isOpenAiCodexOAuthProvider(provider)) {
    return { quota: null, error: 'Provider is not an OpenAI Codex OAuth subscriber' }
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

  const accountId = extractCodexAccountId(accessToken)
  if (!accountId) {
    return { quota: null, error: 'Failed to resolve ChatGPT account id from token' }
  }

  return fetchOpenAiCodexQuota(accessToken, accountId, fetchImpl)
}

export const openaiCodexQuotaAdapter: QuotaProviderAdapter = {
  kind: 'openai-codex',
  matches: isOpenAiCodexOAuthProvider,
  fetch: getOpenAiCodexQuotaForProvider,
}
