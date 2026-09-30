/**
 * heuristics.ts: every numeric heuristic is a configuration value (SPEC 12.1).
 *
 * The defaults are the constants the code carried before, so the change is
 * behaviour neutral on day one. Overrides live in `settings.json` under
 * `heuristics` and are read on every access so a settings edit takes
 * effect without a restart. A change of a default without a corpus run
 * (SPEC 12.3, `scripts/heuristics-regression.mjs`) is a regression by
 * definition.
 */

import { loadConfig } from './config.js'

export interface Heuristics {
  topicShift: {
    /** Jaccard overlap below this counts as a shift signal */
    jaccardThreshold: number
    /** Gap between messages that counts as a shift signal */
    timeGapMinutes: number
    /** Messages per sliding window (left / right) */
    windowSize: number
    /** Minimum messages before detection is active */
    minMessages: number
    /** Minimum qualifying tokens before detection is active */
    minTokens: number
  }
  factExtraction: {
    /** Word overlap above this is a duplicate */
    duplicateOverlap: number
    /** Maximum facts stored per session */
    maxFacts: number
  }
  factInjection: {
    /** Facts injected at strand start / topic shift */
    limit: number
  }
  sessionTail: {
    /** Verbatim messages carried from the previous session */
    messages: number
    /** Previous session must have been active within this window */
    freshnessHours: number
  }
  summary: {
    /** Sessions with fewer messages get a placeholder instead of a model call */
    minMessages: number
  }
  delegation: {
    /** A brief shorter than this that names no context is rejected (SPEC 10.8); 0 disables */
    minBriefChars: number
  }
  strand: {
    /** Token budget for the verbatim recency window of a strand turn (SPEC 11.3) */
    windowTokens: number
    /** Maximum digest lines for messages that fell out of the window */
    indexLines: number
    /** Maximum FTS hits pulled back verbatim per turn */
    retrievalHits: number
    /** Characters per retrieved message before it is cut (with its id kept) */
    retrievalChars: number
  }
  taskHistory: {
    /** Token budget for the verbatim window of a background task transcript */
    windowTokens: number
    /** A trim cuts back to this, so the next trim is far away (cache hysteresis) */
    targetTokens: number
    /** Maximum digest lines for task messages that fell out of the window */
    indexLines: number
  }
  toolOutput: {
    /** Characters of a read_file result that may reach the prompt */
    readFileMaxChars: number
    /** Characters of a shell result that may reach the prompt (head + tail) */
    shellMaxChars: number
  }
  recentMemory: {
    /** Characters of the `<recent_memory>` block in the system prompt */
    maxChars: number
    /** Daily files read for the full prompt profile (slim always uses 1) */
    days: number
    /** Warn when the raw dailies exceed maxChars by this factor; 0 disables */
    warnFactor: number
  }
  /**
   * Progress guards for background tasks (`task-progress-guard.ts`). Every
   * limit is a ceiling that fails the task with an honest message; 0 disables
   * that guard. Defaults are deliberately above every task that ever
   * finished — they only catch the runaway tail.
   */
  taskGuard: {
    /** Hard cap on tool calls per task run; 0 disables */
    maxToolCalls: number
    /** Consecutive identical (tool + args) calls that count as stuck; 0 disables */
    repeatedToolCalls: number
    /** Cap on summed input tokens (input + cache read + cache write); 0 disables */
    maxInputTokens: number
  }
  /**
   * Deadline awareness for background tasks (W5/P0). A task that hits its
   * hard `max_duration` is killed mid-thought and loses everything it had
   * not written down; the wrap-up signal gives it a chance to land the plane
   * itself. The hard abort stays as the fallback.
   */
  taskWrapUp: {
    /**
     * Fraction of the time budget after which the wrap-up message is
     * injected once. Values <= 0 or >= 1 disable the signal.
     */
    budgetFraction: number
    /**
     * Skip the signal when fewer than this many seconds remain between the
     * wrap-up point and the hard deadline — a wrap-up the task cannot act on
     * is just noise.
     */
    minLeadSeconds: number
  }
  taskDelivery: {
    /** Sweep period for undelivered task injections in seconds; 0 disables the sweep */
    sweepIntervalSeconds: number
    /** An injection attempted more recently than this counts as in flight */
    retryAfterSeconds: number
    /** Delivery attempts before an injection is abandoned; 0 disables the cap */
    maxAttempts: number
    /** Age after which an undelivered result is too stale to inject; 0 disables */
    maxAgeHours: number
    /** Injections re-delivered per sweep; 0 means no limit */
    batchLimit: number
    /** Running tasks listed in a restart notice; 0 disables restart notices */
    resumeNoticeMaxTasks: number
    /** Strands a single boot may wake with a restart notice */
    resumeMaxNotices: number
  }
  /**
   * Gates around the capture router (`capture-guards.ts`). Both values are
   * ceilings with an off switch at 0, and both were derived from real
   * misfilings in the live database rather than from taste.
   */
  captureGuards: {
    /**
     * A capture from the same client source within this window offers the
     * strand of its predecessor to the router as a hint; 0 disables the hint.
     */
    deviceAffinityMinutes: number
    /**
     * Longest capture, in characters, the filler gate will even look at. A
     * longer text always says something; 0 disables the gate.
     */
    fillerMaxChars: number
  }
}

