import { Router } from 'express'
import type { NextFunction, Response } from 'express'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createConnectorsController } from './controller.js'
import type { ConnectorsServiceOptions } from './service.js'

export type ConnectorsRouterOptions = ConnectorsServiceOptions

export function createConnectorsRouter(options: ConnectorsRouterOptions = {}): Router {
  const router = Router()
  const controller = createConnectorsController(options)

  // Mounted BEFORE the JWT middleware: the browser returns from the upstream
  // consent screen without our token. The single-use `state` is the guard.
  router.get('/:id/callback', controller.callback)

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  router.get('/', controller.list)
  router.get('/local-model', controller.localModel)
  router.put('/local-model', controller.setLocalModel)
  router.put('/:id/client', controller.setClient)
  router.get('/:id/authorize', controller.authorize)
  router.post('/:id/test', controller.test)
  router.delete('/:id/connection', controller.disconnect)

  return router
}
