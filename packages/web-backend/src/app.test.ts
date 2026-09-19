import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createApp } from './app.js'
import { createMemory, initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import type { AgentCore } from '@axiom/core'
import { setupWebSocketChat } from './ws-chat.js'
import { setupWebSocketLogs } from './ws-logs.js'
import { generateAccessToken } from './auth.js'
import { RuntimeMetrics } from './runtime-metrics.js'
import { SPEECH_TEXT_MAX_CHARS } from './api/modules/speech/schema.js'
import type { HealthMonitorService, HealthMonitorSnapshot } from './health-monitor.js'

let db: Database
let server: http.Server
let wss: import('./ws-chat.js').WebSocketChatResult
let logsWss: import('ws').WebSocketServer
let broadcastLog: (record: import('@axiom/core').ToolCallRecord) => void
let port: number
let baseUrl: string
let tempDataDir: string
let previousDataDir: string | undefined
let previousAdminUsername: string | undefined
let previousAdminPassword: string | undefined
const setTimeoutMinutes = vi.fn()
const refreshSystemPrompt = vi.fn()
const setThinkingLevel = vi.fn()
const restartHealthMonitor = vi.fn()
const healthMonitorSnapshot: HealthMonitorSnapshot = {
  enabled: true,
  agentStatus: 'running',
  intervalMinutes: 5,
  operatingMode: 'normal',
  activeProvider: null,
  primaryProvider: null,
  fallbackProvider: null,
  lastCheck: null,
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-web-backend-'))
  process.env.DATA_DIR = tempDataDir

  // Tests assume the default admin credentials (admin/admin) created by
  // ensureAdminUser(). Snapshot and clear any inherited ADMIN_USERNAME /
  // ADMIN_PASSWORD from the host environment so they don't leak into the
  // bcrypt hash used during admin provisioning.
  previousAdminUsername = process.env.ADMIN_USERNAME
  previousAdminPassword = process.env.ADMIN_PASSWORD
  delete process.env.ADMIN_USERNAME
  delete process.env.ADMIN_PASSWORD

  db = initDatabase(':memory:')
  const mockAgentCore = {
    getSessionManager: () => ({
      setTimeoutMinutes,
      // Stub used by REST upload endpoint and ws-chat session resolution.
      // Returns a synthetic UUID-shaped session ID so tests don't require a
      // full SessionManager.
      getOrCreateSession: (userId: string, source: string = 'web') => ({
        id: `00000000-0000-0000-0000-${userId.padStart(12, '0')}`,
        userId,
        source,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        messageCount: 0,
        summaryWritten: false,
        restored: false,
      }),
    }),
    refreshSystemPrompt,
    setThinkingLevel,
  } as unknown as AgentCore
  const mockHealthMonitorService = {
    restart: restartHealthMonitor,
    getSnapshot: () => healthMonitorSnapshot,
  } as unknown as HealthMonitorService
  const runtimeMetrics = new RuntimeMetrics()
  const app = createApp({ db, getAgentCore: () => mockAgentCore, healthMonitorService: mockHealthMonitorService, runtimeMetrics })
  server = http.createServer(app)
  wss = setupWebSocketChat(server, db, null, runtimeMetrics)
  const logsSetup = setupWebSocketLogs(server)
  logsWss = logsSetup.wss
  broadcastLog = logsSetup.broadcast
  await new Promise<void>((resolve) => server.listen(0, resolve))
  port = (server.address() as { port: number }).port
  baseUrl = `http://localhost:${port}`
})

afterAll(async () => {
  // Close all WebSocket connections first
  for (const client of wss.wss.clients) {
    client.terminate()
  }
  for (const client of logsWss.clients) {
    client.terminate()
  }
  wss.wss.close()
  logsWss.close()
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )

  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) {
    delete process.env.DATA_DIR
  } else {
    process.env.DATA_DIR = previousDataDir
  }
  if (previousAdminUsername === undefined) {
    delete process.env.ADMIN_USERNAME
  } else {
    process.env.ADMIN_USERNAME = previousAdminUsername
  }
  if (previousAdminPassword === undefined) {
    delete process.env.ADMIN_PASSWORD
  } else {
    process.env.ADMIN_PASSWORD = previousAdminPassword
  }
})

describe('health endpoint', () => {
  it('GET /health returns status ok', async () => {
    const res = await fetch(`${baseUrl}/health`)
    const body = (await res.json()) as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
    expect(typeof body.version).toBe('string')
  })
})

describe('API health monitoring', () => {
  let adminToken: string

  beforeAll(async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const body = (await loginRes.json()) as { accessToken: string }
    adminToken = body.accessToken
  })

  it('GET /api/health returns runtime snapshot and activity summary', async () => {
    healthMonitorSnapshot.activeProvider = {
      id: 'provider-1',
      name: 'Primary OpenAI',
      type: 'openai',
      model: 'gpt-4o-mini',
      status: 'degraded',
    }
    healthMonitorSnapshot.lastCheck = {
      checkedAt: '2026-03-27T12:00:00.000Z',
      providerId: 'provider-1',
      providerName: 'Primary OpenAI',
      providerType: 'openai',
      model: 'gpt-4o-mini',
      status: 'degraded',
      latencyMs: 6200,
      errorMessage: null,
      isRateLimited: false,
    }

    db.prepare(`INSERT INTO sessions (id, source, started_at, message_count, summary_written) VALUES (?, ?, datetime('now'), ?, ?)`)
      .run('health-session-1', 'web', 1, 0)
    db.prepare(`INSERT INTO chat_messages (session_id, role, content, timestamp) VALUES (?, ?, ?, datetime('now'))`)
      .run('health-session-1', 'user', 'hello')

    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as {
      agent: { status: string }
      provider: { status: string; model: string }
      lastCheck: { latencyMs: number; checkedAt: string }
      queueDepth: number
      activity: { messagesToday: number; sessionsToday: number }
    }

    expect(res.status).toBe(200)
    expect(body.agent.status).toBe('running')
    expect(body.provider.status).toBe('degraded')
    expect(body.provider.model).toBe('gpt-4o-mini')
    expect(body.lastCheck.latencyMs).toBe(6200)
    expect(body.queueDepth).toBe(0)
    expect(body.activity.messagesToday).toBeGreaterThanOrEqual(1)
    expect(body.activity.sessionsToday).toBeGreaterThanOrEqual(1)
  })

  it('GET /api/health/history returns paginated health checks', async () => {
    db.prepare(
      `INSERT INTO health_checks (timestamp, provider, status, latency_ms, error_message)
       VALUES (?, ?, ?, ?, ?)`
    ).run('2026-03-27T10:00:00.000Z', 'Primary OpenAI', 'healthy', 220, null)
    db.prepare(
      `INSERT INTO health_checks (timestamp, provider, status, latency_ms, error_message)
       VALUES (?, ?, ?, ?, ?)`
    ).run('2026-03-27T10:05:00.000Z', 'Primary OpenAI', 'down', 15000, 'Connection timed out')

    const res = await fetch(`${baseUrl}/api/health/history?page=1&limit=2`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as {
      history: Array<{ status: string; errorMessage: string | null }>
      pagination: { total: number; limit: number }
    }

    expect(res.status).toBe(200)
    expect(body.history).toHaveLength(2)
    expect(body.history[0].status).toBe('down')
    expect(body.history[0].errorMessage).toBe('Connection timed out')
    expect(body.pagination.limit).toBe(2)
    expect(body.pagination.total).toBeGreaterThanOrEqual(2)
  })
})

