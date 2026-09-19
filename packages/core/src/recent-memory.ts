/**
 * recent-memory.ts: character budget for the `<recent_memory>` block.
 *
 * The daily memory notes were injected into the system prompt in full and
 * without any limit (`readRecentDailyFiles()`), which the token audit of
 * 2026-09-17 measured at up to 85k tokens of *fixed* cost per turn (largest
 * observed 3-day window: 188.108 chars). This module packs the dailies into a
 * character budget instead.
 *
 * Rules (deliberately conservative):
 * - Newest day first. Older days are cut before newer ones.
 * - Within a day, the *end* of the file survives: `appendToDailyFile()` writes
 *   chronologically, so the tail holds the most recent notes.
 * - Every cut leaves an honest marker naming the file that was cut, so the
 *   agent can `read_file` the full notes instead of silently losing them.
 * - Nothing is dropped when everything fits: the returned text is then
 *   byte-identical to the unbudgeted join.
 */

/** One daily memory file, already read from disk. */
export interface DailyMemoryEntry {
  /** ISO day (`YYYY-MM-DD`) the file belongs to. */
  date: string
  /** Absolute path of the daily file (used in truncation markers). */
  path: string
  /** Trimmed file content. */
  content: string
}

export interface RecentMemoryBudgetOptions {
  /** Character budget for the whole block. Values <= 0 disable budgeting. */
  maxChars: number
  /** Directory holding the daily files, named in the "omitted" marker. */
  dailyDir: string
  /** Warn when the raw size exceeds `maxChars * warnFactor`. 0 disables. */
  warnFactor?: number
  /** Injectable logger (tests). */
  logger?: Pick<Console, 'warn'>
}

export interface RecentMemoryBudgetResult {
  /** The text to inject between the `<recent_memory>` tags. */
  text: string
  /** Raw size of all dailies before budgeting. */
  rawChars: number
  /** Whether anything was cut. */
  truncated: boolean
  /** Characters of daily content that did not make it into `text`. */
  droppedChars: number
  /** Number of daily files that were dropped completely. */
  droppedFiles: number
}

/** Separator between two daily files — unchanged from `readRecentDailyFiles()`. */
export const DAILY_SEPARATOR = '\n\n---\n\n'

/**
 * Space kept free for the truncation markers once budgeting kicks in, so the
 * rendered block stays within `maxChars` including the markers themselves.
 */
const MARKER_RESERVE = 400

/** A partial day shorter than this is not worth injecting — drop it instead. */
const MIN_PARTIAL_CHARS = 400

function truncationMarker(chars: number, filePath: string): string {
  return `[truncated: ${chars} older chars of this day — read ${filePath} for the full notes]`
}

function omissionMarker(entries: DailyMemoryEntry[], dailyDir: string): string {
  const days = entries.map(e => e.date).join(', ')
  return `[omitted: ${entries.length} older daily file(s) (${days}) — read them under ${dailyDir} for the full notes]`
}

/**
 * Pack the daily entries (newest first) into a character budget.
 *
 * Returns the unchanged join when everything fits, so the normal case costs
 * nothing and stays byte-identical to the previous behaviour.
 */
export function budgetRecentMemory(
  entries: DailyMemoryEntry[],
  options: RecentMemoryBudgetOptions,
): RecentMemoryBudgetResult {
  const usable = entries.filter(e => e.content.length > 0)
  const rawChars = usable.reduce((sum, e) => sum + e.content.length, 0)
    + Math.max(0, usable.length - 1) * DAILY_SEPARATOR.length

  const empty: RecentMemoryBudgetResult = {
    text: '',
    rawChars: 0,
    truncated: false,
    droppedChars: 0,
    droppedFiles: 0,
  }
  if (usable.length === 0) return empty

  const maxChars = options.maxChars
  const unbudgeted: RecentMemoryBudgetResult = {
    text: usable.map(e => e.content).join(DAILY_SEPARATOR),
    rawChars,
    truncated: false,
    droppedChars: 0,
    droppedFiles: 0,
  }

  // Size guard: a block far above its budget means memory consolidation is not
  // running (or a single day exploded). Warn once per assembly — this is cheap
  // and the only signal that would otherwise be invisible.
  const warnFactor = options.warnFactor ?? 0
  if (warnFactor > 0 && maxChars > 0 && rawChars > maxChars * warnFactor) {
    const logger = options.logger ?? console
    logger.warn(
      `[recent-memory] daily notes are ${rawChars} chars, ${(rawChars / maxChars).toFixed(1)}x the ${maxChars}-char budget `
      + `(${usable.length} file(s) under ${options.dailyDir}) — consolidation is likely not running.`,
    )
  }

  if (!Number.isFinite(maxChars) || maxChars <= 0) return unbudgeted
  if (rawChars <= maxChars) return unbudgeted

  const contentBudget = maxChars - MARKER_RESERVE
  const kept: string[] = []
  const dropped: DailyMemoryEntry[] = []
  let used = 0
  let droppedChars = 0

  for (const entry of usable) {
    if (dropped.length > 0) {
      // Once a day was dropped, every older day is dropped too — the order is
      // newest first, so we never skip a day and keep an older one.
      dropped.push(entry)
      droppedChars += entry.content.length
      continue
    }

    const separatorCost = kept.length > 0 ? DAILY_SEPARATOR.length : 0
    const available = contentBudget - used - separatorCost

    if (available >= entry.content.length) {
      kept.push(entry.content)
      used += separatorCost + entry.content.length
      continue
    }

    const marker = truncationMarker(entry.content.length, entry.path)
    const sliceChars = available - marker.length - 1
    if (sliceChars >= MIN_PARTIAL_CHARS) {
      // Keep the END of the file: daily notes are appended chronologically,
      // so the tail carries the most recent entries of that day.
      const slice = entry.content.slice(entry.content.length - sliceChars)
      const partial = `${truncationMarker(entry.content.length - sliceChars, entry.path)}\n${slice}`
      kept.push(partial)
      used += separatorCost + partial.length
      droppedChars += entry.content.length - sliceChars
    } else {
      dropped.push(entry)
      droppedChars += entry.content.length
    }
  }

  const parts = [...kept]
  if (dropped.length > 0) parts.push(omissionMarker(dropped, options.dailyDir))

  return {
    text: parts.join(DAILY_SEPARATOR),
    rawChars,
    truncated: true,
    droppedChars,
    droppedFiles: dropped.length,
  }
}
