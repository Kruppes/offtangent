import type { Database } from './database.js'
import { getConfiguredPriceTable } from './provider-config.js'
import type { TokenPriceTable } from './provider-config.js'

export type UsageGroupBy = 'provider' | 'model' | 'day' | 'hour'

export interface UsageStatsQueryOptions {
  groupBy?: UsageGroupBy[]
  dateFrom?: string
  dateTo?: string
  provider?: string
  model?: string
  priceTable?: TokenPriceTable
  /**
   * Filter by session type (resolved via JOIN on `sessions.type`):
   * - 'main' — interactive sessions (or NULL/orphan session_ids)
   * - 'task' — background agent-initiated sessions: `sessions.type` in
   *   ('task', 'consolidation', 'loop_detection'). Heartbeat is excluded
   *   because it has its own bucket.
   * - 'heartbeat' — agent heartbeat sessions (`sessions.type = 'heartbeat'`)
   * - undefined — all
   *
   * Invariant: `main + task + heartbeat == all` (every session row maps
   * to exactly one of the three buckets; NULL/orphan session_ids count
   * as 'main').
   */
  sessionType?: 'main' | 'task' | 'heartbeat'
}

export interface UsageTotals {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
}

export interface UsageStatsRow extends UsageTotals {
  provider?: string
  model?: string
  day?: string
  hour?: string
}

export interface UsageStatsResult {
  groupBy: UsageGroupBy[]
  rows: UsageStatsRow[]
  totals: UsageTotals
  availableProviders: string[]
  availableModels: string[]
}

export interface UsageSummary {
  today: UsageTotals
  week: UsageTotals
  month: UsageTotals
  allTime: UsageTotals
}

interface WhereOptions {
  includeProvider?: boolean
  includeModel?: boolean
}

const GROUP_SELECTS: Record<UsageGroupBy, string> = {
  provider: 'provider AS provider',
  model: 'model AS model',
  day: "date(timestamp) AS day",
  hour: "strftime('%Y-%m-%d %H:00:00', timestamp) AS hour",
}

