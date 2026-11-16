/**
 * task-budget.ts: one wrap-up for three budgets, and a handoff when a run is
 * cut off anyway (S0-A / A3, UX report 2026-10-23 § 6.1).
 *
 * Before: the wrap-up signal was purely time based (`task-wrap-up.ts`), while
 * the progress guard (`task-progress-guard.ts`) aborted at the tool-call cap
 * or the input-token budget without any warning and left "No result was
 * produced" as the task result. A task that ran out of tool calls at minute
 * 40 of 120 never saw a warning and lost every finding it had not written
 * down.
 *
 * Now:
 *  - `firstBudgetCrossing` decides, for the three budgets (time, tool calls,
 *    input tokens), whether the warning point (default 80 %) is reached and
 *    which budget got there first. The runner sends ONE warning per run — the
 *    first budget that crosses wins, the others stay quiet.
 *  - `buildBudgetWarningMessage` names that budget and makes an interim state
 *    mandatory (HANDOFF section), not optional.
 *  - `TaskActivityLog` keeps value-free metadata of the run: the last few
 *    calls (tool name, time, ok/error), the call count per tool and the
 *    written file paths under the shown roots. `buildAbortHandoff` turns that
 *    into a HANDOFF section that becomes the task result on a hard abort.
 *
 * No I/O, no LLM call. Privacy (S0-A second review): the activity log never
 * collects tool arguments or results, so neither a registered nor an
 * unregistered value can reach the runner-built HANDOFF.
 */

export type BudgetKind = 'time' | 'tool_calls' | 'input_tokens'

export interface BudgetUsage {
  used: number
  /** 0 (or any non-positive / non-finite value) = this budget is disabled. */
  limit: number
}

export interface BudgetCrossing {
  kind: BudgetKind
  used: number
  limit: number
  /** used / limit at the moment of the check. */
  ratio: number
}

/** Order in which simultaneous crossings are reported (most specific first). */
const KIND_ORDER: readonly BudgetKind[] = ['tool_calls', 'input_tokens', 'time']

/**
 * The budget that has reached `fraction` of its limit, or null.
 *
 * When several budgets are past the point at the same check, the one with
 * the highest ratio wins (it is the one that will end the run first); ties
 * follow `KIND_ORDER`. A `fraction` outside (0, 1) disables the warning.
 */
export function firstBudgetCrossing(
  budgets: Partial<Record<BudgetKind, BudgetUsage>>,
  fraction: number,
): BudgetCrossing | null {
  if (!(fraction > 0) || fraction >= 1) return null
  let best: BudgetCrossing | null = null
  for (const kind of KIND_ORDER) {
    const budget = budgets[kind]
    if (!budget) continue
    const { used, limit } = budget
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used) || used < 0) continue
    const ratio = used / limit
    if (ratio < fraction) continue
    if (!best || ratio > best.ratio) best = { kind, used, limit, ratio }
  }
  return best
}

const KIND_LABEL: Record<BudgetKind, string> = {
  time: 'time budget',
  tool_calls: 'tool call budget',
  input_tokens: 'input token budget',
}

function formatAmount(kind: BudgetKind, value: number): string {
  if (kind === 'time') return `${Math.round(value / 60_000)} min`
  if (kind === 'tool_calls') return `${Math.round(value)} calls`
  return `${Math.round(value).toLocaleString('en-US')} tokens`
}

/**
 * The warning for a tool-call or token crossing. Same envelope as the time
 * wrap-up (`<time_budget_warning>`) so the system prompt's instruction ("when
 * a <time_budget_warning> arrives, stop starting new work") covers it too.
 */
export function buildBudgetWarningMessage(crossing: BudgetCrossing): string {
  const label = KIND_LABEL[crossing.kind]
  const percent = Math.round(crossing.ratio * 100)
  return `<time_budget_warning budget="${crossing.kind}">
Your ${label} is ${percent} % used (${formatAmount(crossing.kind, crossing.used)} of ${formatAmount(crossing.kind, crossing.limit)}). The run is aborted when it is exhausted. Start NO new work now.
1. Write your interim state NOW, before anything else: a HANDOFF section (goal, what is done, what is open, current error, exact next step) — into a file you already work in, or into your final message.
2. Bring the work in progress to a consistent state (finish or revert the current edit, commit what is done).
3. Report gate/test/build status honestly — never claim a check is green that did not run or that failed.
4. Then deliver your final STATUS/SUMMARY answer immediately.
</time_budget_warning>`
}

