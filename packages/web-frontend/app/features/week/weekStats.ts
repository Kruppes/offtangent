import type { Capture, Decision } from '@axiom/core'
import { addDays, dayKey, isoWeek, parseInstant, weekdayIndex } from '~/utils/localDay'

/**
 * Numbers for the week page, the same rules as the app's week card: counted
 * from `GET /api/captures` (newest 200), so the page never shows capture
 * text, only counts. The app adds dictated seconds from its own voice log;
 * the web has no such log, so that cell is not part of this result.
 */
export interface WeekStats {
  year: number
  week: number
  /** Monday and Sunday of the week, `YYYY-MM-DD`. */
  weekStart: string
  weekEnd: string
  captures: number
  /** Distinct strands that received a capture this week. */
  strandsTouched: number
  /** Filed in the high band without a manual decision. */
  filedWithoutAsking: number
  /** Went through the review band or was decided by hand. */
  reviewed: number
  undone: number
  /** Captures per weekday, Monday first. */
  perDay: number[]
  /** Index of today in `perDay`. */
  todayIndex: number
  /** Strand ids touched this week, most recent first, at most six. */
  strandIds: string[]
  filedWithoutAskingPercent: number
}

const PLACED: ReadonlySet<Capture['status']> = new Set(['filed', 'needs_review', 'moved'])

/** The decision that speaks for a capture: part 0 of the newest round. */
export function currentDecision(captureId: string, decisions: readonly Decision[]): Decision | null {
  const own = decisions.filter(d => d.captureId === captureId)
  const live = own.filter(d => d.state !== 'superseded')
  const pool = live.length ? live : own
  const sorted = [...pool].sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0) || b.createdAt.localeCompare(a.createdAt))
  return sorted[0] ?? null
}

/** Keep or a manual choice: the user decided, not the router. */
export function userDecided(decision: Decision | null): boolean {
  return !!decision && (decision.model === 'user' || decision.state === 'confirmed')
}

export function weekStats(captures: readonly Capture[], decisions: readonly Decision[], nowMs: number, timeZone?: string): WeekStats {
  const today = dayKey(nowMs, timeZone)
  const todayIndex = weekdayIndex(today)
  const weekStart = addDays(today, -todayIndex)
  const weekEnd = addDays(weekStart, 6)
  const inWeek = captures
    .map(capture => ({ capture, ms: parseInstant(capture.createdAt) }))
    .filter((row): row is { capture: Capture; ms: number } => row.ms !== null)
    .map(row => ({ ...row, day: dayKey(row.ms, timeZone) }))
    .filter(row => row.day >= weekStart && row.day <= weekEnd)
    .sort((a, b) => b.ms - a.ms)
  const perDay = [0, 0, 0, 0, 0, 0, 0]
  for (const row of inWeek) perDay[weekdayIndex(row.day)]! += 1
  const filed = inWeek.filter(row => PLACED.has(row.capture.status))
  const strandIds = [...new Set(filed.map(row => row.capture.strandId).filter((id): id is string => !!id))]
  const auto = filed.filter(row => row.capture.status === 'filed' && !userDecided(currentDecision(row.capture.id, decisions))).length
  const reviewed = filed.length - auto
  const undone = inWeek.filter(row => row.capture.status === 'moved' || currentDecision(row.capture.id, decisions)?.state === 'undone').length
  const total = auto + reviewed
  const { year, week } = isoWeek(today)
  return {
    year,
    week,
    weekStart,
    weekEnd,
    captures: inWeek.length,
    strandsTouched: strandIds.length,
    filedWithoutAsking: auto,
    reviewed,
    undone,
    perDay,
    todayIndex,
    strandIds: strandIds.slice(0, 6),
    filedWithoutAskingPercent: total === 0 ? 0 : Math.round(auto * 100 / total),
  }
}

/** Which claim line the card shows; the copy lives in i18n (`week.claim.*`). */
export function weekClaim(stats: Pick<WeekStats, 'captures'>): 'none' | 'dayOneSingle' | 'dayOne' | 'many' {
  if (stats.captures === 0) return 'none'
  if (stats.captures === 1) return 'dayOneSingle'
  if (stats.captures < 3) return 'dayOne'
  return 'many'
}

/** Bar heights in percent of the tallest day, never below a visible stub. */
export function barHeights(perDay: readonly number[]): number[] {
  const max = Math.max(1, ...perDay)
  return perDay.map(value => Math.max(6, Math.round(value / max * 100)))
}
