import { Router } from 'express'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createSettingsController } from './controller.js'
import type { SettingsRouterOptions } from './types.js'

export { type SettingsRouterOptions } from './types.js'

export function createSettingsRouter(options: SettingsRouterOptions = {}): Router {
  const router = Router()
  const controller = createSettingsController(options)

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }

    next()
  })

  router.get('/', controller.getSettings)
  router.put('/', controller.putSettings)

  return router
}
