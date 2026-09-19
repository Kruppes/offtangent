/**
 * Persistence for the running strand to project assignment (Stufe 2).
 *
 * Four things live here and nothing else: the open suggestion of a strand,
 * the permanent dismissals, the rate limit bookkeeping, and the one write
 * that puts a project on a strand. The write is the reason this module is
 * narrow: `sessions.project_id` is set in exactly two places in the whole
 * system, and this is the automatic one, so the rule "a project that is
 * already set is never touched" can be enforced in a single SQL predicate
 * instead of in every caller.
 */
import type { Database } from './database.js'
import { toIsoUtc } from './timestamps.js'

/** Confidence at which the project is written onto the strand. */
export const PROJECT_ASSIGN_MIN_CONFIDENCE = 0.75
/** Confidence at which a proposal is stored for the user to tap. */
export const PROJECT_SUGGEST_MIN_CONFIDENCE = 0.5
/**
 * How many different projects a user may throw away on one strand before the
 * classifier leaves it alone for good. Three "no" in a row is an answer.
 */
export const PROJECT_ASSIGNMENT_MAX_DISMISSALS = 3

/** What one evaluation did, as recorded in `strand_project_runs`. */
export type ProjectAssignmentOutcome = 'assigned' | 'suggested' | 'none' | 'error'

/** The open project proposal of a strand, as delivered by the strand API. */
export interface StrandProjectSuggestion {
  projectId: string
  /** Resolved at read time so a project rename can never show a stale label. */
  projectName: string | null
  confidence: number
  reason: string
  createdAt: string
}

interface SuggestionRow {
  strand_id: string
  user_id: string
  project_id: string
  confidence: number
  reason: string
  model: string | null
  created_at: string
  project_name: string | null
}

/** Minimal `sessions` view the evaluation needs. */
export interface StrandAssignmentRow {
  id: string
  userId: string | null
  agentId: string
  title: string | null
  projectId: string | null
  archived: boolean
  type: string
}

export function getStrandForAssignment(db: Database, strandId: string): StrandAssignmentRow | null {
  const row = db.prepare(
    `SELECT id, user_id, session_user, agent_id, title, project_id, archived, type
     FROM sessions WHERE id = ?`,
  ).get(strandId) as {
    id: string
    user_id: number | null
    session_user: string | null
    agent_id: string | null
    title: string | null
    project_id: string | null
    archived: number | null
    type: string | null
  } | undefined
  if (!row) return null
  return {
    id: row.id,
    userId: row.session_user ?? (row.user_id === null ? null : String(row.user_id)),
    agentId: row.agent_id ?? 'main',
    title: row.title ?? null,
    projectId: row.project_id ?? null,
    archived: !!row.archived,
    type: row.type ?? 'interactive',
  }
}

/** User + assistant rows of a strand. The router's own counter is not used: it
 * is only maintained for the session that currently holds the (user, persona)
 * slot, so a parked thread would look empty forever. */
export function countStrandMessages(db: Database, strandId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM chat_messages
     WHERE session_id = ? AND role IN ('user','assistant')`,
  ).get(strandId) as { n: number } | undefined
  return row?.n ?? 0
}

export interface ProjectAssignmentRun {
  strandId: string
  lastRunAt: string
  lastMessageCount: number
  runs: number
  lastOutcome: ProjectAssignmentOutcome | null
  lastConfidence: number | null
  lastModel: string | null
}

export function getProjectAssignmentRun(db: Database, strandId: string): ProjectAssignmentRun | null {
  const row = db.prepare(
    `SELECT strand_id, last_run_at, last_message_count, runs, last_outcome, last_confidence, last_model
     FROM strand_project_runs WHERE strand_id = ?`,
  ).get(strandId) as {
    strand_id: string
    last_run_at: string
    last_message_count: number
    runs: number
    last_outcome: string | null
    last_confidence: number | null
    last_model: string | null
  } | undefined
  if (!row) return null
  return {
    strandId: row.strand_id,
    lastRunAt: toIsoUtc(row.last_run_at),
    lastMessageCount: row.last_message_count,
    runs: row.runs,
    lastOutcome: (row.last_outcome as ProjectAssignmentOutcome | null) ?? null,
    lastConfidence: row.last_confidence ?? null,
    lastModel: row.last_model ?? null,
  }
}

/** Record that a strand was evaluated at `messageCount`. Idempotent upsert. */
export function recordProjectAssignmentRun(
  db: Database,
  strandId: string,
  messageCount: number,
  outcome: ProjectAssignmentOutcome,
  options: { confidence?: number | null; model?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO strand_project_runs
       (strand_id, last_run_at, last_message_count, runs, last_outcome, last_confidence, last_model)
     VALUES (?, datetime('now'), ?, 1, ?, ?, ?)
     ON CONFLICT(strand_id) DO UPDATE SET
       last_run_at = datetime('now'),
       last_message_count = excluded.last_message_count,
       runs = strand_project_runs.runs + 1,
       last_outcome = excluded.last_outcome,
       last_confidence = excluded.last_confidence,
       last_model = excluded.last_model`,
  ).run(strandId, messageCount, outcome, options.confidence ?? null, options.model ?? null)
}

