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
import {
  createInteractionsService,
  type CaptureBlockConfirmer,
  type InteractionTurnStarter,
  type InteractionsService,
} from './service.js'
import type { ChatEventBus } from '../../../chat-event-bus.js'

export interface InteractionsRouterOptions {
  db: Database
  getTurnRunner?: () => InteractionTurnStarter | null
  chatEventBus?: ChatEventBus | null
  /** The captures service, for the confirmation card a filed note carries. */
  getCaptureConfirmer?: () => CaptureBlockConfirmer | null
}

/**
 * The one interactions service of the app. Exported so a second door (the LED
 * clock, `/api/device/clock/answer`) answers through the very same code path,
 * broadcast included, instead of a copy that could drift.
 */
export function createSharedInteractionsService(options: InteractionsRouterOptions): InteractionsService {
  return createInteractionsService({
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
}

export function createInteractionsRouter(
  options: InteractionsRouterOptions & { service?: InteractionsService },
): Router {
  const service = options.service ?? createSharedInteractionsService(options)
  const controller = createInteractionsController(service)

  const router = Router()
  router.use(jwtMiddleware)
  router.post('/', controller.answer)

  return router
}
