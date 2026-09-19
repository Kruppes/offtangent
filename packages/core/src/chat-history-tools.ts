import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { normalizeFtsQuery } from './fts-utils.js'
import { resolveAgentReadScope } from './agent-read-scope.js'

export interface ChatHistoryToolsOptions {
  db: Database
  /**
   * Supplies the persona (agentId) the calling runtime belongs to.
   * Non-'main' personas only see chat messages tagged with their own
   * agent_id — without this, any persona (and any persona-triggered task)
   * could read other personas' and main's conversations, which is one of
   * the multi-persona bleeding vectors (2026-07-24). 'main' stays
   * unscoped: it is the orchestrator and needs the full picture for
   * heartbeat/consolidation.
   */
  getCurrentAgentId?: () => string | undefined
  /**
   * Injectable list of known persona ids (excludes 'main'), used to validate
   * the optional `agent` cross-persona read parameter. Defaults to the
   * on-disk personas. Injectable for tests.
   */
  listAgentIds?: () => string[]
}

interface ChatMessageRow {
  id: number
  session_id: string
  user_id: number | null
  role: string
  content: string
  metadata: string | null
  timestamp: string
  session_type: string | null
  session_source: string | null
}

/**
 * Create the `read_chat_history` agent tool.
 *
 * Reads chat messages from the database with optional datetime and source filtering.
 * Useful for:
 * - Agent Heartbeat: reading recent conversations to extract memory-worthy facts
 * - User queries: "What did we talk about yesterday at 2pm?"
 * - Session review: browsing messages from a specific session
 */
