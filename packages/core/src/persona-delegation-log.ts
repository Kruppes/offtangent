/**
 * persona-delegation-log.ts: the delegation protocol (plan persona-architektur 1c).
 *
 * One row per delegation from one persona to another: every `ask_agent` call
 * and every `create_task` that runs as a foreign persona. Answers "how often
 * does Main hand work to Bob, how long does it take, what does it cost, how
 * often does it fail" without parsing transcripts.
 *
 * Additive table, idempotent migration, no backfill (an install without
 * delegations simply has an empty table). Writing a row never throws: the
 * protocol must never break the delegation it records.
 */
import type { Database } from './database.js'

export type PersonaDelegationKind = 'ask_agent' | 'task'

export interface PersonaDelegationRow {
  id: number
  createdAt: string
  callerAgentId: string
  targetAgentId: string
  kind: PersonaDelegationKind
  taskId: string | null
  sessionId: string | null
  /** null while a delegated task is still running. */
  success: boolean | null
  durationMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  error: string | null
  finishedAt: string | null
}

export function ensurePersonaDelegationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS persona_delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      caller_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      task_id TEXT,
      session_id TEXT,
      success INTEGER,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      error TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_persona_delegations_created ON persona_delegations(created_at);
    CREATE INDEX IF NOT EXISTS idx_persona_delegations_task ON persona_delegations(task_id);
  `)
}

export interface RecordDelegationInput {
  callerAgentId: string
  targetAgentId: string
  kind: PersonaDelegationKind
  taskId?: string | null
  sessionId?: string | null
  /** Set for a finished delegation (ask_agent); omit for a task that just started. */
  success?: boolean | null
  durationMs?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
  error?: string | null
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Insert one delegation row. Returns its id, or null if the write failed. */
export function recordPersonaDelegation(db: Database | null | undefined, input: RecordDelegationInput): number | null {
  if (!db) return null
  try {
    const finished = input.success !== undefined && input.success !== null
    const result = db.prepare(`
      INSERT INTO persona_delegations
        (caller_agent_id, target_agent_id, kind, task_id, session_id, success, duration_ms, input_tokens, output_tokens, cost_usd, error, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${finished ? "datetime('now')" : 'NULL'})
    `).run(
      input.callerAgentId,
      input.targetAgentId,
      input.kind,
      input.taskId ?? null,
      input.sessionId ?? null,
      finished ? (input.success ? 1 : 0) : null,
      finiteOrNull(input.durationMs),
      finiteOrNull(input.inputTokens),
      finiteOrNull(input.outputTokens),
      finiteOrNull(input.costUsd),
      input.error ? input.error.slice(0, 500) : null,
    )
    return Number(result.lastInsertRowid)
  } catch (err) {
    console.warn('[persona-delegation] could not record delegation:', (err as Error).message)
    return null
  }
}

/**
 * Close a still-open delegation row as failed (e.g. the delegated task could
 * not be started). No-op for a closed or missing row. Never throws.
 */
export function failPersonaDelegation(db: Database | null | undefined, id: number | null, error: string): void {
  if (!db || id === null) return
  try {
    db.prepare(`
      UPDATE persona_delegations
      SET success = 0, error = ?, finished_at = datetime('now')
      WHERE id = ? AND finished_at IS NULL
    `).run(error.slice(0, 500), id)
  } catch (err) {
    console.warn('[persona-delegation] could not close failed delegation:', (err as Error).message)
  }
}

interface FinishTaskRow {
  status: string
  result_status: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  estimated_cost: number | null
  error_message: string | null
}

function sqliteUtcMs(value: string | null): number | null {
  if (!value) return null
  const ms = new Date(`${value.replace(' ', 'T')}Z`).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * Close the open delegation row of a task from the task row itself (status,
 * duration, tokens, cost). Deterministic: everything comes from `tasks`, the
 * same numbers the task views show. No-op for tasks that were not delegated
 * or whose row is already closed. Never throws.
 */
export function finishTaskDelegation(db: Database | null | undefined, taskId: string): void {
  if (!db) return
  try {
    const open = db.prepare(
      'SELECT id FROM persona_delegations WHERE task_id = ? AND kind = \'task\' AND finished_at IS NULL',
    ).get(taskId) as { id: number } | undefined
    if (!open) return
    const task = db.prepare(`
      SELECT status, result_status, started_at, completed_at, created_at,
             prompt_tokens, completion_tokens, estimated_cost, error_message
      FROM tasks WHERE id = ?
    `).get(taskId) as FinishTaskRow | undefined
    if (!task) return
    // `paused` (question) is not an outcome yet; the row stays open.
    if (task.status === 'running' || task.status === 'paused' || task.status === 'queued') return
    const success = task.status === 'completed' && task.result_status !== 'failed'
    const start = sqliteUtcMs(task.started_at ?? task.created_at)
    const end = sqliteUtcMs(task.completed_at) ?? Date.now()
    db.prepare(`
      UPDATE persona_delegations
      SET success = ?, duration_ms = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, error = ?, finished_at = datetime('now')
      WHERE id = ?
    `).run(
      success ? 1 : 0,
      start !== null ? Math.max(0, end - start) : null,
      finiteOrNull(task.prompt_tokens),
      finiteOrNull(task.completion_tokens),
      finiteOrNull(task.estimated_cost),
      success ? null : (task.error_message ?? task.status).slice(0, 500),
      open.id,
    )
  } catch (err) {
    console.warn(`[persona-delegation] could not close delegation of task ${taskId}:`, (err as Error).message)
  }
}

interface DelegationDbRow {
  id: number
  created_at: string
  caller_agent_id: string
  target_agent_id: string
  kind: string
  task_id: string | null
  session_id: string | null
  success: number | null
  duration_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  error: string | null
  finished_at: string | null
}

/** Newest first. For evaluation and tests; not wired to a UI yet. */
export function listPersonaDelegations(db: Database, options?: { limit?: number; targetAgentId?: string }): PersonaDelegationRow[] {
  const limit = Math.max(1, Math.min(options?.limit ?? 100, 1000))
  const rows = (options?.targetAgentId
    ? db.prepare('SELECT * FROM persona_delegations WHERE target_agent_id = ? ORDER BY id DESC LIMIT ?').all(options.targetAgentId, limit)
    : db.prepare('SELECT * FROM persona_delegations ORDER BY id DESC LIMIT ?').all(limit)) as DelegationDbRow[]
  return rows.map(r => ({
    id: r.id,
    createdAt: r.created_at,
    callerAgentId: r.caller_agent_id,
    targetAgentId: r.target_agent_id,
    kind: r.kind as PersonaDelegationKind,
    taskId: r.task_id,
    sessionId: r.session_id,
    success: r.success === null ? null : r.success === 1,
    durationMs: r.duration_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    error: r.error,
    finishedAt: r.finished_at,
  }))
}
