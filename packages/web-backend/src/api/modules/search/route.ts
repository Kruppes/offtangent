/**
 * Message search (web redesign W5b):
 *
 *   GET /api/search?q=&limit=&agent_id=&include_archived=0|1
 *     -> { query, hits: SearchHit[], truncated }
 *     SearchHit = { strandId, strandTitle, messageId, role, snippet,
 *                   highlights: [start, end][], timestamp }
 *
 * Full text over the user/assistant messages of the caller's own interactive
 * strands, served by the EXISTING `chat_messages_fts` index (the one
 * `read_chat_history` and the strand list `?q=` use; nothing is duplicated).
 *
 * - `q`: required, trimmed 2..200 characters, else 400 `invalid_q`. It is
 *   turned into quoted prefix terms (`toFtsPrefixQuery`), so FTS operators,
 *   quotes, `*`, `NEAR`, column filters and parentheses are plain text. The
 *   query and every other value are bound parameters.
 * - `limit`: 1..50, default 20, else 400 `invalid_limit`.
 * - `agent_id`: optional persona filter, same rules as `GET /api/strands`
 *   (unknown persona -> 400 `unknown_agent`).
 * - `include_archived`: archived strands are left out unless `1`.
 * - `snippet` is PLAIN text (no markup); `highlights` are UTF-16 offsets into
 *   it, so a client can mark the hits without ever rendering HTML.
 * - Without a usable FTS index (or a query without word characters) an
 *   escaped, parameterised LIKE substring match answers instead.
 * - 120 requests per user and minute, then 429 `search_rate_limited`.
 */
import { Router, type Response } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware, type AuthenticatedRequest } from '../../../auth.js'
import { resolveAgentId } from '../../../persona-request.js'
import { perUserRateLimit } from '../../rate-limit.js'
import { parseFlag, parseSearchQuery } from '../strands/schema.js'
import { escapeLike, excerptAround, toFtsPrefixQuery } from '../strands/search.js'

export const SEARCH_DEFAULT_LIMIT = 20
export const SEARCH_MAX_LIMIT = 50
export const SEARCH_PER_MINUTE = 120

/** Private-use markers around a hit inside the FTS snippet; never sent out. */
const MARK_OPEN = '\uE000'
const MARK_CLOSE = '\uE001'

export interface SearchHit {
  strandId: string
  strandTitle: string | null
  messageId: number
  role: 'user' | 'assistant'
  snippet: string
  highlights: Array<[number, number]>
  timestamp: string
}

export interface SearchResult {
  query: string
  hits: SearchHit[]
  truncated: boolean
}

interface HitRow {
  messageId: number
  strandId: string
  strandTitle: string | null
  role: 'user' | 'assistant'
  raw: string
  timestamp: string
}

/**
 * Split an FTS snippet with private-use markers into plain text plus hit
 * ranges. Whitespace is flattened first; stray markers (a message that
 * itself contains U+E000/U+E001) are dropped instead of trusted.
 */
export function parseMarkedSnippet(marked: string): { snippet: string; highlights: Array<[number, number]> } {
  const flat = marked.replace(/\s+/g, ' ').trim()
  let snippet = ''
  const highlights: Array<[number, number]> = []
  let open: number | null = null
  for (const char of flat) {
    if (char === MARK_OPEN) { if (open === null) open = snippet.length; continue }
    if (char === MARK_CLOSE) {
      if (open !== null && snippet.length > open) highlights.push([open, snippet.length])
      open = null
      continue
    }
    snippet += char
  }
  return { snippet, highlights }
}

/** Ranges of every case-insensitive occurrence of `needle` (LIKE fallback). */
function rangesOf(text: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const hay = text.toLowerCase()
  const n = needle.toLowerCase()
  if (!n) return out
  let at = hay.indexOf(n)
  while (at >= 0 && out.length < 20) {
    out.push([at, at + n.length])
    at = hay.indexOf(n, at + n.length)
  }
  return out
}