/** Tools whose `path` argument is a file the run wrote. */
const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

/**
 * Roots under which a written path may appear in the abort HANDOFF (S0-A,
 * second review, decision by main). Anything outside is withheld entirely.
 */
// Installations needing an additional storage root may opt in without baking
// a private mount into the public source. Never accept a filesystem root.
const additionalHandoffRoot = process.env.OFFTANGENT_HANDOFF_PATH_ROOT
const configuredHandoffRoot = additionalHandoffRoot && /^\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+$/.test(additionalHandoffRoot)
  && !additionalHandoffRoot.split('/').some(segment => segment === '..' || segment === '.')
  ? additionalHandoffRoot : null
export const HANDOFF_PATH_ROOTS: readonly string[] = [
  '/workspace', '/mnt/workspace', '/data/memory',
  ...(configuredHandoffRoot ? [configuredHandoffRoot] : []),
]

/** 16 or more alphanumerics without a separator: may be a token, never published. */
const TOKEN_RUN_RE = /[A-Za-z0-9]{16,}/

/**
 * S0-A third review: a run of 12+ alphanumerics that contains a digit looks
 * like a generated value (token, id, hash) and is never published.
 */
export function hasTokenLikeRun(text: string): boolean {
  if (TOKEN_RUN_RE.test(text)) return true
  for (const run of text.match(/[A-Za-z0-9]{12,}/g) ?? []) {
    if (/[0-9]/.test(run)) return true
  }
  return false
}

/** Shape of a tool name the HANDOFF may repeat; anything else becomes `other_tool`. */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/

/**
 * A tool name as the HANDOFF may show it. Tool names come from the model's
 * tool call; a name that is not a plain identifier, that carries a
 * token-like run, or (when the run's registered tools are known) that is not
 * one of them, is reduced to the constant `other_tool`.
 */
export function handoffToolName(name: unknown, knownTools?: ReadonlySet<string> | null): string {
  if (typeof name !== 'string' || !TOOL_NAME_RE.test(name) || hasTokenLikeRun(name)) return 'other_tool'
  // REVIEW-S0-A-4: a known but empty set means "no tools registered", so
  // every name is foreign; only `null`/`undefined` (registry unknown, unit
  // tests) skips the membership check.
  if (knownTools && !knownTools.has(name)) return 'other_tool'
  return name
}

/** Part below the root that may be shown: at most this many segments … */
const MAX_SHOWN_SEGMENTS = 3
/** … and at most this many characters (S0-A third review, decision by main). */
const MAX_SHOWN_CHARS = 48
/** Characters a shown path may consist of; anything else shows the root only. */
const SHOWN_PATH_RE = /^[A-Za-z0-9._\-/]+$/

/**
 * S0-A third review (blocking): the path of a written file as the HANDOFF
 * may show it, or null when it must be withheld.
 *
 *  - Only absolute paths under {@link HANDOFF_PATH_ROOTS} are shown at all;
 *    a path containing a `..` segment is withheld (no normalisation games).
 *  - The check covers the WHOLE part below the root, not single segments: it
 *    may have at most 3 segments and 48 characters, consist of
 *    `[A-Za-z0-9._-/]` only and nowhere contain a run of 12+ alphanumerics
 *    with a digit. Otherwise only the root is shown (`/workspace/`), so a
 *    value split over several short segments never comes through.
 */
export function handoffPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/') || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  const segments: string[] = []
  for (const seg of trimmed.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null
    segments.push(seg)
  }
  const normalized = `/${segments.join('/')}`
  const root = HANDOFF_PATH_ROOTS.find(r => normalized === r || normalized.startsWith(`${r}/`))
  if (!root) return null
  const rootDepth = root.split('/').filter(Boolean).length
  const below = segments.slice(rootDepth)
  if (below.length === 0) return root
  const rest = below.join('/')
  const ok = below.length <= MAX_SHOWN_SEGMENTS
    && rest.length <= MAX_SHOWN_CHARS
    && SHOWN_PATH_RE.test(rest)
    && !hasTokenLikeRun(rest)
  return ok ? `${root}/${rest}` : `${root}/`
}

