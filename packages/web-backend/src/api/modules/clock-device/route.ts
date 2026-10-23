/**
 * /api/device/clock — the LED clock (TC002 Berry app "Offtangent") as a
 * second, screenless window onto Offtangent. Stage 1 (status + notices) and
 * stage 2 (answer a choice/confirm card with the knob).
 *
 * Device side (Bearer <clock token>, LAN only: socket peer in
 * CLOCK_ALLOWED_CIDRS, no proxy/tunnel header):
 *   GET  /state   -> 200 ClockState (SCHNITTSTELLE.md §1–3)
 *   POST /answer  { message_id, block_id, value, client_id }
 *     -> 200 { applied: true, idempotent }
 *        400 invalid_body | 401 unauthorized | 403 not_lan | not_allowed
 *        404 unknown_message | unknown_block | 409 already_answered | 410 stale
 *
 * Owner side (user JWT, for the app's settings screen):
 *   GET    /devices          -> { devices }
 *   POST   /devices { name?, privacy? } -> 201 { device, token }  (token shown ONCE)
 *   PATCH  /devices/:id { privacy }    -> { device }
 *   DELETE /devices/:id                -> { revoked: true }       (immediate)
 */
import net from 'node:net'
import { Router, type NextFunction, type Request, type Response } from 'express'
import {
  extractAnswerableInteractionBlocks,
  type Database,
} from '@axiom/core'
import { jwtMiddleware, type AuthenticatedRequest } from '../../../auth.js'
import { InteractionServiceError, type InteractionsService } from '../interactions/service.js'
import { ClockDeviceRegistry, normaliseDeviceName, type ClockDevice, type ClockScope } from './registry.js'
import { buildClockState, isClockEligibleBlock, resolveClockBlock, resolveClockOptionValue } from './state.js'

export interface ClockDeviceRouterOptions {
  db: Database
  /** The app's shared interactions service (same path as a tap in the app). */
  getInteractions: () => InteractionsService
  /**
   * Comma separated CIDRs the clock may connect from. Defaults to
   * `CLOCK_ALLOWED_CIDRS`, else {@link CLOCK_DEFAULT_ALLOWED_CIDRS}.
   */
  allowedCidrs?: string
}

interface ClockRequest extends Request {
  clockDevice?: ClockDevice
}

const ID_MAX = 64

/**
 * Is this a private, non-loopback LAN address (RFC 1918, fc00::/7, fe80::/10)?
 * Used for the wake target (notifier.ts). Loopback is deliberately NOT LAN:
 * a tunnel or proxy on the same host connects from 127.0.0.1.
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
 * Default peers of the clock gate when `CLOCK_ALLOWED_CIDRS` is unset: the
 * private ranges a home LAN uses. NOT included on purpose: loopback
 * (127.0.0.0/8, ::1), where a same-host tunnel or proxy connects from, and
 * 172.16.0.0/12, where Docker bridges and the userland proxy live. Both only
 * count when the operator lists them explicitly.
 */
export const CLOCK_DEFAULT_ALLOWED_CIDRS = '10.0.0.0/8,192.168.0.0/16,fc00::/7,fe80::/10'

/** Peer allowlist of the clock gate, parsed from a comma separated CIDR list. */
export interface ClockPeerAllowlist {
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

export function parseClockAllowedCidrs(raw: string | undefined): ClockPeerAllowlist {
  const source = raw?.trim() ? raw : CLOCK_DEFAULT_ALLOWED_CIDRS
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
 * A request that came through a tunnel or reverse proxy carries one of these.
 * The clock talks to the backend directly over the LAN, so any of them means
 * the request did NOT come from the clock's network path. `cf-ray` and
 * `cdn-loop` are set by Cloudflare even when the visitor IP headers are
 * stripped; `via` and `x-forwarded-*` by Caddy, nginx and most proxies.
 */
export const FORWARDING_HEADERS = [
  'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cdn-loop',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-server',
  'x-real-ip', 'forwarded', 'true-client-ip', 'via',
]

function lanOnly(allowlist: ClockPeerAllowlist) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // The socket peer, NOT `req.ip`: with `trust proxy` the latter could be a
    // header the caller wrote.
    const forwarded = FORWARDING_HEADERS.some(header => req.headers[header] !== undefined)
    if (forwarded || !allowlist.allows(req.socket.remoteAddress)) {
      res.status(403).json({ error: 'The clock API is only reachable from the local network', code: 'not_lan' })
      return
    }
    next()
  }
}

function requireClockToken(registry: ClockDeviceRegistry, scope: ClockScope) {
  return (req: ClockRequest, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const device = token ? registry.verify(token) : null
    if (!device) {
      res.status(401).json({ error: 'Unknown or revoked clock token', code: 'unauthorized' })
      return
    }
    if (!device.scopes.includes(scope)) {
      res.status(403).json({ error: 'This token may not do that', code: 'forbidden_scope' })
      return
    }
    req.clockDevice = device
    registry.touch(device.id)
    next()
  }
}

interface ClockAnswerBody {
  messageId: number
  blockId: string
  value: string
  clientId: string
}

function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= ID_MAX ? trimmed : null
}

export function parseClockAnswerBody(body: unknown): ClockAnswerBody | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const rawId = typeof record.message_id === 'string' ? Number(record.message_id) : record.message_id
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) return null
  const blockId = readId(record.block_id)
  const value = readId(record.value)
  const clientId = readId(record.client_id)
  if (!blockId || !value || !clientId) return null
  return { messageId: rawId, blockId, value, clientId }
}

