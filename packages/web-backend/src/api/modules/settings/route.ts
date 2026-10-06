import { loadGeneratorConfig } from '@axiom/core'
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

  router.get('/generators', (_req, res) => {
    try {
      const config = loadGeneratorConfig()
      res.json({ default_route: config.default_route, errors: config.errors, routes: config.routes.map(r => ({
        id: r.id, label: r.label, backend: r.backend, model: r.model, cost: r.cost, status: r.status,
      })) })
    } catch (error) {
      res.json({ default_route: '', routes: [], errors: [error instanceof Error ? error.message : 'Unable to read generator config'] })
    }
  })
  router.get('/', controller.getSettings)
  router.put('/', controller.putSettings)

  return router
}
