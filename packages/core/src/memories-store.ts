import type { Database } from './database.js'
import { normalizeFtsQuery } from './fts-utils.js'
import { NotFoundError, InvalidInputError } from './errors.js'
import { embedMemoryBestEffort } from './memory-embeddings.js'

export type MemoryProvenance = 'owner' | 'agent' | 'untrusted' | 'system'
export type MemoryStatus = 'active' | 'superseded'

export interface MemoryFact {
  id: number
  userId: number | null
  sessionId: string | null
  content: string
  source: string
  timestamp: string
  agentId: string | null
  /** SPEC 11.4: who the fact came from. Existing rows read as 'agent'. */
  provenance: MemoryProvenance
  sessionKind: string | null
  observedAt: string | null
  supersessionKey: string | null
  status: MemoryStatus
  supersededBy: number | null
}

/** Provenance classes that are never injected and never consolidated (SPEC 11.4 gate 3). */
export const INJECTABLE_PROVENANCE: readonly MemoryProvenance[] = ['owner', 'agent']

export interface SearchMemoriesOptions {
  userId?: number
  limit?: number
  dateFrom?: string
  dateTo?: string
  /** Include superseded rows (default false: only `status = 'active'`). */
  includeSuperseded?: boolean
  /** Include untrusted and system provenance (default false for retrieval). */
  includeAllProvenance?: boolean
  /**
   * Persona scope: when set, only facts with `agent_id IN (agentId, 'shared')`
   * are returned. When omitted, all facts are searched (main/orchestrator
   * behavior; also the legacy behavior).
   */
  agentId?: string
}

export interface ListMemoriesOptions {
  userId?: number
  query?: string
  limit?: number
  offset?: number
  dateFrom?: string
  dateTo?: string
  /** Include superseded rows (default false). The admin list passes true. */
  includeSuperseded?: boolean
  /** Include untrusted and system provenance (default true for listing). */
  includeAllProvenance?: boolean
}

interface MemoryRow {
  id: number
  user_id: number | null
  session_id: string | null
  content: string
  source: string
  timestamp: string
  agent_id?: string | null
  provenance?: string | null
  session_kind?: string | null
  observed_at?: string | null
  supersession_key?: string | null
  status?: string | null
  superseded_by?: number | null
}

const MEMORY_COLUMNS = 'm.id, m.user_id, m.session_id, m.content, m.source, m.timestamp, m.agent_id, m.provenance, m.session_kind, m.observed_at, m.supersession_key, m.status, m.superseded_by'

function rowToMemoryFact(row: MemoryRow): MemoryFact {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    content: row.content,
    source: row.source,
    timestamp: row.timestamp,
    agentId: row.agent_id ?? null,
    provenance: (row.provenance as MemoryProvenance | undefined) ?? 'agent',
    sessionKind: row.session_kind ?? null,
    observedAt: row.observed_at ?? null,
    supersessionKey: row.supersession_key ?? null,
    status: (row.status as MemoryStatus | undefined) ?? 'active',
    supersededBy: row.superseded_by ?? null,
  }
}

function normalizeDateFrom(input: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return `${input} 00:00:00`
  }

  const noTzMatch = input.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/)
  if (noTzMatch) {
    return `${noTzMatch[1]} ${noTzMatch[2]}`
  }

  const date = new Date(input)
  if (isNaN(date.getTime())) {
    throw new InvalidInputError(`Invalid dateFrom value: ${input}`)
  }

  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function normalizeDateTo(input: string): string {
  const dateOnlyMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnlyMatch) {
    const nextDay = new Date(Date.UTC(
      Number.parseInt(dateOnlyMatch[1], 10),
      Number.parseInt(dateOnlyMatch[2], 10) - 1,
      Number.parseInt(dateOnlyMatch[3], 10) + 1,
    ))
    return nextDay.toISOString().replace('T', ' ').slice(0, 19)
  }

  const noTzMatch = input.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/)
  if (noTzMatch) {
    return `${noTzMatch[1]} ${noTzMatch[2]}`
  }

  const date = new Date(input)
  if (isNaN(date.getTime())) {
    throw new InvalidInputError(`Invalid dateTo value: ${input}`)
  }

  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function buildMemoryFilters(
  options: Pick<SearchMemoriesOptions, 'userId' | 'dateFrom' | 'dateTo' | 'agentId' | 'includeSuperseded' | 'includeAllProvenance'>,
  alias: string,
  defaults: { includeAllProvenance: boolean } = { includeAllProvenance: false },
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (!options.includeSuperseded) {
    conditions.push(`${alias}.status = 'active'`)
  }
  if (!(options.includeAllProvenance ?? defaults.includeAllProvenance)) {
    conditions.push(`${alias}.provenance IN ('owner','agent')`)
  }

  if (options.userId !== undefined) {
    conditions.push(`${alias}.user_id = ?`)
    params.push(options.userId)
  }

  if (options.agentId !== undefined) {
    conditions.push(`${alias}.agent_id IN (?, 'shared')`)
    params.push(options.agentId)
  }

  if (options.dateFrom) {
    conditions.push(`${alias}.timestamp >= ?`)
    params.push(normalizeDateFrom(options.dateFrom))
  }

  if (options.dateTo) {
    conditions.push(`${alias}.timestamp < ?`)
    params.push(normalizeDateTo(options.dateTo))
  }

  return { conditions, params }
}

