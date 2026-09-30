import { Router } from 'express'
import type { NextFunction, Response } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createEmailController } from './controller.js'

export interface EmailRouterOptions {
  db: Database
  onAccountsChanged?: () => void
}

export function createEmailRouter(options: EmailRouterOptions): Router {
  const router = Router()
  const controller = createEmailController({ db: options.db, onAccountsChanged: options.onAccountsChanged })

  router.use(jwtMiddleware)

  router.get('/configured', controller.isConfigured)

  // Read-only audit view — every authenticated user may inspect what the agent sent.
  router.get('/sent-log', controller.listSendLog)
  router.get('/sent-log/:id', controller.getSendLogEntry)

  // Approval decisions are open to every authenticated user, not just admins.
  router.post('/sent-log/:id/approve', controller.approveSendLogEntry)
  router.post('/sent-log/:id/reject', controller.rejectSendLogEntry)
  router.post('/sent-log/:id/retry', controller.retrySendLogEntry)

  router.use('/accounts', (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }

    next()
  })

  router.get('/accounts', controller.listAccounts)
  router.post('/accounts', controller.createAccount)
  router.post('/accounts/test-connection', controller.testConnection)
  router.post('/accounts/folders', controller.listFolders)
  router.get('/accounts/:id', controller.getAccount)
  router.put('/accounts/:id', controller.updateAccount)
  router.delete('/accounts/:id', controller.deleteAccount)

  return router
}