describe('auth flow', () => {
  it('POST /api/auth/login succeeds with valid credentials', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(body.accessToken).toBeDefined()
    expect(body.refreshToken).toBeDefined()
    expect(body.user).toEqual(
      expect.objectContaining({ username: 'admin', role: 'admin' })
    )
  })

  it('POST /api/auth/login fails with invalid credentials', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    })
    expect(res.status).toBe(401)
  })

  it('POST /api/auth/login fails with missing fields', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/auth/refresh returns new tokens', async () => {
    // Login first
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const loginBody = (await loginRes.json()) as { refreshToken: string }

    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(body.accessToken).toBeDefined()
    expect(body.refreshToken).toBeDefined()
  })

  it('POST /api/auth/refresh returns new tokens with user data', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const loginBody = (await loginRes.json()) as { refreshToken: string }

    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    })
    const body = (await res.json()) as { accessToken: string; refreshToken: string; user: { id: number; username: string; role: string } }
    expect(res.status).toBe(200)
    expect(body.user).toBeDefined()
    expect(body.user.username).toBe('admin')
    expect(body.user.role).toBe('admin')
  })

  it('POST /api/auth/refresh fails with invalid token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'invalid-token' }),
    })
    expect(res.status).toBe(401)
  })

  it('GET /api/auth/me returns current user', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const { accessToken } = (await loginRes.json()) as { accessToken: string }

    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const body = (await res.json()) as { user: { id: number; username: string; role: string } }
    expect(res.status).toBe(200)
    expect(body.user).toBeDefined()
    expect(body.user.username).toBe('admin')
    expect(body.user.role).toBe('admin')
  })

  it('GET /api/auth/me rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`)
    expect(res.status).toBe(401)
  })

  it('GET /api/auth/me rejects expired tokens', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: 'Bearer invalid-token' },
    })
    expect(res.status).toBe(401)
  })

  it('protected routes reject unauthenticated requests with 401', async () => {
    const res = await fetch(`${baseUrl}/api/chat/history`)
    expect(res.status).toBe(401)
  })

  it('protected routes accept valid JWT', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const { accessToken } = (await loginRes.json()) as { accessToken: string }

    const res = await fetch(`${baseUrl}/api/chat/history`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(res.status).toBe(200)
  })
})

