/**
 * task-progress-guard.ts: cheap, deterministic guards against a background
 * task that burns tokens without making progress (token audit 2026-09-17,
 * §"2 failed Tasks verbrannten 44,3 Mio Token ohne Ergebnis").
 *
 * Three independent guards, each disabled by setting its limit to 0
 * (`heuristics.taskGuard` in settings.json):
 *
 *  * **tool call cap** — a hard ceiling on tool calls per task run. The two
 *    runaway tasks in the audit made 176 and 279 calls; the default (300)
 *    sits above every task that ever *finished* and only catches the tail.
 *  * **repeated tool calls** — N consecutive calls with the same tool name
 *    AND byte-identical arguments. Unlike `loop-detection.ts` (which only
 *    fires on repeated *errors* and is opt-in via settings) this catches the
 *    "asks the same question forever" shape regardless of the result, and it
 *    is always on.
 *  * **token budget** — the summed *input* volume of the run
 *    (`input + cacheRead + cacheWrite`, i.e. what the provider bills as
 *    input). A task past this budget has demonstrably stopped converging.
 *
 * The guard only decides; aborting, failing the task row and writing an
 * honest error message is the runner's job. Every trip carries the numbers
 * that produced it so the failure message can name them.
 *
 * Deliberately NOT a heuristic about "new facts" or model output: those need
 * an LLM call (that is what `loopDetection.method='smart'` is for) and would
 * add cost to the very path we are trying to make cheap.
 */

/** Which guard tripped. Stable identifiers — they end up in failure messages. */
export type ProgressGuardKind = 'tool_call_cap' | 'repeated_tool_calls' | 'token_budget'

export interface ProgressGuardLimits {
  /** Hard ceiling on tool calls per task run. 0 disables. */
  maxToolCalls: number
  /** Consecutive identical (name + args) tool calls that count as stuck. 0 disables. */
  repeatedToolCalls: number
  /** Ceiling on summed input tokens (input + cacheRead + cacheWrite). 0 disables. */
  maxInputTokens: number
}

export interface ProgressGuardTrip {
  kind: ProgressGuardKind
  /** Honest, self-contained reason — goes verbatim into the task failure. */
  message: string
  /** The numbers behind the decision (logged as a metric row). */
  details: Record<string, unknown>
}

export interface ProgressGuardState {
  toolCalls: number
  inputTokens: number
  /** Length of the current run of identical consecutive tool calls. */
  repeatRun: number
  tripped: ProgressGuardTrip | null
}

/**
 * Deterministic serialization of tool arguments for identity comparison.
 * Keys are sorted so `{a:1,b:2}` and `{b:2,a:1}` are the same call. Returns
 * null when the value cannot be serialized (cycles, BigInt, …) — the caller
 * treats that as "unknown", which RESETS the run instead of extending it.
 * Conservative by construction: unknown never trips a guard.
 */
export function stableArgsSignature(args: unknown): string | null {
  try {
    return serialize(args, 0)
  } catch {
    return null
  }
}

const MAX_SIGNATURE_DEPTH = 12

function serialize(value: unknown, depth: number): string {
  if (depth > MAX_SIGNATURE_DEPTH) return '"…"'
  if (value === null || value === undefined) return 'null'
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return JSON.stringify(value)
  if (type === 'bigint' || type === 'function' || type === 'symbol') throw new Error('unserializable')
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item, depth + 1)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, depth + 1)}`).join(',')}}`
}