const SUGGESTION_SELECT = `
  SELECT s.strand_id, s.user_id, s.project_id, s.confidence, s.reason, s.model, s.created_at,
         (SELECT p.name FROM projects p WHERE p.id = s.project_id) AS project_name
  FROM strand_project_suggestions s`

function toSuggestion(row: SuggestionRow): StrandProjectSuggestion {
  return {
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    confidence: row.confidence,
    reason: row.reason ?? '',
    createdAt: toIsoUtc(row.created_at),
  }
}

/** The open suggestion of a strand, `null` when there is none. */
export function getStrandProjectSuggestion(db: Database, strandId: string): StrandProjectSuggestion | null {
  const row = db.prepare(`${SUGGESTION_SELECT} WHERE s.strand_id = ?`).get(strandId) as SuggestionRow | undefined
  return row ? toSuggestion(row) : null
}

/**
 * Store (or replace) the open suggestion of a strand. Refuses silently for a
 * pair the user has dismissed and for a strand that already has a project:
 * both are the invariants of this feature and a caller must not be able to
 * bypass them by writing the row directly.
 */
export function putStrandProjectSuggestion(
  db: Database,
  input: { strandId: string; userId: string; projectId: string; confidence: number; reason: string; model?: string | null },
): boolean {
  if (isProjectDismissedForStrand(db, input.strandId, input.projectId)) return false
  const strand = getStrandForAssignment(db, input.strandId)
  if (!strand || strand.projectId !== null) return false
  db.prepare(
    `INSERT INTO strand_project_suggestions (strand_id, user_id, project_id, confidence, reason, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(strand_id) DO UPDATE SET
       user_id = excluded.user_id,
       project_id = excluded.project_id,
       confidence = excluded.confidence,
       reason = excluded.reason,
       model = excluded.model,
       created_at = excluded.created_at`,
  ).run(
    input.strandId,
    input.userId,
    input.projectId,
    input.confidence,
    (input.reason ?? '').slice(0, 400),
    input.model ?? null,
  )
  return true
}

export function clearStrandProjectSuggestion(db: Database, strandId: string): void {
  db.prepare('DELETE FROM strand_project_suggestions WHERE strand_id = ?').run(strandId)
}

export function isProjectDismissedForStrand(db: Database, strandId: string, projectId: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS hit FROM strand_project_dismissals WHERE strand_id = ? AND project_id = ?',
  ).get(strandId, projectId) as { hit: number } | undefined
  return !!row
}

export function listDismissedProjectsForStrand(db: Database, strandId: string): string[] {
  const rows = db.prepare(
    'SELECT project_id FROM strand_project_dismissals WHERE strand_id = ? ORDER BY dismissed_at ASC',
  ).all(strandId) as { project_id: string }[]
  return rows.map(r => r.project_id)
}

/** Remember a dismissal forever and drop the open suggestion in one go. */
export function dismissStrandProject(db: Database, strandId: string, projectId: string): void {
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO strand_project_dismissals (strand_id, project_id, dismissed_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(strand_id, project_id) DO NOTHING`,
    ).run(strandId, projectId)
    db.prepare('DELETE FROM strand_project_suggestions WHERE strand_id = ? AND project_id = ?')
      .run(strandId, projectId)
  })
  run()
}

/**
 * Put a project on a strand, but only while it has none.
 *
 * `project_id IS NULL` in the WHERE clause is the whole guarantee of
 * requirement "a set project is never overwritten": two concurrent runs, a
 * run racing a manual assignment, a stale suggestion accepted twice — all of
 * them lose against the row that already carries a project, without a lock.
 *
 * Archived projects are allowed on purpose (unlike `resolveAssignableProjectId`,
 * which serves the manual move): a strand that clearly belongs to a project
 * the user has put away still belongs there. Ownership is checked, so a
 * foreign project can never be written.
 */
export function assignProjectIfUnset(
  db: Database,
  strandId: string,
  userId: string,
  projectId: string,
): boolean {
  if (isProjectDismissedForStrand(db, strandId, projectId)) return false
  const owned = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, userId) as { id: string } | undefined
  if (!owned) return false
  const result = db.prepare(
    `UPDATE sessions SET project_id = ?
     WHERE id = ? AND project_id IS NULL AND type = 'interactive'
       AND (session_user = ? OR CAST(user_id AS TEXT) = ?)`,
  ).run(projectId, strandId, userId, userId)
  if (result.changes === 0) return false
  clearStrandProjectSuggestion(db, strandId)
  return true
}