export function searchMemories(db: Database, query: string, options: SearchMemoriesOptions = {}): MemoryFact[] {
  const trimmedQuery = query.trim()
  if (trimmedQuery.length === 0) {
    return []
  }

  const limit = Math.max(1, Math.floor(options.limit ?? 10))
  const ftsQuery = normalizeFtsQuery(trimmedQuery, 'OR')
  const { conditions, params } = buildMemoryFilters(options, 'm')
  const whereClause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''

  const sql = `
    SELECT ${MEMORY_COLUMNS}
    FROM memories_fts
    INNER JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ?${whereClause}
    ORDER BY bm25(memories_fts) ASC, m.timestamp DESC, m.id DESC
    LIMIT ?
  `

  const rows = db.prepare(sql).all(ftsQuery, ...params, limit) as MemoryRow[]
  return rows.map(rowToMemoryFact)
}

export function listMemories(db: Database, options: ListMemoriesOptions = {}): { facts: MemoryFact[]; total: number } {
  const limit = Math.max(1, Math.floor(options.limit ?? 50))
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const trimmedQuery = options.query?.trim()
  const { conditions, params } = buildMemoryFilters(options, 'm', { includeAllProvenance: true })

  if (trimmedQuery) {
    const ftsQuery = normalizeFtsQuery(trimmedQuery)
    const whereClause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''

    const countSql = `
      SELECT COUNT(*) as count
      FROM memories m
      WHERE m.id IN (
        SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?
      )${whereClause}
    `

    const { count } = db.prepare(countSql).get(ftsQuery, ...params) as { count: number }

    const selectSql = `
      SELECT ${MEMORY_COLUMNS}
      FROM memories_fts
      INNER JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?${whereClause}
      ORDER BY bm25(memories_fts) ASC, m.timestamp DESC, m.id DESC
      LIMIT ? OFFSET ?
    `

    const rows = db.prepare(selectSql).all(ftsQuery, ...params, limit, offset) as MemoryRow[]
    return { facts: rows.map(rowToMemoryFact), total: count }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const countSql = `SELECT COUNT(*) as count FROM memories m ${whereClause}`
  const { count } = db.prepare(countSql).get(...params) as { count: number }

  const selectSql = `
    SELECT ${MEMORY_COLUMNS}
    FROM memories m
    ${whereClause}
    ORDER BY m.timestamp DESC, m.id DESC
    LIMIT ? OFFSET ?
  `

  const rows = db.prepare(selectSql).all(...params, limit, offset) as MemoryRow[]
  return { facts: rows.map(rowToMemoryFact), total: count }
}

export function getMemoryById(db: Database, id: number): MemoryFact | null {
  const row = db.prepare(
    `SELECT ${MEMORY_COLUMNS} FROM memories m WHERE m.id = ?`
  ).get(id) as MemoryRow | undefined

  return row ? rowToMemoryFact(row) : null
}

export interface CreateMemoryProvenance {
  provenance?: MemoryProvenance
  sessionKind?: string | null
  observedAt?: string | null
  /** Normalised subject key; when set, the previous active fact with the same key is superseded. */
  supersessionKey?: string | null
}

export function createMemory(
  db: Database,
  userId: number | null,
  sessionId: string | null,
  content: string,
  source: string = 'session',
  agentId: string = 'main',
  meta: CreateMemoryProvenance = {},
): number {
  const provenance = meta.provenance ?? 'agent'
  const key = meta.supersessionKey?.trim() || null
  const insert = db.transaction((): number => {
    const result = db.prepare(
      'INSERT INTO memories (user_id, session_id, content, source, agent_id, provenance, session_kind, observed_at, supersession_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, sessionId, content, source, agentId, provenance, meta.sessionKind ?? null, meta.observedAt ?? null, key)
    const id = Number(result.lastInsertRowid)
    if (key) {
      // Supersession instead of append (SPEC 11.4 gate 4): the previous
      // active fact for the same subject, persona and user is retired, not
      // deleted. Nothing is ever removed.
      const userClause = userId === null ? 'user_id IS NULL' : 'user_id = ?'
      const params: unknown[] = [id, key, agentId]
      if (userId !== null) params.push(userId)
      params.push(id)
      db.prepare(
        `UPDATE memories SET status = 'superseded', superseded_by = ?
         WHERE supersession_key = ? AND agent_id = ? AND ${userClause} AND status = 'active' AND id != ?`
      ).run(...params)
    }
    return id
  })
  const id = insert()
  // Best-effort semantic vector (no-op when memoryEmbeddings is disabled).
  embedMemoryBestEffort(db, id, content)
  return id
}

/** Retire a fact in place (owner action or consolidation). Never deletes. */
export function supersedeMemory(db: Database, id: number, supersededBy: number | null = null): void {
  const result = db.prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?").run(supersededBy, id)
  if (result.changes === 0) {
    throw new NotFoundError(`Memory not found: ${id}`)
  }
}

export function updateMemory(db: Database, id: number, content: string): void {
  // A stale vector must not survive a content change — cleared synchronously,
  // re-embedded best-effort.
  const result = db.prepare('UPDATE memories SET content = ?, embedding = NULL WHERE id = ?').run(content, id)
  if (result.changes === 0) {
    throw new NotFoundError(`Memory not found: ${id}`)
  }
  embedMemoryBestEffort(db, id, content)
}

export function deleteMemory(db: Database, id: number): void {
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  if (result.changes === 0) {
    throw new NotFoundError(`Memory not found: ${id}`)
  }
}
