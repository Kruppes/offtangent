/**
 * /api/boards (plan 2026-09-25) — the read side of the boards an agent
 * publishes with `publish_board`.
 *
 *   GET    /api/boards                        -> { boards: [...] }   (no payload)
 *   GET    /api/boards/:key                   -> Board incl. payload (object)
 *   GET    /api/boards/:key/revisions         -> { revisions: [...] }
 *   GET    /api/boards/:key/revisions/:n      -> the board state of that revision
 *   GET    /api/boards/:key/series?series=a,b&days=90 -> { series: { a: [...] } }
 *   GET    /api/boards/:key/content?t=        -> the document of an html_view.v1 board
 *   GET    /api/boards/:key/revisions/:n/content?t= -> the document of that revision
 *   DELETE /api/boards/:key                   -> 204 (admin only)
 *
 * The two content routes serve skill written HTML that a browser executes, so
 * they authenticate through a capability token (see the controller) and are
 * mounted BEFORE the JWT middleware, exactly like the artifact content route.
 *
 * The literal sub-paths are registered before `/:key` so a key can never
 * swallow them, exactly like the feed router does.
 */
import { Router } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import { createBoardsController } from './controller.js'
import { createBoardsService } from './service.js'

export interface BoardsRouterOptions {
  db: Database
}

export function createBoardsRouter(options: BoardsRouterOptions): Router {
  const controller = createBoardsController(createBoardsService(options))

  const router = Router()
  // Before `router.use(jwtMiddleware)`: an iframe cannot send an Authorization
  // header, and putting the access token in the URL would hand it to the
  // document. The capability token in `?t=` is the credential here.
  router.get('/:key/content', controller.content)
  router.get('/:key/revisions/:revision/content', controller.revisionContent)

  router.use(jwtMiddleware)
  router.get('/', controller.list)
  router.get('/:key/revisions', controller.revisions)
  router.get('/:key/revisions/:revision', controller.revision)
  router.get('/:key/series', controller.series)
  router.get('/:key', controller.get)
  router.delete('/:key', controller.remove)

  return router
}
