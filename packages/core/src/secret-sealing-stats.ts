/**
 * Sealing telemetry (S0-A / A2, UX report 2026-10-23 § 6.3 proposal 4).
 *
 * Counts how often the secret boundary replaced something, per index entry and
 * per turn, so an entry with hundreds of hits stands out (the project word
 * `offtangent` in the fence instructions, a shell placeholder sealed as a
 * `vw-session-*` value). Counters only — never a value, never message text:
 *
 * - a sealed handle is keyed by its handle text (`{{secret:vw-session-20}}`),
 *   which is what the agent already sees;
 * - an opaque value (no handle) is keyed by its source plus the first eight
 *   hex characters of an HMAC-SHA-256 under a per-process random salt
 *   (`redacted:env:1a2b3c4d`), enough to tell entries apart, useless to
 *   reconstruct a value and not checkable offline against a word list.
 *
 * Both maps are bounded ({@link SEALING_MAX_ENTRIES}): the least recently
 * counted entry goes first, so a flood of distinct values cannot grow memory.
 *
 * Per-turn attribution uses an `AsyncLocalStorage` scope that the runtime opens
 * around one prompt; everything the agent does inside it (context transform,
 * tool calls, sealing of results) lands in that scope. Counts outside any scope
 * (web-backend message persistence, system prompt assembly) still go into the
 * process totals.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface SealingScope {
  /** Free label for the log line, e.g. `agent=main session=web-…`. */
  label: string
  /** Replacements per entry key inside this scope. */
  counts: Map<string, number>
  total: number
}

export interface SealingEntryStat {
  entry: string
  count: number
}

export interface SealingTurnStat {
  label: string
  at: string
  total: number
  top: SealingEntryStat[]
}

export interface SealingStatsSnapshot {
  since: string
  total: number
  entries: SealingEntryStat[]
  recentTurns: SealingTurnStat[]
}

/** How many entries a turn log line names (highest counts first). */
export const SEALING_LOG_TOP_ENTRIES = 5

/** How many finished turns the snapshot keeps for the admin view. */
export const SEALING_RECENT_TURNS = 50

/**
 * A single entry with at least this many replacements in one turn is logged
 * as a warning: that is not a credential, that is a word.
 */
export const SEALING_HOT_ENTRY_THRESHOLD = 25

/**
 * Upper bound of distinct entries in the process counters and in one turn
 * scope (review S0-A / A2). On overflow the least recently counted entry is
 * dropped; `total` keeps counting.
 */
export const SEALING_MAX_ENTRIES = 500

const storage = new AsyncLocalStorage<SealingScope>()

/** Add to a bounded counter map; re-inserting keeps insertion order = recency. */
function bump(counts: Map<string, number>, entry: string, count: number): void {
  const current = counts.get(entry)
  if (current !== undefined) counts.delete(entry)
  counts.set(entry, (current ?? 0) + count)
  while (counts.size > SEALING_MAX_ENTRIES) {
    const oldest = counts.keys().next().value
    if (oldest === undefined) break
    counts.delete(oldest)
  }
}

let since = new Date().toISOString()
let processTotal = 0
const processCounts = new Map<string, number>()
const recentTurns: SealingTurnStat[] = []

/** Record `count` replacements of `entry` (process totals and the current turn scope). */
export function recordSealing(entry: string, count = 1): void {
  if (count <= 0) return
  processTotal += count
  bump(processCounts, entry, count)
  const scope = storage.getStore()
  if (scope) {
    scope.total += count
    bump(scope.counts, entry, count)
  }
}

/** Create an empty scope; pass it to {@link runInSealingScope}. */
export function createSealingScope(label: string): SealingScope {
  return { label, counts: new Map(), total: 0 }
}

/** Run `fn` with `scope` as the turn scope of every async continuation it starts. */
export function runInSealingScope<T>(scope: SealingScope, fn: () => T): T {
  return storage.run(scope, fn)
}

function topEntries(counts: Map<string, number>, limit: number): SealingEntryStat[] {
  return [...counts.entries()]
    .map(([entry, count]) => ({ entry, count }))
    .sort((a, b) => b.count - a.count || a.entry.localeCompare(b.entry))
    .slice(0, limit)
}

/**
 * Close a turn scope: keep it for the admin view and return the log line, or
 * `null` when nothing was replaced. The caller decides where to log.
 */
export function finishSealingScope(scope: SealingScope): { line: string; hot: boolean } | null {
  if (scope.total === 0) return null
  const top = topEntries(scope.counts, SEALING_LOG_TOP_ENTRIES)
  recentTurns.push({ label: scope.label, at: new Date().toISOString(), total: scope.total, top })
  if (recentTurns.length > SEALING_RECENT_TURNS) recentTurns.splice(0, recentTurns.length - SEALING_RECENT_TURNS)
  const hot = top.some(entry => entry.count >= SEALING_HOT_ENTRY_THRESHOLD)
  const entries = top.map(entry => `${entry.entry}=${entry.count}`).join(' ')
  return {
    line: `[secret-boundary] sealing per turn (${scope.label}): replacements=${scope.total} entries=${scope.counts.size} top: ${entries}`,
    hot,
  }
}

/** Process-lifetime counters plus the last turns, for the admin route. */
export function sealingStatsSnapshot(limit = 100): SealingStatsSnapshot {
  return {
    since,
    total: processTotal,
    entries: topEntries(processCounts, limit),
    recentTurns: [...recentTurns].reverse(),
  }
}

/** Reset every counter (tests). */
export function resetSealingStats(): void {
  since = new Date().toISOString()
  processTotal = 0
  processCounts.clear()
  recentTurns.length = 0
}
