/**
 * Integration tests for the MCP client against synthetic MCP servers
 * (src/__fixtures__/mcp-test-server.mjs over real stdio / Streamable HTTP
 * transports of the official SDK, plus raw loopback HTTP servers that
 * reproduce the review 2026-11 counter-probes). No real servers, no real secrets.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { validateToolArguments } from '@earendil-works/pi-ai'
import { resolveMcpSettings, type McpSettings } from './mcp-config.js'
import {
  McpManager,
  McpPublicError,
  boundedFetch,
  classifyMcpError,
  containsKnownSecretDeep,
  mcpToolName,
  renderMcpResult,
  resolveConfigSecrets,
  sanitizeInputSchema,
  withholdLocalOnlyMcpOutput,
  type McpClientLike,
  type McpScope,
} from './mcp-client.js'
import { invalidateKnownValues } from './secret-boundary.js'
import { selectCodemodeTools } from './codemode-tool.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, '__fixtures__', 'mcp-test-server.mjs')
const SECRETS: Record<string, string> = { 'mcp-test-token': 'dummy-value-one' }
const resolveSecret = (slug: string) => SECRETS[slug] ?? null
const FAKE_SECRET = 'fake_review_value_0123456789ABCDEFGHIJ'
const testRedact = (t: string) => t.split(FAKE_SECRET).join('{{secret:redacted}}')

function settingsFrom(servers: Record<string, unknown>): McpSettings {
  const { settings, problems } = resolveMcpSettings({ enabled: true, servers })
  if (problems.length > 0) throw new Error(problems.join('; '))
  return settings
}

function stdioServer(extra: Record<string, unknown> = {}) {
  return { transport: 'stdio', command: process.execPath, args: [fixture, 'stdio'], personas: ['main'], users: ['1'], ...extra }
}

function scope(agentId = 'main', userId: string | undefined = '1', sessionId: string | undefined = 's1', local = true): McpScope {
  return { agentId, userId, sessionId, modelIsLocal: () => local }
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(c => c.text ?? '').join('')
}

function byName(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find(t => t.name === name)
  if (!tool) throw new Error(`tool ${name} missing; have ${tools.map(t => t.name).join(', ')}`)
  return tool
}

const managers: McpManager[] = []
function manager(load: () => McpSettings, extra: Partial<ConstructorParameters<typeof McpManager>[0]> = {}) {
  const m = new McpManager({ loadSettings: load, resolveSecret, redactKnown: testRedact, ...extra })
  managers.push(m)
  return m
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.closeAll()))
})

/** Raw JSON-RPC-over-HTTP server reproducing the review probes (probes.mts). */
async function reviewServer(mode: 'normal' | 'error' | 'stall' | 'pages' | 'secret-meta' | 'call-stall') {
  const state = { requests: [] as Array<{ method: string; session?: string }>, lists: 0, version: 1, sessions: 0, values: new Map<string, unknown>(), stalled: false }
  const sockets = new Set<import('node:net').Socket>()
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let body = ''
    for await (const x of req) body += x
    const q = JSON.parse(body)
    state.requests.push({ method: q.method, session: req.headers['mcp-session-id'] as string | undefined })
    if (mode === 'error') { res.writeHead(403, { 'content-type': 'text/plain' }).end('credential ' + req.headers.authorization); return }
    if (q.method === 'notifications/initialized' && mode === 'stall') { state.stalled = true; return }
    if (q.id === undefined) { res.writeHead(202).end(); return }
    let result: Record<string, unknown>
    if (q.method === 'initialize') {
      res.setHeader('mcp-session-id', 'session-' + (++state.sessions))
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'review', version: '1' } }
    } else if (q.method === 'tools/list') {
      state.lists++
      const n = Number(q.params?.cursor ?? 0)
      const secretPart = mode === 'secret-meta' ? ' api_key=' + FAKE_SECRET : ''
      result = { tools: [{ name: mode === 'pages' ? 'tool' + n : 'echo', description: 'v' + state.version + secretPart, inputSchema: { type: 'object', properties: { write: { type: 'string' } } } }] }
      if (mode === 'pages' && n < 50) result.nextCursor = String(n + 1)
    } else if (q.method === 'tools/call') {
      if (mode === 'call-stall') return // never answers: the outcome stays unknown
      const sid = String(req.headers['mcp-session-id'] ?? 'none')
      const args = q.params.arguments ?? {}
      if (args.write !== undefined) state.values.set(sid, args.write)
      result = { content: [{ type: 'text', text: JSON.stringify({ value: state.values.get(sid) ?? null, sid }) }] }
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'unsupported' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }))
  })
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/mcp`
  return {
    url, state, sockets,
    stop: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) },
  }
}

function httpCfg(url: string, extra: Record<string, unknown> = {}) {
  return settingsFrom({ review: { transport: 'http', url, personas: ['main', 'bob'], users: ['1', '2'], connectTimeoutMs: 1000, callTimeoutMs: 2000, ...extra } })
}

describe('helpers', () => {
  it('builds provider-safe, bounded tool names', () => {
    expect(mcpToolName('files', 'read')).toBe('mcp_files_read')
    expect(mcpToolName('files', 'read.file v2')).toBe('mcp_files_read_file_v2')
    const long = mcpToolName('files', 'x'.repeat(200))
    expect(long.length).toBe(64)
    expect(long).toMatch(/^mcp_files_x+_[0-9a-f]{8}$/)
    expect(mcpToolName('files', 'x'.repeat(200) + 'a')).not.toBe(long)
  })

  it('resolves secret handles only from the store and fails on unknown ones', () => {
    expect(resolveConfigSecrets({ A: 'Bearer {{secret:mcp-test-token}}' }, resolveSecret)).toEqual({ A: 'Bearer dummy-value-one' })
    expect(() => resolveConfigSecrets({ A: '{{secret:missing}}' }, resolveSecret)).toThrow('secret_handle_unknown')
    expect(resolveConfigSecrets({ A: 'plain' }, resolveSecret)).toEqual({ A: 'plain' })
  })

  it('accepts only object input schemas of the safe subset', () => {
    expect(sanitizeInputSchema(undefined)).toEqual({ type: 'object', properties: {} })
    expect(sanitizeInputSchema({ type: 'object', $schema: 'x', properties: { a: { type: 'string' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    expect(sanitizeInputSchema({ type: 'string' })).toBeNull()
    expect(sanitizeInputSchema([1])).toBeNull()
  })

  it('renders results as labelled, truncated text without binary content', () => {
    const out = renderMcpResult('s', { content: [{ type: 'image', mimeType: 'image/png' }, { type: 'text', text: 'abcdef' }] }, 1000)
    expect(out).toContain('Untrusted output of MCP server "s"')
    expect(out).toContain('[image content omitted (image/png)]')
    expect(out).toContain('abcdef')
    const truncated = renderMcpResult('s', { content: [{ type: 'text', text: 'abcdef' }] }, 3)
    expect(truncated).toContain('abc\n[output truncated at 3 characters]')
    expect(truncated).not.toContain('abcd')
  })
})

describe('review P1-5: unsafe input schemas (schema-probe.mts)', () => {
  it('rejects catastrophic regex patterns before the validator ever sees them', () => {
    const schema = sanitizeInputSchema({ type: 'object', properties: { text: { type: 'string', pattern: '^(a+)+$' } }, required: ['text'] })
    expect(schema).toBeNull()
  })

  it('rejects external $ref and invalid properties', () => {
    expect(sanitizeInputSchema({ type: 'object', properties: 'not a schema' })).toBeNull()
    expect(sanitizeInputSchema({ type: 'object', properties: { x: { $ref: 'https://example.invalid/private' } } })).toBeNull()
    expect(sanitizeInputSchema({ type: 'object', $defs: { a: {} } })).toBeNull()
    expect(sanitizeInputSchema({ type: 'object', properties: { x: 5 } })).toBeNull()
  })

  it('enforces depth, node and property limits', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 12; i++) deep = { type: 'object', properties: { a: deep } }
    expect(sanitizeInputSchema(deep)).toBeNull()
    const wide = { type: 'object', properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, { type: 'string' }])) }
    expect(sanitizeInputSchema(wide)).toBeNull()
  })

  it('a rebuilt schema validates large inputs quickly', () => {
    const schema = sanitizeInputSchema({ type: 'object', properties: { text: { type: 'string', maxLength: 100_000, format: 'x' } }, required: ['text'] })!
    const started = Date.now()
    validateToolArguments({ name: 't', description: 't', parameters: schema as never }, { type: 'toolCall', id: 'x', name: 't', arguments: { text: 'a'.repeat(50_000) + '!' } })
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('review P1-4: public error classes (probes.mts › error)', () => {
  it('maps HTTP status to a fixed class and never carries the raw body', () => {
    const raw = Object.assign(new Error('credential Bearer ' + FAKE_SECRET), { status: 403 })
    expect(classifyMcpError(raw, 'connect_failed')).toEqual({ code: 'http_forbidden' })
    const err = new McpPublicError('http_forbidden', 'review')
    expect(err.message).toBe('MCP server "review": server denied access (HTTP 403)')
    expect(classifyMcpError(new Error('ECONNREFUSED ' + FAKE_SECRET), 'connect_failed')).toEqual({ code: 'connect_failed' })
  })

  it('a 403 that echoes the Authorization header leaks neither into status nor logs', async () => {
    const s = await reviewServer('error')
    const logs: string[] = []
    const orig = { warn: console.warn, error: console.error, log: console.log }
    console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
    console.error = console.warn
    console.log = console.warn
    try {
      const m = manager(() => httpCfg(s.url, { headers: { Authorization: 'Bearer {{secret:mcp-test-token}}' } }))
      expect(await m.getToolsFor(scope())).toEqual([])
      const status = JSON.stringify(m.status())
      expect(status).toContain('http_forbidden')
      expect(status).not.toContain('dummy-value-one')
      expect(logs.join('\n')).not.toContain('dummy-value-one')
    } finally {
      Object.assign(console, orig)
      await s.stop()
    }
  }, 15_000)
})

describe('review P1-1: secrets in remote metadata (runtime-probe.mts)', () => {
  it('drops a tool whose description/schema contains a known secret', async () => {
    const s = await reviewServer('secret-meta')
    try {
      const m = manager(() => httpCfg(s.url))
      expect(await m.getToolsFor(scope())).toEqual([])
      expect(s.state.lists).toBe(1)
    } finally {
      await s.stop()
    }
  }, 15_000)

  it('uses the real secret boundary by default', async () => {
    const s = await reviewServer('secret-meta')
    process.env.MCP_REVIEW_API_KEY = FAKE_SECRET
    invalidateKnownValues()
    try {
      const m = manager(() => httpCfg(s.url), { redactKnown: undefined })
      expect(await m.getToolsFor(scope())).toEqual([])
    } finally {
      delete process.env.MCP_REVIEW_API_KEY
      invalidateKnownValues()
      await s.stop()
    }
  }, 15_000)
})

describe('review P1-2: per user × persona × strand sessions (agent-probes.mts)', () => {
  it('user1/main cannot read what user2/bob wrote, and strands are separate', async () => {
    const s = await reviewServer('normal')
    try {
      const m = manager(() => httpCfg(s.url))
      const a = byName(await m.getToolsFor(scope('main', '1', 'strand-a')), 'mcp_review_echo')
      const b = byName(await m.getToolsFor(scope('bob', '2', 'strand-b')), 'mcp_review_echo')
      const c = byName(await m.getToolsFor(scope('main', '1', 'strand-c')), 'mcp_review_echo')
      const body = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(text(r).split('\n').slice(1).join('\n'))
      expect(body(await a.execute('1', { write: 'marker-user1' } as never)).value).toBe('marker-user1')
      const fromB = body(await b.execute('2', {} as never))
      const fromC = body(await c.execute('3', {} as never))
      expect(fromB.value).toBeNull()
      expect(fromC.value).toBeNull()
      expect(new Set([body(await a.execute('4', {} as never)).sid, fromB.sid, fromC.sid]).size).toBe(3)
      expect(s.state.sessions).toBe(3)
    } finally {
      await s.stop()
    }
  }, 20_000)

  it('offers nothing without an authenticated user or strand, or to an unlisted user', async () => {
    const s = await reviewServer('normal')
    try {
      const m = manager(() => httpCfg(s.url))
      expect(await m.getToolsFor({ agentId: 'main', userId: undefined, sessionId: 's1', modelIsLocal: () => true })).toEqual([])
      expect(await m.getToolsFor({ agentId: 'main', userId: '1', sessionId: undefined, modelIsLocal: () => true })).toEqual([])
      expect(await m.getToolsFor(scope('main', '3'))).toEqual([])
      expect(s.state.requests).toHaveLength(0)
    } finally {
      await s.stop()
    }
  })

  it('caps sessions per server and evicts idle ones', async () => {
    const s = await reviewServer('normal')
    try {
      const m = manager(() => httpCfg(s.url, { maxSessions: 2 }))
      for (const sid of ['x1', 'x2', 'x3']) expect(await m.getToolsFor(scope('main', '1', sid))).toHaveLength(1)
      expect(m.status()[0]!.connections).toBe(2)
    } finally {
      await s.stop()
    }
  }, 20_000)
})

describe('review P1-3: local_only egress gate', () => {
  it('local_only (default) servers are not offered to a non-local model and calls are refused', async () => {
    const s = await reviewServer('normal')
    try {
      let local = true
      const m = manager(() => httpCfg(s.url))
      const sc: McpScope = { agentId: 'main', userId: '1', sessionId: 's', modelIsLocal: () => local }
      const echo = byName(await m.getToolsFor(sc), 'mcp_review_echo')
      local = false
      expect(await m.getToolsFor(sc)).toEqual([])
      await expect(echo.execute('c', {} as never)).rejects.toThrow(/local_only/)
      const calls = s.state.requests.filter(r => r.method === 'tools/call').length
      expect(calls).toBe(0)
    } finally {
      await s.stop()
    }
  }, 15_000)

  it('a model-policy error counts as remote (fail closed)', async () => {
    const s = await reviewServer('normal')
    try {
      const m = manager(() => httpCfg(s.url))
      expect(await m.getToolsFor({ agentId: 'main', userId: '1', sessionId: 's', modelIsLocal: () => { throw new Error('x') } })).toEqual([])
      expect(await m.getToolsFor({ agentId: 'main', userId: '1', sessionId: 's' })).toEqual([])
    } finally {
      await s.stop()
    }
  })

  it('cloud_ok is an explicit opt-in and marks the result', async () => {
    const s = await reviewServer('normal')
    try {
      const m = manager(() => httpCfg(s.url, { dataClass: 'cloud_ok' }))
      const echo = byName(await m.getToolsFor(scope('main', '1', 's', false)), 'mcp_review_echo')
      const r = await echo.execute('c', {} as never)
      expect(r.details).toMatchObject({ mcpDataClass: 'cloud_ok' })
    } finally {
      await s.stop()
    }
  }, 15_000)

  it('withholds local_only MCP output from a non-local request, fail closed on unmarked results', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'toolResult', toolName: 'mcp_mail_read', details: { mcpDataClass: 'local_only' }, content: [{ type: 'text', text: 'PRIVATE_MAIL' }] },
      { role: 'toolResult', toolName: 'mcp_mail_old', content: [{ type: 'text', text: 'PRIVATE_OLD' }] },
      { role: 'toolResult', toolName: 'mcp_pub_x', details: { mcpDataClass: 'cloud_ok' }, content: [{ type: 'text', text: 'PUBLIC' }] },
      { role: 'toolResult', toolName: 'read_file', content: [{ type: 'text', text: 'FILE' }] },
    ]
    const remote = JSON.stringify(withholdLocalOnlyMcpOutput(msgs, false))
    expect(remote).not.toContain('PRIVATE_MAIL')
    expect(remote).not.toContain('PRIVATE_OLD')
    expect(remote).toContain('PUBLIC')
    expect(remote).toContain('FILE')
    expect(withholdLocalOnlyMcpOutput(msgs, true)).toBe(msgs)
  })
})

describe('review P1-6: hard connect deadline (probes.mts › stall)', () => {
  it('a server that stalls notifications/initialized is cut off at connectTimeoutMs and its sockets closed', async () => {
    const s = await reviewServer('stall')
    try {
      const m = manager(() => httpCfg(s.url, { connectTimeoutMs: 1000 }))
      const started = Date.now()
      expect(await m.getToolsFor(scope())).toEqual([])
      expect(Date.now() - started).toBeLessThan(2000)
      expect(s.state.stalled).toBe(true)
      expect(m.status()[0]).toMatchObject({ connections: 0, lastError: 'connect_timeout' })
      await new Promise(r => setTimeout(r, 300))
      expect(s.sockets.size).toBe(0)
    } finally {
      await s.stop()
    }
  }, 15_000)

  it('closeAll during an in-flight connect resolves promptly and closes the transport', async () => {
    const s = await reviewServer('stall')
    try {
      const m = manager(() => httpCfg(s.url, { connectTimeoutMs: 10_000 }))
      let finished = false
      const p = m.getToolsFor(scope()).then(t => { finished = true; return t })
      await new Promise(r => setTimeout(r, 500))
      const started = Date.now()
      await m.closeAll()
      expect(Date.now() - started).toBeLessThan(1500)
      expect(await Promise.race([p, new Promise(r => setTimeout(() => r('pending'), 1000))])).toEqual([])
      expect(finished).toBe(true)
      await new Promise(r => setTimeout(r, 300))
      expect(s.sockets.size).toBe(0)
    } finally {
      await s.stop()
    }
  }, 15_000)

  it('a turn abort returns promptly and a healthy server is not blocked by a stalled one', async () => {
    const stall = await reviewServer('stall')
    const ok = await reviewServer('normal')
    try {
      const settings = settingsFrom({
        stall: { transport: 'http', url: stall.url, personas: ['main'], users: ['1'], connectTimeoutMs: 10_000 },
        ok: { transport: 'http', url: ok.url, personas: ['main'], users: ['1'], connectTimeoutMs: 10_000 },
      })
      const m = manager(() => settings)
      const abort = new AbortController()
      setTimeout(() => abort.abort(), 700)
      const started = Date.now()
      expect(await m.getToolsFor(scope(), new Set(), abort.signal)).toEqual([])
      expect(Date.now() - started).toBeLessThan(1500)
      // healthy server finished its own connect independently
      await new Promise(r => setTimeout(r, 200))
      expect(m.status().find(x => x.id === 'ok')?.connections).toBe(1)
    } finally {
      await stall.stop()
      await ok.stop()
    }
  }, 20_000)
})

describe('review P1-7: bounded discovery (list-cost-probe.mts)', () => {
  function fakeClient(pages: number, perPage: number, counter: { requests: number }): McpClientLike {
    return {
      connect: async () => {},
      request: async (req) => {
        counter.requests++
        const n = Number((req.params as { cursor?: string })?.cursor ?? 0)
        return { tools: Array.from({ length: perPage }, (_, i) => ({ name: `t${n}_${i}`, inputSchema: { type: 'object', properties: {} } })), nextCursor: n + 1 < pages ? String(n + 1) : undefined }
      },
      callTool: async () => ({ content: [] }),
      close: async () => {},
    }
  }
  const cfg = (extra: Record<string, unknown> = {}) => settingsFrom({ review: { transport: 'http', url: 'http://127.0.0.1:1/mcp', personas: ['main'], users: ['1'], connectTimeoutMs: 5000, ...extra } })

  it('maxTools 1 stops paginating early and stores few tools', async () => {
    const counter = { requests: 0 }
    const m = manager(() => cfg({ maxTools: 1 }), { clientFactory: async () => fakeClient(12, 1, counter), transportFactory: async () => ({}) })
    expect(await m.getToolsFor(scope())).toHaveLength(1)
    expect(counter.requests).toBeLessThanOrEqual(4)
  })

  it('never requests more than 10 pages for an endless server', async () => {
    const counter = { requests: 0 }
    const m = manager(() => cfg({ maxTools: 256 }), { clientFactory: async () => fakeClient(1_000_000, 1, counter), transportFactory: async () => ({}) })
    await m.getToolsFor(scope())
    expect(counter.requests).toBe(10)
  })

  it('30k tools in one page with a large deny list stay fast', async () => {
    const counter = { requests: 0 }
    const deny = Array.from({ length: 5000 }, (_, i) => `t0_${i}`)
    const m = manager(() => cfg({ maxTools: 100, tools: { deny } }), { clientFactory: async () => fakeClient(1, 30_000, counter), transportFactory: async () => ({}) })
    const started = Date.now()
    const tools = await m.getToolsFor(scope())
    expect(Date.now() - started).toBeLessThan(1000)
    expect(tools.length).toBeLessThanOrEqual(100)
  })

  it('boundedFetch rejects oversized bodies', async () => {
    const big = 'x'.repeat(2000)
    const f = boundedFetch(1000, (async () => new Response(big)) as typeof fetch)
    const res = await f('http://127.0.0.1/')
    await expect(res.text()).rejects.toThrow()
    const declared = boundedFetch(1000, (async () => new Response('x', { headers: { 'content-length': '5000' } })) as typeof fetch)
    await expect(declared('http://127.0.0.1/')).rejects.toThrow('response_too_large')
  })
})

describe('review P2-9: TTL refresh goes over the wire (probes.mts › ttl-cache)', () => {
  it('re-lists tools after toolsTtlMs', async () => {
    const s = await reviewServer('normal')
    try {
      let now = 100_000
      const m = manager(() => httpCfg(s.url, { toolsTtlMs: 1000 }), { now: () => now })
      expect(byName(await m.getToolsFor(scope()), 'mcp_review_echo').description).toContain('v1')
      s.state.version = 2
      now += 500
      expect(byName(await m.getToolsFor(scope()), 'mcp_review_echo').description).toContain('v1')
      now += 1000
      expect(byName(await m.getToolsFor(scope()), 'mcp_review_echo').description).toContain('v2')
      expect(s.state.lists).toBe(2)
    } finally {
      await s.stop()
    }
  }, 15_000)
})

describe('review P2-10: no replay, no codemode reach', () => {
  it('a call with unknown outcome (timeout) is sent exactly once and never resent', async () => {
    const s = await reviewServer('call-stall')
    try {
      const m = manager(() => httpCfg(s.url, { callTimeoutMs: 1000 }))
      const tools = await m.getToolsFor(scope())
      await expect(byName(tools, 'mcp_review_echo').execute('c', { write: 'x' } as never)).rejects.toThrow(/call timed out/)
      await new Promise(r => setTimeout(r, 300))
      expect(s.state.requests.filter(r => r.method === 'tools/call')).toHaveLength(1)
    } finally {
      await s.stop()
    }
  }, 15_000)

  it('codemode never selects an MCP tool, in any mode', () => {
    const mcpTool = { name: 'mcp_review_echo', label: 'x', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) } as unknown as AgentTool
    for (const mode of ['readonly', 'coding'] as const) expect(selectCodemodeTools([mcpTool], mode)).toEqual([])
  })
})

describe('MCP over stdio (synthetic server)', () => {
  it('returns no tools and starts no process when MCP is off', async () => {
    let factoryCalls = 0
    const m = manager(() => ({ enabled: false, servers: [] }), { transportFactory: async () => { factoryCalls++; throw new Error('unreachable') } })
    expect(await m.getToolsFor(scope())).toEqual([])
    expect(factoryCalls).toBe(0)
  })

  it('discovers tools, executes them and enforces persona scope', async () => {
    const m = manager(() => settingsFrom({ test: stdioServer() }))
    expect(await m.getToolsFor(scope('other'))).toEqual([])
    const tools = await m.getToolsFor(scope())
    expect(tools.map(t => t.name).sort()).toEqual(['mcp_test_big', 'mcp_test_dangerous', 'mcp_test_echo', 'mcp_test_env_probe', 'mcp_test_fail', 'mcp_test_image', 'mcp_test_slow'])
    const echo = byName(tools, 'mcp_test_echo')
    expect(echo.description).toContain('External MCP server "test"')
    expect(echo.parameters).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } })
    expect((echo.parameters as Record<string, unknown>).$schema).toBeUndefined()
    const result = await echo.execute('call-1', { text: 'hello' } as never)
    expect(text(result)).toContain('echo:hello')
    expect(text(result)).toContain('Untrusted output')
    expect(m.status()).toEqual([{ id: 'test', transport: 'stdio', connections: 1, lastError: null }])
  }, 30_000)

  it('passes only the safe env plus configured (secret-resolved) env to the child', async () => {
    process.env.OFFTANGENT_LEAK_PROBE = 'must-not-leak'
    try {
      const m = manager(() => settingsFrom({ test: stdioServer({ env: { MCP_TEST_TOKEN: '{{secret:mcp-test-token}}' } }) }))
      const tools = await m.getToolsFor(scope())
      const probe = JSON.parse(text(await byName(tools, 'mcp_test_env_probe').execute('c', {} as never)).split('\n').slice(1).join('\n'))
      expect(probe).toEqual({ token: 'dummy-value-one', leak: null })
    } finally {
      delete process.env.OFFTANGENT_LEAK_PROBE
    }
  }, 30_000)

  it('does not connect when a configured secret handle is unknown', async () => {
    const m = manager(() => settingsFrom({ test: stdioServer({ env: { MCP_TEST_TOKEN: '{{secret:does-not-exist}}' } }) }))
    expect(await m.getToolsFor(scope())).toEqual([])
    expect(m.status()[0]).toMatchObject({ connections: 0, lastError: 'secret_handle_unknown' })
  })

  it('applies tool allow/deny filters at discovery and at call time', async () => {
    let settings = settingsFrom({ test: stdioServer({ tools: { deny: ['dangerous'] } }) })
    const m = manager(() => settings)
    let tools = await m.getToolsFor(scope())
    expect(tools.map(t => t.name)).not.toContain('mcp_test_dangerous')
    const echo = byName(tools, 'mcp_test_echo')
    settings = settingsFrom({ test: stdioServer({ tools: { allow: ['big'] } }) })
    tools = await m.getToolsFor(scope())
    expect(tools.map(t => t.name)).toEqual(['mcp_test_big'])
    await expect(echo.execute('c', { text: 'x' } as never)).rejects.toThrow(/not allowed/)
  }, 30_000)

  it('re-checks persona and user scope at call time after the config changed', async () => {
    let settings = settingsFrom({ test: stdioServer() })
    const m = manager(() => settings)
    const echo = byName(await m.getToolsFor(scope()), 'mcp_test_echo')
    settings = settingsFrom({ test: stdioServer({ personas: ['bob'] }) })
    await expect(echo.execute('c', { text: 'x' } as never)).rejects.toThrow(/not allowed/)
    settings = settingsFrom({ test: stdioServer({ users: ['2'] }) })
    await expect(echo.execute('c', { text: 'x' } as never)).rejects.toThrow(/not allowed/)
    settings = { enabled: false, servers: [] }
    await expect(echo.execute('c', { text: 'x' } as never)).rejects.toThrow(/not configured/)
  }, 30_000)

  it('times out a slow call with a fixed error and stays usable afterwards', async () => {
    const m = manager(() => settingsFrom({ test: stdioServer({ callTimeoutMs: 1000 }) }))
    const tools = await m.getToolsFor(scope())
    const started = Date.now()
    await expect(byName(tools, 'mcp_test_slow').execute('c', { ms: 10_000 } as never)).rejects.toThrow(/call timed out/)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(text(await byName(tools, 'mcp_test_echo').execute('c', { text: 'after' } as never))).toContain('echo:after')
  }, 30_000)

  it('honours the caller abort signal', async () => {
    const m = manager(() => settingsFrom({ test: stdioServer() }))
    const tools = await m.getToolsFor(scope())
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 300)
    await expect(byName(tools, 'mcp_test_slow').execute('c', { ms: 10_000 } as never, abort.signal)).rejects.toThrow(/call aborted/)
  }, 30_000)

  it('reports tool errors and truncates large output', async () => {
    const m = manager(() => settingsFrom({ test: stdioServer({ maxOutputChars: 1000 }) }))
    const tools = await m.getToolsFor(scope())
    await expect(byName(tools, 'mcp_test_fail').execute('c', {} as never)).rejects.toThrow(/tool failed on purpose/)
    const big = text(await byName(tools, 'mcp_test_big').execute('c', { size: 5000 } as never))
    expect(big).toContain('[output truncated at 1000 characters]')
    expect(big.length).toBeLessThan(1300)
    const img = text(await byName(tools, 'mcp_test_image').execute('c', {} as never))
    expect(img).toContain('[image content omitted (image/png)]')
    expect(img).not.toContain('iVBOR')
  }, 30_000)

  it('skips tools whose names collide with existing tools', async () => {
    const m = manager(() => settingsFrom({ test: stdioServer() }))
    const tools = await m.getToolsFor(scope(), new Set(['mcp_test_echo']))
    expect(tools.map(t => t.name)).not.toContain('mcp_test_echo')
    expect(tools.length).toBe(6)
  }, 30_000)

  it('isolates a failing server and backs off', async () => {
    const m = manager(() => settingsFrom({ bad: stdioServer({ command: '/nonexistent/binary', args: [] }), test: stdioServer() }))
    const tools = await m.getToolsFor(scope())
    expect(tools.some(t => t.name === 'mcp_test_echo')).toBe(true)
    expect(m.status().find(s => s.id === 'bad')?.lastError).toBeTruthy()
  }, 30_000)

  it('kills the child when MCP is disabled and on closeAll', async () => {
    const pids: number[] = []
    const factory = async (server: { command?: string; args: string[] }, resolved: { env: Record<string, string> }) => {
      const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
      const t = new StdioClientTransport({ command: server.command!, args: server.args, env: resolved.env, stderr: 'ignore' })
      const start = t.start.bind(t)
      t.start = async () => { await start(); if (t.pid) pids.push(t.pid) }
      return t
    }
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    const waitDead = async (pid: number) => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 100)); return !alive(pid) }

    let settings = settingsFrom({ test: stdioServer() })
    const m = manager(() => settings, { transportFactory: factory as never })
    await m.getToolsFor(scope())
    expect(pids).toHaveLength(1)
    settings = { enabled: false, servers: [] }
    expect(await m.getToolsFor(scope())).toEqual([])
    expect(await waitDead(pids[0]!)).toBe(true)
    expect(m.status()).toEqual([])

    settings = settingsFrom({ test: stdioServer() })
    await m.getToolsFor(scope())
    expect(pids).toHaveLength(2)
    await m.closeAll()
    expect(await waitDead(pids[1]!)).toBe(true)
    expect(await m.getToolsFor(scope())).toEqual([])
  }, 30_000)

  it('reconnects only when connection fields change', async () => {
    let settings = settingsFrom({ test: stdioServer() })
    let connects = 0
    const m = manager(() => settings, {
      transportFactory: async (server, resolved) => {
        connects++
        const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
        return new StdioClientTransport({ command: server.command!, args: server.args, env: resolved.env, stderr: 'ignore' })
      },
    })
    await m.getToolsFor(scope())
    settings = settingsFrom({ test: stdioServer({ personas: ['main', 'bob'] }) })
    await m.getToolsFor(scope())
    expect(connects).toBe(1) // scope change: no reconnect of the existing session
    settings = settingsFrom({ test: stdioServer({ env: { X: '1' } }) })
    await m.getToolsFor(scope())
    expect(connects).toBe(2)
  }, 30_000)
})

describe('MCP over Streamable HTTP (synthetic server on loopback)', () => {
  let srv: Awaited<ReturnType<typeof import('./__fixtures__/mcp-test-server.mjs')['startHttpTestServer']>>
  beforeAll(async () => {
    const mod = await import('./__fixtures__/mcp-test-server.mjs')
    srv = await mod.startHttpTestServer({ expectedToken: 'dummy-value-one' })
  })
  afterAll(async () => { await srv?.close() })

  it('connects with a secret-resolved Authorization header and calls a tool', async () => {
    const m = manager(() => settingsFrom({ remote: { transport: 'http', url: srv.url, personas: ['main'], users: ['1'], headers: { Authorization: 'Bearer {{secret:mcp-test-token}}' } } }))
    const tools = await m.getToolsFor(scope())
    const echo = byName(tools, 'mcp_remote_echo')
    expect(text(await echo.execute('c', { text: 'over-http' } as never))).toContain('echo:over-http')
    expect(srv.seen.authHeaders.every(h => h === 'Bearer dummy-value-one')).toBe(true)
  }, 30_000)

  it('exposes no tools when the server rejects the credentials', async () => {
    const m = manager(() => settingsFrom({ remote: { transport: 'http', url: srv.url, personas: ['main'], users: ['1'], headers: { Authorization: 'Bearer wrong' }, connectTimeoutMs: 3000 } }))
    expect(await m.getToolsFor(scope())).toEqual([])
    expect(m.status()[0]?.lastError).toBeTruthy()
  }, 30_000)

  it('does not follow redirects', async () => {
    const before = srv.seen.requests
    const m = manager(() => settingsFrom({ remote: { transport: 'http', url: srv.redirectUrl, personas: ['main'], users: ['1'], headers: { Authorization: 'Bearer {{secret:mcp-test-token}}' }, connectTimeoutMs: 3000 } }))
    expect(await m.getToolsFor(scope())).toEqual([])
    expect(srv.seen.requests - before).toBeGreaterThanOrEqual(1)
    expect(m.status()[0]?.connections).toBe(0)
  }, 30_000)
})

describe('review 2 (REVIEW-77292ef9.md)', () => {
  // A known secret with a quote and a backslash: JSON escaping rewrites both,
  // so a check on serialised JSON text misses it.
  const QUOTED = 'SYNTH_Quoted"Secret\\Password_8675309'
  const SEALED = '[SEALED]'
  const qRedact = (t: string) => t.split(QUOTED).join(SEALED)
  const cfg = (extra: Record<string, unknown> = {}) => settingsFrom({ review: { transport: 'http', url: 'http://127.0.0.1:1/mcp', personas: ['main'], users: ['1'], connectTimeoutMs: 5000, ...extra } })
  function listClient(tools: unknown[], closes = { n: 0 }): McpClientLike {
    return {
      connect: async () => {},
      request: async () => ({ tools }),
      callTool: async () => ({ content: [] }),
      close: async () => { closes.n++ },
    }
  }

  describe('A (P1): escaping bypass', () => {
    it('the deep check sees decoded strings in keys and values', () => {
      expect(JSON.stringify({ a: QUOTED }).includes(QUOTED)).toBe(false) // the bypass itself
      expect(containsKnownSecretDeep({ a: [{ b: QUOTED }] }, qRedact)).toBe(true)
      expect(containsKnownSecretDeep({ [QUOTED]: 1 }, qRedact)).toBe(true)
      expect(containsKnownSecretDeep({ a: 'harmless' }, qRedact)).toBe(false)
    })

    for (const where of ['title', 'description', 'schema-description', 'schema-key', 'enum'] as const) {
      it(`drops a tool with a quoted/backslashed secret in ${where}`, async () => {
        const schema: Record<string, unknown> = { type: 'object', properties: { q: { type: 'string' } } }
        if (where === 'schema-description') schema.properties = { q: { type: 'string', description: QUOTED } }
        if (where === 'schema-key') schema.properties = { [QUOTED]: { type: 'string' } }
        if (where === 'enum') schema.properties = { q: { type: 'string', enum: ['a', QUOTED] } }
        const tool = { name: 'read', title: where === 'title' ? QUOTED : 'Read', description: where === 'description' ? `x ${QUOTED} y` : 'd', inputSchema: schema }
        const m = manager(() => cfg({ dataClass: 'cloud_ok' }), { clientFactory: async () => listClient([tool]), transportFactory: async () => ({}), redactKnown: qRedact })
        expect(await m.getToolsFor(scope('main', '1', 's1', false))).toEqual([])
      })
    }

    it('a clean tool on the same path is still offered (no over-blocking)', async () => {
      const tool = { name: 'read', title: 'Read', description: 'd', inputSchema: { type: 'object', properties: { q: { type: 'string', enum: ['a'] } } } }
      const m = manager(() => cfg({ dataClass: 'cloud_ok' }), { clientFactory: async () => listClient([tool]), transportFactory: async () => ({}), redactKnown: qRedact })
      expect((await m.getToolsFor(scope('main', '1', 's1', false))).map(t => t.name)).toEqual(['mcp_review_read'])
    })

    it('structuredContent is sealed string by string before serialisation', () => {
      const out = renderMcpResult('srv', { content: [], structuredContent: { v: QUOTED, [QUOTED]: 'k', nested: [QUOTED] } } as never, 10_000, qRedact)
      expect(out).not.toContain('SYNTH_Quoted')
      expect(out).not.toContain(JSON.stringify(QUOTED).slice(1, -1))
      expect(out).toContain(SEALED)
    })
  })

  describe('C (P1): reject logs carry no remote text', () => {
    it('schema reject and secret reject log a fixed class and the trusted server id only', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const tools = [
          { name: 'REMOTE_NAME_SYNTH_A', description: 'REMOTE_DESC_SYNTH_A', inputSchema: { type: 'object', properties: { q: { type: 'string', pattern: '^(a+)+$' } } } },
          { name: `REMOTE_NAME_SYNTH_B ${QUOTED}`, inputSchema: { type: 'object', properties: { q: { type: 'string', pattern: '^(a+)+$' } } } },
          { name: 'REMOTE_NAME_SYNTH_C', inputSchema: { type: 'object', properties: {}, $ref: 'http://x/REMOTE_REF_SYNTH' } },
        ]
        const m = manager(() => cfg({ dataClass: 'cloud_ok' }), { clientFactory: async () => listClient(tools), transportFactory: async () => ({}), redactKnown: qRedact })
        expect(await m.getToolsFor(scope('main', '1', 's1', false))).toEqual([])
        const logged = warn.mock.calls.map(c => c.map(String).join(' ')).join('\n')
        expect(logged).toContain('[mcp] tool from server review skipped:')
        for (const remote of ['REMOTE_NAME_SYNTH', 'REMOTE_DESC_SYNTH', 'REMOTE_REF_SYNTH', 'SYNTH_Quoted']) expect(logged).not.toContain(remote)
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('E (P2): turn abort cancels the pending connect, peers are not harmed', () => {
    it('the only waiter aborting closes the stalled connect (socket gone) and records no server failure', async () => {
      const s = await reviewServer('stall')
      try {
        const m = manager(() => httpCfg(s.url, { connectTimeoutMs: 10_000 }))
        const ac = new AbortController()
        const p = m.getToolsFor(scope(), new Set(), ac.signal)
        await new Promise(r => setTimeout(r, 400))
        expect(s.state.stalled).toBe(true)
        ac.abort()
        expect(await p).toEqual([])
        await new Promise(r => setTimeout(r, 400))
        expect(s.sockets.size).toBe(0)
        expect(m.status()[0]).toMatchObject({ connections: 0, lastError: null })
      } finally {
        await s.stop()
      }
    }, 15_000)

    it('one of two waiters aborting does not cancel the shared connect', async () => {
      let release!: () => void
      const gate = new Promise<void>(r => { release = r })
      const client: McpClientLike = { ...listClient([{ name: 'read', inputSchema: { type: 'object', properties: {} } }]), connect: async () => { await gate } }
      const m = manager(() => cfg({ dataClass: 'cloud_ok' }), { clientFactory: async () => client, transportFactory: async () => ({}) })
      const a = new AbortController()
      const b = new AbortController()
      const pa = m.getToolsFor(scope('main', '1', 's1', false), new Set(), a.signal)
      const pb = m.getToolsFor(scope('main', '1', 's1', false), new Set(), b.signal)
      await new Promise(r => setTimeout(r, 50))
      a.abort()
      expect(await pa).toEqual([])
      release()
      expect((await pb).map(t => t.name)).toEqual(['mcp_review_read'])
    })
  })

  describe('F (P2): idleTimeoutMs is enforced by a real timer', () => {
    it('an idle connection is closed without any further turn; closeAll clears the timer', async () => {
      vi.useFakeTimers()
      try {
        const closes = { n: 0 }
        const m = manager(() => cfg({ dataClass: 'cloud_ok', idleTimeoutMs: 60_000 }), {
          clientFactory: async () => listClient([{ name: 'read', inputSchema: { type: 'object', properties: {} } }], closes),
          transportFactory: async () => ({}),
        })
        expect(await m.getToolsFor(scope('main', '1', 's1', false))).toHaveLength(1)
        expect(m.status()[0]).toMatchObject({ connections: 1 })
        await vi.advanceTimersByTimeAsync(30_000)
        expect(closes.n).toBe(0)
        await vi.advanceTimersByTimeAsync(32_000)
        expect(closes.n).toBe(1)
        expect(m.status()[0]).toMatchObject({ connections: 0 })
        await m.closeAll()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
