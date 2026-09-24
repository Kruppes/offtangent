/**
 * /api/captures and /api/router (SPEC 6.1).
 *
 *   POST /api/captures                 { text, clientMessageId?, agentId?, strandId?, kind?, source?, attachments?, intent? }
 *                                      -> 201 { capture, decision } | 200 on a known clientMessageId
 *   GET  /api/captures?status=&limit=&offset=  -> { captures, decisions, parts }
 *   GET  /api/captures/:id             -> { capture, decision, parts, partCount, split }
 *   POST /api/captures/:id/apply       { decisionId?, action?, strandId?, title?, personaId?, partIndex? } -> { capture, decision }
 *   POST /api/captures/:id/undo        { strandId?, partIndex? } -> { capture, decision }   (no partIndex undoes every part)
 *   POST /api/captures/:id/keep-as-one {} -> { capture, decision }   (undo every part, route the original text as one)
 *   POST /api/captures/:id/dismiss     {} -> { capture, decision }   (tray card thrown away, undo restores)
 *   POST /api/router/preview           { text, agentId? } -> { decision }   (admin, no writes)
 */
import { Router } from 'express'
import type { AgentCore, Database, ResolvedRouterModel, RouterCompletion } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import type { ChatEventBus } from '../../../chat-event-bus.js'
import { createCapturesController } from './controller.js'
import { createCapturesService, type CapturesService, type CapturesServiceOptions, type CaptureTurnStarter } from './service.js'

export interface CapturesRouterOptions {
  db: Database
  getAgentCore: () => AgentCore | null
  chatEventBus?: ChatEventBus | null
  getTurnRunner?: () => CaptureTurnStarter | null
  /** Doorbell for a question the service wrote into a strand (PROTOCOL 7). */
  sendDoorbell?: CapturesServiceOptions['sendDoorbell']
  routerChain?: () => ResolvedRouterModel[] | undefined
  routerComplete?: RouterCompletion
  /** Test hook for the two split stages, same role as `routerComplete`. */
  splitComplete?: CapturesServiceOptions['splitComplete']
  /** Now-set size / fill mode, injectable for tests (default: `settings.json`). */
  getNowSetMax?: CapturesServiceOptions['getNowSetMax']
  getNowSetMode?: CapturesServiceOptions['getNowSetMode']
}

export function createCapturesRouters(
  options: CapturesRouterOptions,
): { captures: Router; router: Router; service: CapturesService } {
  const service = createCapturesService(options)
  const controller = createCapturesController(service)

  const captures = Router()
  captures.use(jwtMiddleware)
  captures.post('/', controller.create)
  captures.get('/', controller.list)
  captures.get('/:id', controller.get)
  captures.post('/:id/apply', controller.apply)
  captures.post('/:id/undo', controller.undo)
  captures.post('/:id/keep-as-one', controller.keepAsOne)
  captures.post('/:id/dismiss', controller.dismiss)

  const router = Router()
  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })
  router.post('/preview', controller.preview)

  // The service is handed out so `/api/feed/:id/ask` can create its capture
  // through exactly this instance — one router path, no second copy.
  return { captures, router, service }
}