/**
 * S0-A third review, decision by main: the runner-built part of an abort
 * HANDOFF names WHY a run ended only as one of these codes, never as free
 * text (exception messages, guard messages, abort reasons can carry
 * arguments, paths, URLs with tokens or steering text).
 */
export const HANDOFF_ERROR_CLASSES = [
  'timeout',
  'tool_call_budget',
  'token_budget',
  'repeated_call',
  'loop_detected',
  'provider_error',
  'cancelled',
  'unknown',
] as const
export type HandoffErrorClass = typeof HANDOFF_ERROR_CLASSES[number]

/**
 * Map a runner-side reason or error text onto {@link HANDOFF_ERROR_CLASSES}.
 * The text itself is only read here, never returned.
 */
export function classifyHandoffError(text: unknown): HandoffErrorClass {
  if (typeof text !== 'string' || text.length === 0) return 'unknown'
  if (/tool call cap/i.test(text)) return 'tool_call_budget'
  if (/token budget|input tokens/i.test(text)) return 'token_budget'
  if (/loop detected/i.test(text)) return 'loop_detected'
  if (/identical arguments|repeated/i.test(text)) return 'repeated_call'
  if (/max(imum)? duration|timed? ?out|ETIMEDOUT/i.test(text)) return 'timeout'
  if (/provider|rate.?limit|overloaded|api key|unauthori[sz]ed|forbidden|\b(?:401|403|429|5\d\d)\b|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|stopReason|model/i.test(text)) return 'provider_error'
  if (/abort|cancel|killed|stopped|restart/i.test(text)) return 'cancelled'
  return 'unknown'
}

/** Map a progress-guard trip kind onto the vocabulary. */
export function guardTripErrorClass(kind: string): HandoffErrorClass {
  if (kind === 'tool_call_cap') return 'tool_call_budget'
  if (kind === 'token_budget') return 'token_budget'
  if (kind === 'repeated_tool_calls') return 'repeated_call'
  return 'unknown'
}

/**
 * One tool call as the abort HANDOFF records it: metadata only. There is
 * deliberately NO field for arguments or results (S0-A second review: a
 * value that is not in the known-value index cannot be sealed after the
 * fact, so it must never be collected).
 */
export interface ActivityEntry {
  toolName: string
  /** Epoch milliseconds when the result arrived. */
  at: number
  isError: boolean
}

export interface ToolCallCount {
  toolName: string
  calls: number
  errors: number
}

/**
 * Rolling record of what a task run did, value-free by construction: the
 * last `maxEntries` calls (tool name, time, ok/error), the call count per
 * tool and the shown form ({@link handoffPath}) of the files it wrote.
 */
export class TaskActivityLog {
  private readonly entries: ActivityEntry[] = []
  private readonly counts = new Map<string, ToolCallCount>()
  private readonly written: string[] = []
  private withheld = 0

  constructor(
    private readonly maxEntries = 8,
    private readonly maxPaths = 40,
    private readonly maxTools = 64,
    knownTools?: Iterable<string> | null,
  ) {
    this.knownTools = knownTools ? new Set(knownTools) : null
  }

  /** Registered tool names of the run; other names show as `other_tool`. */
  private readonly knownTools: ReadonlySet<string> | null

  /**
   * REVIEW-S0-A-4: the registered tool set, so a log re-created after a
   * pause/resume keeps checking against the same tools (null = unknown).
   */
  registeredTools(): string[] | null {
    return this.knownTools ? [...this.knownTools] : null
  }

  /** `result` is accepted for call-site compatibility and never read. */
  record(toolName: string, args: unknown, _result: unknown, isError: boolean, at: number = Date.now()): void {
    const name = handoffToolName(toolName, this.knownTools)
    this.entries.push({ toolName: name, at, isError: !!isError })
    if (this.entries.length > this.maxEntries) this.entries.shift()

    const count = this.counts.get(name) ?? (this.counts.size < this.maxTools ? { toolName: name, calls: 0, errors: 0 } : null)
    if (count) {
      count.calls++
      if (isError) count.errors++
      this.counts.set(name, count)
    }