describe('chat history API', () => {
  it('GET /api/chat/history returns paginated messages', async () => {
    // Login
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const { accessToken } = (await loginRes.json()) as { accessToken: string }

    // Insert some test messages
    const userId = (db.prepare('SELECT id FROM users WHERE username = ?').get('admin') as { id: number }).id
    db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)').run('test-session', userId, 'user', 'Hello')
    db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)').run('test-session', userId, 'assistant', 'Hi there!')

    const res = await fetch(`${baseUrl}/api/chat/history?session_id=test-session`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const body = (await res.json()) as { messages: unknown[]; pagination: { total: number } }
    expect(res.status).toBe(200)
    expect(body.messages.length).toBe(2)
    expect(body.pagination.total).toBe(2)
  })

  it('serves a legacy task-result row as a card instead of the whole report', async () => {
    // Rows written before the task card format carry the full report in
    // `content` — the longest one on the live database is 20,342 characters,
    // and the app downloaded all of it every time it opened the strand. No
    // migration: the card is derived here, on read.
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const { accessToken } = (await loginRes.json()) as { accessToken: string }
    const userId = (db.prepare('SELECT id FROM users WHERE username = ?').get('admin') as { id: number }).id

    const report = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: detail of the report.`).join('\n')
    expect(report.length).toBeGreaterThan(5000)
    db.prepare(
      `INSERT INTO tasks (id, name, prompt, status, trigger_type, result_summary, created_at)
       VALUES ('legacy-task', 'Nightly run', 'do it', 'completed', 'user', ?, datetime('now'))`,
    ).run(report)
    db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'legacy-session', userId, 'system',
      `\u2705 Task completed: Nightly run\n\n${report}`,
      JSON.stringify({ type: 'task_result', taskId: 'legacy-task', taskName: 'Nightly run' }),
    )

    const res = await fetch(`${baseUrl}/api/chat/history?session_id=legacy-session`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const body = (await res.json()) as { messages: Array<{ content: string; metadata: string }> }
    expect(res.status).toBe(200)
    const message = body.messages[0]
    expect(message.content.length).toBeLessThan(900)
    expect(message.content).toContain('Task completed: Nightly run')
    expect(message.content).toContain('open the task card for the full report (task legacy-task)')
    const metadata = JSON.parse(message.metadata) as Record<string, unknown>
    expect(metadata.resultPreviewDerived).toBe(true)
    expect(metadata.resultFullLength).toBe(report.length)

    // The stored row is untouched: nothing was migrated, nothing was lost.
    const stored = db.prepare("SELECT content FROM chat_messages WHERE session_id = 'legacy-session'").get() as { content: string }
    expect(stored.content.length).toBeGreaterThan(report.length)
  })
})

describe('WebSocket chat', () => {
  interface BufferedWs {
    ws: WebSocket
    messages: Record<string, unknown>[]
    waitForMessage: () => Promise<Record<string, unknown>>
  }

  function connectWs(token?: string): Promise<BufferedWs> {
    const url = token
      ? `ws://localhost:${port}/ws/chat?token=${token}`
      : `ws://localhost:${port}/ws/chat`
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const messages: Record<string, unknown>[] = []
      let pendingResolve: ((msg: Record<string, unknown>) => void) | null = null

      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>
        if (pendingResolve) {
          const r = pendingResolve
          pendingResolve = null
          r(parsed)
        } else {
          messages.push(parsed)
        }
      })

      const waitForMessage = (): Promise<Record<string, unknown>> => {
        if (messages.length > 0) {
          return Promise.resolve(messages.shift()!)
        }
        return new Promise((res) => {
          pendingResolve = res
        })
      }

      ws.on('open', () => resolve({ ws, messages, waitForMessage }))
      ws.on('error', reject)
    })
  }

  it('authenticates via query param token', async () => {
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const { ws, waitForMessage } = await connectWs(token)
    const msg = await waitForMessage()
    expect(msg.type).toBe('system')
    expect(msg.text).toBe('Authenticated')
    // Session ID is no longer assigned at auth time — it's resolved lazily
    // from SessionManager on the first user message.
    expect(msg.sessionId).toBeUndefined()
    ws.close()
  })

  it('rejects unauthenticated messages', async () => {
    const { ws, waitForMessage } = await connectWs()
    ws.send(JSON.stringify({ type: 'message', content: 'hello' }))
    const msg = await waitForMessage()
    expect(msg.type).toBe('error')
    expect(msg.error).toContain('Not authenticated')
    ws.close()
  })

  it('authenticates via first message JWT', async () => {
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const { ws, waitForMessage } = await connectWs()
    ws.send(JSON.stringify({ type: 'message', content: token }))
    const msg = await waitForMessage()
    expect(msg.type).toBe('system')
    expect(msg.text).toBe('Authenticated')
    ws.close()
  })

  it('sends message and receives agent-not-available error', async () => {
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const { ws, waitForMessage } = await connectWs(token)
    await waitForMessage() // auth confirmation

    ws.send(JSON.stringify({ type: 'message', content: 'Hello agent' }))
    const msg = await waitForMessage()
    expect(msg.type).toBe('error')
    expect(msg.error).toContain('Agent core not available')
    ws.close()
  })

  it('/new command resets session', async () => {
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const { ws, waitForMessage } = await connectWs(token)
    await waitForMessage() // auth confirmation (no sessionId)

    ws.send(JSON.stringify({ type: 'command', content: '/new' }))
    const msg = await waitForMessage()
    expect(msg.type).toBe('session_end')
    // ws-chat in this test is set up with a `null` agent core, so /new emits
    // a session_end without a sessionId (no SessionManager available to mint one).
    expect(msg.sessionId).toBeUndefined()
    ws.close()
  })

  it('/stop command reports when there is nothing to abort', async () => {
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const { ws, waitForMessage } = await connectWs(token)
    await waitForMessage() // auth

    ws.send(JSON.stringify({ type: 'command', content: '/stop' }))
    const msg = await waitForMessage()
    expect(msg.type).toBe('system')
    expect(msg.text).toBe('Nothing to stop.')
    ws.close()
  })
})

