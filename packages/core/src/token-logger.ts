import type { Database } from './database.js'

export interface TokenUsageRecord {
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
  sessionId?: string
}

export interface ToolCallRecord {
  id?: number
  timestamp?: string
  sessionId: string
  toolName: string
  input: string
  output: string
  durationMs: number
  status?: 'success' | 'error'
  /** Joined from `sessions.type` (populated by queries that JOIN sessions) */
  sessionType?: string | null
  /** Joined from `sessions.source` (populated by queries that JOIN sessions) */
  sessionSource?: string | null
}

/**
 * Tool names that are NOT tool calls: internal metric rows written to
 * `tool_calls` per SPEC 12.2 (context window, summary and extraction
 * accounting). Views that replay a session's tool calls to a user filter
 * these out — they are diagnostics, not work the agent did.
 */
export const INTERNAL_METRIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'strand_context',
  'task_history',
  'session_summary_delta',
  'fact_extraction',
  // Background task accounting (token audit 2026-09-17, P5c/P7): one
  // `task_usage` row per finished task run (tokens, cost, cache read ratio)
  // and one `task_guard` row whenever a progress guard aborted a task.
  'task_usage',
  'task_guard',
])

/**
 * Log token usage to the SQLite database
 */
export function logTokenUsage(db: Database, record: TokenUsageRecord): void {
  db.prepare(
    `INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, cache_read, cache_write, estimated_cost, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.provider,
    record.model,
    record.promptTokens,
    record.completionTokens,
    record.cacheRead,
    record.cacheWrite,
    record.estimatedCost,
    record.sessionId ?? null,
  )

  if (record.sessionId) {
    db.prepare(
      `UPDATE sessions
       SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?,
           cache_read = cache_read + ?, cache_write = cache_write + ?
       WHERE id = ?`
    ).run(record.promptTokens, record.completionTokens, record.cacheRead, record.cacheWrite, record.sessionId)
  }
}

/**
 * Log a tool call to the SQLite database
 */
export function logToolCall(db: Database, record: ToolCallRecord): number {
  const result = db.prepare(
    `INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    record.sessionId,
    record.toolName,
    record.input,
    record.output,
    record.durationMs,
    record.status ?? 'success',
  )
  return Number(result.lastInsertRowid)
}

/**
 * Query token usage records from the database
 */
export function getTokenUsage(db: Database, options?: {
  provider?: string
  model?: string
  limit?: number
}): TokenUsageRecord[] {
  let sql = 'SELECT provider, model, prompt_tokens as promptTokens, completion_tokens as completionTokens, cache_read as cacheRead, cache_write as cacheWrite, estimated_cost as estimatedCost, session_id as sessionId FROM token_usage WHERE 1=1'
  const params: unknown[] = []

  if (options?.provider) {
    sql += ' AND provider = ?'
    params.push(options.provider)
  }
  if (options?.model) {
    sql += ' AND model = ?'
    params.push(options.model)
  }

  sql += ' ORDER BY timestamp DESC'

  if (options?.limit) {
    sql += ' LIMIT ?'
    params.push(options.limit)
  }

  return db.prepare(sql).all(...params) as TokenUsageRecord[]
}

/**
 * Query tool call records from the database
 */
export interface ToolCallQueryOptions {
  sessionId?: string
  toolName?: string
  search?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  limit?: number
  /**
   * Filter by session type (resolved via JOIN on `sessions.type`):
   * - 'main' — interactive sessions (or NULL/orphan session_ids)
   * - 'task' — background sessions (`sessions.type` in
   *   'task' | 'heartbeat' | 'consolidation' | 'loop_detection')
   */
  sessionType?: 'main' | 'task'
  /** @deprecated use `sessionType`. Kept for backward compatibility. */
  sourceFilter?: 'main' | 'task'
}

