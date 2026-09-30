import type { Database } from './database.js'
import type { ProviderConfig } from './provider-config.js'
import { buildModel, getApiKeyForProvider, PROVIDER_TYPE_PRESETS, resolveModelTemperature, getProviderDefaultModel, DEFAULT_HEALTH_CHECK_TIMEOUT_MS } from './provider-config.js'
import { completeSimple } from './pi-models.js'
import { assertLlmResponseOk } from './llm-response.js'

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down' | 'unconfigured'

export interface ProviderHealthCheckOptions {
  /**
   * Explicit hard abort timeout. Takes precedence over the provider's
   * persisted `healthCheckTimeoutMs` (used e.g. by the manual provider test,
   * which always allows 60 s regardless of the monitor configuration).
   */
  timeoutMs?: number
  degradedThresholdMs?: number
  fetchImpl?: typeof fetch
}

export interface ProviderHealthCheckResult {
  checkedAt: string
  providerId: string | null
  providerName: string | null
  providerType: string | null
  model: string | null
  status: ProviderHealthStatus
  latencyMs: number | null
  errorMessage: string | null
  isRateLimited: boolean
  /**
   * True when the check failed because the hard timeout aborted the request
   * (as opposed to a real provider error such as 401, 5xx or connection
   * refused). Lets callers treat cold-start timeouts differently from actual
   * outages. Absent/false for successful checks and non-timeout failures.
   */
  isTimeout?: boolean
}

export interface HealthCheckLogInput {
  timestamp?: string
  provider?: string | null
  status: ProviderHealthStatus
  latencyMs?: number | null
  errorMessage?: string | null
}

export interface HealthCheckHistoryRecord {
  id: number
  timestamp: string
  provider: string | null
  status: ProviderHealthStatus
  latencyMs: number | null
  errorMessage: string | null
}