function preview(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Per-task-run guard state. One instance per running task; it lives on the
 * `RunningTask` entry and therefore survives a pause/resume with its agent.
 */
export class TaskProgressGuard {
  private readonly limits: ProgressGuardLimits
  private toolCalls = 0
  private inputTokens = 0
  private lastSignature: string | null = null
  private repeatRun = 0
  private trip: ProgressGuardTrip | null = null

  /**
   * `initial` seeds an already-spent budget (used on pause/resume, where the
   * task keeps its accumulated usage). Seeding never trips on its own — the
   * next recorded call or response decides.
   */
  constructor(limits: ProgressGuardLimits, initial?: { toolCalls?: number; inputTokens?: number }) {
    this.limits = {
      maxToolCalls: normalizeLimit(limits.maxToolCalls),
      repeatedToolCalls: normalizeLimit(limits.repeatedToolCalls),
      maxInputTokens: normalizeLimit(limits.maxInputTokens),
    }
    this.toolCalls = normalizeLimit(initial?.toolCalls ?? 0)
    this.inputTokens = normalizeLimit(initial?.inputTokens ?? 0)
  }

  /**
   * Record one finished tool call. Returns the trip that this call caused,
   * or null. Once tripped, later calls return null — the runner acts on the
   * first trip and tears the task down.
   */
  recordToolCall(toolName: string, args: unknown): ProgressGuardTrip | null {
    if (this.trip) return null

    this.toolCalls += 1

    const signature = stableArgsSignature(args)
    const key = signature === null ? null : `${toolName}\u0000${signature}`
    if (key !== null && key === this.lastSignature) {
      this.repeatRun += 1
    } else {
      this.lastSignature = key
      this.repeatRun = key === null ? 0 : 1
    }

    if (this.limits.repeatedToolCalls > 0 && this.repeatRun >= this.limits.repeatedToolCalls) {
      return this.setTrip({
        kind: 'repeated_tool_calls',
        message:
          `Progress guard: the task called "${toolName}" ${this.repeatRun} times in a row with identical arguments ` +
          `(${preview(signature ?? '')}) and is not making progress. Aborted after ${this.toolCalls} tool calls. ` +
          'No result was produced. Raise or disable `heuristics.taskGuard.repeatedToolCalls` if this repetition was intended.',
        details: { toolName, repeats: this.repeatRun, limit: this.limits.repeatedToolCalls, toolCalls: this.toolCalls },
      })
    }

    if (this.limits.maxToolCalls > 0 && this.toolCalls >= this.limits.maxToolCalls) {
      return this.setTrip({
        kind: 'tool_call_cap',
        message:
          `Progress guard: the task hit the tool call cap of ${this.limits.maxToolCalls} calls without finishing. ` +
          'No result was produced. Raise `heuristics.taskGuard.maxToolCalls` (or split the task) if it legitimately needs more steps.',
        details: { toolCalls: this.toolCalls, limit: this.limits.maxToolCalls, lastTool: toolName },
      })
    }

    return null
  }

  /**
   * Record the input volume of one model response (`input + cacheRead +
   * cacheWrite`). Returns the trip this pushed the task over, or null.
   */
  recordUsage(inputTokens: number): ProgressGuardTrip | null {
    if (this.trip) return null
    if (Number.isFinite(inputTokens) && inputTokens > 0) {
      this.inputTokens += inputTokens
    }

    if (this.limits.maxInputTokens > 0 && this.inputTokens >= this.limits.maxInputTokens) {
      return this.setTrip({
        kind: 'token_budget',
        message:
          `Progress guard: the task consumed ${this.inputTokens.toLocaleString('en-US')} input tokens ` +
          `(budget ${this.limits.maxInputTokens.toLocaleString('en-US')}, counted as input + cache read + cache write) without finishing. ` +
          'No result was produced. Raise `heuristics.taskGuard.maxInputTokens` if this task is genuinely that large.',
        details: { inputTokens: this.inputTokens, limit: this.limits.maxInputTokens, toolCalls: this.toolCalls },
      })
    }

    return null
  }

  getState(): ProgressGuardState {
    return {
      toolCalls: this.toolCalls,
      inputTokens: this.inputTokens,
      repeatRun: this.repeatRun,
      tripped: this.trip,
    }
  }

  private setTrip(trip: ProgressGuardTrip): ProgressGuardTrip {
    this.trip = trip
    return trip
  }
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}
