/**
 * MCP client configuration (settings.json › `mcp`).
 *
 * Pure parsing and validation, no I/O besides `loadMcpSettings`. The feature
 * is OFF unless `mcp.enabled === true` AND at least one valid server is
 * configured. Every server must name the personas allowed to see its tools;
 * there is no "all personas" default.
 *
 * Example:
 * ```json
 * "mcp": {
 *   "enabled": true,
 *   "servers": {
 *     "files": {
 *       "transport": "stdio",
 *       "command": "/usr/bin/node",
 *       "args": ["/opt/mcp/files-server.js"],
 *       "env": { "API_TOKEN": "{{secret:files-token}}" },
 *       "personas": ["main"]
 *     },
 *     "wiki": {
 *       "transport": "http",
 *       "url": "https://mcp.example.org/mcp",
 *       "headers": { "Authorization": "Bearer {{secret:wiki-token}}" },
 *       "personas": ["main", "bob"],
 *       "tools": { "allow": ["search", "read_page"] }
 *     }
 *   }
 * }
 * ```
 */

import { loadConfig, warnConfigReadFailed } from './config.js'

export type McpTransportKind = 'stdio' | 'http'

export interface McpServerConfig {
  id: string
  transport: McpTransportKind
  /** stdio only. Absolute path or a binary on the inherited safe PATH. */
  command?: string
  args: string[]
  cwd?: string
  /** stdio only. Values may contain `{{secret:<slug>}}` handles. */
  env: Record<string, string>
  /** http only. https, or http on loopback / with `allowInsecureHttp`. */
  url?: string
  /** http only. Values may contain `{{secret:<slug>}}` handles. */
  headers: Record<string, string>
  allowInsecureHttp: boolean
  /** Persona ids (runtime agentId) allowed to see and call this server's tools. */
  personas: string[]
  /** Optional user id allowlist (numeric Offtangent user ids, kept as strings); empty = every user of an allowed persona. */
  users: string[]
  /** Optional remote-tool-name filters (exact names). deny wins over allow. */
  toolAllow: string[] | null
  toolDeny: string[]
  connectTimeoutMs: number
  callTimeoutMs: number
  maxOutputChars: number
  maxTools: number
  /** Re-list tools after this many ms (0 = only on reconnect). */
  toolsTtlMs: number
  /**
   * Data class of everything this server returns (review P1-3), same
   * vocabulary as connector manifests. `local_only` (default): the tools are
   * offered only while the turn runs on a strictly local model, and their
   * results are withheld from every non-local model request. `cloud_ok`:
   * the operator explicitly declares the server's output fit for cloud
   * models.
   */
  dataClass: McpDataClass
  /** http only: explicit operator acknowledgement that tool arguments leave the box (required for non-loopback hosts). */
  remoteEgress: boolean
  /** Upper bound of concurrent sessions (one per user + persona + strand). */
  maxSessions: number
  /** A session unused for this long is closed. */
  idleTimeoutMs: number
}

export type McpDataClass = 'local_only' | 'cloud_ok'

export interface McpSettings {
  enabled: boolean
  servers: McpServerConfig[]
}

export const MCP_DEFAULTS = Object.freeze({
  connectTimeoutMs: 10_000,
  callTimeoutMs: 60_000,
  maxOutputChars: 20_000,
  maxTools: 64,
  toolsTtlMs: 300_000,
  maxSessions: 8,
  idleTimeoutMs: 900_000,
})

const LIMITS = Object.freeze({
  connectTimeoutMs: [1_000, 60_000],
  callTimeoutMs: [1_000, 600_000],
  maxOutputChars: [1_000, 200_000],
  maxTools: [1, 256],
  toolsTtlMs: [0, 86_400_000],
  maxSessions: [1, 64],
  idleTimeoutMs: [60_000, 86_400_000],
} as const)

const SERVER_KEYS = new Set([
  'enabled', 'transport', 'command', 'args', 'cwd', 'env', 'url', 'headers', 'allowInsecureHttp',
  'personas', 'users', 'tools', 'connectTimeoutMs', 'callTimeoutMs', 'maxOutputChars', 'maxTools',
  'toolsTtlMs', 'dataClass', 'remoteEgress', 'maxSessions', 'idleTimeoutMs',
])
const TOP_KEYS = new Set(['enabled', 'servers'])
const TOOLS_KEYS = new Set(['allow', 'deny'])

