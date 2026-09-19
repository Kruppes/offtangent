/**
 * Projects light (Offtangent Stufe 2): a flat grouping layer above threads.
 *
 * A project is nothing but a named, coloured bucket owned by one user; a
 * thread points at (at most) one project via `sessions.project_id`. There is
 * no foreign key — deleting a project detaches its threads here in code, which
 * keeps the `sessions` table out of another SQLite rebuild.
 *
 * The shapes below are the wire contract of `/api/projects` (camelCase,
 * ISO-8601 UTC timestamps, exactly like `Thread`).
 */
import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import { InvalidInputError, ProjectNotFoundError } from './errors.js'
import { toIsoUtc } from './timestamps.js'

/** Wire shape of a project. `threadCount` counts NON-archived threads. */
export interface Project {
  id: string
  name: string
  color: string | null
  archived: boolean
  createdAt: string
  updatedAt: string
  threadCount: number
}

export interface ListProjectsOptions {
  /** Include archived projects (hidden by default). */
  includeArchived?: boolean
}

export interface CreateProjectInput {
  name: string
  color?: string | null
}

export interface UpdateProjectPatch {
  name?: string
  color?: string | null
  archived?: boolean
}

interface ProjectRow {
  id: string
  name: string
  color: string | null
  archived: number
  created_at: string
  updated_at: string
  thread_count: number
}

/** Upper bound for a user-supplied project name. */
export const PROJECT_NAME_MAX_LENGTH = 80
/** Colours are plain 6-digit hex so every client can render them. */
const PROJECT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

/** Trim + length-check a project name. Throws {@link InvalidInputError}. */
export function normalizeProjectName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new InvalidInputError('name must be a string')
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new InvalidInputError('name must not be empty')
  }
  if (trimmed.length > PROJECT_NAME_MAX_LENGTH) {
    throw new InvalidInputError(`name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`)
  }
  return trimmed
}

/**
 * Validate an optional colour. `null`/`undefined`/empty means "no colour";
 * anything else must be `#rrggbb` and is stored lowercased.
 */
export function normalizeProjectColor(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') {
    throw new InvalidInputError('color must be a hex string like #4f46e5 or null')
  }
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (!PROJECT_COLOR_PATTERN.test(trimmed)) {
    throw new InvalidInputError('color must be a hex string like #4f46e5 or null')
  }
  return trimmed.toLowerCase()
}

/**
 * Resolve the project a thread may be attached to.
 *
 * `null`/`undefined` detaches the thread. Any other value must name a project
 * that exists, belongs to `userId` and is NOT archived — otherwise
 * {@link ProjectNotFoundError} (route: 400 `project_not_found`). Unknown,
 * foreign and archived are deliberately indistinguishable.
 */
export function resolveAssignableProjectId(
  db: Database,
  userId: string,
  projectId: string | null | undefined,
): string | null {
  if (projectId === null || projectId === undefined || projectId === '') return null
  if (typeof projectId !== 'string') {
    throw new ProjectNotFoundError()
  }
  const row = db
    .prepare('SELECT id FROM projects WHERE id = ? AND user_id = ? AND archived = 0')
    .get(projectId, userId) as { id: string } | undefined
  if (!row) throw new ProjectNotFoundError()
  return row.id
}

/** SELECT list shared by every read: project row + its live thread count. */
const PROJECT_SELECT = `
  SELECT p.id, p.name, p.color, p.archived, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM sessions s
           WHERE s.project_id = p.id AND s.type = 'interactive' AND s.archived = 0
             AND (s.session_user = p.user_id OR CAST(s.user_id AS TEXT) = p.user_id)) AS thread_count
  FROM projects p`

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? null,
    archived: !!row.archived,
    createdAt: toIsoUtc(row.created_at),
    updatedAt: toIsoUtc(row.updated_at),
    threadCount: row.thread_count,
  }
}

/**
 * CRUD for projects. Every method is scoped to one user: a foreign project is
 * as invisible as a non-existent one (the routes answer 404 for both).
 */
export class ProjectManager {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  /**
   * A user's projects: active ones first, then alphabetically
   * (case-insensitive) so the list order is stable across reloads.
   */
  listProjects(userId: string, options: ListProjectsOptions = {}): Project[] {
    const where = options.includeArchived ? 'p.user_id = ?' : 'p.user_id = ? AND p.archived = 0'
    const rows = this.db
      .prepare(`${PROJECT_SELECT} WHERE ${where} ORDER BY p.archived ASC, p.name COLLATE NOCASE ASC, p.id ASC`)
      .all(userId) as ProjectRow[]
    return rows.map(toProject)
  }

  /** Read one project, or `null` when unknown or owned by someone else. */
  getProject(userId: string, projectId: string): Project | null {
    const row = this.db
      .prepare(`${PROJECT_SELECT} WHERE p.id = ? AND p.user_id = ?`)
      .get(projectId, userId) as ProjectRow | undefined
    return row ? toProject(row) : null
  }

  /** Create a project. Throws {@link InvalidInputError} on bad name/colour. */
  createProject(userId: string, input: CreateProjectInput): Project {
    const name = normalizeProjectName(input.name)
    const color = normalizeProjectColor(input.color)
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, color, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
      )
      .run(id, userId, name, color)
    const project = this.getProject(userId, id)
    if (!project) throw new Error(`[projects] Project ${id} vanished right after creation`)
    return project
  }

  /**
   * Rename / recolour / (un)archive a project. Returns the updated project, or
   * `null` when it does not exist or belongs to someone else (404 at the
   * route). Omitted fields stay untouched; archiving does NOT touch the
   * threads (they keep their `projectId` and reappear when it is unarchived).
   */
  updateProject(userId: string, projectId: string, patch: UpdateProjectPatch): Project | null {
    const existing = this.getProject(userId, projectId)
    if (!existing) return null

    const sets: string[] = []
    const params: unknown[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(normalizeProjectName(patch.name))
    }
    if (patch.color !== undefined) {
      sets.push('color = ?')
      params.push(normalizeProjectColor(patch.color))
    }
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== 'boolean') {
        throw new InvalidInputError('archived must be a boolean')
      }
      sets.push('archived = ?')
      params.push(patch.archived ? 1 : 0)
    }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')")
      this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params, projectId)
    }
    return this.getProject(userId, projectId)
  }

  /**
   * Delete a project and DETACH its threads (`project_id = NULL`). Threads are
   * never deleted along with their project — losing conversations because a
   * bucket was removed would be unrecoverable.
   *
   * Returns `false` when the project is unknown or foreign (route: 404).
   */
  deleteProject(userId: string, projectId: string): boolean {
    const existing = this.getProject(userId, projectId)
    if (!existing) return false

    const localDb = this.db
    localDb.transaction(() => {
      localDb.prepare('UPDATE sessions SET project_id = NULL WHERE project_id = ?').run(projectId)
      localDb.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(projectId, userId)
    })()
    return true
  }
}