describe('logs API', () => {
  let adminToken: string

  beforeAll(async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const body = (await loginRes.json()) as { accessToken: string }
    adminToken = body.accessToken

    // Insert test tool call records
    db.prepare(
      "INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('sess-1', 'bash', 'ls -la', 'file1.txt\nfile2.txt', 120, 'success')
    db.prepare(
      "INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('sess-1', 'file_read', '/tmp/test.txt', 'hello world', 45, 'success')
    db.prepare(
      "INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('sess-2', 'bash', 'rm -rf /oops', 'Permission denied', 10, 'error')
  })

  it('GET /api/logs returns paginated log entries', async () => {
    const res = await fetch(`${baseUrl}/api/logs`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as { logs: unknown[]; pagination: { total: number; page: number } }
    expect(res.status).toBe(200)
    expect(body.logs.length).toBeGreaterThanOrEqual(3)
    expect(body.pagination.total).toBeGreaterThanOrEqual(3)
    expect(body.pagination.page).toBe(1)
  })

  it('GET /api/logs filters by tool_name', async () => {
    const res = await fetch(`${baseUrl}/api/logs?tool_name=bash`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as { logs: { toolName: string }[] }
    expect(res.status).toBe(200)
    expect(body.logs.length).toBeGreaterThanOrEqual(2)
    for (const log of body.logs) {
      expect(log.toolName).toBe('bash')
    }
  })

  it('GET /api/logs filters by session_id', async () => {
    const res = await fetch(`${baseUrl}/api/logs?session_id=sess-2`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as { logs: { sessionId: string }[] }
    expect(res.status).toBe(200)
    expect(body.logs.length).toBe(1)
    expect(body.logs[0].sessionId).toBe('sess-2')
  })

  it('GET /api/logs text search works across tool_name, input, output', async () => {
    const res = await fetch(`${baseUrl}/api/logs?search=Permission`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as { logs: { output: string }[] }
    expect(res.status).toBe(200)
    expect(body.logs.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /api/logs truncates input/output in list view', async () => {
    // Insert a log with very long input
    const longInput = 'x'.repeat(500)
    db.prepare(
      "INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('sess-3', 'bash', longInput, 'short output', 10, 'success')

    const res = await fetch(`${baseUrl}/api/logs?session_id=sess-3`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as { logs: { input: string }[] }
    expect(res.status).toBe(200)
    expect(body.logs[0].input.length).toBeLessThan(300)
  })

  it('GET /api/logs/:id returns full untruncated log entry', async () => {
    // Get the ID of the long input entry
    const listRes = await fetch(`${baseUrl}/api/logs?session_id=sess-3`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const listBody = (await listRes.json()) as { logs: { id: number }[] }
    const id = listBody.logs[0].id

    const res = await fetch(`${baseUrl}/api/logs/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as { log: { id: number; input: string; toolName: string; status: string } }
    expect(res.status).toBe(200)
    expect(body.log.id).toBe(id)
    expect(body.log.input.length).toBe(500) // Full untruncated
    expect(body.log.toolName).toBe('bash')
    expect(body.log.status).toBe('success')
  })

  it('GET /api/logs/:id returns 404 for missing entry', async () => {
    const res = await fetch(`${baseUrl}/api/logs/99999`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(404)
  })

  it('GET /api/logs/tool-names returns distinct tool names', async () => {
    const res = await fetch(`${baseUrl}/api/logs/tool-names`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as { toolNames: string[] }
    expect(res.status).toBe(200)
    expect(body.toolNames).toContain('bash')
    expect(body.toolNames).toContain('file_read')
  })

  it('rejects non-admin users', async () => {
    // Create a regular user
    const bcrypt = await import('bcrypt')
    const hash = bcrypt.hashSync('userpass', 10)
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('regular', hash, 'user')

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'regular', password: 'userpass' }),
    })
    const { accessToken } = (await loginRes.json()) as { accessToken: string }

    const res = await fetch(`${baseUrl}/api/logs`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(res.status).toBe(403)
  })

  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/logs`)
    expect(res.status).toBe(401)
  })
})

describe('WebSocket logs', () => {
  interface BufferedWs {
    ws: WebSocket
    messages: Record<string, unknown>[]
    waitForMessage: () => Promise<Record<string, unknown>>
  }

  function connectLogsWs(token?: string): Promise<BufferedWs> {
    const url = token
      ? `ws://localhost:${port}/ws/logs?token=${token}`
      : `ws://localhost:${port}/ws/logs`
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const messages: Record<string, unknown>[] = []
      let pendingResolve: ((msg: Record<string, unknown>) => void) | null = null

      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>
        if (pendingResolve) {
          const r = pendingResolve
          pendingResolve = null
          r(parsed)
        } else {
          messages.push(parsed)
        }
      })

      const waitForMessage = (): Promise<Record<string, unknown>> => {
        if (messages.length > 0) {
          return Promise.resolve(messages.shift()!)
        }
        return new Promise((res) => {
          pendingResolve = res
        })
      }

      ws.on('open', () => resolve({ ws, messages, waitForMessage }))
      ws.on('error', reject)
    })
  }

  it('authenticates admin and receives connected message', async () => {
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const { ws, waitForMessage } = await connectLogsWs(token)
    const msg = await waitForMessage()
    expect(msg.type).toBe('connected')
    ws.close()
  })

  it('rejects non-admin users', async () => {
    const token = generateAccessToken({ userId: 2, username: 'regular', role: 'user' })
    const ws = new WebSocket(`ws://localhost:${port}/ws/logs?token=${token}`)
    await new Promise<void>((resolve) => {
      ws.on('error', (err) => {
        expect((err as Error).message).toContain('401')
        resolve()
      })
    })
  })

  it('rejects unauthenticated connections', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/logs`)
    await new Promise<void>((resolve) => {
      ws.on('error', (err) => {
        expect((err as Error).message).toContain('401')
        resolve()
      })
    })
  })

  it('broadcasts log entries to connected clients', async () => {
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const { ws, waitForMessage } = await connectLogsWs(token)
    await waitForMessage() // connected

    // Broadcast a log entry
    broadcastLog({
      timestamp: '2025-01-01T00:00:00',
      sessionId: 'test-sess',
      toolName: 'bash',
      input: 'echo hello',
      output: 'hello',
      durationMs: 50,
      status: 'success',
    })

    const msg = await waitForMessage()
    expect(msg.type).toBe('log_entry')
    const data = msg.data as Record<string, unknown>
    expect(data.toolName).toBe('bash')
    expect(data.input).toBe('echo hello')
    ws.close()
  })
})

describe('memory API', () => {
  let adminToken: string

  beforeAll(async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const body = (await loginRes.json()) as { accessToken: string }
    adminToken = body.accessToken
  })

  it('reads and updates SOUL.md', async () => {
    const getRes = await fetch(`${baseUrl}/api/memory/soul`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const getBody = (await getRes.json()) as { content: string }
    expect(getRes.status).toBe(200)
    expect(getBody.content).toContain('# Soul')

    const putRes = await fetch(`${baseUrl}/api/memory/soul`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: '# Soul\n\nUpdated from test\n' }),
    })
    const putBody = (await putRes.json()) as { content: string }
    expect(putRes.status).toBe(200)
    expect(putBody.content).toContain('Updated from test')
    expect(refreshSystemPrompt).toHaveBeenCalled()
  })

  it('lists, writes, and reads daily memory files', async () => {
    const putRes = await fetch(`${baseUrl}/api/memory/daily/2026-03-27`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: '# Daily Memory — 2026-03-27\n\nNote\n' }),
    })
    expect(putRes.status).toBe(200)

    const listRes = await fetch(`${baseUrl}/api/memory/daily`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const listBody = (await listRes.json()) as {
      files: Array<{ date: string; filename: string }>
    }
    expect(listRes.status).toBe(200)
    expect(listBody.files.some((file) => file.date === '2026-03-27')).toBe(true)

    const getRes = await fetch(`${baseUrl}/api/memory/daily/2026-03-27`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const getBody = (await getRes.json()) as { content: string }
    expect(getRes.status).toBe(200)
    expect(getBody.content).toContain('Note')
  })

  it('reads and updates HEARTBEAT.md', async () => {
    const getRes = await fetch(`${baseUrl}/api/memory/heartbeat`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const getBody = (await getRes.json()) as { content: string }
    expect(getRes.status).toBe(200)
    expect(getBody.content).toContain('Heartbeat')

    const putRes = await fetch(`${baseUrl}/api/memory/heartbeat`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: '# Heartbeat Tasks\n\nUpdated from test\n' }),
    })
    const putBody = (await putRes.json()) as { content: string }
    expect(putRes.status).toBe(200)
    expect(putBody.content).toContain('Updated from test')
    expect(refreshSystemPrompt).toHaveBeenCalled()
  })

  it('reads, updates, and exposes the default of TASKS.md', async () => {
    const getRes = await fetch(`${baseUrl}/api/memory/tasks-guidelines`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const getBody = (await getRes.json()) as { content: string }
    expect(getRes.status).toBe(200)
    expect(getBody.content).toContain('# Background Task Guidelines')

    const defaultRes = await fetch(`${baseUrl}/api/memory/tasks-guidelines/default`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const defaultBody = (await defaultRes.json()) as { content: string }
    expect(defaultRes.status).toBe(200)
    expect(defaultBody.content).toContain('# Background Task Guidelines')
    expect(defaultBody.content).toContain('Work independently for as long as possible')

    const putRes = await fetch(`${baseUrl}/api/memory/tasks-guidelines`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: '# Custom Task Guidelines\n\n- Be concise\n' }),
    })
    const putBody = (await putRes.json()) as { content: string }
    expect(putRes.status).toBe(200)
    expect(putBody.content).toContain('Be concise')
    expect(refreshSystemPrompt).toHaveBeenCalled()

    const onDisk = fs.readFileSync(path.join(tempDataDir, 'config', 'TASKS.md'), 'utf-8')
    expect(onDisk).toContain('Be concise')
  })

  it('reads and updates user profile', async () => {
    const getRes = await fetch(`${baseUrl}/api/memory/profile`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const getBody = (await getRes.json()) as { username: string; content: string }
    expect(getRes.status).toBe(200)
    expect(getBody.username).toBe('admin')
    expect(getBody.content).toContain('admin')

    const putRes = await fetch(`${baseUrl}/api/memory/profile`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: '# User Profile — admin\n\nUpdated from test\n' }),
    })
    const putBody = (await putRes.json()) as { username: string; content: string }
    expect(putRes.status).toBe(200)
    expect(putBody.username).toBe('admin')
    expect(putBody.content).toContain('Updated from test')
    expect(refreshSystemPrompt).toHaveBeenCalled()
  })

  it('lists, filters, updates, and deletes stored facts', async () => {
    db.prepare('INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(2, 'regular-facts', 'hash', 'user')

    const dockerFactId = createMemory(db, 1, 'facts-session-1', 'User works with Docker every day', 'session')
    createMemory(db, 1, 'facts-session-2', 'Prefers Postgres over SQLite', 'session')
    const userTwoFactId = createMemory(db, 2, 'facts-session-3', 'Enjoys gardening on weekends', 'session')

    const listRes = await fetch(`${baseUrl}/api/memory/facts?limit=2&offset=0`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const listBody = (await listRes.json()) as {
      facts: Array<{ id: number }>
      total: number
    }
    expect(listRes.status).toBe(200)
    expect(listBody.total).toBeGreaterThanOrEqual(3)
    expect(listBody.facts).toHaveLength(2)

    const queryRes = await fetch(`${baseUrl}/api/memory/facts?query=docker`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const queryBody = (await queryRes.json()) as {
      facts: Array<{ id: number; content: string }>
      total: number
    }
    expect(queryRes.status).toBe(200)
    expect(queryBody.total).toBe(1)
    expect(queryBody.facts[0]?.id).toBe(dockerFactId)
    expect(queryBody.facts[0]?.content).toContain('Docker')

    const userFilterRes = await fetch(`${baseUrl}/api/memory/facts?userId=1`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const userFilterBody = (await userFilterRes.json()) as {
      facts: Array<{ userId: number | null }>
      total: number
    }
    expect(userFilterRes.status).toBe(200)
    expect(userFilterBody.total).toBeGreaterThanOrEqual(2)
    expect(userFilterBody.facts.every((fact) => fact.userId === 1)).toBe(true)

    const updateRes = await fetch(`${baseUrl}/api/memory/facts/${dockerFactId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'User works with Docker and Kubernetes every day' }),
    })
    expect(updateRes.status).toBe(200)

    const updatedFact = db.prepare('SELECT content FROM memories WHERE id = ?').get(dockerFactId) as { content: string }
    expect(updatedFact.content).toBe('User works with Docker and Kubernetes every day')

    const deleteRes = await fetch(`${baseUrl}/api/memory/facts/${userTwoFactId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(deleteRes.status).toBe(200)

    const deletedFact = db.prepare('SELECT id FROM memories WHERE id = ?').get(userTwoFactId)
    expect(deletedFact).toBeUndefined()
  })

  it('enforces admin-only access for facts endpoints', async () => {
    const userToken = generateAccessToken({ userId: 2, username: 'regular', role: 'user' })

    const listRes = await fetch(`${baseUrl}/api/memory/facts`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(listRes.status).toBe(403)

    const updateRes = await fetch(`${baseUrl}/api/memory/facts/1`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Nope' }),
    })
    expect(updateRes.status).toBe(403)

    const deleteRes = await fetch(`${baseUrl}/api/memory/facts/1`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(deleteRes.status).toBe(403)
  })

  it('requires authentication for memory routes', async () => {
    const soulRes = await fetch(`${baseUrl}/api/memory/soul`)
    expect(soulRes.status).toBe(401)

    const heartbeatRes = await fetch(`${baseUrl}/api/memory/heartbeat`)
    expect(heartbeatRes.status).toBe(401)

    const profileRes = await fetch(`${baseUrl}/api/memory/profile`)
    expect(profileRes.status).toBe(401)
  })
})

describe('settings API', () => {
  let adminToken: string

  beforeAll(async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const body = (await loginRes.json()) as { accessToken: string }
    adminToken = body.accessToken
  })

  it('reads settings including telegram token and fact extraction defaults', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as {
      telegram: { enabled: boolean; botToken: string; batchingDelayMs: number }
      factExtraction: { enabled: boolean; providerId: string; minSessionMessages: number }
    }
    expect(res.status).toBe(200)
    expect(body.telegram).toEqual({
      enabled: false,
      botToken: '',
      batchingDelayMs: 2500,
      sendVoiceReply: false,
      sendStallWarnings: false,
    })
    expect(body.factExtraction).toEqual({ enabled: true, providerId: '', minSessionMessages: 3 })
  })

  it('updates settings and applies live changes', async () => {
    setTimeoutMinutes.mockClear()
    refreshSystemPrompt.mockClear()
    restartHealthMonitor.mockClear()

    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionTimeoutMinutes: 30,
        language: 'German',
        healthMonitorIntervalMinutes: 7,
        telegram: {
          batchingDelayMs: 4000,
          botToken: 'telegram-secret',
        },
      }),
    })
    const body = (await res.json()) as {
      sessionTimeoutMinutes: number
      language: string
      healthMonitorIntervalMinutes: number
      telegram: { botToken: string; batchingDelayMs: number }
    }

    expect(res.status).toBe(200)
    expect(body.sessionTimeoutMinutes).toBe(30)
    expect(body.language).toBe('German')
    expect(body.healthMonitorIntervalMinutes).toBe(7)
    expect(body.telegram.batchingDelayMs).toBe(4000)
    expect(body.telegram.botToken).toBe('telegram-secret')
    expect(setTimeoutMinutes).toHaveBeenCalledWith(30)
    expect(refreshSystemPrompt).toHaveBeenCalled()
    expect(restartHealthMonitor).toHaveBeenCalled()

    const settingsPath = path.join(tempDataDir, 'config', 'settings.json')
    const telegramPath = path.join(tempDataDir, 'config', 'telegram.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { language: string; batchingDelayMs?: number }
    const telegram = JSON.parse(fs.readFileSync(telegramPath, 'utf-8')) as { botToken: string; batchingDelayMs: number }
    expect(settings.language).toBe('German')
    expect(settings.batchingDelayMs).toBeUndefined()
    expect(telegram.batchingDelayMs).toBe(4000)
    expect(telegram.botToken).toBe('telegram-secret')
  })

  it('accepts legacy healthMonitor.intervalMinutes in update payloads', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        healthMonitor: {
          intervalMinutes: 11,
        },
      }),
    })

    const body = (await res.json()) as { healthMonitorIntervalMinutes: number }
    expect(res.status).toBe(200)
    expect(body.healthMonitorIntervalMinutes).toBe(11)

    const settingsPath = path.join(tempDataDir, 'config', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { healthMonitorIntervalMinutes: number }
    expect(settings.healthMonitorIntervalMinutes).toBe(11)
  })

  it('persists factExtraction when saving full form (like the frontend)', async () => {
    const getRes = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const defaults = (await getRes.json()) as Record<string, unknown>
    expect(defaults.factExtraction).toEqual({
      enabled: true,
      providerId: '',
      minSessionMessages: 3,
    })

    const fullForm = {
      ...defaults,
      factExtraction: {
        ...(defaults.factExtraction as Record<string, unknown>),
        enabled: true,
        providerId: 'provider-123',
        minSessionMessages: 5,
      },
    }
    delete (fullForm as Record<string, unknown>).message

    const putRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fullForm),
    })
    const putBody = (await putRes.json()) as {
      factExtraction: { enabled: boolean; providerId: string; minSessionMessages: number }
    }
    expect(putRes.status).toBe(200)
    expect(putBody.factExtraction).toEqual({ enabled: true, providerId: 'provider-123', minSessionMessages: 5 })

    const settingsPath = path.join(tempDataDir, 'config', 'settings.json')
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    expect(raw.factExtraction).toEqual({ enabled: true, providerId: 'provider-123', minSessionMessages: 5 })

    const reloadRes = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const reloaded = (await reloadRes.json()) as {
      factExtraction: { enabled: boolean; providerId: string; minSessionMessages: number }
    }
    expect(reloaded.factExtraction).toEqual({ enabled: true, providerId: 'provider-123', minSessionMessages: 5 })
  })

  it('persists agentHeartbeat when saving full form (like the frontend)', async () => {
    // Step 1: GET defaults
    const getRes = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const defaults = (await getRes.json()) as Record<string, unknown>
    expect(defaults.agentHeartbeat).toEqual({
      enabled: false,
      intervalMinutes: 60,
      nightMode: { enabled: true, startHour: 23, endHour: 8 },
    })

    // Step 2: PUT the full form (like the frontend does), with agentHeartbeat.enabled = true
    const fullForm = {
      ...defaults,
      agentHeartbeat: {
        ...(defaults.agentHeartbeat as Record<string, unknown>),
        enabled: true,
      },
    }
    delete (fullForm as Record<string, unknown>).message // remove any extra keys

    const putRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fullForm),
    })
    const putBody = (await putRes.json()) as { agentHeartbeat: { enabled: boolean } }
    expect(putRes.status).toBe(200)
    expect(putBody.agentHeartbeat.enabled).toBe(true)

    // Step 3: Verify file was written
    const settingsPath = path.join(tempDataDir, 'config', 'settings.json')
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    expect((raw.agentHeartbeat as Record<string, unknown>)?.enabled).toBe(true)

    // Step 4: GET again (simulating page reload) — should still be enabled
    const reloadRes = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const reloaded = (await reloadRes.json()) as { agentHeartbeat: { enabled: boolean } }
    expect(reloaded.agentHeartbeat.enabled).toBe(true)
  })

  it('persists telegram.enabled when saving full form', async () => {
    // GET defaults
    const getRes = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const defaults = (await getRes.json()) as Record<string, unknown>
    const telegramDefaults = defaults.telegram as Record<string, unknown>

    // PUT with telegram.enabled = true
    const putRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...defaults, telegram: { ...telegramDefaults, enabled: true } }),
    })
    expect(putRes.status).toBe(200)
    const putBody = (await putRes.json()) as { telegram: { enabled: boolean } }
    expect(putBody.telegram.enabled).toBe(true)

    // GET again — should persist
    const reloadRes = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const reloaded = (await reloadRes.json()) as { telegram: { enabled: boolean } }
    expect(reloaded.telegram.enabled).toBe(true)
  })

  it('applies live settings updates to agentCore without failures (thinkingLevel, session, prompt)', async () => {
    // Regression: a full-form PUT from the frontend includes every live-updatable
    // setting (thinkingLevel, language, timezone, sessionTimeoutMinutes). Every
    // corresponding agentCore.* hook must exist and must not throw — otherwise
    // the service would silently log "Failed to apply live settings update" and
    // subsequent live updates in the same try-block would be skipped.
    setTimeoutMinutes.mockClear()
    refreshSystemPrompt.mockClear()
    setThinkingLevel.mockClear()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const getRes = await fetch(`${baseUrl}/api/settings`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      const defaults = (await getRes.json()) as Record<string, unknown>

      const fullForm = { ...defaults, thinkingLevel: 'medium', language: 'en', timezone: 'UTC' }
      delete (fullForm as Record<string, unknown>).message

      const putRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(fullForm),
      })
      expect(putRes.status).toBe(200)

      // All live hooks must have been called — proves none of them silently threw
      // and caused the catch-block to swallow the rest.
      expect(setThinkingLevel).toHaveBeenCalledWith('medium')
      expect(refreshSystemPrompt).toHaveBeenCalled()
      expect(setTimeoutMinutes).toHaveBeenCalled()

      // And the service must not have logged any live-update failure.
      const liveUpdateErrors = errorSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Failed to apply live settings update')
      )
      expect(liveUpdateErrors).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('providers API', () => {
  let adminToken: string

  beforeAll(async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const body = (await loginRes.json()) as { accessToken: string }
    adminToken = body.accessToken
  })

  it('restarts health monitor when the active provider changes', async () => {
    restartHealthMonitor.mockClear()

    const firstRes = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Provider One',
        providerType: 'openai',
        apiKey: 'sk-provider-one',
        enabledModels: ['gpt-4o-mini'],
      }),
    })
    const firstBody = (await firstRes.json()) as { provider: { id: string } }
    expect(firstRes.status).toBe(201)
    expect(restartHealthMonitor).toHaveBeenCalledTimes(1)

    const secondRes = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Provider Two',
        providerType: 'openai',
        apiKey: 'sk-provider-two',
        enabledModels: ['gpt-4o-mini'],
      }),
    })
    const secondBody = (await secondRes.json()) as { provider: { id: string } }
    expect(secondRes.status).toBe(201)

    restartHealthMonitor.mockClear()
    const activateRes = await fetch(`${baseUrl}/api/providers/${secondBody.provider.id}/activate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    })

    expect(activateRes.status).toBe(200)
    expect(restartHealthMonitor).toHaveBeenCalledTimes(1)
    expect(firstBody.provider.id).not.toBe(secondBody.provider.id)
  })
})

describe('users API', () => {
  let adminToken: string

  beforeAll(async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const body = (await loginRes.json()) as { accessToken: string }
    adminToken = body.accessToken
  })

  it('creates, updates, lists, and deletes users', async () => {
    const createRes = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'alice', password: 'pass1234', role: 'user' }),
    })
    const createBody = (await createRes.json()) as { user: { id: number; role: string } }
    expect(createRes.status).toBe(201)
    expect(createBody.user.role).toBe('user')

    const listRes = await fetch(`${baseUrl}/api/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const listBody = (await listRes.json()) as { users: Array<{ username: string }> }
    expect(listRes.status).toBe(200)
    expect(listBody.users.some((user) => user.username === 'alice')).toBe(true)

    const updateRes = await fetch(`${baseUrl}/api/users/${createBody.user.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'admin', password: 'newpass123' }),
    })
    const updateBody = (await updateRes.json()) as { user: { role: string } }
    expect(updateRes.status).toBe(200)
    expect(updateBody.user.role).toBe('admin')

    const deleteRes = await fetch(`${baseUrl}/api/users/${createBody.user.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(deleteRes.status).toBe(200)
  })

  it('does not allow deleting yourself', async () => {
    const res = await fetch(`${baseUrl}/api/users/1`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(400)
  })
})

describe('stats API', () => {
  let adminToken: string

  beforeAll(async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    const body = (await loginRes.json()) as { accessToken: string }
    adminToken = body.accessToken

    const configDir = path.join(tempDataDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({
        sessionTimeoutMinutes: 15,
        language: 'en',
        healthMonitorIntervalMinutes: 5,
        tokenPriceTable: {
          'custom-model': { input: 1.25, output: 2.5 },
          'gpt-4o': { input: 2.5, output: 10 },
        },
      }, null, 2),
      'utf-8',
    )

    const insert = db.prepare(
      'INSERT INTO token_usage (timestamp, provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )

    insert.run('2026-03-27T08:00:00.000Z', 'openai', 'gpt-4o', 1000, 500, 0, 'usage-sess-1')
    insert.run('2026-03-27T12:00:00.000Z', 'openai', 'gpt-4o', 2000, 1000, 0.5, 'usage-sess-2')
    insert.run('2026-03-26T10:30:00.000Z', 'anthropic', 'custom-model', 3000, 1500, 0, 'usage-sess-3')
    insert.run('2026-03-01T09:00:00.000Z', 'anthropic', 'custom-model', 4000, 2000, 0, 'usage-sess-4')
  })

  it('GET /api/stats/usage aggregates usage with group_by and filters', async () => {
    const res = await fetch(`${baseUrl}/api/stats/usage?group_by=provider,model&date_from=2026-03-26&date_to=2026-03-27`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as {
      groupBy: string[]
      rows: Array<{
        provider: string
        model: string
        requests: number
        totalTokens: number
        estimatedCost: number
      }>
      totals: { requests: number; totalTokens: number; estimatedCost: number }
      availableProviders: string[]
      availableModels: string[]
    }

    expect(res.status).toBe(200)
    expect(body.groupBy).toEqual(['provider', 'model'])
    expect(body.rows).toHaveLength(2)
    expect(body.rows[0].provider).toBe('openai')
    expect(body.rows[0].model).toBe('gpt-4o')
    expect(body.rows[0].requests).toBe(2)
    expect(body.rows[0].totalTokens).toBe(4500)
    expect(body.rows[0].estimatedCost).toBeCloseTo(0.5075, 6)
    expect(body.rows[1].provider).toBe('anthropic')
    expect(body.rows[1].estimatedCost).toBeCloseTo(0.0075, 6)
    expect(body.totals.requests).toBe(3)
    expect(body.totals.totalTokens).toBe(9000)
    expect(body.availableProviders).toEqual(['anthropic', 'openai'])
    expect(body.availableModels).toEqual(['custom-model', 'gpt-4o'])
  })

  it('GET /api/stats/usage supports hourly grouping with provider/model filters', async () => {
    const res = await fetch(`${baseUrl}/api/stats/usage?group_by=hour&provider=openai&model=gpt-4o&date_from=2026-03-27&date_to=2026-03-27`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as {
      rows: Array<{ hour: string; promptTokens: number; completionTokens: number; totalTokens: number }>
    }

    expect(res.status).toBe(200)
    expect(body.rows).toHaveLength(2)
    expect(body.rows[0].hour).toBe('2026-03-27 08:00:00')
    expect(body.rows[0].totalTokens).toBe(1500)
    expect(body.rows[1].hour).toBe('2026-03-27 12:00:00')
  })

  it('GET /api/stats/summary returns today/week/month/all-time totals', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-27T15:30:00.000Z'))

    try {
      const res = await fetch(`${baseUrl}/api/stats/summary`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      const body = (await res.json()) as {
        today: { totalTokens: number; estimatedCost: number }
        week: { totalTokens: number }
        month: { totalTokens: number }
        allTime: { totalTokens: number }
      }

      expect(res.status).toBe(200)
      expect(body.today.totalTokens).toBe(4500)
      expect(body.today.estimatedCost).toBeCloseTo(0.5075, 6)
      expect(body.week.totalTokens).toBe(9000)
      expect(body.month.totalTokens).toBe(15000)
      expect(body.allTime.totalTokens).toBe(15000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('GET /api/stats/stalls aggregates provider stalls for the period', async () => {
    const insertStall = db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const stallMetadata = (durationMs: number, outcome: string | null) => JSON.stringify({
      kind: 'provider_stall',
      startedAt: '2026-03-27T08:00:00.000Z',
      resolvedAt: outcome ? '2026-03-27T08:01:00.000Z' : null,
      durationMs,
      outcome,
    })

    insertStall.run('stall-sess-1', null, 'system', 'stalled', stallMetadata(30_000, 'recovered'), '2026-03-27T08:00:00.000Z')
    insertStall.run('stall-sess-1', null, 'system', 'stalled', stallMetadata(50_000, 'recovered'), '2026-03-27T09:00:00.000Z')
    insertStall.run('stall-sess-2', null, 'system', 'stalled', stallMetadata(90_000, 'aborted'), '2026-03-27T10:00:00.000Z')
    insertStall.run('stall-sess-3', null, 'system', 'stalled', stallMetadata(60_000, 'aborted'), '2026-03-01T10:00:00.000Z')

    const res = await fetch(`${baseUrl}/api/stats/stalls?date_from=2026-03-26&date_to=2026-03-27`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = (await res.json()) as {
      total: number
      recovered: number
      aborted: number
      unresolved: number
      averageDurationMs: number
      maxDurationMs: number
    }

    expect(res.status).toBe(200)
    expect(body.total).toBe(3)
    expect(body.recovered).toBe(2)
    expect(body.aborted).toBe(1)
    expect(body.unresolved).toBe(0)
    expect(body.averageDurationMs).toBe(56_667)
    expect(body.maxDurationMs).toBe(90_000)

    const emptyRes = await fetch(`${baseUrl}/api/stats/stalls?date_from=2026-04-01&date_to=2026-04-30`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const emptyBody = (await emptyRes.json()) as { total: number; averageDurationMs: number }
    expect(emptyRes.status).toBe(200)
    expect(emptyBody.total).toBe(0)
    expect(emptyBody.averageDurationMs).toBe(0)
  })

  it('stats endpoints reject non-admin users', async () => {
    const bcrypt = await import('bcrypt')
    const hash = bcrypt.hashSync('stats-pass', 10)
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('stats-user', hash, 'user')

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'stats-user', password: 'stats-pass' }),
    })
    const { accessToken } = (await loginRes.json()) as { accessToken: string }

    const res = await fetch(`${baseUrl}/api/stats/usage?group_by=provider`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    expect(res.status).toBe(403)
  })

  it('stats endpoints reject unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/stats/summary`)
    expect(res.status).toBe(401)
  })
})

