/**
 * Tool names that are NOT tool calls: internal metric rows written to
 * `tool_calls` per SPEC 12.2 (context window, summary and extraction
 * accounting). Views that replay a session's tool calls to a user filter
 * these out — they are diagnostics, not work the agent did.
 */
export const INTERNAL_METRIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'strand_context',
  'task_history',
  'session_summary_delta',
  'fact_extraction',
  // Background task accounting (token audit 2026-09-17, P5c/P7): one
  // `task_usage` row per finished task run (tokens, cost, cache read ratio)
  // and one `task_guard` row whenever a progress guard aborted a task.
  'task_usage',
  'task_guard',
])

/**
 * Everything in `tool_calls` that is not work the agent did: the metric rows
 * above plus lifecycle markers (session end/timeout, reminder delivery).
 * Rows with these names get `is_internal = 1` so the strand statistics count
 * real tool calls without a name filter.
 */
export const NON_WORK_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...INTERNAL_METRIC_TOOL_NAMES,
  'session_timeout',
  'session_end',
  'reminder_delivery',
])