const GROUP_EXPRESSIONS: Record<UsageGroupBy, string> = {
  provider: 'provider',
  model: 'model',
  day: 'date(timestamp)',
  hour: "strftime('%Y-%m-%d %H:00:00', timestamp)",
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

function buildPriceCase(kind: 'input' | 'output', priceTable: TokenPriceTable): string {
  const entries = Object.entries(priceTable).filter(([, prices]) => {
    const value = prices?.[kind]
    return typeof value === 'number' && Number.isFinite(value)
  })

  if (entries.length === 0) {
    return '0'
  }

  return `CASE model ${entries
    .map(([model, prices]) => `WHEN '${escapeSqlString(model)}' THEN ${prices[kind]}`)
    .join(' ')} ELSE 0 END`
}

function buildCostExpression(priceTable: TokenPriceTable): string {
  const inputCase = buildPriceCase('input', priceTable)
  const outputCase = buildPriceCase('output', priceTable)

  return `COALESCE(SUM(CASE
    WHEN estimated_cost > 0 THEN estimated_cost
    ELSE ((prompt_tokens * (${inputCase})) + (completion_tokens * (${outputCase}))) / 1000000.0
  END), 0)`
}

function buildWhereClause(options: UsageStatsQueryOptions, whereOptions: WhereOptions = {}): {
  clause: string
  params: unknown[]
} {
  const includeProvider = whereOptions.includeProvider !== false
  const includeModel = whereOptions.includeModel !== false
  const clauses = ['1=1']
  const params: unknown[] = []

  if (options.dateFrom) {
    clauses.push('datetime(timestamp) >= datetime(?)')
    params.push(options.dateFrom)
  }

  if (options.dateTo) {
    clauses.push('datetime(timestamp) <= datetime(?)')
    params.push(options.dateTo)
  }

  if (includeProvider && options.provider) {
    clauses.push('provider = ?')
    params.push(options.provider)
  }

  if (includeModel && options.model) {
    clauses.push('model = ?')
    params.push(options.model)
  }

  // Session type filter: JOIN on sessions.type. NULL session_ids / orphan
  // FKs map to 'main'. The three buckets partition every row exactly once
  // so totals are additive: main + task + heartbeat == all.
  //   'task'      -> sessions.type IN ('task', 'consolidation', 'loop_detection')
  //   'heartbeat' -> sessions.type = 'heartbeat'
  //   'main'      -> sessions.type = 'interactive' OR session_id orphaned/NULL
  if (options.sessionType === 'task') {
    clauses.push("EXISTS (SELECT 1 FROM sessions s WHERE s.id = token_usage.session_id AND s.type IN ('task', 'consolidation', 'loop_detection'))")
  } else if (options.sessionType === 'heartbeat') {
    clauses.push("EXISTS (SELECT 1 FROM sessions s WHERE s.id = token_usage.session_id AND s.type = 'heartbeat')")
  } else if (options.sessionType === 'main') {
    clauses.push("(token_usage.session_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = token_usage.session_id AND s.type IN ('task', 'heartbeat', 'consolidation', 'loop_detection')))")
  }

  return {
    clause: clauses.join(' AND '),
    params,
  }
}

function normalizeTotals(row?: {
  requests?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
  estimatedCost?: number | null
}): UsageTotals {
  const requests = row?.requests ?? 0
  const promptTokens = row?.promptTokens ?? 0
  const completionTokens = row?.completionTokens ?? 0
  const estimatedCost = row?.estimatedCost ?? 0

  return {
    requests,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheRead: row?.cacheRead ?? 0,
    cacheWrite: row?.cacheWrite ?? 0,
    estimatedCost,
  }
}

function getUsageTotalsInternal(db: Database, options: UsageStatsQueryOptions): UsageTotals {
  const priceTable = options.priceTable ?? getConfiguredPriceTable()
  const costExpression = buildCostExpression(priceTable)
  const { clause, params } = buildWhereClause(options)

  const row = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
      COALESCE(SUM(completion_tokens), 0) AS completionTokens,
      COALESCE(SUM(cache_read), 0) AS cacheRead,
      COALESCE(SUM(cache_write), 0) AS cacheWrite,
      ${costExpression} AS estimatedCost
    FROM token_usage
    WHERE ${clause}
  `).get(...params) as {
    requests?: number | null
    promptTokens?: number | null
    completionTokens?: number | null
    cacheRead?: number | null
    cacheWrite?: number | null
    estimatedCost?: number | null
  } | undefined

  return normalizeTotals(row)
}

export function queryUsageStats(db: Database, options: UsageStatsQueryOptions = {}): UsageStatsResult {
  const priceTable = options.priceTable ?? getConfiguredPriceTable()
  const groupBy = Array.from(new Set(options.groupBy ?? []))
  const costExpression = buildCostExpression(priceTable)
  const { clause, params } = buildWhereClause(options)
  const totals = getUsageTotalsInternal(db, { ...options, priceTable })

  const selectGroups = groupBy.map((group) => GROUP_SELECTS[group])
  const groupExpressions = groupBy.map((group) => GROUP_EXPRESSIONS[group])

  const rows = db.prepare(`
    SELECT
      ${selectGroups.length > 0 ? `${selectGroups.join(', ')},` : ''}
      COUNT(*) AS requests,
      COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
      COALESCE(SUM(completion_tokens), 0) AS completionTokens,
      COALESCE(SUM(cache_read), 0) AS cacheRead,
      COALESCE(SUM(cache_write), 0) AS cacheWrite,
      ${costExpression} AS estimatedCost
    FROM token_usage
    WHERE ${clause}
    ${groupExpressions.length > 0 ? `GROUP BY ${groupExpressions.join(', ')}` : ''}
    ${groupBy.includes('day') || groupBy.includes('hour')
      ? `ORDER BY ${groupExpressions.join(', ')}`
      : `ORDER BY estimatedCost DESC, requests DESC${groupExpressions.length > 0 ? `, ${groupExpressions.join(', ')}` : ''}`}
  `).all(...params) as Array<{
    provider?: string
    model?: string
    day?: string
    hour?: string
    requests?: number | null
    promptTokens?: number | null
    completionTokens?: number | null
    cacheRead?: number | null
    cacheWrite?: number | null
    estimatedCost?: number | null
  }>

  const providerWhere = buildWhereClause(options, { includeProvider: false })
  const modelWhere = buildWhereClause(options, { includeModel: false })

  const availableProviders = (db.prepare(`
    SELECT DISTINCT provider
    FROM token_usage
    WHERE ${providerWhere.clause}
    ORDER BY provider ASC
  `).all(...providerWhere.params) as Array<{ provider: string }>).map((row) => row.provider)

  const availableModels = (db.prepare(`
    SELECT DISTINCT model
    FROM token_usage
    WHERE ${modelWhere.clause}
    ORDER BY model ASC
  `).all(...modelWhere.params) as Array<{ model: string }>).map((row) => row.model)

  return {
    groupBy,
    rows: rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      day: row.day,
      hour: row.hour,
      ...normalizeTotals(row),
    })),
    totals,
    availableProviders,
    availableModels,
  }
}

function getStartOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

function getStartOfWeek(date: Date): Date {
  const start = getStartOfDay(date)
  const day = start.getDay()
  const offset = day === 0 ? 6 : day - 1
  start.setDate(start.getDate() - offset)
  return start
}

function getStartOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0)
}

export function getUsageSummary(db: Database, now: Date = new Date(), priceTable?: TokenPriceTable): UsageSummary {
  const effectivePriceTable = priceTable ?? getConfiguredPriceTable()
  const nowIso = now.toISOString()

  return {
    today: getUsageTotalsInternal(db, {
      dateFrom: getStartOfDay(now).toISOString(),
      dateTo: nowIso,
      priceTable: effectivePriceTable,
    }),
    week: getUsageTotalsInternal(db, {
      dateFrom: getStartOfWeek(now).toISOString(),
      dateTo: nowIso,
      priceTable: effectivePriceTable,
    }),
    month: getUsageTotalsInternal(db, {
      dateFrom: getStartOfMonth(now).toISOString(),
      dateTo: nowIso,
      priceTable: effectivePriceTable,
    }),
    allTime: getUsageTotalsInternal(db, {
      priceTable: effectivePriceTable,
    }),
  }
}