export interface ToolCallQueryResult {
  records: ToolCallRecord[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export function getToolCalls(db: Database, options?: {
  sessionId?: string
  toolName?: string
  limit?: number
  /**
   * Only rows with `id > afterId`. `tool_calls.id` is AUTOINCREMENT and a
   * row is written once, after the call returned — so the id is a stable,
   * monotone cursor, which `timestamp` (second resolution, ties across
   * tables) is not.
   */
  afterId?: number
  /** Only rows with `id <= throughId` — pins the upper end of a page. */
  throughId?: number
}): ToolCallRecord[] {
  let sql = 'SELECT id, timestamp, session_id as sessionId, tool_name as toolName, input, output, duration_ms as durationMs, status FROM tool_calls WHERE 1=1'
  const params: unknown[] = []

  if (options?.sessionId) {
    sql += ' AND session_id = ?'
    params.push(options.sessionId)
  }
  if (options?.toolName) {
    sql += ' AND tool_name = ?'
    params.push(options.toolName)
  }
  if (options?.afterId !== undefined) {
    sql += ' AND id > ?'
    params.push(options.afterId)
  }
  if (options?.throughId !== undefined) {
    sql += ' AND id <= ?'
    params.push(options.throughId)
  }

  // `id` breaks the tie: `tool_calls.timestamp` has second resolution, and the
  // task timelines reverse this list straight into a rendered order.
  sql += ' ORDER BY timestamp DESC, id DESC'

  if (options?.limit) {
    sql += ' LIMIT ?'
    params.push(options.limit)
  }

  return db.prepare(sql).all(...params) as ToolCallRecord[]
}

/**
 * Query tool calls with pagination, full-text search, and date range
 */
export function queryToolCalls(db: Database, options: ToolCallQueryOptions = {}): ToolCallQueryResult {
  const page = Math.max(1, options.page ?? 1)
  const limit = Math.min(100, Math.max(1, options.limit ?? 50))
  const offset = (page - 1) * limit

  let where = 'WHERE 1=1'
  const params: unknown[] = []

  if (options.sessionId) {
    where += ' AND session_id = ?'
    params.push(options.sessionId)
  }
  if (options.toolName) {
    where += ' AND tool_name = ?'
    params.push(options.toolName)
  }
  const sessionType = options.sessionType ?? options.sourceFilter
  if (sessionType === 'task') {
    where += " AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = tool_calls.session_id AND s.type IN ('task', 'heartbeat', 'consolidation', 'loop_detection'))"
  } else if (sessionType === 'main') {
    where += " AND (tool_calls.session_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = tool_calls.session_id AND s.type IN ('task', 'heartbeat', 'consolidation', 'loop_detection')))"
  }
  if (options.search) {
    where += ' AND (tool_name LIKE ? OR input LIKE ? OR output LIKE ?)'
    const term = `%${options.search}%`
    params.push(term, term, term)
  }
  if (options.dateFrom) {
    where += ' AND timestamp >= ?'
    // dateFrom is a date string like "2026-03-28" — ensure start-of-day
    params.push(options.dateFrom.length === 10 ? `${options.dateFrom} 00:00:00` : options.dateFrom)
  }
  if (options.dateTo) {
    where += ' AND timestamp <= ?'
    // dateTo is a date string like "2026-03-28", but timestamps are "2026-03-28 HH:MM:SS"
    // Append end-of-day time so the entire day is included
    params.push(options.dateTo.length === 10 ? `${options.dateTo} 23:59:59` : options.dateTo)
  }

  const total = (db.prepare(`SELECT COUNT(*) as count FROM tool_calls ${where}`).get(...params) as { count: number }).count

  const records = db.prepare(
    `SELECT
       tool_calls.id,
       tool_calls.timestamp,
       tool_calls.session_id as sessionId,
       tool_calls.tool_name as toolName,
       tool_calls.input,
       tool_calls.output,
       tool_calls.duration_ms as durationMs,
       tool_calls.status,
       s.type as sessionType,
       s.source as sessionSource
     FROM tool_calls
     LEFT JOIN sessions s ON s.id = tool_calls.session_id
     ${where}
     ORDER BY tool_calls.timestamp DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as ToolCallRecord[]

  return {
    records,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  }
}

export interface MemoryFileReadStat {
  path: string
  count: number
  lastReadAt: string
}

export interface MemorySearchStat {
  id: number
  timestamp: string
  query: string
  resultCount: number
  facts: { content: string; timestamp: string; source: string }[]
}

export interface MemoryUsageStats {
  fileReads: MemoryFileReadStat[]
  searches: MemorySearchStat[]
}

/**
 * Aggregate memory usage from the tool_calls log: which files under the
 * memory dir were read via read_file, and which search_memories calls ran.
 */
export function getMemoryUsageStats(db: Database, options: { memoryDir: string; days: number }): MemoryUsageStats {
  const days = Math.min(Math.max(Math.floor(options.days), 1), 365)
  const since = `-${days} days`
  const prefix = options.memoryDir.endsWith('/') ? options.memoryDir : `${options.memoryDir}/`

  const fileReads = (db.prepare(
    `SELECT
       json_extract(output, '$.details.path') AS path,
       COUNT(*) AS count,
       MAX(timestamp) AS lastReadAt
     FROM tool_calls
     WHERE tool_name = 'read_file'
       AND status = 'success'
       AND timestamp >= datetime('now', ?)
       AND json_extract(output, '$.details.path') LIKE ?
     GROUP BY path
     ORDER BY count DESC, path ASC`
  ).all(since, `${prefix}%`) as MemoryFileReadStat[]).map((row) => ({
    ...row,
    path: row.path.slice(prefix.length),
  }))

  const searchRows = db.prepare(
    `SELECT id, timestamp, input, output
     FROM tool_calls
     WHERE tool_name = 'search_memories'
       AND timestamp >= datetime('now', ?)
     ORDER BY timestamp DESC
     LIMIT 500`
  ).all(since) as { id: number; timestamp: string; input: string; output: string }[]

  const searches: MemorySearchStat[] = searchRows.map((row) => {
    let query = ''
    let resultCount = 0
    let facts: MemorySearchStat['facts'] = []
    try {
      query = String((JSON.parse(row.input) as { query?: unknown }).query ?? '')
    } catch { /* unparseable input, keep defaults */ }
    try {
      const details = (JSON.parse(row.output) as { details?: { count?: number; facts?: { content: string; timestamp: string; source: string }[] } }).details
      resultCount = details?.count ?? 0
      facts = (details?.facts ?? []).map((fact) => ({
        content: fact.content,
        timestamp: fact.timestamp,
        source: fact.source,
      }))
    } catch { /* unparseable output, keep defaults */ }

    return { id: row.id, timestamp: row.timestamp, query, resultCount, facts }
  })

  return { fileReads, searches }
}

/**
 * Get a single tool call by ID
 */
export function getToolCallById(db: Database, id: number): ToolCallRecord | null {
  const row = db.prepare(
    'SELECT id, timestamp, session_id as sessionId, tool_name as toolName, input, output, duration_ms as durationMs, status FROM tool_calls WHERE id = ?'
  ).get(id) as ToolCallRecord | undefined
  return row ?? null
}

/**
 * Get distinct tool names for filter dropdown
 */
export function getDistinctToolNames(db: Database): string[] {
  const rows = db.prepare('SELECT DISTINCT tool_name FROM tool_calls ORDER BY tool_name').all() as { tool_name: string }[]
  return rows.map(r => r.tool_name)
}
