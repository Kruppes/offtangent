/**
 * Canvas artifacts (SPEC 7.4b, R2).
 *
 *   GET /api/artifacts?strandId=&limit=&offset=  -> { artifacts: ArtifactRef[] }
 *   GET /api/artifacts/:id                       -> { artifact, contentUrl, contentExpiresAt, embed }
 *   GET /api/artifacts/:id/content?t=<token>     -> raw bytes, locked down headers
 *
 * The content route carries the only bytes in this system that are written by
 * a language model and executed by a browser, so it authenticates differently
 * from every other route (see the controller) and is mounted BEFORE the JWT
 * middleware on purpose.
 */
import { Router } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import { createArtifactsController } from './controller.js'
import { createArtifactsService } from './service.js'

export interface ArtifactsRouterOptions {
  db: Database
}

export function createArtifactsRouter(options: ArtifactsRouterOptions): Router {
  const service = createArtifactsService({ db: options.db })
  const controller = createArtifactsController(service)

  const router = Router()

  // Registered before `router.use(jwtMiddleware)` so the capability token is
  // the credential here. An iframe cannot send an Authorization header, and
  // putting the access token in the URL would hand it to the artifact.
  router.get('/:id/content', controller.content)

  router.use(jwtMiddleware)
  router.get('/', controller.list)
  router.get('/:id', controller.detail)

  return router
}
