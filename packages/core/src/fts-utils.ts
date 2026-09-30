/**
 * Shared FTS5 query normalization utilities.
 *
 * Used by both chat-history-tools and memories-store to convert
 * user-supplied search strings into valid FTS5 query syntax.
 */

/**
 * Normalize plain-text queries into valid FTS5 syntax by stripping
 * non-word characters and preserving only letters, numbers, and underscores.
 *
 * With `join: 'OR'`, tokens are OR-joined: FTS5's implicit AND empties results
 * on short atomic rows whenever a single query token is absent; bm25 ranking +
 * LIMIT still surface rows matching more tokens first.
 */
export function normalizePlainFtsQuery(query: string, join: 'AND' | 'OR' = 'AND'): string {
  const tokens = query.replace(/[^\p{L}\p{N}_]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return '""'
  return tokens.map(token => `"${token}"`).join(join === 'OR' ? ' OR ' : ' ')
}

/**
 * Normalize a user-supplied query into valid FTS5 syntax while preserving
 * advanced FTS operators (AND, OR, NOT, wildcards, quoted phrases, grouping).
 *
 * Plain queries are sanitized; queries that already use FTS5 syntax are
 * passed through as-is.
 */
export function normalizeFtsQuery(query: string, join: 'AND' | 'OR' = 'AND'): string {
  const trimmed = query.trim()
  if (trimmed.length === 0) return '""'

  const hasBooleanOperators = /(^|\s)(AND|OR|NOT)(?=\s|$)/.test(trimmed)
  const hasWildcard = /\*/.test(trimmed)
  const quoteCount = (trimmed.match(/"/g) ?? []).length
  const hasBalancedQuotes = quoteCount > 0 && quoteCount % 2 === 0
  const hasGrouping = /[()]/.test(trimmed) && (hasBooleanOperators || hasWildcard || hasBalancedQuotes)

  if (hasBooleanOperators || hasWildcard || hasBalancedQuotes || hasGrouping) {
    return trimmed
  }

  return normalizePlainFtsQuery(trimmed, join)
}
