/**
 * Boot diagnostics: records event-loop stalls during the server start so the
 * log shows where the boot holds the loop (and whether short network timeouts
 * started after `listen` still overlap a stall). Only timings are logged, no
 * payloads.
 *
 * A timer ticks every `intervalMs`; a tick that arrives more than
 * `thresholdMs` late means the loop was blocked for that long. The monitor
 * keeps the largest `maxReported` stalls and logs them once on `finish()`.
 */

export interface BootStall {
  /** How long the loop was blocked, in ms. */
  ms: number
  /** Wall-clock end of the stall (the first tick after it), ISO 8601. */
  endedAt: string
  /** True when the stall ended after `markListening()`. */
  afterListen: boolean
}

export interface BootStallMonitorOptions {
  intervalMs?: number
  thresholdMs?: number
  maxReported?: number
  now?: () => number
  logger?: Pick<typeof console, 'log'>
}

export interface BootStallMonitor {
  markListening: () => void
  /** Stop the timer and log the summary. Idempotent. */
  finish: () => BootStall[]
  stalls: () => BootStall[]
}

export const BOOT_STALL_INTERVAL_MS = 50
export const BOOT_STALL_THRESHOLD_MS = 500
/** After `listen` the monitor keeps watching this long, then logs. */
export const BOOT_STALL_AFTER_LISTEN_MS = 30_000

export function startBootStallMonitor(options: BootStallMonitorOptions = {}): BootStallMonitor {
  const intervalMs = options.intervalMs ?? BOOT_STALL_INTERVAL_MS
  const thresholdMs = options.thresholdMs ?? BOOT_STALL_THRESHOLD_MS
  const maxReported = options.maxReported ?? 5
  const now = options.now ?? (() => Date.now())
  const logger = options.logger ?? console
  const startedAt = now()
  let listenAt: number | null = null
  let last = startedAt
  let finished = false
  const recorded: BootStall[] = []

  const timer = setInterval(() => {
    const t = now()
    const late = t - last - intervalMs
    last = t
    if (late < thresholdMs) return
    recorded.push({ ms: Math.round(late), endedAt: new Date(t).toISOString(), afterListen: listenAt !== null })
    recorded.sort((a, b) => b.ms - a.ms)
    if (recorded.length > maxReported) recorded.length = maxReported
  }, intervalMs)
  timer.unref?.()

  return {
    markListening: () => {
      if (listenAt === null) listenAt = now()
    },
    stalls: () => [...recorded],
    finish: () => {
      if (finished) return [...recorded]
      finished = true
      clearInterval(timer)
      const readyMs = listenAt === null ? null : listenAt - startedAt
      const ready = readyMs === null ? 'not listening' : `listening after ${readyMs} ms`
      if (recorded.length === 0) {
        logger.log(`[boot] ${ready}; no event-loop stall >= ${thresholdMs} ms`)
      } else {
        const list = recorded
          .map(s => `${s.ms} ms ending ${s.endedAt}${s.afterListen ? ' (after listen)' : ''}`)
          .join(', ')
        logger.log(`[boot] ${ready}; event-loop stalls >= ${thresholdMs} ms: ${list}`)
      }
      return [...recorded]
    },
  }
}

/** Boot steps at or above this duration get one `[boot]` timing line. */
export const BOOT_STEP_LOG_THRESHOLD_MS = 250

/** Log one timing line for a boot step when it took long enough to matter. */
export function logBootStepDuration(
  logger: Pick<typeof console, 'log'>,
  label: string,
  ms: number,
  thresholdMs = BOOT_STEP_LOG_THRESHOLD_MS,
): void {
  if (ms >= thresholdMs) logger.log(`[boot] ${label} took ${Math.round(ms)} ms`)
}

/** Run a synchronous boot step and log its duration (see logBootStepDuration). Errors propagate unchanged. */
export function timeBootStep<T>(
  logger: Pick<typeof console, 'log'>,
  label: string,
  fn: () => T,
  thresholdMs = BOOT_STEP_LOG_THRESHOLD_MS,
): T {
  const startedAt = performance.now()
  try {
    return fn()
  } finally {
    logBootStepDuration(logger, label, performance.now() - startedAt, thresholdMs)
  }
}
