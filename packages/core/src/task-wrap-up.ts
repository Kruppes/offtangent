/**
 * task-wrap-up.ts: deadline awareness for background tasks (W5/P0).
 *
 * Before this, a task that reached `max_duration` was killed mid-thought by
 * `abortTask('Max duration exceeded')`: no summary, no commit, no handoff —
 * everything it had not written to disk was lost, and the main agent got a
 * bare "failed" line.
 *
 * The fix is deliberately small: at `budgetFraction` of the time budget the
 * runner steers ONE message into the task agent's context ("your budget is
 * nearly gone, land the plane"). The hard abort at 100 % stays exactly as it
 * was — this only gives the task a chance to finish itself first.
 *
 * Pure functions here, timers in the runner (`scheduleMaxDurationTimeout`).
 */

export interface WrapUpScheduleInput {
  /** Effective budget in minutes (per-task limit or runner default). */
  budgetMinutes: number
  /** Milliseconds left until the hard deadline, as the runner computed it. */
  remainingMs: number
  /** `heuristics.taskWrapUp.budgetFraction` (<= 0 or >= 1 disables). */
  budgetFraction: number
  /** `heuristics.taskWrapUp.minLeadSeconds`. */
  minLeadSeconds: number
}

export interface WrapUpSchedule {
  /** Delay from now until the wrap-up message, in ms. */
  delayMs: number
  /** Minutes left at that point (for the message text). */
  remainingMinutesAtWrapUp: number
}

/**
 * When to inject the wrap-up message, or null when it should be skipped.
 *
 * Skipped when the feature is disabled, when the wrap-up point has already
 * passed (e.g. a task resumed deep into its budget — the hard deadline is
 * close enough that a signal would only burn a turn), or when the lead time
 * to the hard abort is below `minLeadSeconds`.
 */
export function planWrapUp(input: WrapUpScheduleInput): WrapUpSchedule | null {
  const { budgetMinutes, remainingMs, budgetFraction, minLeadSeconds } = input
  if (!(budgetFraction > 0) || budgetFraction >= 1) return null
  if (!(budgetMinutes > 0) || !(remainingMs > 0)) return null

  const budgetMs = budgetMinutes * 60_000
  const elapsedMs = budgetMs - remainingMs
  const wrapUpAtMs = budgetMs * budgetFraction
  const delayMs = wrapUpAtMs - elapsedMs
  if (delayMs <= 0) return null

  const leadMs = remainingMs - delayMs
  if (leadMs < minLeadSeconds * 1000) return null

  return {
    delayMs,
    remainingMinutesAtWrapUp: Math.max(1, Math.round(leadMs / 60_000)),
  }
}

/**
 * The one message the task agent gets. Phrased as an operator interrupt, not
 * as a new task: no new work, make what exists consistent, report gates
 * honestly, write a handoff if anything is unfinished, then answer.
 */
export function buildWrapUpMessage(remainingMinutes: number, budgetMinutes: number): string {
  return `<time_budget_warning>
Your time budget (${budgetMinutes} min) is nearly exhausted — about ${remainingMinutes} minute(s) remain before this task is aborted. Start NO new work now.
1. Bring the work in progress to a consistent state (finish or revert the current edit, commit what is done).
2. Report gate/test/build status honestly — never claim a check is green that did not run or that failed.
3. If anything stays unfinished, write a HANDOFF section (goal, what is done, what is open, current error, exact next step) into your final message.
4. Then deliver your final STATUS/SUMMARY answer immediately.
</time_budget_warning>`
}
