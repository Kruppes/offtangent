/**
 * Durable queue for task-result injections (W4, resume robustness).
 *
 * The problem it solves: a finished background task hands its
 * `<task_injection>` payload to `AgentCore.injectTaskResult`, which runs an
 * LLM turn in the origin strand. That call lived exclusively in process
 * memory (`pendingInjections`, a `Map`). When the container restarts — which
 * happens on every deploy of the agent's own stack — the payload of every
 * injection that was in flight, or that was produced while the process was
 * down, is gone. The task is `completed` in the database, the strand never
 * hears about it and the agent goes quiet until a human asks.
 *
 * The fix is deliberately boring: one row per injection, written BEFORE the
 * turn starts, acknowledged only when the turn actually produced its `done`
 * chunk. Everything that is still `pending` after a restart (or after a
 * session died mid-run) is simply re-delivered. Delivery is therefore
 * at-least-once: a result may reach the strand twice if the process dies
 * between the agent's answer and the ack, which is the safe direction — a
 * duplicate result is visible and cheap, a lost result is invisible and
 * expensive.
 *
 * The row is the same correlation token the streaming path already used
 * (`injectionId`), so nothing downstream had to learn a new identifier.
 */

import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'

/** What kind of payload a queued row carries. */
export type TaskInjectionKind = 'task_result' | 'resume_notice'

/**
 * `pending`   — enqueued, not yet acknowledged. Eligible for (re)delivery.
 * `delivered` — an agent run consumed it and reached its `done` chunk.
 * `abandoned` — given up on (too old, too many attempts). Never retried.
 */
export type TaskInjectionStatus = 'pending' | 'delivered' | 'abandoned'

export interface TaskInjectionRow {
  id: string
  taskId: string
  kind: TaskInjectionKind
  userId: number
  agentId: string
  sessionId: string
  payload: string
  status: TaskInjectionStatus
  attempts: number
  createdAt: string
  lastAttemptAt: string | null
  deliveredAt: string | null
  lastError: string | null
}

export interface EnqueueTaskInjectionInput {
  /** Pre-minted id; a fresh UUID when omitted. */
  id?: string
  taskId: string
  kind?: TaskInjectionKind
  userId: number
  agentId: string
  /** The strand the injection runs in. Feed-only outcomes never get a row. */
  sessionId: string
  payload: string
}

interface TaskInjectionDbRow {
  id: string
  task_id: string
  kind: string
  user_id: number
  agent_id: string
  session_id: string
  payload: string
  status: string
  attempts: number
  created_at: string
  last_attempt_at: string | null
  delivered_at: string | null
  last_error: string | null
}

export function initTaskInjectionQueueTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_injections (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'task_result' CHECK(kind IN ('task_result', 'resume_notice')),
      user_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main',
      session_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'abandoned')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_attempt_at TEXT,
      delivered_at TEXT,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_task_injections_status ON task_injections(status);
    CREATE INDEX IF NOT EXISTS idx_task_injections_task ON task_injections(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_injections_session ON task_injections(session_id);
  `)
}

function rowToInjection(row: TaskInjectionDbRow): TaskInjectionRow {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: (row.kind === 'resume_notice' ? 'resume_notice' : 'task_result') as TaskInjectionKind,
    userId: row.user_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    payload: row.payload,
    status: row.status as TaskInjectionStatus,
    attempts: row.attempts,
    createdAt: row.created_at,
    lastAttemptAt: row.last_attempt_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
  }
}

/** Write the row that makes an injection survive a restart. */
export function enqueueTaskInjection(db: Database, input: EnqueueTaskInjectionInput): TaskInjectionRow {
  const id = input.id ?? randomUUID()
  db.prepare(
    `INSERT INTO task_injections (id, task_id, kind, user_id, agent_id, session_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.taskId, input.kind ?? 'task_result', input.userId, input.agentId, input.sessionId, input.payload)
  const row = getTaskInjection(db, id)
  if (!row) throw new Error(`enqueueTaskInjection: row ${id} vanished right after insert`)
  return row
}

export function getTaskInjection(db: Database, id: string): TaskInjectionRow | null {
  const row = db.prepare('SELECT * FROM task_injections WHERE id = ?').get(id) as TaskInjectionDbRow | undefined
  return row ? rowToInjection(row) : null
}

/**
 * Count an attempt. Called the moment a delivery is handed to the agent, not
 * when it succeeds — so a crashed run leaves a visible attempt behind and the
 * retry backoff (`last_attempt_at`) starts immediately. This doubles as the
 * in-flight marker: a row attempted 10 seconds ago is not picked up again.
 */
export function markTaskInjectionAttempt(db: Database, id: string): void {
  db.prepare(
    `UPDATE task_injections
     SET attempts = attempts + 1, last_attempt_at = datetime('now')
     WHERE id = ? AND status = 'pending'`,
  ).run(id)
}

