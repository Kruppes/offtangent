/**
 * The HTTP layer shared by the Google connector's tools.
 *
 * Two rules live here, both security relevant:
 *
 *  - An upstream failure is reported as a COARSE CODE only (`http_403`,
 *    `network_error`). The response body of a mail or calendar API carries
 *    personal data, so it is never read, never logged and never handed to a
 *    model.
 *  - A `401` triggers EXACTLY ONE forced token refresh and one retry. Google
 *    can reject a token before its recorded expiry; a second `401` is a real
 *    error and must not become a refresh loop.
 *
 * Every request carries a deadline. A blackholed endpoint (proxy timeout, DNS
 * hang) would otherwise keep the tool call — and with it the single local-model
 * lane of the sub-agent — busy forever.
 */
import type { ConnectorToolContext } from '../types.js'

export const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1'
export const CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3'

/** Per-request deadline for every Google call. */
export const GOOGLE_REQUEST_TIMEOUT_MS = 20_000

/** Upstream failure, reduced to a code. Carries no response body. */
export class GoogleApiError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryAfterSeconds = 0) {
    super(`google_api_error: ${code}`)
    this.name = 'GoogleApiError'
  }
}

/**
 * The `reason` of a Google error body — a fixed vocabulary
 * (`insufficientPermissions`, `rateLimitExceeded`, …). ONLY that token is read;
 * the rest of the body may quote a subject line and never leaves this function.
 */
export function readErrorReason(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { status?: unknown; errors?: Array<{ reason?: unknown }> }
    }
    const fromErrors = parsed?.error?.errors?.find(entry => typeof entry?.reason === 'string')?.reason
    const candidate = typeof fromErrors === 'string'
      ? fromErrors
      : typeof parsed?.error?.status === 'string' ? parsed.error.status : ''
    return /^[A-Za-z_]{1,64}$/.test(candidate) ? candidate : ''
  } catch {
    return ''
  }
}

function retryAfterSeconds(response: Response): number {
  const raw = response.headers?.get?.('retry-after') ?? ''
  const seconds = Number.parseInt(raw.trim(), 10)
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 86_400)
  const asDate = raw ? Date.parse(raw) : Number.NaN
  if (!Number.isNaN(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000))
  return 0
}

/**
 * 403 is two very different things at Google: a missing/withdrawn scope (the
 * user has to consent again) and a rate limit (the user has to wait). The
 * `reason` token decides, so the model can say the right sentence.
 */
export function classifyGoogleFailure(status: number, reason: string): string {
  if (status === 403) {
    if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') return 'reauth_required'
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'quotaExceeded') {
      return 'rate_limited'
    }
    return 'http_403'
  }
  if (status === 429) return 'rate_limited'
  return `http_${status}`
}

export interface GoogleEndpoints {
  gmailBaseUrl: string
  calendarBaseUrl: string
}

export function resolveGoogleEndpoints(overrides: Partial<GoogleEndpoints> = {}): GoogleEndpoints {
  return {
    gmailBaseUrl: (overrides.gmailBaseUrl ?? GMAIL_BASE_URL).replace(/\/+$/, ''),
    calendarBaseUrl: (overrides.calendarBaseUrl ?? CALENDAR_BASE_URL).replace(/\/+$/, ''),
  }
}

export function buildUrl(baseUrl: string, path: string, query: Record<string, string | number | string[]> = {}): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`)
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, entry)
      continue
    }
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * The caller's abort signal (pi-agent-core hands one to `execute`) combined
 * with our own deadline. Either one cancels the socket.
 */
export function requestSignal(signal?: AbortSignal, timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

async function requestOnce(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: requestSignal(signal),
    })
  } catch (err) {
    const name = (err as Error)?.name ?? ''
    if (name === 'TimeoutError' || name === 'AbortError') throw new GoogleApiError('timeout')
    throw new GoogleApiError('network_error')
  }
}

/**
 * `GET` a JSON resource with the connector's access token.
 *
 * Counts refreshes so a caller can assert "exactly one refresh" — the P3 gate
 * of the plan.
 */
export async function googleGetJson<T>(
  ctx: ConnectorToolContext,
  url: string,
  counters?: { refreshes: number },
  signal?: AbortSignal,
): Promise<T> {
  const fetchImpl = ctx.fetchImpl ?? fetch
  const token = await ctx.getAccessToken()
  let response = await requestOnce(fetchImpl, url, token, signal)

  if (response.status === 401) {
    if (!ctx.refreshAccessToken) throw new GoogleApiError('http_401', 401)
    const refreshed = await ctx.refreshAccessToken()
    if (counters) counters.refreshes += 1
    response = await requestOnce(fetchImpl, url, refreshed, signal)
  }

  if (!response.ok) {
    let reason = ''
    if (response.status === 403) {
      // Read the body ONLY to pick the reason token out of it; nothing of it is
      // kept or handed on.
      try {
        reason = readErrorReason(await response.text())
      } catch {
        reason = ''
      }
    }
    throw new GoogleApiError(
      classifyGoogleFailure(response.status, reason),
      response.status,
      response.status === 429 || response.status === 403 ? retryAfterSeconds(response) : 0,
    )
  }

  try {
    return (await response.json()) as T
  } catch {
    throw new GoogleApiError('invalid_json', response.status)
  }
}