    if (WRITE_TOOLS.has(toolName) && !isError && args && typeof args === 'object') {
      const shown = handoffPath((args as { path?: unknown }).path)
      if (shown === null) {
        this.withheld++
      } else if (!this.written.includes(shown) && this.written.length < this.maxPaths) {
        this.written.push(shown)
      }
    }
  }

  recent(): readonly ActivityEntry[] {
    return this.entries
  }

  toolCounts(): readonly ToolCallCount[] {
    return [...this.counts.values()]
  }

  writtenPaths(): readonly string[] {
    return this.written
  }

  /** Successful writes whose path is outside the shown roots. */
  withheldWrites(): number {
    return this.withheld
  }
}

export interface AbortHandoffInput {
  /** Why the run was cut off, as a code of the closed vocabulary (never free text). */
  errorClass: HandoffErrorClass
  /** Task id, the only identity the HANDOFF repeats (no free-text name). */
  taskId: string
  toolCalls: number
  activity: TaskActivityLog
  /** Whether the budget warning had been delivered before the abort. */
  warned: boolean
}

/** First words of every runner-built abort result; the error class follows. */
export const ABORT_HANDOFF_HEAD = 'Task aborted by the runner, error class:'

/** Absolute cap of the runner-built abort result (review S0-A § 3). */
export const MAX_ABORT_HANDOFF_CHARS = 8000

/** Fixed hint: the real interim state comes from the model, not from here. */
export const ABORT_HANDOFF_WRAPUP_NOTE = 'The actual interim state is written by the model itself in the wrap-up step (budget warning): look for the HANDOFF it wrote into its working files or its last message. This runner section only lists value-free metadata.'

/**
 * The task result for a hard abort: the reason plus a HANDOFF section with
 * value-free metadata only (tool names, call counts, timestamps, ok/error,
 * written paths under the shown roots). No argument heads, no result
 * previews, no free text from tool input or output (S0-A second review).
 * `extractHandoffSection` recognises the `HANDOFF:` opener, so the persisted
 * handoff and a `continuation_of` successor get the same text. The runner
 * still seals the whole text afterwards (`TaskRunner.abortSummary`).
 */
export function buildAbortHandoff(input: AbortHandoffInput): string {
  const { activity } = input
  const lines: string[] = []
  lines.push(`${ABORT_HANDOFF_HEAD} ${HANDOFF_ERROR_CLASSES.includes(input.errorClass) ? input.errorClass : 'unknown'}`)
  lines.push('')
  lines.push('HANDOFF:')
  lines.push(`Goal: see the prompt of task ${input.taskId}.`)
  lines.push(`State: aborted by the runner after ${input.toolCalls} tool calls${input.warned ? ' (the budget warning had been sent)' : ' (no budget warning reached the agent before the abort)'}. This handoff was generated by the runner, not written by the agent.`)
  lines.push(ABORT_HANDOFF_WRAPUP_NOTE)

  const paths = activity.writtenPaths()
  const withheld = activity.withheldWrites()
  lines.push('')
  lines.push('Files written in this run:')
  if (paths.length === 0 && withheld === 0) lines.push('- none recorded')
  for (const p of paths) lines.push(`- ${p}`)
  if (withheld > 0) lines.push(`- ${withheld} write(s) outside the shown roots (paths withheld)`)

  const counts = activity.toolCounts()
  lines.push('')
  lines.push('Tool calls per tool:')
  if (counts.length === 0) lines.push('- none recorded')
  for (const c of counts) lines.push(`- ${c.toolName}: ${c.calls} call(s), ${c.errors} error(s)`)

  const recent = activity.recent()
  lines.push('')
  lines.push(`Last ${recent.length} tool calls (oldest first):`)
  if (recent.length === 0) lines.push('- none recorded')
  for (const entry of recent) {
    lines.push(`- ${new Date(entry.at).toISOString()} ${entry.toolName} ${entry.isError ? 'error' : 'ok'}`)
  }

  lines.push('')
  lines.push('Open: everything the task prompt asks for that the files above do not show as done.')
  lines.push('Next step: start a successor with `continuation_of` this task id; verify the written files first, then continue from the HANDOFF the model wrote.')
  const text = lines.join('\n')
  return text.length > MAX_ABORT_HANDOFF_CHARS ? `${text.slice(0, MAX_ABORT_HANDOFF_CHARS)}…` : text
}