function deviceView(device: ClockDevice) {
  return {
    id: device.id,
    name: device.name,
    scopes: device.scopes,
    privacy: device.privacy,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  }
}

export function createClockDeviceRouter(options: ClockDeviceRouterOptions): Router {
  const { db } = options
  const registry = new ClockDeviceRegistry(db)
  const router = Router()
  const allowlist = parseClockAllowedCidrs(options.allowedCidrs ?? process.env.CLOCK_ALLOWED_CIDRS)
  if (allowlist.invalid.length > 0) {
    console.warn(`[clock-device] CLOCK_ALLOWED_CIDRS: ignoring invalid entries ${allowlist.invalid.join(', ')}`)
  }
  if (allowlist.cidrs.length === 0) {
    console.warn('[clock-device] CLOCK_ALLOWED_CIDRS allows no peer: every clock request is refused (403 not_lan)')
  }
  const lanGate = lanOnly(allowlist)

  // ---- device side -------------------------------------------------------
  router.get('/state', lanGate, requireClockToken(registry, 'clock:state'), (req: ClockRequest, res) => {
    const device = req.clockDevice!
    res.set('Cache-Control', 'no-store')
    res.json(buildClockState(db, { userId: device.userId, privacy: device.privacy }))
  })

  router.post('/answer', lanGate, requireClockToken(registry, 'clock:answer'), (req: ClockRequest, res) => {
    const device = req.clockDevice!
    const body = parseClockAnswerBody(req.body)
    if (!body) {
      res.status(400).json({ error: 'message_id, block_id, value and client_id are required', code: 'invalid_body' })
      return
    }
    // The clock may only answer what the state endpoint would show it: an
    // eligible block of a message of the token's own user. Everything else is
    // refused BEFORE the shared service sees it, so a stolen clock token can
    // never confirm a destructive card or pick from a multi list.
    const row = db.prepare('SELECT content FROM chat_messages WHERE id = ? AND user_id = ?')
      .get(body.messageId, device.userId) as { content: string } | undefined
    if (!row) {
      res.status(404).json({ error: 'No such message', code: 'unknown_message' })
      return
    }
    // Privacy mode sends opaque positional ids (`~n`); both forms resolve.
    const block = resolveClockBlock(extractAnswerableInteractionBlocks(row.content), body.blockId, device.privacy)
    if (!block) {
      res.status(404).json({ error: 'No such block in this message', code: 'unknown_block' })
      return
    }
    if (!isClockEligibleBlock(block)) {
      res.status(403).json({ error: 'This question must be answered on the phone', code: 'not_allowed' })
      return
    }
    try {
      const result = options.getInteractions().answer(device.userId, {
        messageId: body.messageId,
        blockId: block.id,
        value: resolveClockOptionValue(block, body.value, device.privacy),
        // Namespaced, so a clock retry can never collide with an app tap.
        clientMessageId: `clock:${device.id}:${body.clientId}`.slice(0, ID_MAX),
      })
      // No label in the reply: the clock already shows the short label it
      // sent, and the stored label may be private (privacy mode).
      res.json({ applied: true, idempotent: result.idempotent })
    } catch (err) {
      if (err instanceof InteractionServiceError) {
        // The 409 deliberately does NOT echo the stored label: the clock only
        // needs "already answered", and the label may be private.
        res.status(err.status).json({ error: err.message, code: err.code })
        return
      }
      console.error('[clock-device] Failed to apply the answer:', err)
      res.status(500).json({ error: 'Failed to apply the answer', code: 'internal' })
    }
  })

  // ---- owner side (user JWT) ---------------------------------------------
  const owner = Router()
  owner.use(jwtMiddleware)
  owner.get('/', (req: AuthenticatedRequest, res) => {
    res.json({ devices: registry.listForUser(req.user!.userId).map(deviceView) })
  })
  owner.post('/', (req: AuthenticatedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = normaliseDeviceName(body.name)
    if (!name) {
      res.status(400).json({ error: 'name must be 1-40 characters', code: 'invalid_name' })
      return
    }
    if (body.privacy !== undefined && typeof body.privacy !== 'boolean') {
      res.status(400).json({ error: 'privacy must be a boolean', code: 'invalid_privacy' })
      return
    }
    const { device, token } = registry.create(req.user!.userId, { name, privacy: body.privacy === true })
    res.set('Cache-Control', 'no-store')
    res.status(201).json({ device: deviceView(device), token })
  })
  owner.patch('/:id', (req: AuthenticatedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.privacy !== 'boolean') {
      res.status(400).json({ error: 'privacy must be a boolean', code: 'invalid_privacy' })
      return
    }
    const device = registry.setPrivacy(req.user!.userId, String(req.params.id), body.privacy)
    if (!device) {
      res.status(404).json({ error: 'No such active clock', code: 'unknown_device' })
      return
    }
    res.json({ device: deviceView(device) })
  })
  owner.delete('/:id', (req: AuthenticatedRequest, res) => {
    if (!registry.revoke(req.user!.userId, String(req.params.id))) {
      res.status(404).json({ error: 'No such active clock', code: 'unknown_device' })
      return
    }
    res.json({ revoked: true })
  })
  router.use('/devices', owner)

  return router
}
