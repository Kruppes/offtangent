import { Router } from 'express'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import { jwtMiddleware } from '../auth.js'
import { listSelectableModels } from '../model-selection.js'

export function createModelsRouter(
  getQuotaSnapshot?: () => Record<string, ProviderQuotaContract>,
): Router {
  const router = Router()
  router.use(jwtMiddleware)
  router.get('/', (_req, res) => {
    try {
      res.json({ models: listSelectableModels(getQuotaSnapshot?.() ?? {}) })
    } catch (error) {
      res.status(500).json({ error: `Failed to load models: ${(error as Error).message}` })
    }
  })
  return router
}
