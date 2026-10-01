/**
 * Strand search for `GET /api/strands?q=` (web redesign W1).
 *
 * A strand matches when its title contains the query (case-insensitive LIKE,
 * `%`, `_` and `\` escaped) OR one of its user/assistant messages matches the
 * query in the existing `chat_messages_fts` index (FTS5, every token as a
 * quoted prefix term, implicit AND). Every value is bound as a parameter; the
 * user's text never becomes SQL or FTS syntax.
 *
 * Fallback: when the FTS index cannot answer (an SQLite build without FTS5,
 * a missing or broken index) or the query has no word characters at all
 * (e.g. `%%`), message content is searched with a parameterised
 * `LIKE ? ESCAPE '\'` substring match instead, wildcards escaped.
 *
 * The result is an ID SET plus, per strand, a short excerpt of its best
 * matching message. Ordering and pagination stay with `listThreads`, exactly
 * like the attention/unread chips, so a search page never comes back short.
 */
import type { Database } from '@axiom/core'

export const STRAND_SEARCH_MIN_LENGTH = 2
export const STRAND_SEARCH_MAX_LENGTH = 200
/** Upper bound of message hits read per search; the best ranked come first. */
const MESSAGE_HIT_CAP = 2000
/** Tokens of an FTS query; more is noise and only slows the index down. */
const MAX_TOKENS = 12

export interface StrandSearchHits {
  /** Matching strand ids, best message rank first, title-only hits after. */
  ids: string[]
  /** Plain-text excerpt of the best matching message per strand (no markup). */
  snippets: Map<string, string>
}

/** Escape LIKE wildcards so `%`, `_` and `\` match themselves (ESCAPE '\'). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, char => `\\${char}`)
}

/**
 * Turn free text into a safe FTS5 query: letters/digits/underscore tokens,
 * each quoted (so `AND`, `NEAR`, `*`, `"` lose their meaning) and used as a
 * prefix term, so a search-as-you-type query matches the word being typed.
 * Returns null when nothing searchable is left (e.g. `%%`).
 */
export function toFtsPrefixQuery(text: string): string | null {
  const tokens = text.replace(/[^\p{L}\p{N}_]+/gu, ' ').trim().split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS)
  if (tokens.length === 0) return null
  return tokens.map(token => `"${token}"*`).join(' ')
}

/** Characters of context on each side of a LIKE fallback match. */
const SNIPPET_CONTEXT = 60

/**
 * Plain-text excerpt around the first case-insensitive occurrence of `needle`
 * (used by the LIKE fallback, which has no FTS `snippet()`).
 */
export function excerptAround(content: string, needle: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return flat.slice(0, SNIPPET_CONTEXT * 2)
  const start = Math.max(0, at - SNIPPET_CONTEXT)
  const end = Math.min(flat.length, at + needle.length + SNIPPET_CONTEXT)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** Flatten an excerpt to one line; the client renders it as plain text. */
function cleanSnippet(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

export function searchStrands(
  db: Database,
  userId: number,
  q: string,
  options: { includeArchived: boolean },
): StrandSearchHits {
  const user = String(userId)
  const archived = options.includeArchived ? '' : 'AND s.archived = 0'
  const ids: string[] = []
  const seen = new Set<string>()
  const snippets = new Map<string, string>()

  const ftsQuery = toFtsPrefixQuery(q)
  let rows: Array<{ id: string; snippet: string | null }> | null = null
  if (ftsQuery) {
    try {
      rows = db.prepare(
        `SELECT cm.session_id AS id,
                snippet(chat_messages_fts, 0, '', '', '…', 16) AS snippet
         FROM chat_messages_fts
         JOIN chat_messages cm ON cm.id = chat_messages_fts.rowid
         JOIN sessions s ON s.id = cm.session_id
         WHERE chat_messages_fts MATCH ?
           AND cm.role IN ('user', 'assistant')
           AND s.type = 'interactive'
           AND (s.session_user = ? OR CAST(s.user_id AS TEXT) = ?)
           ${archived}
         ORDER BY chat_messages_fts.rank
         LIMIT ?`,
      ).all(ftsQuery, user, user, MESSAGE_HIT_CAP) as Array<{ id: string; snippet: string | null }>
    } catch {
      // A malformed FTS expression cannot come from toFtsPrefixQuery, so this
      // is a missing/unusable index: fall through to the LIKE search below.
      rows = null
    }
  }
  if (rows === null) {
    const likeRows = db.prepare(
      `SELECT cm.session_id AS id, cm.content AS content
       FROM chat_messages cm
       JOIN sessions s ON s.id = cm.session_id
       WHERE cm.content LIKE ? ESCAPE '\\'
         AND cm.role IN ('user', 'assistant')
         AND s.type = 'interactive'
         AND (s.session_user = ? OR CAST(s.user_id AS TEXT) = ?)
         ${archived}
       ORDER BY cm.id DESC
       LIMIT ?`,
    ).all(`%${escapeLike(q)}%`, user, user, MESSAGE_HIT_CAP) as Array<{ id: string; content: string }>
    rows = likeRows.map(row => ({ id: row.id, snippet: excerptAround(row.content, q) }))
  }
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    ids.push(row.id)
    const snippet = row.snippet ? cleanSnippet(row.snippet) : ''
    if (snippet) snippets.set(row.id, snippet)
  }

  const titleRows = db.prepare(
    `SELECT s.id AS id
     FROM sessions s
     WHERE s.type = 'interactive'
       AND (s.session_user = ? OR CAST(s.user_id AS TEXT) = ?)
       AND s.title LIKE ? ESCAPE '\\'
       ${archived}`,
  ).all(user, user, `%${escapeLike(q)}%`) as Array<{ id: string }>
  for (const row of titleRows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    ids.push(row.id)
  }

  return { ids, snippets }
}