const SERVER_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/
const PERSONA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/
/** Headers the transport manages itself; a config must not override them. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'connection', 'transfer-encoding'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface McpSettingsResult {
  settings: McpSettings
  problems: string[]
}

const OFF: McpSettings = Object.freeze({ enabled: false, servers: [] }) as McpSettings

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stringArray(v: unknown, field: string, problems: string[]): string[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 4096)) {
    problems.push(`${field} must be an array of non-empty strings`)
    return null
  }
  return v as string[]
}

function stringMap(v: unknown, field: string, keyRe: RegExp, problems: string[]): Record<string, string> | null {
  if (v === undefined) return {}
  if (!isRecord(v)) {
    problems.push(`${field} must be an object of strings`)
    return null
  }
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (!keyRe.test(k) || typeof val !== 'string' || val.length > 8192 || /[\r\n\0]/.test(val)) {
      problems.push(`${field}.${k} is invalid (name or value)`)
      return null
    }
    out[k] = val
  }
  return out
}

function boundedInt(v: unknown, field: keyof typeof LIMITS, problems: string[]): number | null {
  if (v === undefined) return MCP_DEFAULTS[field]
  const [min, max] = LIMITS[field]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    problems.push(`${field} must be an integer between ${min} and ${max}`)
    return null
  }
  return v
}

/** Validates an http(s) URL. Returns a problem string or null. */
export function checkMcpUrl(raw: string, allowInsecureHttp: boolean): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'url is not a valid URL'
  }
  if (url.username || url.password) return 'url must not contain credentials (use headers with a secret handle)'
  if (url.protocol === 'https:') return null
  if (url.protocol !== 'http:') return 'url must use https (or http)'
  if (LOOPBACK_HOSTS.has(url.hostname) || allowInsecureHttp) return null
  return 'plain http is only allowed for loopback hosts unless allowInsecureHttp is true'
}

function parseServer(id: string, raw: unknown, problems: string[]): McpServerConfig | null {
  const p: string[] = []
  if (!SERVER_ID_RE.test(id)) {
    problems.push(`server "${id}": id must match ${SERVER_ID_RE}`)
    return null
  }
  if (!isRecord(raw)) {
    problems.push(`server "${id}": must be an object`)
    return null
  }
  for (const key of Object.keys(raw)) if (!SERVER_KEYS.has(key)) p.push(`unknown field "${key}"`)
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') p.push('enabled must be true or false')
  if (raw.allowInsecureHttp !== undefined && typeof raw.allowInsecureHttp !== 'boolean') p.push('allowInsecureHttp must be true or false')
  if (raw.remoteEgress !== undefined && typeof raw.remoteEgress !== 'boolean') p.push('remoteEgress must be true or false')
  if (raw.dataClass !== undefined && raw.dataClass !== 'local_only' && raw.dataClass !== 'cloud_ok') p.push('dataClass must be "local_only" or "cloud_ok"')
  if (raw.enabled === false && p.length === 0) return null
  const transport = raw.transport
  if (transport !== 'stdio' && transport !== 'http') p.push('transport must be "stdio" or "http"')

  const personas = stringArray(raw.personas, 'personas', p)
  if (personas && (personas.length === 0 || !personas.every(x => PERSONA_ID_RE.test(x)))) {
    p.push('personas must be a non-empty list of persona ids (there is no "all" default)')
  }
  const users = Array.isArray(raw.users) && raw.users.every(u => typeof u === 'number' && Number.isInteger(u))
    ? (raw.users as number[]).map(String)
    : stringArray(raw.users, 'users', p)
  if (!users || users.length === 0 || !users.every(u => /^[1-9][0-9]{0,9}$/.test(u))) {
    p.push('users must be a non-empty list of user ids (there is no "all users" default)')
  }
  const args = stringArray(raw.args, 'args', p)
  const env = stringMap(raw.env, 'env', ENV_NAME_RE, p)
  const headers = stringMap(raw.headers, 'headers', HEADER_NAME_RE, p)
  if (headers) {
    for (const k of Object.keys(headers)) if (RESERVED_HEADERS.has(k.toLowerCase())) p.push(`headers.${k} is managed by the transport`)
  }
  let toolAllow: string[] | null = null
  let toolDeny: string[] = []
  if (raw.tools !== undefined) {
    if (!isRecord(raw.tools)) p.push('tools must be an object { allow?, deny? }')
    else {
      for (const key of Object.keys(raw.tools)) if (!TOOLS_KEYS.has(key)) p.push(`unknown field "tools.${key}"`)
      if (raw.tools.allow !== undefined) toolAllow = stringArray(raw.tools.allow, 'tools.allow', p)
      toolDeny = stringArray(raw.tools.deny, 'tools.deny', p) ?? []
    }
  }
  const allowInsecureHttp = raw.allowInsecureHttp === true
  const command = typeof raw.command === 'string' ? raw.command : undefined
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : undefined
  const url = typeof raw.url === 'string' ? raw.url : undefined
  if (transport === 'stdio') {
    if (!command || command.length === 0) p.push('stdio needs "command"')
    if (raw.url !== undefined || raw.headers !== undefined) p.push('stdio does not take url/headers')
    if (raw.cwd !== undefined && (!cwd || !cwd.startsWith('/'))) p.push('cwd must be an absolute path')
  } else if (transport === 'http') {
    if (!url) p.push('http needs "url"')
    else {
      const problem = checkMcpUrl(url, allowInsecureHttp)
      if (problem) p.push(problem)
      else if (!isLoopbackUrl(url) && raw.remoteEgress !== true) {
        p.push('a non-loopback http server needs "remoteEgress": true (tool arguments leave the box)')
      }
    }
    if (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined || raw.cwd !== undefined) {
      p.push('http does not take command/args/env/cwd')
    }
  }
  const connectTimeoutMs = boundedInt(raw.connectTimeoutMs, 'connectTimeoutMs', p)
  const callTimeoutMs = boundedInt(raw.callTimeoutMs, 'callTimeoutMs', p)
  const maxOutputChars = boundedInt(raw.maxOutputChars, 'maxOutputChars', p)
  const maxTools = boundedInt(raw.maxTools, 'maxTools', p)
  const toolsTtlMs = boundedInt(raw.toolsTtlMs, 'toolsTtlMs', p)
  const maxSessions = boundedInt(raw.maxSessions, 'maxSessions', p)
  const idleTimeoutMs = boundedInt(raw.idleTimeoutMs, 'idleTimeoutMs', p)

  if (p.length > 0) {
    problems.push(...p.map(x => `server "${id}": ${x}`))
    return null
  }
  return {
    id,
    transport: transport as McpTransportKind,
    command,
    args: args ?? [],
    cwd,
    env: env ?? {},
    url,
    headers: headers ?? {},
    allowInsecureHttp,
    personas: personas ?? [],
    users: users ?? [],
    toolAllow,
    toolDeny,
    connectTimeoutMs: connectTimeoutMs!,
    callTimeoutMs: callTimeoutMs!,
    maxOutputChars: maxOutputChars!,
    maxTools: maxTools!,
    toolsTtlMs: toolsTtlMs!,
    dataClass: raw.dataClass === 'cloud_ok' ? 'cloud_ok' : 'local_only',
    remoteEgress: raw.remoteEgress === true,
    maxSessions: maxSessions!,
    idleTimeoutMs: idleTimeoutMs!,
  }
}

