/**
 * Read-path shield for lean local workers (plan 2026-10-18-lokale-worker, B2,
 * review finding 2).
 *
 * A `lean_local` task reads raw data on a local model and should hand back
 * only its schema-validated result. This shield covers ONE path, the read
 * tools below; it is not a privacy boundary (other paths such as summaries,
 * proxies or spilled tool output are not covered). Its transcript (kickoff,
 * intermediate answers, tool calls and tool results) lives in the task's own
 * session in `chat_messages` / `tool_calls`. Every tool that hands stored
 * messages to a model (get_task, recall_message, read_chat_history) must run
 * them through this ONE check: for a caller that is not itself running on a
 * local provider, rows of a lean task session are replaced by a placeholder.
 * The validated end result (the task's result summary after a completed,
 * schema-checked run) stays visible on the session's last assistant row.
 */
import type { Database } from './database.js'
import { LEAN_LOCAL_PROFILE, isLocalProvider } from './lean-worker-profile.js'
import { getCurrentTaskExecutionContext } from './task-execution-context.js'

/**
 * True when the current caller may see raw lean transcripts: only a
 * background task whose own provider is local. The interactive runtime (no
 * task context) and any cloud task fail closed.
 */
export function callerMaySeeLeanRaw(): boolean {
  const ctx = getCurrentTaskExecutionContext()
  return !!ctx && isLocalProvider(ctx.provider)
}

/**
 * SQL predicate (column = a session id column) that excludes lean task
 * sessions. Used where a search would otherwise act as an oracle over
 * private content (a query matching a lean row still reveals the match).
 */
export function leanSessionExcludeSql(sessionColumn: string): string {
  return `${sessionColumn} NOT IN (SELECT session_id FROM tasks WHERE worker_profile = '${LEAN_LOCAL_PROFILE}' AND session_id IS NOT NULL)`
}

interface LeanSessionInfo {
  taskId: string
  /** Validated result, or null when the run did not complete (schema not satisfied / still running). */
  result: string | null
  lastAssistantId: number | null
}

export interface LeanShield {
  /** True when lean rows are withheld for this caller. */
  readonly active: boolean
  /** True when the SQL helper may be used (tasks table with worker_profile exists). */
  readonly tasksTableExists: boolean
  /**
   * Replacement text for a row of a lean session, or null when the row is
   * not from a lean session (or the caller may see it).
   */
  replacement(row: { id: number; session_id: string | null; role: string }): string | null
}

export function leanWithheldText(taskId: string): string {
  return `[withheld: message of ${LEAN_LOCAL_PROFILE} task ${taskId} — the worker's raw data stays local; only its validated result is shared]`
}

/** Build the shield for one tool call (per-call cache of session lookups). */
export function createLeanShield(db: Database, opts: { callerMaySeeRaw?: boolean } = {}): LeanShield {
  let tasksTableExists = false
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all() as { name: string }[]
    tasksTableExists = cols.some(c => c.name === 'worker_profile') && cols.some(c => c.name === 'session_id')
  } catch {
    tasksTableExists = false
  }
  const active = tasksTableExists && !(opts.callerMaySeeRaw ?? callerMaySeeLeanRaw())
  const cache = new Map<string, LeanSessionInfo | null>()

  function info(sessionId: string): LeanSessionInfo | null {
    if (cache.has(sessionId)) return cache.get(sessionId) ?? null
    let out: LeanSessionInfo | null = null
    try {
      const task = db.prepare(
        `SELECT id, status, result_status, result_summary FROM tasks WHERE session_id = ? AND worker_profile = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(sessionId, LEAN_LOCAL_PROFILE) as { id: string; status: string; result_status: string | null; result_summary: string | null } | undefined
      if (task) {
        const last = db.prepare(
          "SELECT MAX(id) AS id FROM chat_messages WHERE session_id = ? AND role = 'assistant'",
        ).get(sessionId) as { id: number | null } | undefined
        const validated = task.status === 'completed' && task.result_status === 'completed' && !!task.result_summary
        out = { taskId: task.id, result: validated ? task.result_summary : null, lastAssistantId: last?.id ?? null }
      }
    } catch {
      // Lookup failed (schema mismatch): no lean evidence to act on.
      out = null
    }
    cache.set(sessionId, out)
    return out
  }

  return {
    active,
    tasksTableExists,
    replacement(row) {
      if (!active || !row.session_id) return null
      const lean = info(row.session_id)
      if (!lean) return null
      if (row.role === 'assistant' && row.id === lean.lastAssistantId && lean.result !== null) {
        return `[${LEAN_LOCAL_PROFILE} task ${lean.taskId}: validated result]\n${lean.result}`
      }
      return leanWithheldText(lean.taskId)
    },
  }
}
