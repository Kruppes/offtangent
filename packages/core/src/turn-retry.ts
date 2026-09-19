import { isRetryableAssistantError } from '@earendil-works/pi-ai'
import type { AssistantMessage, RetryPolicy } from '@earendil-works/pi-ai'
import { loadConfig, warnConfigReadFailed } from './config.js'
import { DEFAULT_RETRY_SETTINGS } from './contracts/settings.js'
import type { RetryInfo } from './agent-runtime-types.js'

export type { RetryPolicy }

export const DEFAULT_RETRY_ENABLED = DEFAULT_RETRY_SETTINGS.enabled
export const DEFAULT_RETRY_MAX_RETRIES = DEFAULT_RETRY_SETTINGS.maxRetries
export const DEFAULT_RETRY_BASE_DELAY_MS = DEFAULT_RETRY_SETTINGS.baseDelayMs

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: DEFAULT_RETRY_ENABLED,
  maxRetries: DEFAULT_RETRY_MAX_RETRIES,
  baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
}

interface RetrySettingsFile {
  retry?: {
    enabled?: unknown
    maxRetries?: unknown
    baseDelayMs?: unknown
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/**
 * Read the auto-retry policy from `settings.json`. Config-file only for now;
 * a missing/unreadable file falls back to pi's defaults (3 retries, 2000 ms) —
 * a turn is never failed over a config problem, but the failure is logged.
 */
export function loadRetryPolicy(
  load: () => RetrySettingsFile = () => loadConfig<RetrySettingsFile>('settings.json'),
): RetryPolicy {
  let retry: RetrySettingsFile['retry']
  try {
    retry = load().retry
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
    retry = undefined
  }

  return {
    enabled: typeof retry?.enabled === 'boolean' ? retry.enabled : DEFAULT_RETRY_ENABLED,
    maxRetries: nonNegativeInteger(retry?.maxRetries, DEFAULT_RETRY_MAX_RETRIES),
    baseDelayMs: positiveNumber(retry?.baseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS),
  }
}

/**
 * Classify a failed turn via pi-ai's shared classifier, so transient provider
 * noise (429/5xx/timeouts/dropped streams) is retried while deterministic
 * failures (auth, quota, billing) fail fast. The classifier works on an
 * `AssistantMessage`, which is what a turn's error chunk boils down to here.
 */
export function isRetryableTurnError(errorMessage: string): boolean {
  return isRetryableAssistantError({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage,
  } as unknown as AssistantMessage)
}

/**
 * Recognize the AbortError text a cancelled fetch/stream produces ("This
 * operation was aborted", "The user aborted a request.", `AbortError: ...`).
 * pi-ai's classifier rates these as permanent, which is right for a user
 * `/stop` but wrong for an abort the turn never asked for — the caller
 * decides which case it is.
 */
export function isAbortError(errorMessage: string): boolean {
  return /\boperation was aborted\b|\baborterror\b|\baborted a request\b/i.test(errorMessage)
}

/** Exponential backoff for a 1-indexed attempt: `base * 2^(attempt-1)`. */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  return policy.baseDelayMs * 2 ** (attempt - 1)
}

/**
 * Body of the `retry_scheduled` chunk. Channels that can render structured
 * data use `RetryInfo`; this text is the fallback for plain-text channels.
 */
export function formatRetryScheduledContent(retry: RetryInfo): string {
  const seconds = Math.max(1, Math.round(retry.delayMs / 1000))
  return `\u{1F504} Provider error \u2014 retrying (${retry.attempt}/${retry.maxRetries}) in ${seconds}s\u2026`
}