function isoUtc(value: string): string {
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

export function searchMessages(
  db: Database,
  userId: number,
  q: string,
  options: { limit: number; agentId?: string; includeArchived: boolean },
): SearchResult {
  const user = String(userId)
  const filters = [
    "cm.role IN ('user', 'assistant')",
    "s.type = 'interactive'",
    '(s.session_user = ? OR CAST(s.user_id AS TEXT) = ?)',
    ...(options.includeArchived ? [] : ['s.archived = 0']),
    ...(options.agentId ? ['s.agent_id = ?'] : []),
  ].join(' AND ')
  const filterParams: unknown[] = [user, user, ...(options.agentId ? [options.agentId] : [])]
  // One more than asked tells `truncated` without a COUNT over the index.
  const take = options.limit + 1

  const ftsQuery = toFtsPrefixQuery(q)
  let rows: HitRow[] | null = null
  if (ftsQuery) {
    try {
      rows = db.prepare(
        `SELECT cm.id AS messageId, cm.session_id AS strandId, s.title AS strandTitle, cm.role AS role,
                snippet(chat_messages_fts, 0, ?, ?, '…', 16) AS raw, cm.timestamp AS timestamp
           FROM chat_messages_fts
           JOIN chat_messages cm ON cm.id = chat_messages_fts.rowid
           JOIN sessions s ON s.id = cm.session_id
          WHERE chat_messages_fts MATCH ? AND ${filters}
          ORDER BY chat_messages_fts.rank, cm.id DESC
          LIMIT ?`,
      ).all(MARK_OPEN, MARK_CLOSE, ftsQuery, ...filterParams, take) as HitRow[]
    } catch (err) {
      // toFtsPrefixQuery never yields a malformed expression, so this is a
      // missing or unusable index: answer from the LIKE fallback below.
      console.warn('[search] FTS unavailable, using LIKE fallback:', (err as Error).message)
      rows = null
    }
  }

  let hits: SearchHit[]
  if (rows !== null) {
    hits = rows.map((row) => {
      const { snippet, highlights } = parseMarkedSnippet(row.raw ?? '')
      return {
        strandId: row.strandId,
        strandTitle: row.strandTitle,
        messageId: row.messageId,
        role: row.role,
        snippet,
        highlights,
        timestamp: isoUtc(row.timestamp),
      }
    })
  } else {
    const likeRows = db.prepare(
      `SELECT cm.id AS messageId, cm.session_id AS strandId, s.title AS strandTitle, cm.role AS role,
              cm.content AS raw, cm.timestamp AS timestamp
         FROM chat_messages cm
         JOIN sessions s ON s.id = cm.session_id
        WHERE cm.content LIKE ? ESCAPE '\\' AND ${filters}
        ORDER BY cm.id DESC
        LIMIT ?`,
    ).all(`%${escapeLike(q)}%`, ...filterParams, take) as HitRow[]
    hits = likeRows.map((row) => {
      const snippet = excerptAround(row.raw ?? '', q)
      return {
        strandId: row.strandId,
        strandTitle: row.strandTitle,
        messageId: row.messageId,
        role: row.role,
        snippet,
        highlights: rangesOf(snippet, q),
        timestamp: isoUtc(row.timestamp),
      }
    })
  }

  const truncated = hits.length > options.limit
  return { query: q, hits: hits.slice(0, options.limit), truncated }
}

type Parsed = { ok: true; value: { q: string; limit: number; agentId?: string; includeArchived: boolean } }
  | { ok: false; error: string; code: string }

export function parseMessageSearchQuery(query: Record<string, unknown>): Parsed {
  const q = parseSearchQuery(query.q)
  if (!q.ok) return { ok: false, error: q.error, code: q.code ?? 'invalid_q' }
  if (q.value === undefined) return { ok: false, error: 'q is required', code: 'invalid_q' }

  let limit = SEARCH_DEFAULT_LIMIT
  if (query.limit !== undefined && query.limit !== '') {
    const raw = query.limit
    const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isInteger(n) || n < 1 || n > SEARCH_MAX_LIMIT) {
      return { ok: false, error: `limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}`, code: 'invalid_limit' }
    }
    limit = n
  }

  let agentId: string | undefined
  if (query.agent_id !== undefined && query.agent_id !== '') {
    if (typeof query.agent_id !== 'string') return { ok: false, error: 'Unknown agent_id', code: 'unknown_agent' }
    const resolved = resolveAgentId(query.agent_id)
    if (resolved === null) return { ok: false, error: 'Unknown agent_id', code: 'unknown_agent' }
    agentId = resolved
  }

  return { ok: true, value: { q: q.value, limit, agentId, includeArchived: parseFlag(query.include_archived) } }
}

export function createSearchRouter(options: { db: Database }): Router {
  const router = Router()
  router.use(jwtMiddleware)
  router.get(
    '/',
    perUserRateLimit({ windowMs: 60_000, max: SEARCH_PER_MINUTE, code: 'search_rate_limited' }),
    (req: AuthenticatedRequest, res: Response) => {
      const parsed = parseMessageSearchQuery(req.query as Record<string, unknown>)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        const { q, ...rest } = parsed.value
        res.json(searchMessages(options.db, req.user!.userId, q, rest))
      } catch (err) {
        console.error('[search] failed:', err)
        res.status(500).json({ error: 'Search failed', code: 'internal_error' })
      }
    },
  )
  return router
}
