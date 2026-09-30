import { Router } from 'express'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createMemoryController } from './controller.js'
import type { MemoryModuleOptions } from './types.js'

export type MemoryRouterOptions = MemoryModuleOptions

export function createMemoryRouter(options: MemoryRouterOptions): Router {
  const router = Router()
  const controller = createMemoryController(options)

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }

    next()
  })

  // Generic memory file tree (whole /data/memory folder); file path passed via ?path=
  router.get('/files', controller.getFileTree)
  router.get('/file', controller.getFile)
  router.put('/file', controller.putFile)
  router.delete('/file', controller.deleteFile)

  router.get('/soul', controller.getSoul)
  router.put('/soul', controller.putSoul)

  // Core memory endpoints (MEMORY.md)
  // Support both /memory (new) and /agents (legacy) paths
  router.get('/core', controller.getCoreMemory)
  router.put('/core', controller.putCoreMemory)

  // Agent rules endpoints (AGENTS.md)
  router.get('/agents', controller.getAgentRules)
  router.put('/agents', controller.putAgentRules)
  router.get('/agents/default', controller.getDefaultAgentRules)

  router.get('/daily', controller.listDailyFiles)
  router.get('/daily/:date', controller.getDailyFile)
  router.put('/daily/:date', controller.putDailyFile)

  // Wiki page endpoints (/data/memory/wiki/*.md)
  // Also keep /projects/* as legacy aliases for backward compatibility
  router.get('/wiki', controller.listWikiPages)
  router.get('/wiki/:filename', controller.getWikiPage)
  router.put('/wiki/:filename', controller.putWikiPage)
  router.delete('/wiki/:filename', controller.deleteWikiPage)

  // Legacy /projects/* aliases for backward compatibility
  router.get('/projects', controller.listProjects)
  router.get('/projects/:name', controller.getProject)
  router.put('/projects/:name', controller.putProject)

  // Heartbeat endpoints (HEARTBEAT.md — agent heartbeat task list)
  router.get('/heartbeat', controller.getHeartbeat)
  router.put('/heartbeat', controller.putHeartbeat)
  router.get('/heartbeat/default', controller.getDefaultHeartbeat)

  // User profile endpoints
  router.get('/profile', controller.getProfile)
  router.put('/profile', controller.putProfile)

  router.get('/facts', controller.listFacts)
  router.get('/usage-stats', controller.getUsageStats)
  router.put('/facts/:id', controller.putFact)
  router.delete('/facts/:id', controller.deleteFact)

  // Consolidation rules endpoints (CONSOLIDATION.md)
  router.get('/consolidation-rules', controller.getConsolidationRules)
  router.put('/consolidation-rules', controller.putConsolidationRules)
  router.get('/consolidation-rules/default', controller.getDefaultConsolidationRules)

  router.get('/tasks-guidelines', controller.getTasksGuidelines)
  router.put('/tasks-guidelines', controller.putTasksGuidelines)
  router.get('/tasks-guidelines/default', controller.getDefaultTasksGuidelines)

  // Consolidation endpoints
  router.get('/consolidation/status', controller.getConsolidationStatus)
  router.post('/consolidation/run', controller.runConsolidation)

  return router
}
