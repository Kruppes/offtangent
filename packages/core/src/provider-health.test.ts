import { describe, it, expect } from 'vitest'
import {
  performProviderHealthCheck,
  logHealthCheck,
  queryHealthCheckHistory,
  getLatestHealthCheck,
  getActivitySummary,
  initDatabase,
} from './index.js'

const provider = {
  id: 'provider-1',
  name: 'Test Provider',
  type: 'openai-completions',
  providerType: 'openai' as const,
  provider: 'openai',
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  enabledModels: ['gpt-4o-mini'],
}

describe('provider-health', () => {
  it('returns unconfigured when no provider is active', async () => {
    const result = await performProviderHealthCheck(null)
    expect(result.status).toBe('unconfigured')
    expect(result.errorMessage).toContain('No active provider')
    expect(result.providerName).toBeNull()
    expect(result.isRateLimited).toBe(false)
  })

  it('classifies successful checks as healthy or degraded based on latency', async () => {
    const healthy = await performProviderHealthCheck(provider, {
      degradedThresholdMs: 100,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    expect(healthy.status).toBe('healthy')
    expect(healthy.errorMessage).toBeNull()
    expect(healthy.isRateLimited).toBe(false)

    const degraded = await performProviderHealthCheck(provider, {
      degradedThresholdMs: 1,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })
    expect(degraded.status).toBe('degraded')
    expect(degraded.latencyMs).toBeGreaterThanOrEqual(1)
    expect(degraded.isRateLimited).toBe(false)
  })

  it('detects HTTP 429 and sets isRateLimited to true', async () => {
    const result = await performProviderHealthCheck(provider, {
      fetchImpl: async () => new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 }),
    })
    expect(result.status).toBe('down')
    expect(result.isRateLimited).toBe(true)
  })

  it('sets isRateLimited to false for non-429 errors', async () => {
    const result = await performProviderHealthCheck(provider, {
      fetchImpl: async () => new Response(JSON.stringify({ error: 'Server error' }), { status: 500 }),
    })
    expect(result.status).toBe('down')
    expect(result.isRateLimited).toBe(false)
  })

  describe('timeout resolution and classification', () => {
    /** Fake fetch that only answers after `resolveAfterMs`, but honours the abort signal like real fetch. */
    function slowFetch(resolveAfterMs: number): typeof fetch {
      return ((_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
            resolveAfterMs,
          )
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            const err = new Error('This operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })) as unknown as typeof fetch
    }

    it('uses provider.healthCheckTimeoutMs when no call option is given', async () => {
      const result = await performProviderHealthCheck(
        { ...provider, healthCheckTimeoutMs: 30 },
        { fetchImpl: slowFetch(1500) },
      )
      expect(result.status).toBe('down')
      expect(result.isTimeout).toBe(true)
      expect(result.errorMessage).toBe('Connection timed out')
      // Aborted at the provider timeout, not at the 15 s default
      expect(result.latencyMs).toBeLessThan(1500)
    })

    it('explicit options.timeoutMs takes precedence over provider.healthCheckTimeoutMs', async () => {
      // With the provider field (30 ms) in effect this would abort; the
      // explicit call option (manual test path) must win.
      const result = await performProviderHealthCheck(
        { ...provider, healthCheckTimeoutMs: 30 },
        { timeoutMs: 5000, fetchImpl: slowFetch(150) },
      )
      expect(result.status).toBe('healthy')
      expect(result.errorMessage).toBeNull()
    })

    it('falls back to the 15 s default when neither option nor provider field is set', async () => {
      // Would go down instantly under a tiny timeout; the default gives it room.
      const result = await performProviderHealthCheck(provider, {
        fetchImpl: slowFetch(100),
      })
      expect(result.status).toBe('healthy')
    })

    it('does not classify real HTTP errors as timeout', async () => {
      const result = await performProviderHealthCheck(provider, {
        fetchImpl: async () => new Response(JSON.stringify({ error: 'Server error' }), { status: 500 }),
      })
      expect(result.status).toBe('down')
      expect(result.isTimeout).not.toBe(true)
    })

    it('does not classify thrown non-abort errors as timeout', async () => {
      const result = await performProviderHealthCheck(provider, {
        fetchImpl: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
        },
      })
      expect(result.status).toBe('down')
      expect(result.isTimeout).toBe(false)
      expect(result.errorMessage).toContain('ECONNREFUSED')
    })
  })

  it('logs history rows and activity summary in sqlite', () => {
    const db = initDatabase(':memory:')

    logHealthCheck(db, {
      timestamp: '2026-03-27T09:00:00.000Z',
      provider: 'OpenAI Primary',
      status: 'healthy',
      latencyMs: 240,
      errorMessage: null,
    })
    logHealthCheck(db, {
      timestamp: '2026-03-27T09:05:00.000Z',
      provider: 'OpenAI Primary',
      status: 'down',
      latencyMs: 15000,
      errorMessage: 'Connection timed out',
    })

    db.prepare(
      `INSERT INTO sessions (id, source, started_at, message_count, summary_written)
       VALUES (?, ?, datetime('now'), ?, ?)`
    ).run('session-1', 'web', 2, 0)
    db.prepare(
      `INSERT INTO chat_messages (session_id, role, content, timestamp)
       VALUES (?, ?, ?, datetime('now'))`
    ).run('session-1', 'user', 'Hello')
    db.prepare(
      `INSERT INTO chat_messages (session_id, role, content, timestamp)
       VALUES (?, ?, ?, datetime('now'))`
    ).run('session-1', 'assistant', 'Hi')

    const latest = getLatestHealthCheck(db)
    expect(latest?.status).toBe('down')
    expect(latest?.errorMessage).toBe('Connection timed out')

    const history = queryHealthCheckHistory(db, 1, 10)
    expect(history.records).toHaveLength(2)
    expect(history.records[0].status).toBe('down')
    expect(history.pagination.total).toBe(2)

    const activity = getActivitySummary(db)
    expect(activity.messagesToday).toBe(2)
    expect(activity.sessionsToday).toBe(1)

    db.close()
  })
})
