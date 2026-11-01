import { describe, expect, it } from 'vitest'
import { checkMcpUrl, isMcpServerAllowedFor, MCP_DEFAULTS, mcpConnectionFingerprint, resolveMcpSettings } from './mcp-config.js'

const stdio = { transport: 'stdio', command: '/usr/bin/node', args: ['server.js'], personas: ['main'], users: ['1'] }

describe('resolveMcpSettings', () => {
  it('is off when the block is missing, not an object, or not explicitly enabled', () => {
    expect(resolveMcpSettings(undefined).settings.enabled).toBe(false)
    expect(resolveMcpSettings(null).settings.enabled).toBe(false)
    expect(resolveMcpSettings('yes').settings.enabled).toBe(false)
    expect(resolveMcpSettings({ servers: { a: stdio } }).settings.enabled).toBe(false)
    expect(resolveMcpSettings({ enabled: 'true', servers: { a: stdio } }).settings.enabled).toBe(false)
  })

  it('accepts a valid stdio server with defaults', () => {
    const { settings, problems } = resolveMcpSettings({ enabled: true, servers: { files: stdio } })
    expect(problems).toEqual([])
    expect(settings.enabled).toBe(true)
    expect(settings.servers[0]).toMatchObject({
      id: 'files', transport: 'stdio', command: '/usr/bin/node', args: ['server.js'], personas: ['main'],
      callTimeoutMs: MCP_DEFAULTS.callTimeoutMs, connectTimeoutMs: MCP_DEFAULTS.connectTimeoutMs, toolAllow: null, toolDeny: [],
    })
  })

  it('is off when every server is invalid', () => {
    const { settings, problems } = resolveMcpSettings({ enabled: true, servers: { a: { transport: 'stdio' } } })
    expect(settings.enabled).toBe(false)
    expect(problems.join(' ')).toMatch(/command/)
  })

  it('requires an explicit persona list (no all-personas default)', () => {
    for (const personas of [undefined, [], ['*bad*'], 'main']) {
      const { settings, problems } = resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, personas } } })
      expect(settings.servers).toHaveLength(0)
      expect(problems.length).toBeGreaterThan(0)
    }
  })

  it('drops only the invalid server and keeps the valid one', () => {
    const { settings, problems } = resolveMcpSettings({ enabled: true, servers: { good: stdio, bad: { ...stdio, transport: 'sse' } } })
    expect(settings.servers.map(s => s.id)).toEqual(['good'])
    expect(problems.join(' ')).toMatch(/bad/)
  })

  it('skips servers with enabled:false silently', () => {
    const { settings, problems } = resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, enabled: false }, b: stdio } })
    expect(settings.servers.map(s => s.id)).toEqual(['b'])
    expect(problems).toEqual([])
  })

  it('rejects invalid server ids', () => {
    const { settings } = resolveMcpSettings({ enabled: true, servers: { 'Bad_Id': stdio, ['x'.repeat(30)]: stdio } })
    expect(settings.servers).toHaveLength(0)
  })

  it('rejects mixing transport fields', () => {
    expect(resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, url: 'https://x.test/mcp' } } }).settings.servers).toHaveLength(0)
    expect(resolveMcpSettings({ enabled: true, servers: { a: { transport: 'http', url: 'https://x.test/mcp', command: 'x', personas: ['main'] } } }).settings.servers).toHaveLength(0)
  })

  it('validates env names, header names, reserved headers and CR/LF in values', () => {
    const bad = [
      { ...stdio, env: { 'BAD-NAME': 'x' } },
      { ...stdio, env: { OK: 'a\nb' } },
      { ...stdio, cwd: 'relative/dir' },
      { transport: 'http', url: 'https://x.test/mcp', personas: ['main'], users: ['1'], headers: { 'Mcp-Session-Id': 'x' } },
      { transport: 'http', url: 'https://x.test/mcp', personas: ['main'], users: ['1'], headers: { Authorization: 'Bearer a\r\nX: y' } },
    ]
    for (const server of bad) expect(resolveMcpSettings({ enabled: true, servers: { a: server } }).settings.servers).toHaveLength(0)
  })

  it('bounds timeouts and limits', () => {
    expect(resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, callTimeoutMs: 10 } } }).settings.servers).toHaveLength(0)
    expect(resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, maxTools: 10_000 } } }).settings.servers).toHaveLength(0)
    expect(resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, callTimeoutMs: 1.5 } } }).settings.servers).toHaveLength(0)
    expect(resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, callTimeoutMs: 5000 } } }).settings.servers[0]?.callTimeoutMs).toBe(5000)
  })

  it('rejects unknown fields and wrong types fail-closed (review P2-8)', () => {
    // typo `user` instead of `users`
    const typo = resolveMcpSettings({ enabled: true, servers: { a: { transport: 'stdio', command: '/usr/bin/node', personas: ['main'], user: ['1'] } } })
    expect(typo.settings.servers).toHaveLength(0)
    expect(typo.problems.join(' ')).toMatch(/unknown field "user"/)
    // enabled as string must not silently count as "on" or "off"
    const strEnabled = resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, enabled: 'false' } } })
    expect(strEnabled.settings.servers).toHaveLength(0)
    expect(strEnabled.problems.join(' ')).toMatch(/enabled must be true or false/)
    const top = resolveMcpSettings({ enabled: 'true', servers: { a: stdio } })
    expect(top.settings.enabled).toBe(false)
    expect(top.problems.join(' ')).toMatch(/MCP stays off/)
    const topUnknown = resolveMcpSettings({ enabled: true, server: { a: stdio } })
    expect(topUnknown.settings.enabled).toBe(false)
    expect(resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, tools: { allowed: ['x'] } } } }).settings.servers).toHaveLength(0)
    expect(resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, dataClass: 'public' } } }).settings.servers).toHaveLength(0)
    expect(resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, remoteEgress: 'yes' } } }).settings.servers).toHaveLength(0)
  })

  it('requires an explicit user list and defaults to local_only (review P1-2/P1-3)', () => {
    const noUsers = resolveMcpSettings({ enabled: true, servers: { a: { transport: 'stdio', command: '/usr/bin/node', personas: ['main'] } } })
    expect(noUsers.settings.servers).toHaveLength(0)
    expect(noUsers.problems.join(' ')).toMatch(/users must be/)
    expect(resolveMcpSettings({ enabled: true, servers: { a: stdio } }).settings.servers[0]).toMatchObject({ dataClass: 'local_only', remoteEgress: false })
  })

  it('requires remoteEgress for non-loopback http servers', () => {
    const remote = { transport: 'http', url: 'https://mcp.example.org/mcp', personas: ['main'], users: ['1'] }
    expect(resolveMcpSettings({ enabled: true, servers: { a: remote } }).settings.servers).toHaveLength(0)
    expect(resolveMcpSettings({ enabled: true, servers: { a: { ...remote, remoteEgress: true } } }).settings.servers).toHaveLength(1)
    expect(resolveMcpSettings({ enabled: true, servers: { a: { ...remote, url: 'http://127.0.0.1:9/mcp' } } }).settings.servers).toHaveLength(1)
  })

  it('parses tool allow/deny lists and numeric user ids', () => {
    const { settings } = resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, users: [1, 2], tools: { allow: ['echo'], deny: ['rm'] } } } })
    expect(settings.servers[0]).toMatchObject({ users: ['1', '2'], toolAllow: ['echo'], toolDeny: ['rm'] })
  })
})

