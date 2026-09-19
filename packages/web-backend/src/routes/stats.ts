import { Router } from 'express'
import type { Database, UsageGroupBy } from '@axiom/core'
import { getUsageSummary, queryStallStats, queryUsageStats } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

const VALID_GROUPS: UsageGroupBy[] = ['provider', 'model', 'day', 'hour']

function parseGroupBy(value: string | string[] | undefined): UsageGroupBy[] {
  const raw = Array.isArray(value) ? value.join(',') : value ?? ''
  const groups = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  const invalid = groups.filter((entry) => !VALID_GROUPS.includes(entry as UsageGroupBy))
  if (invalid.length > 0) {
    throw new Error(`Invalid group_by values: ${invalid.join(', ')}`)
  }

  return groups as UsageGroupBy[]
}

function normalizeDateInput(value: unknown, endOfDay: boolean): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined
  }

  const trimmed = value.trim()
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    )

    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid date: ${trimmed}`)
    }

    return date.toISOString()
  }

  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${trimmed}`)
  }

  return date.toISOString()
}

function normalizeFilter(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function createStatsRouter(db: Database): Router {
  const router = Router()

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  router.get('/usage', (req: AuthenticatedRequest, res) => {
    try {
      const dateFrom = normalizeDateInput(req.query.date_from ?? req.query.start_date, false)
      const dateTo = normalizeDateInput(req.query.date_to ?? req.query.end_date, true)

      if (dateFrom && dateTo && new Date(dateFrom) > new Date(dateTo)) {
        res.status(400).json({ error: 'date_from must be before or equal to date_to' })
        return
      }

      const sessionTypeParam = normalizeFilter(req.query.session_type)
      const sessionType = sessionTypeParam === 'main' || sessionTypeParam === 'task' || sessionTypeParam === 'heartbeat'
        ? sessionTypeParam
        : undefined

      const result = queryUsageStats(db, {
        groupBy: parseGroupBy(req.query.group_by as string | string[] | undefined),
        dateFrom,
        dateTo,
        provider: normalizeFilter(req.query.provider),
        model: normalizeFilter(req.query.model),
        sessionType,
      })

      res.json({
        filters: {
          dateFrom,
          dateTo,
          provider: normalizeFilter(req.query.provider) ?? null,
          model: normalizeFilter(req.query.model) ?? null,
        },
        ...result,
      })
    } catch (err) {
      const message = (err as Error).message
      const status = message.startsWith('Invalid') ? 400 : 500
      res.status(status).json({ error: message })
    }
  })

  router.get('/stalls', (req: AuthenticatedRequest, res) => {
    try {
      const dateFrom = normalizeDateInput(req.query.date_from ?? req.query.start_date, false)
      const dateTo = normalizeDateInput(req.query.date_to ?? req.query.end_date, true)

      if (dateFrom && dateTo && new Date(dateFrom) > new Date(dateTo)) {
        res.status(400).json({ error: 'date_from must be before or equal to date_to' })
        return
      }

      res.json({
        filters: { dateFrom: dateFrom ?? null, dateTo: dateTo ?? null },
        ...queryStallStats(db, { dateFrom, dateTo }),
      })
    } catch (err) {
      const message = (err as Error).message
      const status = message.startsWith('Invalid') ? 400 : 500
      res.status(status).json({ error: message })
    }
  })

  router.get('/summary', (_req, res) => {
    try {
      res.json(getUsageSummary(db))
    } catch (err) {
      res.status(500).json({ error: `Failed to read usage summary: ${(err as Error).message}` })
    }
  })

  return router
}