function isLoopbackUrl(raw: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(raw).hostname)
  } catch {
    return false
  }
}

/**
 * Resolve raw `settings.json › mcp`. Invalid servers are dropped (fail
 * closed per server) and reported in `problems`; valid ones stay usable.
 */
export function resolveMcpSettings(raw: unknown): McpSettingsResult {
  if (raw === undefined || raw === null) return { settings: OFF, problems: [] }
  if (!isRecord(raw)) return { settings: OFF, problems: ['mcp must be an object'] }
  const unknown = Object.keys(raw).filter(k => !TOP_KEYS.has(k))
  if (unknown.length > 0) return { settings: OFF, problems: [`mcp: unknown field(s) ${unknown.map(k => `"${k}"`).join(', ')} — MCP stays off`] }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return { settings: OFF, problems: ['mcp.enabled must be true or false — MCP stays off'] }
  if (raw.enabled !== true) return { settings: OFF, problems: [] }
  const problems: string[] = []
  if (!isRecord(raw.servers)) return { settings: OFF, problems: ['mcp.servers must be an object keyed by server id'] }
  const servers: McpServerConfig[] = []
  for (const [id, entry] of Object.entries(raw.servers)) {
    const server = parseServer(id, entry, problems)
    if (server) servers.push(server)
  }
  return { settings: { enabled: servers.length > 0, servers }, problems }
}

let lastReportedProblems = ''

/** Read settings.json › mcp. Any read error means MCP is off. */
export function loadMcpSettings(): McpSettings {
  let raw: unknown
  try {
    raw = loadConfig<{ mcp?: unknown }>('settings.json').mcp
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
    return OFF
  }
  const { settings, problems } = resolveMcpSettings(raw)
  const report = problems.join('; ')
  if (report && report !== lastReportedProblems) console.warn(`[mcp] invalid server config ignored: ${report}`)
  lastReportedProblems = report
  return settings
}

/** Stable fingerprint of everything that requires a reconnect when changed. */
export function mcpConnectionFingerprint(s: McpServerConfig): string {
  return JSON.stringify([s.transport, s.command, s.args, s.cwd, s.env, s.url, s.headers, s.allowInsecureHttp, s.connectTimeoutMs])
}

/**
 * True when `agentId`/`userId` may use the server. An unknown owner
 * (no authenticated user id) is never allowed (review P1-2).
 */
export function isMcpServerAllowedFor(s: McpServerConfig, agentId: string, userId: string | undefined): boolean {
  if (!userId) return false
  if (!s.personas.includes(agentId)) return false
  if (!s.users.includes(userId)) return false
  return true
}