export function createReadChatHistoryTool(options: ChatHistoryToolsOptions): AgentTool {
  return {
    name: 'read_chat_history',
    label: 'Read Chat History',
    description:
      'Read chat messages from the database. Supports filtering by datetime range, source (web/telegram/task), ' +
      'role (user/assistant/tool/system), and session. Returns messages in chronological order. ' +
      'Use this to review past conversations, extract facts for memory, or answer questions about chat history. ' +
      'Optionally search message content and related tool call inputs/outputs with the query parameter. ' +
      'By default you only read your own persona\'s messages. To read another persona\'s history on demand — ' +
      'e.g. the user asks what was discussed with another persona, or you need to continue work started in ' +
      'another persona (its in-progress session is already readable here) — pass the `agent` parameter with ' +
      'that persona\'s id (e.g. "main", "bob"), or "all" to read across every persona.',
    parameters: Type.Object({
      start: Type.Optional(
        Type.String({
          description:
            'Start datetime (inclusive) in ISO 8601 format, e.g. "2025-04-04T14:00:00" or "2025-04-04". ' +
            'Messages from this time onward are included. Omit to not filter by start time.',
        }),
      ),
      end: Type.Optional(
        Type.String({
          description:
            'End datetime (exclusive) in ISO 8601 format, e.g. "2025-04-04T15:00:00" or "2025-04-05". ' +
            'Messages before this time are included. Omit to not filter by end time.',
        }),
      ),
      source: Type.Optional(
        Type.String({
          description:
            'Filter by message source: "web", "telegram", or "task". Matches the session_id prefix. ' +
            'Omit to include all sources.',
        }),
      ),
      role: Type.Optional(
        Type.String({
          description:
            'Filter by message role: "user", "assistant", "tool", or "system". Omit to include all roles.',
        }),
      ),
      session_id: Type.Optional(
        Type.String({
          description: 'Filter by exact session ID. Omit to include all sessions.',
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: 'Maximum number of messages to return (default: 100, max: 500).',
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description: 'Number of messages to skip for pagination (default: 0).',
        }),
      ),
      agent: Type.Optional(
        Type.String({
          description:
            'Cross-persona read scope. Omit to read only your own persona\'s messages — the default. ' +
            'Pass a persona id (e.g. "main", "bob") to read exactly that persona\'s history, or "all" to ' +
            'read across every persona. An unknown id returns an error.',
        }),
      ),
      query: Type.Optional(
        Type.String({
          description:
            'Full-text search query. Supports word matching, prefix queries (e.g. "config*"), ' +
            'phrase matching (e.g. "memory system"), and boolean operators (e.g. "docker OR container"). ' +
            'Results are ranked by relevance when a query is provided. ' +
            'Also searches tool call inputs and outputs.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const {
        start,
        end,
        source,
        role,
        session_id,
        limit: rawLimit,
        offset: rawOffset,
        query,
        agent: rawAgent,
      } = params as {
        start?: string
        end?: string
        source?: string
        role?: string
        session_id?: string
        limit?: number
        offset?: number
        query?: string
        agent?: string
      }

      try {
        const limit = Math.min(Math.max(rawLimit ?? 100, 1), 500)
        const offset = Math.max(rawOffset ?? 0, 0)

        // Build query dynamically
        const baseConditions: string[] = []
        const baseParams: unknown[] = []

        // Persona scoping (applied before all user filters). By default a
        // non-'main' persona is locked to its own agent_id; 'main' stays
        // unscoped. An explicit `agent` param opts into cross-persona reads:
        // 'all' → no filter; a concrete id → that bucket (+ 'shared', for
        // consistency with memory scoping). Unknown ids error out instead of
        // silently returning an empty set.
        const scope = resolveAgentReadScope({
          requested: rawAgent,
          callerAgentId: options.getCurrentAgentId?.(),
          listAgentIds: options.listAgentIds,
        })
        if (!scope.ok) {
          return {
            content: [{ type: 'text' as const, text: scope.error }],
            details: { error: true },
          }
        }
        if (scope.agentId !== undefined) {
          if (scope.explicit) {
            // Explicit cross-persona request: include the 'shared' bucket for
            // consistency with memory scoping.
            baseConditions.push("cm.agent_id IN (?, 'shared')")
            baseParams.push(scope.agentId)
          } else {
            // Default path: exact-match the caller's own bucket (strict no-op
            // vs. the pre-RC4 behaviour).
            baseConditions.push('cm.agent_id = ?')
            baseParams.push(scope.agentId)
          }
        }
        const toolCallQueryCondition =
          'cm.id IN (' +
          '  SELECT cm2.id FROM chat_messages cm2' +
          '  INNER JOIN tool_calls tc ON tc.session_id = cm2.session_id' +
          '  WHERE tc.input LIKE ? OR tc.output LIKE ?' +
          ')'

        // Datetime filters — normalize to SQLite-compatible format
        if (start) {
          const normalized = normalizeDatetime(start)
          if (!normalized) {
            return {
              content: [{ type: 'text' as const, text: `Error: Invalid start datetime "${start}". Use ISO 8601 format, e.g. "2025-04-04T14:00:00" or "2025-04-04".` }],
              details: { error: true },
            }
          }
          baseConditions.push('cm.timestamp >= ?')
          baseParams.push(normalized)
        }

        if (end) {
          const normalized = normalizeDatetime(end)
          if (!normalized) {
            return {
              content: [{ type: 'text' as const, text: `Error: Invalid end datetime "${end}". Use ISO 8601 format, e.g. "2025-04-05T00:00:00" or "2025-04-05".` }],
              details: { error: true },
            }
          }
          baseConditions.push('cm.timestamp < ?')
          baseParams.push(normalized)
        }

        // Source filter — resolved via JOIN on `sessions.type` / `sessions.source`
        // instead of fragile session_id prefix matching.
        //
        // Accepted filter values (aligned with the canonical session model
        // in agent_docs/architecture-conventions.md):
        //   'web'      — WebSocket + REST upload (source IN ('web','rest'))
        //   'rest'     — alias for 'web' (REST uploads are logged under the
        //                user's web session; exposed so callers who reason
        //                from the documented source list don't get rejected)
        //   'telegram' — Telegram DM + group (source IN ('telegram','telegram-group'))
        //   'task'     — all background agent-initiated session types
        if (source) {
          const validSources = ['web', 'rest', 'telegram', 'task']
          if (!validSources.includes(source)) {
            return {
              content: [{ type: 'text' as const, text: `Error: Invalid source "${source}". Valid sources: ${validSources.join(', ')}.` }],
              details: { error: true },
            }
          }
          if (source === 'task') {
            // Background agent-initiated work: task runs, heartbeats, memory
            // consolidation, and loop-detection sub-sessions.
            baseConditions.push(
              "EXISTS (SELECT 1 FROM sessions s WHERE s.id = cm.session_id AND s.type IN ('task', 'heartbeat', 'consolidation', 'loop_detection'))"
            )
          } else if (source === 'telegram') {
            baseConditions.push(
              "EXISTS (SELECT 1 FROM sessions s WHERE s.id = cm.session_id AND s.source IN ('telegram', 'telegram-group'))"
            )
          } else {
            // 'web' and 'rest' collapse into the same query — REST uploads
            // land under the user's web session (see chat.ts).
            baseConditions.push(
              "EXISTS (SELECT 1 FROM sessions s WHERE s.id = cm.session_id AND s.source IN ('web', 'rest'))"
            )
          }
        }

        // Role filter
        if (role) {
          const validRoles = ['user', 'assistant', 'tool', 'system']
          if (!validRoles.includes(role)) {
            return {
              content: [{ type: 'text' as const, text: `Error: Invalid role "${role}". Valid roles: ${validRoles.join(', ')}.` }],
              details: { error: true },
            }
          }
          baseConditions.push('cm.role = ?')
          baseParams.push(role)
        }

        // Session ID filter
        if (session_id) {
          baseConditions.push('cm.session_id = ?')
          baseParams.push(session_id)
        }

        let countConditions = [...baseConditions]
        let countParams = [...baseParams]
        let selectConditions = [...baseConditions]
        let selectParams = [...baseParams]
        let joinClause = ''
        // `cm.id` is the tiebreaker everywhere: `timestamp` has second
        // resolution and several rows per second are the norm.
        let orderByClause = 'cm.timestamp ASC, cm.id ASC'

        // Full-text query filter: match message content via FTS5 MATCH, with LIKE fallback for tool calls
        if (query) {
          const ftsQuery = normalizeFtsQuery(query)
          const pattern = `%${query}%`

          countConditions = [
            ...baseConditions,
            `(cm.id IN (SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH ?) OR ${toolCallQueryCondition})`,
          ]
          countParams = [...baseParams, ftsQuery, pattern, pattern]

          joinClause = `
          LEFT JOIN (
            SELECT rowid, bm25(chat_messages_fts) AS rank
            FROM chat_messages_fts
            WHERE chat_messages_fts MATCH ?
          ) ranked_matches ON ranked_matches.rowid = cm.id`
          selectConditions = [
            ...baseConditions,
            `(ranked_matches.rowid IS NOT NULL OR ${toolCallQueryCondition})`,
          ]
          selectParams = [ftsQuery, ...baseParams, pattern, pattern]
          orderByClause =
            'CASE WHEN ranked_matches.rank IS NULL THEN 1 ELSE 0 END ASC, ' +
            'ranked_matches.rank ASC, cm.timestamp ASC, cm.id ASC'
        }

        const countWhereClause = countConditions.length > 0
          ? `WHERE ${countConditions.join(' AND ')}`
          : ''
        const selectWhereClause = selectConditions.length > 0
          ? `WHERE ${selectConditions.join(' AND ')}`
          : ''

        // Get total count
        const countSql = `SELECT COUNT(*) as count FROM chat_messages cm ${countWhereClause}`
        const { count: total } = options.db.prepare(countSql).get(...countParams) as { count: number }

        if (total === 0) {
          const filterDesc = buildFilterDescription({ start, end, source, role, session_id, query })
          return {
            content: [{ type: 'text' as const, text: `No chat messages found${filterDesc}.` }],
            details: { count: 0, total: 0, filters: { start, end, source, role, session_id, query } },
          }
        }

        // Fetch messages, ranked by FTS relevance when a query is provided.
        // LEFT JOIN sessions so the session source/type is available for
        // metadata-driven source labeling (replaces ID-prefix parsing).
        const selectSql = `SELECT cm.id, cm.session_id, cm.user_id, cm.role, cm.content, cm.metadata, cm.timestamp,
            s.type as session_type, s.source as session_source
          FROM chat_messages cm
          LEFT JOIN sessions s ON s.id = cm.session_id
          ${joinClause}
          ${selectWhereClause}
          ORDER BY ${orderByClause}
          LIMIT ? OFFSET ?`

        const rows = options.db.prepare(selectSql).all(...selectParams, limit, offset) as ChatMessageRow[]

        // Format messages for readability
        const formatted = rows.map(row => {
          const meta = parseMetadata(row.metadata)
          const sourceLabel = deriveSourceLabel(row.session_type, row.session_source)
          const parts: string[] = [
            `[${row.timestamp}] [${sourceLabel}] [${row.role}]`,
          ]

          // Add username context if available from metadata
          if (meta?.username) {
            parts[0] = `[${row.timestamp}] [${sourceLabel}] [${row.role}: ${meta.username}]`
          }

          // Truncate very long messages to keep output manageable
          const maxContentLength = 2000
          const content = row.content.length > maxContentLength
            ? row.content.slice(0, maxContentLength) + `\n... (truncated, ${row.content.length} chars total)`
            : row.content

          parts.push(content)

          return parts.join('\n')
        })

        const output = formatted.join('\n\n---\n\n')
        const paginationInfo = total > limit + offset
          ? `\n\nShowing ${offset + 1}–${offset + rows.length} of ${total} messages. Use offset=${offset + limit} to see more.`
          : `\n\n${total} message(s) total.`

        return {
          content: [{ type: 'text' as const, text: output + paginationInfo }],
          details: {
            count: rows.length,
            total,
            offset,
            limit,
            filters: { start, end, source, role, session_id, query },
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error reading chat history: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Normalize a datetime string to SQLite-compatible format (YYYY-MM-DD HH:MM:SS).
 * 
 * The database stores timestamps in UTC via datetime('now').
 * - Date-only ("2025-04-04") → "2025-04-04 00:00:00" (treated as UTC)
 * - ISO without timezone ("2025-04-04T14:00:00") → "2025-04-04 14:00:00" (treated as UTC)
 * - ISO with timezone ("2025-04-04T14:00:00Z", "2025-04-04T14:00:00+02:00") → converted to UTC
 * 
 * Returns null if the input is invalid.
 */
function normalizeDatetime(input: string): string | null {
  // Date-only: "2025-04-04"
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return `${input} 00:00:00`
  }

  // ISO without timezone: "2025-04-04T14:00:00" — treat as UTC, just reformat
  const noTzMatch = input.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/)
  if (noTzMatch) {
    return `${noTzMatch[1]} ${noTzMatch[2]}`
  }

  // ISO with timezone (Z or +/-offset): parse and convert to UTC
  const date = new Date(input)
  if (isNaN(date.getTime())) {
    return null
  }

  return date.toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Parse metadata JSON safely
 */
function parseMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null
  try {
    return JSON.parse(metadata)
  } catch {
    return null
  }
}

/**
 * Derive a human-readable source label from the joined `sessions.type` and
 * `sessions.source` columns. This replaces the legacy ID-prefix parser.
 */
function deriveSourceLabel(sessionType: string | null, sessionSource: string | null): string {
  // Background agent-initiated sessions are grouped under 'task'.
  if (sessionType && sessionType !== 'interactive') return 'task'
  if (sessionSource === 'telegram' || sessionSource === 'telegram-group') return 'telegram'
  if (sessionSource === 'web' || sessionSource === 'rest') return 'web'
  return sessionSource ?? 'unknown'
}

/**
 * Build a human-readable filter description for empty results
 */
function buildFilterDescription(filters: {
  start?: string
  end?: string
  source?: string
  role?: string
  session_id?: string
  query?: string
}): string {
  const parts: string[] = []
  if (filters.start) parts.push(`from ${filters.start}`)
  if (filters.end) parts.push(`until ${filters.end}`)
  if (filters.source) parts.push(`source: ${filters.source}`)
  if (filters.role) parts.push(`role: ${filters.role}`)
  if (filters.session_id) parts.push(`session: ${filters.session_id}`)
  if (filters.query) parts.push(`query: "${filters.query}"`)
  return parts.length > 0 ? ` (filters: ${parts.join(', ')})` : ''
}
