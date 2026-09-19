import type { Database } from './database.js'

/**
 * cache-stats.ts: prompt cache measurement (SPEC 11.5).
 *
 * `sessions.cache_read` / `cache_write` are accumulated by
 * `logTokenUsage` on every turn. These helpers turn them into the two
 * numbers the SPEC asks for: the cache read ratio per strand and a seven
 * day average per persona. A drop after a deploy is a regression.
 */

export interface SessionCacheStats {
  sessionId: string
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  /** cache_read / (prompt_tokens + cache_read), 0..1, null when nothing was prompted yet */
  cacheReadRatio: number | null
}

export interface PersonaCacheStats {
  agentId: string
  days: number
  sessions: number
  promptTokens: number
  cacheRead: number
  cacheWrite: number
  cacheReadRatio: number | null
}

export function cacheReadRatio(promptTokens: number, cacheRead: number): number | null {
  const total = promptTokens + cacheRead
  if (total <= 0) return null
  return cacheRead / total
}

export function getSessionCacheStats(db: Database, sessionId: string): SessionCacheStats | null {
  const row = db.prepare(
    'SELECT id, prompt_tokens, completion_tokens, cache_read, cache_write FROM sessions WHERE id = ?',
  ).get(sessionId) as { id: string; prompt_tokens: number; completion_tokens: number; cache_read: number; cache_write: number } | undefined
  if (!row) return null
  return {
    sessionId: row.id,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    cacheReadRatio: cacheReadRatio(row.prompt_tokens, row.cache_read),
  }
}

export function getPersonaCacheStats(db: Database, agentId: string, days: number = 7): PersonaCacheStats {
  const row = db.prepare(
    `SELECT COUNT(*) AS sessions,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(cache_read), 0) AS cache_read,
            COALESCE(SUM(cache_write), 0) AS cache_write
     FROM sessions
     WHERE agent_id = ? AND type = 'interactive'
       AND last_activity >= datetime('now', ?)`,
  ).get(agentId, `-${Math.max(1, Math.floor(days))} days`) as { sessions: number; prompt_tokens: number; cache_read: number; cache_write: number }
  return {
    agentId,
    days,
    sessions: row.sessions,
    promptTokens: row.prompt_tokens,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    cacheReadRatio: cacheReadRatio(row.prompt_tokens, row.cache_read),
  }
}
