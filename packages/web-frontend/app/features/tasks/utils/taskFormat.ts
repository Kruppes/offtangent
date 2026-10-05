import type { Task } from '~/api/tasks'
import { parseBackendTimestamp } from '~/utils/datetime'

export type TaskStatusVariant = 'default' | 'success' | 'destructive' | 'warning' | 'muted'

/**
 * Display status of a task row. The backend has no `queued` status on
 * purpose: a task that waits for a free concurrency slot is stored as
 * `running` with `startedAt = NULL` (the Android client reads the same
 * marker). Without this distinction the task list would claim a waiting task
 * is working.
 */
export function taskDisplayStatus(task: Pick<Task, 'status' | 'startedAt'>): string {
  return task.status === 'running' && !task.startedAt ? 'queued' : task.status
}

export function taskStatusVariant(status: string): TaskStatusVariant {
  switch (status) {
    case 'running': return 'default'
    case 'queued': return 'muted'
    case 'completed': return 'success'
    case 'failed': return 'destructive'
    case 'paused': return 'warning'
    default: return 'muted'
  }
}

/**
 * Backend timestamps arrive either naked (`2026-09-15 06:15:53`, SQLite's
 * `datetime('now')`, UTC without a marker) or as ISO-8601 with `Z`. Blindly
 * appending a `Z` turns the second shape into `...ZZ` and therefore into NaN,
 * so both go through the shared parser.
 */
function parseSqliteTimestamp(value: string): number {
  return parseBackendTimestamp(value)?.getTime() ?? NaN
}

export function formatTaskDuration(task: Pick<Task, 'startedAt' | 'completedAt'>, now = Date.now()): string {
  const start = task.startedAt ? parseSqliteTimestamp(task.startedAt) : null
  if (!start) return '—'

  const end = task.completedAt ? parseSqliteTimestamp(task.completedAt) : now
  if (!Number.isFinite(end)) return '—'

  const diffMs = end - start
  if (diffMs < 0) return '—'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

export function hasCacheTokens(task: Pick<Task, 'cacheRead' | 'cacheWrite'>): boolean {
  return task.cacheRead > 0 || task.cacheWrite > 0
}

type CacheUsage = {
  promptTokens?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
}

function usageCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Share of the input tokens that was served from the provider's prompt cache,
 * in percent (0..100), or null when it is unknown.
 *
 *   cacheRead / (promptTokens + cacheRead + cacheWrite) * 100
 *
 * pi-ai normalizes every provider's usage so that `input` (stored as
 * `promptTokens`) EXCLUDES cached reads and cache writes (OpenAI subtracts
 * `cached_tokens`, Anthropic reports `cache_read_input_tokens` /
 * `cache_creation_input_tokens` separately). The full input of the requests
 * is therefore the sum of all three. Cache writes are input, but never a hit.
 * Output tokens are not part of the denominator. Numerator and denominator
 * always come from the same usage record, so the scope (one task's own run)
 * is identical.
 *
 * Null (rendered as a dash, never as 0 %) when a field is missing, negative or
 * not finite, or when no input was recorded at all.
 */
export function cachedInputPercent(usage: CacheUsage): number | null {
  const prompt = usageCount(usage.promptTokens)
  const read = usageCount(usage.cacheRead)
  const write = usageCount(usage.cacheWrite)
  if (prompt === null || read === null || write === null) return null
  const denominator = prompt + read + write
  if (denominator <= 0) return null
  return Math.min(100, (read / denominator) * 100)
}

/** Kept for existing callers: same formula as `cachedInputPercent`. */
export function cacheHitRate(task: Pick<Task, 'promptTokens' | 'cacheRead' | 'cacheWrite'>): number | null {
  return cachedInputPercent(task)
}

/** "5.0%" or "—" when the rate is unknown. */
export function formatCachePercent(rate: number | null): string {
  return rate === null ? '—' : `${rate.toFixed(1)}%`
}

export function cacheSummary(task: CacheUsage): string {
  return `CH ${formatCachePercent(cachedInputPercent(task))}`
}

export function formatTaskTriggerModel(
  task: Pick<Task, 'provider' | 'model' | 'isDefaultModel' | 'thinkingLevel'>,
  t: (key: string, values: Record<string, string>) => string,
): string | null {
  if (!task.provider && !task.model) return null

  const parts = [task.provider, task.model].filter(Boolean).join(' – ')
  const base = task.isDefaultModel === true
    ? t('tasks.triggerModelDefault', { value: parts })
    : parts
  return task.thinkingLevel
    ? t('tasks.triggerModelThinking', { value: base, level: task.thinkingLevel })
    : base
}

/**
 * Tooltip with the routing decision of the task policy (why this model and
 * thinking level), or null for tasks without a routing record.
 */
export function formatTaskRoutingTooltip(
  task: Pick<Task, 'routing'>,
  t: (key: string, values: Record<string, string>) => string,
): string | null {
  const routing = task.routing
  if (!routing) return null
  const profile = routing.kind ? `${routing.kind}/${routing.difficulty}` : '–'
  const text = t('tasks.routingTooltip', {
    profile,
    thinking: routing.thinking ?? '–',
    reason: routing.reason,
  })
  return routing.modelReason ? `${text} (${routing.modelReason})` : text
}