/** The ack. Only an agent run that reached `done` may call this. */
export function markTaskInjectionDelivered(db: Database, id: string): boolean {
  const res = db.prepare(
    `UPDATE task_injections
     SET status = 'delivered', delivered_at = datetime('now'), last_error = NULL
     WHERE id = ? AND status = 'pending'`,
  ).run(id)
  return res.changes > 0
}

/** A failed attempt. The row stays `pending` so the sweeper tries again. */
export function markTaskInjectionFailed(db: Database, id: string, error: string): void {
  db.prepare(
    `UPDATE task_injections SET last_error = ? WHERE id = ? AND status = 'pending'`,
  ).run(error.slice(0, 2000), id)
}

/** Give up on a row: too old, too many attempts, or no strand left. */
export function abandonTaskInjection(db: Database, id: string, reason: string): void {
  db.prepare(
    `UPDATE task_injections
     SET status = 'abandoned', last_error = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(reason.slice(0, 2000), id)
}

export interface ListPendingOptions {
  limit?: number
  agentId?: string
  sessionId?: string
}

/** Oldest first: a restart replays results in the order they happened. */
export function listPendingTaskInjections(db: Database, options: ListPendingOptions = {}): TaskInjectionRow[] {
  const clauses = ["status = 'pending'"]
  const params: unknown[] = []
  if (options.agentId) {
    clauses.push('agent_id = ?')
    params.push(options.agentId)
  }
  if (options.sessionId) {
    clauses.push('session_id = ?')
    params.push(options.sessionId)
  }
  const limit = Number.isSafeInteger(options.limit) && (options.limit as number) > 0 ? options.limit as number : 200
  const rows = db.prepare(
    `SELECT * FROM task_injections WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, rowid ASC LIMIT ?`,
  ).all(...params, limit) as TaskInjectionDbRow[]
  return rows.map(rowToInjection)
}

export function countPendingTaskInjections(db: Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM task_injections WHERE status = 'pending'`).get() as { n: number }
  return row?.n ?? 0
}

/** Parse the naked SQLite datetime (`2026-09-17 15:18:02`, always UTC). */
export function injectionTimestampMs(value: string | null | undefined): number {
  if (!value) return 0
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  return Number.isNaN(parsed) ? 0 : parsed
}

export interface RedeliverySelectionOptions {
  now: number
  /** A row attempted more recently than this is considered in flight. */
  retryAfterMs: number
  /** Attempts after which a row is abandoned; 0 disables the cap. */
  maxAttempts: number
  /** Age after which a result is too stale to be worth a turn; 0 disables. */
  maxAgeMs: number
  /** Maximum rows dispatched per sweep; 0 means no limit. */
  limit: number
}

export interface RedeliverySelection {
  redeliver: TaskInjectionRow[]
  expire: Array<{ row: TaskInjectionRow; reason: string }>
}

/**
 * Pure: given the pending rows, decide what to retry and what to bury.
 * No clock, no database — the sweeper and the boot hook share this logic and
 * the tests drive it directly.
 */
export function selectInjectionsForRedelivery(
  rows: TaskInjectionRow[],
  options: RedeliverySelectionOptions,
): RedeliverySelection {
  const redeliver: TaskInjectionRow[] = []
  const expire: Array<{ row: TaskInjectionRow; reason: string }> = []

  for (const row of rows) {
    if (row.status !== 'pending') continue

    const ageMs = options.now - injectionTimestampMs(row.createdAt)
    if (options.maxAgeMs > 0 && ageMs > options.maxAgeMs) {
      expire.push({ row, reason: `expired after ${Math.round(ageMs / 60000)} min without a deliverable session` })
      continue
    }
    if (options.maxAttempts > 0 && row.attempts >= options.maxAttempts) {
      expire.push({ row, reason: `giving up after ${row.attempts} delivery attempts` })
      continue
    }
    const sinceAttempt = row.lastAttemptAt ? options.now - injectionTimestampMs(row.lastAttemptAt) : Number.POSITIVE_INFINITY
    if (sinceAttempt < options.retryAfterMs) continue

    if (options.limit > 0 && redeliver.length >= options.limit) continue
    redeliver.push(row)
  }

  return { redeliver, expire }
}

/**
 * The banner a re-delivered payload carries, so the agent can tell a repeat
 * from a fresh result instead of assuming it missed something.
 */
export function formatRedeliveryPayload(row: TaskInjectionRow, reason: 'container_restart' | 'retry'): string {
  if (row.attempts <= 0) return row.payload
  const note = reason === 'container_restart'
    ? 'The container restarted before this background-task result could be delivered, so the agent session that was waiting for it is gone.'
    : 'The agent session this result was delivered into died before it was processed.'
  return `<delivery_notice reason="${reason}" attempt="${row.attempts + 1}">
${note} The original result is repeated verbatim below — treat it as newly arrived and continue the work it belongs to.
</delivery_notice>
${row.payload}`
}
