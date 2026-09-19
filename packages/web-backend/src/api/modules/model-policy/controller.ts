import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createModelPolicyService, ModelPolicyValidationError } from './service.js'

export interface ModelPolicyController {
  getPolicy: (req: AuthenticatedRequest, res: Response) => void
  putPolicy: (req: AuthenticatedRequest, res: Response) => void
  getResolve: (req: AuthenticatedRequest, res: Response) => void
}

function fail(res: Response, err: unknown, prefix: string): void {
  if (err instanceof ModelPolicyValidationError) {
    res.status(400).json({ error: err.message, code: err.code })
    return
  }
  res.status(500).json({ error: `${prefix}: ${(err as Error).message}` })
}

export function createModelPolicyController(): ModelPolicyController {
  const service = createModelPolicyService()

  return {
    getPolicy(_req, res) {
      try {
        res.json(service.read())
      } catch (err) {
        fail(res, err, 'Failed to read model policy')
      }
    },

    putPolicy(req, res) {
      try {
        res.json(service.update((req.body ?? {}) as Record<string, unknown>))
      } catch (err) {
        fail(res, err, 'Failed to update model policy')
      }
    },

    getResolve(req, res) {
      try {
        const query = req.query as Record<string, unknown>
        res.json(service.resolve({
          role: typeof query.role === 'string' ? query.role : undefined,
          kind: typeof query.kind === 'string' ? query.kind : undefined,
          agentId: typeof query.agentId === 'string' ? query.agentId : undefined,
        }))
      } catch (err) {
        fail(res, err, 'Failed to resolve model policy role')
      }
    },
  }
}
