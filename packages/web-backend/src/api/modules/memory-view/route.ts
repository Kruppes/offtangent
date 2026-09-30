/**
 * Structured memory view (SPEC 6.4), read only:
 *
 *   GET /api/memory/tree?agent_id=&q=&only_with_facts=1
 *        -> { generatedAt, totals, limits, notes, nodes[] }
 *   GET /api/memory/facts?node=<id>&limit=&cursor=&q=&include_superseded=1
 *        -> { node, facts[], total, limit, nextCursor, conflictScanLimit }
 *   GET /api/memory/graph?root=<id>&depth=1..2&limit=1..300
 *        -> { root, depth, nodeLimit, truncated, nodes[], edges[] }
 *   GET /api/memory/fact/:id
 *        -> { fact, node, origin, supersedes[], supersededBy, history[], conflicts[] }
 *
 * This router is mounted on `/api/memory` BEFORE the admin memory router so
 * a normal user can read the view. `GET /api/memory/facts` without `node`
 * falls through to the admin fact list, which keeps its old behaviour.
 */
import { Router } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import { createMemoryViewController } from './controller.js'
import { createMemoryViewService } from './service.js'

export interface MemoryViewRouterOptions {
  db: Database
  /** Tests and offline tools: never refresh page embeddings in the background. */
  disableBackgroundRefresh?: boolean
}

export function createMemoryViewRouter(options: MemoryViewRouterOptions): Router {
  const controller = createMemoryViewController(createMemoryViewService(options))

  const router = Router()
  router.use(jwtMiddleware)
  router.get('/tree', controller.getTree)
  router.get('/facts', controller.getFacts)
  router.get('/graph', controller.getGraph)
  router.get('/fact/:id', controller.getFact)
  return router
}