describe('upload API', () => {
  let adminToken: string

  beforeAll(async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })
    adminToken = (await loginRes.json() as { accessToken: string }).accessToken
  })

  it('stores uploaded files with chat messages', async () => {
    const form = new FormData()
    form.append('content', 'with file')
    form.append('files', new Blob(['hello upload'], { type: 'text/plain' }), 'note.txt')

    const res = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: form,
    })
    const body = await res.json() as { message: { metadata: string } }
    expect(res.status).toBe(201)
    expect(body.message.metadata).toContain('note.txt')

    const meta = JSON.parse(body.message.metadata) as { files: Array<{ relativePath: string }> }
    const filePath = path.join(tempDataDir, 'uploads', meta.files[0].relativePath)
    expect(fs.existsSync(filePath)).toBe(true)
  })
})

describe('speech body limit', () => {
  // The speech routes accept an inline text up to SPEECH_TEXT_MAX_CHARS
  // (200.000 chars). Without the path scoped json parser in createApp the
  // default express.json() (100 kB) would answer 413 and the documented
  // `400 { error: 'text_too_large' }` would be unreachable for a real client.
  it('answers 400 text_too_large instead of 413 for an oversized inline text', async () => {
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const res = await fetch(`${baseUrl}/api/speech/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: 'x'.repeat(SPEECH_TEXT_MAX_CHARS + 1) }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'text_too_large' })
  })

  it('still parses a normal sized speech body', async () => {
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const res = await fetch(`${baseUrl}/api/speech/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
  })
})