describe('checkMcpUrl', () => {
  it('allows https and loopback http', () => {
    expect(checkMcpUrl('https://mcp.example.org/mcp', false)).toBeNull()
    expect(checkMcpUrl('http://127.0.0.1:8080/mcp', false)).toBeNull()
    expect(checkMcpUrl('http://localhost/mcp', false)).toBeNull()
    expect(checkMcpUrl('http://[::1]:9/mcp', false)).toBeNull()
  })
  it('rejects plain http to other hosts unless opted in', () => {
    expect(checkMcpUrl('http://mcp.example.org/mcp', false)).toMatch(/plain http/)
    expect(checkMcpUrl('http://mcp.example.org/mcp', true)).toBeNull()
  })
  it('rejects credentials in the URL and other schemes', () => {
    expect(checkMcpUrl('https://user:pw@mcp.example.org/mcp', false)).toMatch(/credentials/)
    expect(checkMcpUrl('file:///etc/passwd', true)).toMatch(/https/)
    expect(checkMcpUrl('not a url', false)).toMatch(/valid/)
  })
})

describe('scope and fingerprint', () => {
  const server = resolveMcpSettings({ enabled: true, servers: { a: { ...stdio, personas: ['main', 'bob'], users: ['7'] } } }).settings.servers[0]!
  it('allows only listed personas and users', () => {
    expect(isMcpServerAllowedFor(server, 'main', '7')).toBe(true)
    expect(isMcpServerAllowedFor(server, 'bob', '7')).toBe(true)
    expect(isMcpServerAllowedFor(server, 'other', '7')).toBe(false)
    expect(isMcpServerAllowedFor(server, 'main', '8')).toBe(false)
    expect(isMcpServerAllowedFor(server, 'main', undefined)).toBe(false)
  })
  it('fingerprint changes with connection fields only', () => {
    const changedScope = { ...server, personas: ['main'] }
    const changedCommand = { ...server, args: ['other.js'] }
    expect(mcpConnectionFingerprint(changedScope)).toBe(mcpConnectionFingerprint(server))
    expect(mcpConnectionFingerprint(changedCommand)).not.toBe(mcpConnectionFingerprint(server))
  })
})
