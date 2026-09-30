import type { NextFunction, Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { parseFactDetailParams, parseGraphQuery, parseNodeFactsQuery, parseTreeQuery } from './schema.js'
import { MemoryViewError, type MemoryViewService } from './service.js'

export interface MemoryViewController {
  getTree: (req: AuthenticatedRequest, res: Response) => void
  getFacts: (req: AuthenticatedRequest, res: Response, next: NextFunction) => void
  getGraph: (req: AuthenticatedRequest, res: Response) => void
  getFact: (req: AuthenticatedRequest, res: Response) => void
}

function run(res: Response, context: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    if (err instanceof MemoryViewError) {
      res.status(err.status).json({ error: err.message, code: err.code })
      return
    }
    console.error(`[memory-view] ${context}:`, err)
    res.status(500).json({ error: `${context}: ${(err as Error).message}` })
  }
}

export function createMemoryViewController(service: MemoryViewService): MemoryViewController {
  const isAdmin = (req: AuthenticatedRequest): boolean => req.user?.role === 'admin'

  return {
    getTree(req, res) {
      const parsed = parseTreeQuery(req.query as Record<string, unknown>)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to build memory tree', () => {
        res.json(service.tree(req.user!.userId, isAdmin(req), parsed.value))
      })
    },

    getFacts(req, res, next) {
      // Without `node` this is the legacy admin fact list, which is mounted
      // behind this router on the same path. Hand the request over instead of
      // shadowing it.
      if (req.query.node === undefined || req.query.node === '') {
        next()
        return
      }
      const parsed = parseNodeFactsQuery(req.query as Record<string, unknown>)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to list node facts', () => {
        res.json(service.facts(req.user!.userId, isAdmin(req), parsed.value))
      })
    },

    getGraph(req, res) {
      const parsed = parseGraphQuery(req.query as Record<string, unknown>)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to build memory graph', () => {
        res.json(service.graph(req.user!.userId, isAdmin(req), parsed.value))
      })
    },

    getFact(req, res) {
      const parsed = parseFactDetailParams(req.params.id, req.query as Record<string, unknown>)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to read fact', () => {
        res.json(service.fact(req.user!.userId, isAdmin(req), parsed.value.id, parsed.value.agentId))
      })
    },
  }
}
