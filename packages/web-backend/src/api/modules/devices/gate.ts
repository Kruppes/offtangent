/**
 * Request gates of every device-token endpoint (LED clock, status API).
 *
 * LAN only: the socket peer must be in the device allowlist
 * (`DEVICE_ALLOWED_CIDRS`, old name `CLOCK_ALLOWED_CIDRS` as alias) and the
 * request must not carry any proxy or tunnel header. Then the bearer token
 * must belong to an active device that holds the required scope.
 */
import net from 'node:net'
import type { NextFunction, Request, Response } from 'express'
import type { Device, DeviceRegistry, DeviceScope } from './registry.js'

/**
 * Is this a private, non-loopback LAN address (RFC 1918, fc00::/7, fe80::/10)?
 * Loopback is deliberately NOT LAN: a tunnel or proxy on the same host
 * connects from 127.0.0.1.
 */
export function isLanAddress(address: string | undefined): boolean {
  if (!address) return false
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address
  const parts = v4.split('.')
  if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) {
    const [a, b] = parts.map(Number) as [number, number]
    if (a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    return false
  }
  const v6 = address.toLowerCase()
  // fc00::/7 (unique local) and fe80::/10 (link local)
  return /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6)
}

/**
 * Default peers of the device gate when no allowlist is configured: the
 * private ranges a home LAN uses. NOT included on purpose: loopback
 * (127.0.0.0/8, ::1), where a same-host tunnel or proxy connects from, and
 * 172.16.0.0/12, where Docker bridges and the userland proxy live. Both only
 * count when the operator lists them explicitly.
 */
export const DEVICE_DEFAULT_ALLOWED_CIDRS = '10.0.0.0/8,192.168.0.0/16,fc00::/7,fe80::/10'

/** Peer allowlist of the device gate, parsed from a comma separated CIDR list. */
export interface DevicePeerAllowlist {
  /** Entries that were understood, normalised (`a.b.c.d/n`). */
  cidrs: string[]
  /** Entries that were not, and are ignored (fail closed). */
  invalid: string[]
  allows: (address: string | undefined) => boolean
}

function parseCidr(entry: string): { net: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [rawNet, rawPrefix, ...rest] = entry.split('/')
  if (rest.length > 0 || !rawNet) return null
  const family = net.isIPv4(rawNet) ? 'ipv4' : net.isIPv6(rawNet) ? 'ipv6' : null
  if (!family) return null
  const max = family === 'ipv4' ? 32 : 128
  const prefix = rawPrefix === undefined ? max : /^\d{1,3}$/.test(rawPrefix) ? Number(rawPrefix) : NaN
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null
  return { net: rawNet, prefix, family }
}

/**
 * `undefined` (variable not set) means the default ranges. Any string, even an
 * empty one or one without a single valid entry, is taken as written: an
 * operator who set the variable and got it wrong gets NO peer (fail closed),
 * never the broad default.
 */
export function parseDeviceAllowedCidrs(raw: string | undefined): DevicePeerAllowlist {
  const source = raw === undefined ? DEVICE_DEFAULT_ALLOWED_CIDRS : raw
  const list = new net.BlockList()
  const cidrs: string[] = []
  const invalid: string[] = []
  for (const entry of source.split(',').map(part => part.trim()).filter(Boolean)) {
    const cidr = parseCidr(entry)
    if (!cidr) {
      invalid.push(entry)
      continue
    }
    list.addSubnet(cidr.net, cidr.prefix, cidr.family)
    cidrs.push(`${cidr.net}/${cidr.prefix}`)
  }
  return {
    cidrs,
    invalid,
    allows(address) {
      if (!address) return false
      // An IPv4 peer on a dual-stack socket arrives as ::ffff:a.b.c.d.
      const mapped = /^::ffff:(\d{1,3}\.){3}\d{1,3}$/i.test(address) ? address.slice(7) : address
      if (net.isIPv4(mapped)) return list.check(mapped, 'ipv4')
      if (net.isIPv6(mapped)) return list.check(mapped, 'ipv6')
      return false
    },
  }
}

/**
 * The configured allowlist source: `DEVICE_ALLOWED_CIDRS`, else the old name
 * `CLOCK_ALLOWED_CIDRS` (alias, so an existing .env keeps working), else
 * undefined (= the private-range default). A variable that is SET counts,
 * even when empty: `DEVICE_ALLOWED_CIDRS=` refuses every peer.
 */
export function resolveDeviceAllowedCidrs(env: NodeJS.ProcessEnv = process.env): { value: string | undefined; source: string } {
  if (env.DEVICE_ALLOWED_CIDRS !== undefined) return { value: env.DEVICE_ALLOWED_CIDRS, source: 'DEVICE_ALLOWED_CIDRS' }
  if (env.CLOCK_ALLOWED_CIDRS !== undefined) return { value: env.CLOCK_ALLOWED_CIDRS, source: 'CLOCK_ALLOWED_CIDRS' }
  return { value: undefined, source: 'default' }
}

/** Parses the allowlist and logs what an operator needs to know about it. */
export function loadDeviceAllowlist(explicit: string | undefined, logTag: string): DevicePeerAllowlist {
  const resolved = explicit !== undefined ? { value: explicit, source: 'option' } : resolveDeviceAllowedCidrs()
  const allowlist = parseDeviceAllowedCidrs(resolved.value)
  if (allowlist.invalid.length > 0) {
    console.warn(`[${logTag}] ${resolved.source}: ignoring invalid entries ${allowlist.invalid.join(', ')}`)
  }
  if (allowlist.cidrs.length === 0) {
    console.warn(`[${logTag}] ${resolved.source} allows no peer: every device request is refused (403 not_lan)`)
  }
  return allowlist
}

/**
 * A request that came through a tunnel or reverse proxy carries one of these.
 * Devices talk to the backend directly over the LAN, so any of them means
 * the request did NOT come from the device's network path. `cf-ray` and
 * `cdn-loop` are set by Cloudflare even when the visitor IP headers are
 * stripped; `via` and `x-forwarded-*` by Caddy, nginx and most proxies.
 */
export const FORWARDING_HEADERS = [
  'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cdn-loop',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-server',
  'x-real-ip', 'forwarded', 'true-client-ip', 'via',
]

/** True when the request came straight from an allowed LAN peer. */
export function isDirectLanRequest(req: Request, allowlist: DevicePeerAllowlist): boolean {
  // The socket peer, NOT `req.ip`: with `trust proxy` the latter could be a
  // header the caller wrote.
  const forwarded = FORWARDING_HEADERS.some(header => req.headers[header] !== undefined)
  return !forwarded && allowlist.allows(req.socket.remoteAddress)
}

export function lanOnly(allowlist: DevicePeerAllowlist, message: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isDirectLanRequest(req, allowlist)) {
      res.status(403).json({ error: message, code: 'not_lan' })
      return
    }
    next()
  }
}

export interface DeviceRequest extends Request {
  device?: Device
}

export function bearerOf(req: Request): string {
  const header = req.headers.authorization
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

export function requireDeviceToken(registry: DeviceRegistry, scope: DeviceScope, unknownMessage: string) {
  return (req: DeviceRequest, res: Response, next: NextFunction): void => {
    const token = bearerOf(req)
    const device = token ? registry.verify(token) : null
    if (!device) {
      res.status(401).json({ error: unknownMessage, code: 'unauthorized' })
      return
    }
    if (!device.scopes.includes(scope)) {
      res.status(403).json({ error: 'This token may not do that', code: 'forbidden_scope' })
      return
    }
    req.device = device
    registry.touch(device.id)
    next()
  }
}