export interface HealthCheckHistoryResult {
  records: HealthCheckHistoryRecord[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export interface ActivitySummary {
  messagesToday: number
  sessionsToday: number
}

function buildOpenAiCompatibleRequest(provider: ProviderConfig): {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`
  }

  const tokenLimitField = provider.providerType === 'openai-compatible'
    ? { max_tokens: 5 }
    : { max_completion_tokens: 5 }

  return {
    url: `${provider.baseUrl}/chat/completions`,
    headers,
    body: {
      model: getProviderDefaultModel(provider),
      ...tokenLimitField,
      temperature: resolveModelTemperature(provider, getProviderDefaultModel(provider), 0),
      messages: [{ role: 'user', content: 'Respond with OK only.' }],
    },
  }
}

function buildAnthropicRequest(provider: ProviderConfig): {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  return {
    url: `${provider.baseUrl}/v1/messages`,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: getProviderDefaultModel(provider),
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Respond with OK only.' }],
    },
  }
}

function parseErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null
  }

  const record = body as {
    error?: string | { message?: string }
    message?: string
  }

  if (typeof record.error === 'string') {
    return record.error
  }

  if (record.error && typeof record.error === 'object' && typeof record.error.message === 'string') {
    return record.error.message
  }

  if (typeof record.message === 'string') {
    return record.message
  }

  return null
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Health check using pi-ai's completeSimple.
 * Handles all API types correctly (codex-responses, gemini-cli, mistral-conversations, etc.)
 * Used for OAuth providers and non-standard API types without a custom request builder.
 */
async function performPiAiHealthCheck(
  provider: ProviderConfig,
  startedAt: number,
  checkedAt: string,
  timeoutMs: number,
  degradedThresholdMs: number,
): Promise<ProviderHealthCheckResult> {
  try {
    const model = buildModel(provider)
    const apiKey = await getApiKeyForProvider(provider)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await completeSimple(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Respond with OK only.' }], timestamp: Date.now() }],
      }, {
        apiKey,
        maxTokens: 5,
        signal: controller.signal,
      })

      assertLlmResponseOk(response, 'Health check failed')

      const latencyMs = Date.now() - startedAt
      return {
        checkedAt,
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.providerType,
        model: getProviderDefaultModel(provider),
        status: latencyMs > degradedThresholdMs ? 'degraded' : 'healthy',
        latencyMs,
        errorMessage: null,
        isRateLimited: false,
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    const message = (err as Error).message || 'Unknown error'
    const isTimeout = message.includes('abort') || (err as Error).name === 'AbortError'
    const errorMessage = isTimeout ? 'Connection timed out' : message
    const isRateLimited = message.includes('429') || message.toLowerCase().includes('rate limit')

    return {
      checkedAt,
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.providerType,
      model: getProviderDefaultModel(provider),
      status: 'down',
      latencyMs: Date.now() - startedAt,
      errorMessage,
      isRateLimited,
      isTimeout,
    }
  }
}

export async function performProviderHealthCheck(
  provider: ProviderConfig | null,
  options: ProviderHealthCheckOptions = {},
): Promise<ProviderHealthCheckResult> {
  const checkedAt = new Date().toISOString()

  if (!provider) {
    return {
      checkedAt,
      providerId: null,
      providerName: null,
      providerType: null,
      model: null,
      status: 'unconfigured',
      latencyMs: null,
      errorMessage: 'No active provider configured',
      isRateLimited: false,
    }
  }

  // Resolution order: explicit call option > per-provider persisted timeout
  // (e.g. 60 s for local Ollama providers whose model cold start exceeds 15 s)
  // > global default.
  const timeoutMs = options.timeoutMs ?? provider.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS
  const degradedThresholdMs = options.degradedThresholdMs ?? provider.degradedThresholdMs ?? 5000
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  try {
    // For OAuth providers or non-standard API types (e.g. mistral-conversations),
    // use pi-ai's completeSimple for proper API-type-aware health check
    const preset = PROVIDER_TYPE_PRESETS[provider.providerType as keyof typeof PROVIDER_TYPE_PRESETS]
    const hasCustomRequestBuilder = provider.type === 'anthropic-messages' || provider.type === 'openai-completions'
    if (preset?.authMethod === 'oauth' || preset?.resolveModelsFromCatalog || !hasCustomRequestBuilder) {
      return await performPiAiHealthCheck(provider, startedAt, checkedAt, timeoutMs, degradedThresholdMs)
    }

    const request = provider.type === 'anthropic-messages'
      ? buildAnthropicRequest(provider)
      : buildOpenAiCompatibleRequest(provider)

    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    })

    const latencyMs = Date.now() - startedAt

    if (!response.ok) {
      const body = await parseJsonSafely(response)
      return {
        checkedAt,
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.providerType,
        model: getProviderDefaultModel(provider),
        status: 'down',
        latencyMs,
        errorMessage: parseErrorMessage(body) ?? `HTTP ${response.status}`,
        isRateLimited: response.status === 429,
      }
    }

    return {
      checkedAt,
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.providerType,
      model: getProviderDefaultModel(provider),
      status: latencyMs > degradedThresholdMs ? 'degraded' : 'healthy',
      latencyMs,
      errorMessage: null,
      isRateLimited: false,
    }
  } catch (err) {
    const message = (err as Error).message || 'Unknown error'
    const isTimeout = message.includes('abort') || (err as Error).name === 'AbortError'
    const errorMessage = isTimeout ? 'Connection timed out' : message

    return {
      checkedAt,
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.providerType,
      model: getProviderDefaultModel(provider),
      status: 'down',
      latencyMs: Date.now() - startedAt,
      errorMessage,
      isRateLimited: false,
      isTimeout,
    }
  } finally {
    clearTimeout(timer)
  }
}

export function logHealthCheck(db: Database, input: HealthCheckLogInput): number {
  const result = db.prepare(
    `INSERT INTO health_checks (timestamp, provider, status, latency_ms, error_message)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    input.timestamp ?? new Date().toISOString(),
    input.provider ?? null,
    input.status,
    input.latencyMs ?? null,
    input.errorMessage ?? null,
  )

  return Number(result.lastInsertRowid)
}

export function getLatestHealthCheck(db: Database): HealthCheckHistoryRecord | null {
  const row = db.prepare(
    `SELECT id, timestamp, provider, status, latency_ms, error_message
     FROM health_checks
     ORDER BY datetime(timestamp) DESC, id DESC
     LIMIT 1`
  ).get() as {
    id: number
    timestamp: string
    provider: string | null
    status: ProviderHealthStatus
    latency_ms: number | null
    error_message: string | null
  } | undefined

  if (!row) {
    return null
  }

  return {
    id: row.id,
    timestamp: row.timestamp,
    provider: row.provider,
    status: row.status,
    latencyMs: row.latency_ms,
    errorMessage: row.error_message,
  }
}

export function queryHealthCheckHistory(
  db: Database,
  page: number = 1,
  limit: number = 50,
): HealthCheckHistoryResult {
  const safePage = Math.max(1, page)
  const safeLimit = Math.max(1, Math.min(100, limit))
  const offset = (safePage - 1) * safeLimit

  const rows = db.prepare(
    `SELECT id, timestamp, provider, status, latency_ms, error_message
     FROM health_checks
     ORDER BY datetime(timestamp) DESC, id DESC
     LIMIT ? OFFSET ?`
  ).all(safeLimit, offset) as Array<{
    id: number
    timestamp: string
    provider: string | null
    status: ProviderHealthStatus
    latency_ms: number | null
    error_message: string | null
  }>

  const total = (db.prepare('SELECT COUNT(*) AS count FROM health_checks').get() as { count: number }).count

  return {
    records: rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      provider: row.provider,
      status: row.status,
      latencyMs: row.latency_ms,
      errorMessage: row.error_message,
    })),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  }
}

export function getActivitySummary(db: Database): ActivitySummary {
  const messagesToday = (db.prepare(
    `SELECT COUNT(*) AS count
     FROM chat_messages
     WHERE date(timestamp) = date('now')`
  ).get() as { count: number }).count

  const sessionsToday = (db.prepare(
    `SELECT COUNT(*) AS count
     FROM sessions
     WHERE date(started_at) = date('now')`
  ).get() as { count: number }).count

  return {
    messagesToday,
    sessionsToday,
  }
}
