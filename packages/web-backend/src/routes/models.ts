import { Router } from 'express'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import { jwtMiddleware, type AuthenticatedRequest } from '../auth.js'
import { listSelectableModels } from '../model-selection.js'

export function createModelsRouter(
  getQuotaSnapshot?: () => Record<string, ProviderQuotaContract>,
): Router {
  const router = Router()
  router.use(jwtMiddleware)
  router.get('/', (req: AuthenticatedRequest, res) => {
    try {
      const snapshot = getQuotaSnapshot?.() ?? {}
      res.json({ models: listSelectableModels(req.user?.role === 'admin' ? snapshot : withoutBalances(snapshot)) })
    } catch (error) {
      res.status(500).json({ error: `Failed to load models: ${(error as Error).message}` })
    }
  })
  return router
}

/**
 * The prepaid account balance (e.g. a Moonshot API key's credit) is account
 * money and stays admin-only, like the top-bar indicator. Usage windows are
 * left untouched for every signed-in user.
 */
function withoutBalances(snapshot: Record<string, ProviderQuotaContract>): Record<string, ProviderQuotaContract> {
  const out: Record<string, ProviderQuotaContract> = {}
  for (const [providerId, quota] of Object.entries(snapshot)) {
    if (quota.balance === undefined) { out[providerId] = quota; continue }
    const { balance: _balance, ...rest } = quota
    out[providerId] = rest
  }
  return out
}
