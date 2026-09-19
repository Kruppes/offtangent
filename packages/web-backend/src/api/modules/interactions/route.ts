/**
 * /api/interactions (SPEC 7.4c) — the answer of a tapped card.
 *
 *   POST /api/interactions { messageId, blockId, value, clientMessageId }
 *     -> 200 { applied: true, resumed, idempotent, value, label }
 *        400 invalid_body | invalid_message_id | invalid_block_id
 *            | invalid_client_message_id | invalid_value
 *        404 unknown_message | unknown_block
 *        409 already_answered  (+ the stored value/label)
 *        410 stale             (strand deleted, or the block expired)
 */
import { Router } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import { createInteractionsController } from './controller.js'
import { createInteractionsService, type CaptureBlockConfirmer, type InteractionTurnStarter } from './service.js'
import type { ChatEventBus } from '../../../chat-event-bus.js'

export interface InteractionsRouterOptions {
  db: Database
  getTurnRunner?: () => InteractionTurnStarter | null
  chatEventBus?: ChatEventBus | null
  /** The captures service, for the confirmation card a filed note carries. */
  getCaptureConfirmer?: () => CaptureBlockConfirmer | null
}

export function createInteractionsRouter(options: InteractionsRouterOptions): Router {
  const service = createInteractionsService({
    db: options.db,
    getTurnRunner: options.getTurnRunner,
    getCaptureConfirmer: options.getCaptureConfirmer,
    broadcast: input => {
      // Other tabs collapse the card to its chip without a reload. The answer
      // itself also travels as an ordinary `user_message`.
      options.chatEventBus?.broadcast({
        type: 'user_message',
        userId: input.userId,
        source: 'web',
        sessionId: input.sessionId,
        agentId: input.agentId,
        text: input.label,
      })
    },
  })
  const controller = createInteractionsController(service)

  const router = Router()
  router.use(jwtMiddleware)
  router.post('/', controller.answer)

  return router
}
