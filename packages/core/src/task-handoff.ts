/**
 * task-handoff.ts: the state a background task leaves behind (W5/P2).
 *
 * A long job rarely fits into one task run. When a run ends without having
 * finished the job — wrap-up, timeout, progress guard, crash, or an honest
 * `STATUS: failed` — everything the next run would need (what was done, what
 * is open, which error was on screen) lives only in a transcript nobody
 * reads. The handoff is that state, persisted on the task row, so a
 * successor task can be started with `continuation_of: <task id>`.
 *
 * Storage decision (minimal invasive): ONE nullable `handoff TEXT` column on
 * the existing `tasks` table, filled via the additive-ALTER pattern the table
 * already uses for `agent_id` / `output_schema` / `context_mode`. No new
 * table, no JSON blob to migrate, and `NULL` means exactly what it says: this
 * task did not leave unfinished work behind.
 */

import type { Task } from './task-store.js'

/** Why the run ended. Stable identifiers — they appear in the handoff text. */
export type HandoffReason =
  | 'wrap_up'
  | 'timeout'
  | 'aborted'
  | 'progress_guard'
  | 'error'
  | 'reported_failed'

const REASON_LABEL: Record<HandoffReason, string> = {
  wrap_up: 'time budget nearly exhausted (wrap-up signal was sent)',
  timeout: 'hard max-duration abort',
  aborted: 'aborted',
  progress_guard: 'progress guard tripped',
  error: 'run error',
  reported_failed: 'task reported STATUS: failed',
}

/** Hard cap for the stored handoff so one task cannot bloat the row. */
export const MAX_HANDOFF_CHARS = 8000
/** Cap for the continuation block injected into a successor's prompt. */
export const MAX_CONTINUATION_CHARS = 8000

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated at ${max} chars]`
}

/**
 * Pull an explicit handoff section out of a task's final message.
 *
 * Recognised openers (case-insensitive, start of a line): `HANDOFF:`,
 * `## Handoff`, `# Handoff`, `**Handoff**`. Everything from there to the end
 * of the text is the section — a handoff is the last thing an agent writes.
 * Returns null when no section is present.
 */
export function extractHandoffSection(summary: string | null | undefined): string | null {
  if (!summary) return null
  const match = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?handoff(?:\*\*)?[ \t]*:?[ \t]*$|^[ \t]*handoff:[ \t]*\S/im.exec(summary)
  if (!match) return null
  const section = summary.slice(match.index).trim()
  return section.length > 0 ? section : null
}

export interface BuildHandoffInput {
  task: Task
  reason: HandoffReason
  /** Elapsed wall-clock minutes of the run. */
  durationMinutes?: number
  /** Error message for the failing paths, when the row does not carry it yet. */
  errorMessage?: string | null
  /** Final summary, when the row does not carry it yet. */
  summary?: string | null
}

/**
 * Render the handoff record. Deterministic, no LLM call: metadata the runner
 * already has plus the agent's own words (its explicit HANDOFF section when
 * it wrote one, otherwise the tail of its summary).
 */
export function buildTaskHandoff(input: BuildHandoffInput): string {
  const { task, reason } = input
  const summary = input.summary ?? task.resultSummary ?? null
  const error = input.errorMessage ?? task.errorMessage ?? null
  const explicit = extractHandoffSection(summary)

  const lines: string[] = []
  lines.push(`Task: ${task.name} (${task.id})`)
  lines.push(`Ended: ${REASON_LABEL[reason]}`)
  if (typeof input.durationMinutes === 'number') {
    lines.push(`Ran: ${input.durationMinutes} min of ${task.maxDurationMinutes ?? '?'} min budget, ${task.toolCallCount} tool calls`)
  }
  if (error) lines.push(`Error: ${truncate(error, 500)}`)
  lines.push('')
  if (explicit) {
    lines.push(explicit)
  } else if (summary && summary.trim().length > 0) {
    lines.push('No explicit HANDOFF section — last reported state:')
    lines.push(truncate(summary.trim(), 4000))
  } else {
    lines.push('No result text was produced before the run ended.')
  }

  return truncate(lines.join('\n').trim(), MAX_HANDOFF_CHARS)
}

/**
 * The context block a successor task gets for `continuation_of`.
 *
 * Marked explicitly as predecessor state (never as the successor's own work)
 * and capped, so a long predecessor cannot crowd out the new brief.
 */
export function formatContinuationContext(
  predecessor: Task,
  options: { maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? MAX_CONTINUATION_CHARS
  const body = predecessor.handoff?.trim()
    || (predecessor.resultSummary?.trim() ? `Final summary of the predecessor:\n${predecessor.resultSummary.trim()}` : '')
    || 'The predecessor left neither a handoff nor a summary.'

  const header = [
    `<continuation_of task_id="${predecessor.id}" name="${escapeAttr(predecessor.name)}" status="${predecessor.resultStatus ?? predecessor.status}">`,
    'You are continuing the work of an earlier background task. The block below is',
    'the predecessor\'s own final state — treat it as a report you did not write:',
    'verify claims before you build on them, and do not repeat work listed as done',
    'unless it turns out to be wrong.',
    '',
  ].join('\n')

  const budget = Math.max(0, maxChars - header.length - '\n</continuation_of>'.length)
  return `${header}${truncate(body, budget)}\n</continuation_of>`
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').slice(0, 120)
}
