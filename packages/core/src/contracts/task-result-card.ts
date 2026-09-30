/**
 * The shape of a finished background task in the strand.
 *
 * Before this, `persistTaskResultMessage` wrote
 * `${emoji} Task ${status}: ${name}\n\n${task.resultSummary}` straight into
 * `chat_messages.content` with no cap at all: a task that reports twelve
 * kilobytes of detail dumped twelve kilobytes into the conversation, pushed
 * everything else out of the viewport, and cost that much context on the next
 * turn.
 *
 * What is stored now is a card: headline, a short preview, and the structured
 * rest in `chat_messages.metadata` (NO schema change — the column exists and
 * already carries the task id). The full report is not thrown away, it stays
 * in `tasks.result_summary` and is fetched on demand via `GET /api/tasks/:id`
 * when the user expands the card.
 *
 * Dependency-free on purpose: the web frontend renders the same preview the
 * backend persisted, and Telegram uses the same truncation.
 */

/** How much of the report is visible in the message stream. */
export const TASK_RESULT_PREVIEW_MAX_CHARS = 400
/** …and never more than this many lines, whichever hits first. */
export const TASK_RESULT_PREVIEW_MAX_LINES = 3

export type TaskResultBodyKind = 'summary' | 'error' | 'empty'

export interface TaskResultPreview {
  /** Single line: emoji, status, task name. */
  headline: string
  /** The capped body that goes into the message stream. */
  preview: string
  /** True when the full body did not fit. */
  truncated: boolean
  /** Length of the full body in characters. */
  fullLength: number
  /** Whether the body is the result summary or the failure reason. */
  bodyKind: TaskResultBodyKind
}

export interface TaskResultPreviewInput {
  taskId: string
  name: string
  status: string
  resultSummary?: string | null
  errorMessage?: string | null
}

export interface TaskResultPreviewOptions {
  maxChars?: number
  maxLines?: number
}

export function taskStatusEmoji(status: string): string {
  switch (status) {
    case 'completed': return '✅'
    case 'failed': return '❌'
    case 'question': return '❓'
    default: return 'ℹ️'
  }
}

/**
 * Cut a body down to at most `maxLines` lines and `maxChars` characters,
 * preferring a word boundary so the preview does not end mid-word. Returns
 * the untouched body when it already fits.
 */
export function truncateTaskResultBody(
  body: string,
  options: TaskResultPreviewOptions = {},
): { preview: string; truncated: boolean } {
  const maxChars = options.maxChars ?? TASK_RESULT_PREVIEW_MAX_CHARS
  const maxLines = options.maxLines ?? TASK_RESULT_PREVIEW_MAX_LINES
  const normalized = body.replace(/\r\n/g, '\n').trim()
  if (!normalized) return { preview: '', truncated: false }

  let truncated = false
  const lines = normalized.split('\n')
  // Blank lines carry no information in a three-line preview; dropping them
  // means a report that starts with a heading and an empty line still shows
  // three lines of substance.
  const meaningful = lines.filter(line => line.trim() !== '')
  let preview = meaningful.slice(0, maxLines).join('\n')
  if (meaningful.length > maxLines) truncated = true

  if (preview.length > maxChars) {
    const hard = preview.slice(0, maxChars)
    const lastSpace = hard.lastIndexOf(' ')
    preview = (lastSpace > maxChars * 0.6 ? hard.slice(0, lastSpace) : hard).trimEnd()
    truncated = true
  }

  if (truncated) preview = `${preview.replace(/[.,;:\s]+$/, '')}…`
  return { preview, truncated }
}

/** The body of a task card: the summary, or the failure reason for a failed task. */
export function taskResultBodyOf(input: TaskResultPreviewInput): { body: string; kind: TaskResultBodyKind } {
  const summary = (input.resultSummary ?? '').trim()
  if (summary) return { body: summary, kind: 'summary' }
  const error = (input.errorMessage ?? '').trim()
  if (error) return { body: error, kind: 'error' }
  return { body: '', kind: 'empty' }
}

export function buildTaskResultPreview(
  input: TaskResultPreviewInput,
  options: TaskResultPreviewOptions = {},
): TaskResultPreview {
  const { body, kind } = taskResultBodyOf(input)
  const { preview, truncated } = truncateTaskResultBody(body, options)
  return {
    headline: `${taskStatusEmoji(input.status)} Task ${input.status}: ${input.name}`,
    preview: preview || (kind === 'empty' ? 'No summary available.' : preview),
    truncated,
    fullLength: body.length,
    bodyKind: kind,
  }
}

/**
 * The line that replaces the cut-off rest. It names where the full report is,
 * because "…" alone reads like the task produced nothing more.
 */
export function taskResultMoreLine(preview: TaskResultPreview, taskId: string): string {
  const remaining = Math.max(0, preview.fullLength - preview.preview.length)
  return `…${remaining} more characters — open the task card for the full report (task ${taskId}).`
}

/**
 * The `chat_messages.content` of a task card. Kept human-readable because it
 * is what search, the LLM context and any client without the card renderer
 * see — but capped, which is the entire point of this module.
 */
export function buildTaskResultContent(
  input: TaskResultPreviewInput,
  options: TaskResultPreviewOptions = {},
): string {
  const preview = buildTaskResultPreview(input, options)
  const lines = [preview.headline, '', preview.preview]
  if (preview.truncated) {
    lines.push('', taskResultMoreLine(preview, input.taskId))
  }
  return lines.join('\n')
}

/**
 * The card for a task-result row that was written BEFORE this module existed.
 *
 * Those rows carry the whole report in `chat_messages.content` (measured on
 * the live database on 2026-09-15: one report of 20,342 characters) and a
 * metadata object without any of the `result*` preview fields. There is no
 * migration for them on purpose — the card is derivable from what the row
 * already holds, so the server derives it on read and the column stays
 * untouched. Nothing is lost: the full report is still in `tasks.result_summary`
 * (fetched by the expanded card via `GET /api/tasks/:id`) and, for as long as
 * the row is not rewritten, in the message itself.
 *
 * The stored shape is `${emoji} Task ${status}: ${name}\n\n${body}`, so the
 * first line is the headline and the rest is the body. A row that does not
 * look like that keeps its whole content as the body, which is the safe
 * direction: a preview too long is a nuisance, a headline eaten as body is a
 * lie about the task.
 *
 * Returns null when the row is not worth touching (already short enough),
 * so the caller can leave such a message exactly as it is.
 */
export function deriveTaskResultCard(
  content: string,
  taskId: string,
  options: TaskResultPreviewOptions = {},
): { content: string; preview: TaskResultPreview } | null {
  const normalized = (content ?? '').replace(/\r\n/g, '\n')
  if (!normalized.trim()) return null

  const newlineIndex = normalized.indexOf('\n')
  const firstLine = (newlineIndex === -1 ? normalized : normalized.slice(0, newlineIndex)).trim()
  const looksLikeHeadline = /^\S*\s*Task\s+\w+:/u.test(firstLine)
  const headline = looksLikeHeadline ? firstLine : ''
  const body = (looksLikeHeadline && newlineIndex !== -1 ? normalized.slice(newlineIndex + 1) : normalized).trim()

  const { preview, truncated } = truncateTaskResultBody(body, options)
  if (!truncated) return null

  const result: TaskResultPreview = {
    headline,
    preview,
    truncated: true,
    fullLength: body.length,
    bodyKind: 'summary',
  }
  const lines = headline ? [headline, '', preview] : [preview]
  lines.push('', taskResultMoreLine(result, taskId))
  return { content: lines.join('\n'), preview: result }
}
