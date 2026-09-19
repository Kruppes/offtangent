/**
 * /api/projects — projects light (Offtangent Stufe 2): a flat grouping layer
 * above threads. A project is a named, optionally coloured bucket owned by one
 * user; threads point at it via `projectId` (see /api/threads).
 *
 * Contract (the Android app and the web frontend are built against it):
 *   GET    /api/projects?include_archived=0|1 -> { projects: Project[] }
 *   POST   /api/projects   { name, color? }            -> 201 { project }
 *   PATCH  /api/projects/:id { name?, color?, archived? } -> { project }
 *   DELETE /api/projects/:id -> 204, threads are detached (never deleted)
 *
 * Unknown and foreign projects are both 404 — indistinguishable on purpose.
 */
import { Router } from 'express'
import type { Database } from '@axiom/core'
import { InvalidInputError, ProjectManager } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export interface ProjectsRouterOptions {
  db: Database
}

/** Parse an optional boolean-ish query flag ('1', 'true', 'yes'). */
function parseFlag(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'
}

/** Validation failures are user errors, not server errors: 400 with the message. */
function isValidationError(err: unknown): boolean {
  if (err instanceof InvalidInputError) return true
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'INVALID_INPUT'
}

export function createProjectsRouter(options: ProjectsRouterOptions): Router {
  const router = Router()
  const projects = new ProjectManager(options.db)

  router.use(jwtMiddleware)

  router.get('/', (req: AuthenticatedRequest, res) => {
    res.json({
      projects: projects.listProjects(String(req.user!.userId), {
        includeArchived: parseFlag(req.query.include_archived),
      }),
    })
  })

  router.post('/', (req: AuthenticatedRequest, res) => {
    const { name, color } = req.body ?? {}
    try {
      const project = projects.createProject(String(req.user!.userId), { name, color })
      res.status(201).json({ project })
    } catch (err) {
      if (isValidationError(err)) {
        res.status(400).json({ error: (err as Error).message })
        return
      }
      throw err
    }
  })

  router.patch('/:id', (req: AuthenticatedRequest, res) => {
    const { name, color, archived } = req.body ?? {}
    try {
      const project = projects.updateProject(String(req.user!.userId), String(req.params.id), {
        ...(name !== undefined ? { name } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(archived !== undefined ? { archived } : {}),
      })
      if (!project) {
        res.status(404).json({ error: 'Project not found' })
        return
      }
      res.json({ project })
    } catch (err) {
      if (isValidationError(err)) {
        res.status(400).json({ error: (err as Error).message })
        return
      }
      throw err
    }
  })

  /**
   * Deleting a project detaches its threads (`projectId` back to `null`); the
   * conversations themselves are never touched.
   */
  router.delete('/:id', (req: AuthenticatedRequest, res) => {
    const deleted = projects.deleteProject(String(req.user!.userId), String(req.params.id))
    if (!deleted) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    res.status(204).end()
  })

  return router
}
