import { loadConfig, warnConfigReadFailed } from './config.js'
import { DEFAULT_WATCHDOG_SETTINGS } from './contracts/settings.js'
import { STALL_OUTCOMES } from './agent-runtime-types.js'
import type { StallInfo, StallOutcome } from './agent-runtime-types.js'
import type { Database } from './database.js'

/** `chat_messages.metadata.kind` marking a persisted provider-stall notice. */
export const PROVIDER_STALL_KIND = 'provider_stall'

export const DEFAULT_STALL_WARN_MS = DEFAULT_WATCHDOG_SETTINGS.stallWarnMs
export const DEFAULT_STALL_ABORT_MS = DEFAULT_WATCHDOG_SETTINGS.stallAbortMs

export interface StallThresholds {
  warnMs: number
  abortMs: number
}

/**
 * Persisted shape of a stall notice. Written once when the warn threshold
 * fires (unresolved) and updated in place when the stall ends, so statistics
 * can aggregate over `durationMs` / `outcome` without reparsing chat text.
 */
export interface ProviderStallMetadata {
  kind: typeof PROVIDER_STALL_KIND
  startedAt: string
  resolvedAt: string | null
  durationMs: number
  outcome: StallOutcome | null
}

export function buildProviderStallMetadata(stall: StallInfo): ProviderStallMetadata {
  return {
    kind: PROVIDER_STALL_KIND,
    startedAt: stall.startedAt,
    resolvedAt: stall.resolvedAt ?? null,
    durationMs: stall.durationMs,
    outcome: stall.outcome ?? null,
  }
}

export function parseProviderStallMetadata(raw: string | null | undefined): ProviderStallMetadata | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const value = parsed as Record<string, unknown>
  if (value.kind !== PROVIDER_STALL_KIND) return null
  if (typeof value.startedAt !== 'string') return null

  const outcome = typeof value.outcome === 'string' && (STALL_OUTCOMES as readonly string[]).includes(value.outcome)
    ? value.outcome as StallOutcome
    : null

  return {
    kind: PROVIDER_STALL_KIND,
    startedAt: value.startedAt,
    resolvedAt: typeof value.resolvedAt === 'string' ? value.resolvedAt : null,
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : 0,
    outcome,
  }
}

/**
 * Human-readable body of the stall row. Channels that can render structured
 * data use `StallInfo`; this text is the fallback (Telegram, old clients) and
 * what a history reload shows verbatim.
 */
export function formatProviderStallContent(stall: StallInfo): string {
  const seconds = Math.max(1, Math.round(stall.durationMs / 1000))
  if (stall.outcome === 'recovered') return `\u2705 Provider recovered after ${seconds}s of silence`
  if (stall.outcome === 'aborted') return `\u26A0\uFE0F Provider stopped responding \u2014 aborted after ${seconds}s of silence`
  return `\u23F3 Provider has not responded for ${seconds}s\u2026`
}

export interface StallStatsQueryOptions {
  dateFrom?: string
  dateTo?: string
}

/**
 * Aggregated stall statistics for a period. `unresolved` counts rows whose
 * stall never got an outcome — the process died mid-stall — so they are
 * excluded from the duration averages, where they would understate reality.
 */
export interface StallStats {
  total: number
  recovered: number
  aborted: number
  unresolved: number
  averageDurationMs: number
  maxDurationMs: number
  averageRecoveredDurationMs: number
  averageAbortedDurationMs: number
}

function toRoundedNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
}

/**
 * Aggregate the persisted provider-stall rows over a date range. No provider /
 * model dimension exists: a stall is recorded per turn, not per request.
 */
export function queryStallStats(db: Database, options: StallStatsQueryOptions = {}): StallStats {
  const clauses = [`json_extract(metadata, '$.kind') = '${PROVIDER_STALL_KIND}'`]
  const params: unknown[] = []

  if (options.dateFrom) {
    clauses.push('datetime(timestamp) >= datetime(?)')
    params.push(options.dateFrom)
  }

  if (options.dateTo) {
    clauses.push('datetime(timestamp) <= datetime(?)')
    params.push(options.dateTo)
  }

  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN outcome = 'recovered' THEN 1 ELSE 0 END), 0) AS recovered,
      COALESCE(SUM(CASE WHEN outcome = 'aborted' THEN 1 ELSE 0 END), 0) AS aborted,
      COALESCE(SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END), 0) AS unresolved,
      AVG(CASE WHEN outcome IS NOT NULL THEN durationMs END) AS averageDurationMs,
      MAX(CASE WHEN outcome IS NOT NULL THEN durationMs END) AS maxDurationMs,
      AVG(CASE WHEN outcome = 'recovered' THEN durationMs END) AS averageRecoveredDurationMs,
      AVG(CASE WHEN outcome = 'aborted' THEN durationMs END) AS averageAbortedDurationMs
    FROM (
      SELECT
        json_extract(metadata, '$.outcome') AS outcome,
        COALESCE(json_extract(metadata, '$.durationMs'), 0) AS durationMs
      FROM chat_messages
      WHERE ${clauses.join(' AND ')}
    )
  `).get(...params) as Record<string, unknown> | undefined

  return {
    total: toRoundedNumber(row?.total),
    recovered: toRoundedNumber(row?.recovered),
    aborted: toRoundedNumber(row?.aborted),
    unresolved: toRoundedNumber(row?.unresolved),
    averageDurationMs: toRoundedNumber(row?.averageDurationMs),
    maxDurationMs: toRoundedNumber(row?.maxDurationMs),
    averageRecoveredDurationMs: toRoundedNumber(row?.averageRecoveredDurationMs),
    averageAbortedDurationMs: toRoundedNumber(row?.averageAbortedDurationMs),
  }
}

interface WatchdogSettingsFile {
  watchdog?: {
    stallWarnMs?: unknown
    stallAbortMs?: unknown
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Read the watchdog thresholds from `settings.json`. Config-file only for now;
 * a missing/unreadable file falls back to the 30 s / 90 s defaults — a turn is
 * never failed over a config problem, but the failure is logged.
 */
export function loadStallThresholds(
  load: () => WatchdogSettingsFile = () => loadConfig<WatchdogSettingsFile>('settings.json'),
): StallThresholds {
  let watchdog: WatchdogSettingsFile['watchdog']
  try {
    watchdog = load().watchdog
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
    watchdog = undefined
  }

  return {
    warnMs: positiveNumber(watchdog?.stallWarnMs, DEFAULT_STALL_WARN_MS),
    abortMs: positiveNumber(watchdog?.stallAbortMs, DEFAULT_STALL_ABORT_MS),
  }
}
