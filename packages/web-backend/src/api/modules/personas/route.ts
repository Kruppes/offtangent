/**
 * Persona routes (SPEC 13).
 *
 *   GET    /api/personas                     list, archived flagged not hidden
 *   POST   /api/personas                     create
 *   GET    /api/personas/:id                 detail: files + structured fields
 *   PUT    /api/personas/:id                 files, fields, archived, isDefault
 *   GET    /api/personas/:id/delete-preview  what a hard delete would remove
 *   DELETE /api/personas/:id?confirm=1       hard delete
 *
 * Errors answer `{ error, code }`. Codes: invalid_id, invalid_body,
 * persona_not_found, persona_exists, persona_busy, persona_is_default,
 * default_required, telegram_bound, confirm_required, internal_error.
 *
 * SPEC 13.7, non negotiable: every route here sits behind the JWT middleware
 * AND an admin check. There is no agent-facing path into this module — a
 * persona proposes changes to itself in chat, it never applies one.
 */
import express, { Router } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createPersonasController } from './controller.js'
import { createPersonasService } from './service.js'
import type { PersonaTurnGuard } from './service.js'

export interface PersonasRouterOptions {
  db: Database
  getTurnRunner?: () => PersonaTurnGuard | null
}

export function createPersonasRouter(options: PersonasRouterOptions): Router {
  const router = Router()
  const service = createPersonasService(options)
  const controller = createPersonasController(service)

  // Persona-specific body size limit (2 MB — supports up to 6 files × 256 KB + overhead)
  router.use(express.json({ limit: '2mb' }))

  // All persona endpoints require admin auth
  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required', code: 'forbidden' })
      return
    }
    next()
  })

  router.get('/', controller.list)
  router.post('/', controller.create)
  router.get('/:id', controller.get)
  router.put('/:id', controller.update)
  router.get('/:id/delete-preview', controller.deletePreview)
  router.delete('/:id', controller.remove)

  return router
}
