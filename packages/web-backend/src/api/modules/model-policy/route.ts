import { Router } from 'express'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createModelPolicyController } from './controller.js'

/**
 * `/api/model-policy` — the model policy roles (ADR 2026-09-13).
 * Admin-only, like `/api/settings`: this decides which model every background
 * job runs on, which is deployment configuration, not user preference.
 */
export function createModelPolicyRouter(): Router {
  const router = Router()
  const controller = createModelPolicyController()

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }

    next()
  })

  router.get('/resolve', controller.getResolve)
  router.get('/', controller.getPolicy)
  router.put('/', controller.putPolicy)

  return router
}
