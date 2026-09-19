/**
 * /api/feed (SPEC 6.4) — everything unsolicited, out of the strand dialogue.
 *
 *   GET  /api/feed?since_id=&limit=50&kind=&unread_only=  -> { items: FeedItem[] }
 *   POST /api/feed/:id/read        -> 204 (idempotent)
 *   POST /api/feed/read-all        -> 204
 *   GET  /api/feed/unread-count    -> { count }
 *   POST /api/feed/:id/ask { text? } -> 201 { capture, decision }
 *
 * `read-all` and `unread-count` are registered before the `/:id` routes so a
 * literal path can never be swallowed by the id parameter.
 */
import { Router } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import { createFeedController } from './controller.js'
import { createFeedService, type FeedCaptureCreator } from './service.js'

export interface FeedRouterOptions {
  db: Database
  /** The captures service, so `ask` uses the one existing router path. */
  getCaptureCreator?: () => FeedCaptureCreator | null
}

export function createFeedRouter(options: FeedRouterOptions): Router {
  const service = createFeedService(options)
  const controller = createFeedController(service)

  const router = Router()
  router.use(jwtMiddleware)
  router.get('/', controller.list)
  router.get('/unread-count', controller.unreadCount)
  router.post('/read-all', controller.readAll)
  router.post('/:id/read', controller.read)
  router.post('/:id/ask', controller.ask)

  return router
}