export const DEFAULT_HEURISTICS: Heuristics = {
  topicShift: {
    jaccardThreshold: 0.25,
    timeGapMinutes: 30,
    windowSize: 3,
    minMessages: 5,
    minTokens: 200,
  },
  factExtraction: {
    duplicateOverlap: 0.7,
    maxFacts: 10,
  },
  factInjection: {
    limit: 5,
  },
  sessionTail: {
    messages: 5,
    freshnessHours: 12,
  },
  summary: {
    minMessages: 3,
  },
  delegation: {
    minBriefChars: 200,
  },
  strand: {
    windowTokens: 24000,
    indexLines: 60,
    retrievalHits: 5,
    retrievalChars: 1200,
  },
  taskHistory: {
    windowTokens: 60000,
    targetTokens: 30000,
    indexLines: 60,
  },
  toolOutput: {
    readFileMaxChars: 20000,
    shellMaxChars: 30000,
  },
  recentMemory: {
    maxChars: 8000,
    days: 3,
    warnFactor: 3,
  },
  taskGuard: {
    maxToolCalls: 300,
    repeatedToolCalls: 5,
    maxInputTokens: 30_000_000,
  },
  taskWrapUp: {
    budgetFraction: 0.8,
    minLeadSeconds: 60,
  },
  taskDelivery: {
    sweepIntervalSeconds: 90,
    retryAfterSeconds: 300,
    maxAttempts: 5,
    maxAgeHours: 24,
    batchLimit: 5,
    resumeNoticeMaxTasks: 5,
    resumeMaxNotices: 5,
  },
  captureGuards: {
    deviceAffinityMinutes: 10,
    fillerMaxChars: 80,
  },
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function mergeGroup<T extends Record<string, number>>(defaults: T, override: DeepPartial<T> | undefined): T {
  const out = { ...defaults }
  if (!override || typeof override !== 'object') return out
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const v = (override as Record<string, unknown>)[key as string]
    if (isFiniteNumber(v) && v >= 0) (out as Record<string, number>)[key as string] = v
  }
  return out
}

/** Merge a partial override into the defaults. Non numeric or negative values are ignored. */
export function resolveHeuristics(override: DeepPartial<Heuristics> | undefined): Heuristics {
  return {
    topicShift: mergeGroup(DEFAULT_HEURISTICS.topicShift, override?.topicShift),
    factExtraction: mergeGroup(DEFAULT_HEURISTICS.factExtraction, override?.factExtraction),
    factInjection: mergeGroup(DEFAULT_HEURISTICS.factInjection, override?.factInjection),
    sessionTail: mergeGroup(DEFAULT_HEURISTICS.sessionTail, override?.sessionTail),
    summary: mergeGroup(DEFAULT_HEURISTICS.summary, override?.summary),
    delegation: mergeGroup(DEFAULT_HEURISTICS.delegation, override?.delegation),
    strand: mergeGroup(DEFAULT_HEURISTICS.strand, override?.strand),
    taskHistory: mergeGroup(DEFAULT_HEURISTICS.taskHistory, override?.taskHistory),
    toolOutput: mergeGroup(DEFAULT_HEURISTICS.toolOutput, override?.toolOutput),
    recentMemory: mergeGroup(DEFAULT_HEURISTICS.recentMemory, override?.recentMemory),
    taskGuard: mergeGroup(DEFAULT_HEURISTICS.taskGuard, override?.taskGuard),
    taskWrapUp: mergeGroup(DEFAULT_HEURISTICS.taskWrapUp, override?.taskWrapUp),
    taskDelivery: mergeGroup(DEFAULT_HEURISTICS.taskDelivery, override?.taskDelivery),
    captureGuards: mergeGroup(DEFAULT_HEURISTICS.captureGuards, override?.captureGuards),
  }
}

let testOverride: DeepPartial<Heuristics> | null = null

/** Test hook: pin an override without touching settings.json. Pass null to clear. */
export function setHeuristicsOverrideForTests(override: DeepPartial<Heuristics> | null): void {
  testOverride = override
}

/** Read the effective heuristics (settings.json `heuristics` block over the defaults). */
export function loadHeuristics(): Heuristics {
  if (testOverride) return resolveHeuristics(testOverride)
  try {
    const settings = loadConfig<{ heuristics?: DeepPartial<Heuristics> }>('settings.json')
    return resolveHeuristics(settings.heuristics)
  } catch {
    return resolveHeuristics(undefined)
  }
}
