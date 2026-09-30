import { Router } from 'express'
import type { Database } from '@axiom/core'
import { queryToolCalls, getToolCallById, getDistinctToolNames } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

function truncate(str: string | null | undefined, maxLen: number = 200): string {
  if (!str) return ''
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str
}

export function createLogsRouter(db: Database): Router {
  const router = Router()

  // All logs routes require admin JWT
  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  /**
   * GET /api/logs
   * Paginated, filterable tool call log
   */
  router.get('/', (req: AuthenticatedRequest, res) => {
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50))

    // Accept both `session_type` (canonical) and the legacy `source` param
    // name used by older clients. Both resolve to the same filter contract.
    const rawSessionType = (req.query.session_type ?? req.query.source) as string | undefined
    const validTypes = ['main', 'task'] as const
    const sessionType = rawSessionType && validTypes.includes(rawSessionType as 'main' | 'task')
      ? (rawSessionType as 'main' | 'task')
      : undefined

    const result = queryToolCalls(db, {
      sessionId: req.query.session_id as string | undefined,
      toolName: req.query.tool_name as string | undefined,
      search: req.query.search as string | undefined,
      dateFrom: req.query.date_from as string | undefined,
      dateTo: req.query.date_to as string | undefined,
      sessionType,
      page,
      limit,
    })

    // Truncate input/output in list view
    const records = result.records.map((r: { input: string; output: string }) => ({
      ...r,
      input: truncate(r.input),
      output: truncate(r.output),
    }))

    res.json({
      logs: records,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    })
  })

  /**
   * GET /api/logs/tool-names
   * Distinct tool names for filter dropdown
   */
  router.get('/tool-names', (_req: AuthenticatedRequest, res) => {
    const names = getDistinctToolNames(db)
    res.json({ toolNames: names })
  })

  /**
   * GET /api/logs/:id
   * Full untruncated log entry
   */
  router.get('/:id', (req: AuthenticatedRequest, res) => {
    const id = parseInt(req.params.id as string)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid log ID' })
      return
    }

    const record = getToolCallById(db, id)
    if (!record) {
      res.status(404).json({ error: 'Log entry not found' })
      return
    }

    res.json({ log: record })
  })

  return router
}
