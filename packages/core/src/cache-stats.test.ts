import { describe, expect, it } from 'vitest'
import { initDatabase } from './database.js'
import { cacheReadRatio, getPersonaCacheStats, getSessionCacheStats } from './cache-stats.js'

describe('cache-stats', () => {
  it('computes the ratio and tolerates empty sessions', () => {
    expect(cacheReadRatio(0, 0)).toBeNull()
    expect(cacheReadRatio(1000, 3000)).toBe(0.75)
  })

  it('reads per session and per persona over a window', () => {
    const db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'h')").run()
    db.prepare("INSERT INTO sessions (id, user_id, source, type, agent_id, last_activity, prompt_tokens, cache_read, cache_write) VALUES ('a', 1, 'web', 'interactive', 'bob', datetime('now'), 100, 300, 50)").run()
    db.prepare("INSERT INTO sessions (id, user_id, source, type, agent_id, last_activity, prompt_tokens, cache_read, cache_write) VALUES ('b', 1, 'web', 'interactive', 'bob', datetime('now', '-30 days'), 100, 0, 0)").run()
    db.prepare("INSERT INTO sessions (id, user_id, source, type, agent_id, last_activity, prompt_tokens, cache_read, cache_write) VALUES ('c', 1, 'system', 'task', 'bob', datetime('now'), 100, 0, 0)").run()

    expect(getSessionCacheStats(db, 'a')).toMatchObject({ sessionId: 'a', promptTokens: 100, cacheRead: 300, cacheReadRatio: 0.75 })
    expect(getSessionCacheStats(db, 'nope')).toBeNull()
    const persona = getPersonaCacheStats(db, 'bob', 7)
    expect(persona.sessions).toBe(1)
    expect(persona.cacheReadRatio).toBe(0.75)
    db.close()
  })
})
