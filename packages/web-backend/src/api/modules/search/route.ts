/**
 * Message search (web redesign W5b):
 *
 *   GET /api/search?q=&limit=&agent_id=&include_archived=0|1&cursor=
 *     -> { query, hits: SearchHit[], truncated, nextCursor }
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
 * - Paging (W6b, additive): `nextCursor` is an opaque string when more hits
 *   follow (`truncated: true`), else `null`. Sending it back as `cursor`
 *   (with the SAME q/agent_id/include_archived) returns the next page. The
 *   order is a total order — FTS rank ascending, then message id descending
 *   (LIKE fallback: message id descending) — and the cursor carries the last
 *   (rank, id) seen, so pages neither repeat nor skip a hit (keyset, not an
 *   offset window). A cursor that is malformed, of another query/filter or
 *   of the other search mode -> 400 `invalid_cursor`. Caveat: bm25 ranks
 *   depend on the whole index, so a message written between two pages can
 *   shift ranks; the newest message then may show up late or not at all,
 *   but the pages still never repeat a hit of the same order.
 * - `snippet` is PLAIN text (no markup); `highlights` are UTF-16 offsets into
 *   it, so a client can mark the hits without ever rendering HTML.
 * - Without a usable FTS index (or a query without word characters) an
 *   escaped, parameterised LIKE substring match answers instead.
 * - 120 requests per user and minute, then 429 `search_rate_limited`.
 */
import { createHash } from 'node:crypto'
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
  /** Opaque cursor for the next page, `null` on the last page (W6b). */
  nextCursor: string | null
}

/** Position after the last hit of a page. `r` is the FTS rank (absent in LIKE mode). */
interface SearchCursor {
  v: 1
  m: 'fts' | 'like'
  /** Hash of query + filters: a cursor only continues the search it came from. */
  h: string
  r?: number
  id: number
}

const CURSOR_MAX_LENGTH = 400

function searchFingerprint(q: string, options: { agentId?: string; includeArchived: boolean }): string {
  return createHash('sha256')
    .update(JSON.stringify([q, options.agentId ?? null, options.includeArchived]))
    .digest('base64url')
    .slice(0, 16)
}

export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Strict decode: anything that is not exactly a cursor of this shape is `null`. */
export function decodeSearchCursor(raw: unknown): SearchCursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const c = parsed as Record<string, unknown>
  const keys = Object.keys(c).sort().join(',')
  if (c.v !== 1 || (c.m !== 'fts' && c.m !== 'like') || typeof c.h !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(c.h)) return null
  if (typeof c.id !== 'number' || !Number.isSafeInteger(c.id) || c.id < 1) return null
  if (c.m === 'fts') {
    if (keys !== 'h,id,m,r,v' || typeof c.r !== 'number' || !Number.isFinite(c.r)) return null
  } else if (keys !== 'h,id,m,v') {
    return null
  }
  return c as unknown as SearchCursor
}

export class SearchCursorError extends Error {
  constructor() {
    super('invalid cursor')
    this.name = 'SearchCursorError'
  }
}

interface HitRow {
  score?: number
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
  options: { limit: number; agentId?: string; includeArchived: boolean; cursor?: string },
): SearchResult {
  const fingerprint = searchFingerprint(q, options)
  let cursor: SearchCursor | null = null
  if (options.cursor !== undefined) {
    cursor = decodeSearchCursor(options.cursor)
    if (!cursor || cursor.h !== fingerprint) throw new SearchCursorError()
  }
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
  if (ftsQuery && cursor?.m === 'like') throw new SearchCursorError()
  if (ftsQuery) {
    // Keyset over (rank ASC, id DESC): the page starts strictly after the
    // cursor's (rank, id). The inner query names the rank so the outer one
    // can compare it; the snippet is built for the returned page only.
    const after = cursor ? 'WHERE (score > ? OR (score = ? AND messageId < ?))' : ''
    const afterParams = cursor ? [cursor.r!, cursor.r!, cursor.id] : []
    try {
      rows = db.prepare(
        `SELECT * FROM (
           SELECT chat_messages_fts.rank AS score, cm.id AS messageId, cm.session_id AS strandId,
                  s.title AS strandTitle, cm.role AS role,
                  snippet(chat_messages_fts, 0, ?, ?, '…', 16) AS raw, cm.timestamp AS timestamp
             FROM chat_messages_fts
             JOIN chat_messages cm ON cm.id = chat_messages_fts.rowid
             JOIN sessions s ON s.id = cm.session_id
            WHERE chat_messages_fts MATCH ? AND ${filters}
         ) ${after}
         ORDER BY score, messageId DESC
         LIMIT ?`,
      ).all(MARK_OPEN, MARK_CLOSE, ftsQuery, ...filterParams, ...afterParams, take) as HitRow[]
    } catch (err) {
      // toFtsPrefixQuery never yields a malformed expression, so this is a
      // missing or unusable index: answer from the LIKE fallback below.
      console.warn('[search] FTS unavailable, using LIKE fallback:', (err as Error).message)
      rows = null
    }
  }
  // A cursor of one mode never continues in the other: the orders differ.
  if (cursor && (rows === null) !== (cursor.m === 'like')) throw new SearchCursorError()

  let hits: SearchHit[]
  let keys: Array<{ r?: number; id: number }>
  if (rows !== null) {
    keys = rows.map(row => ({ r: row.score, id: row.messageId }))
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
        WHERE cm.content LIKE ? ESCAPE '\\' AND ${filters}${cursor ? ' AND cm.id < ?' : ''}
        ORDER BY cm.id DESC
        LIMIT ?`,
    ).all(`%${escapeLike(q)}%`, ...filterParams, ...(cursor ? [cursor.id] : []), take) as HitRow[]
    keys = likeRows.map(row => ({ id: row.messageId }))
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
  let nextCursor: string | null = null
  if (truncated) {
    const last = keys[options.limit - 1]!
    nextCursor = encodeSearchCursor(rows !== null
      ? { v: 1, m: 'fts', h: fingerprint, r: last.r!, id: last.id }
      : { v: 1, m: 'like', h: fingerprint, id: last.id })
  }
  return { query: q, hits: hits.slice(0, options.limit), truncated, nextCursor }
}

type Parsed = { ok: true; value: { q: string; limit: number; agentId?: string; includeArchived: boolean; cursor?: string } }
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

  let cursor: string | undefined
  if (query.cursor !== undefined && query.cursor !== '') {
    // Shape only here; whether it belongs to THIS search is checked in
    // `searchMessages`, which knows the fingerprint.
    if (!decodeSearchCursor(query.cursor)) return { ok: false, error: 'Invalid cursor', code: 'invalid_cursor' }
    cursor = query.cursor as string
  }

  return { ok: true, value: { q: q.value, limit, agentId, includeArchived: parseFlag(query.include_archived), cursor } }
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
        if (err instanceof SearchCursorError) {
          res.status(400).json({ error: 'Invalid cursor', code: 'invalid_cursor' })
          return
        }
        console.error('[search] failed:', err)
        res.status(500).json({ error: 'Search failed', code: 'internal_error' })
      }
    },
  )
  return router
}
