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
import { Router, type Response, type NextFunction } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware, type AuthenticatedRequest } from '../../../auth.js'
import type { InteractionsService } from '../interactions/service.js'
import { applyDeviceAnswer, parseDeviceAnswerBody, type DeviceAnswerBody } from '../devices/answer.js'
import {
  DEVICE_DEFAULT_ALLOWED_CIDRS,
  FORWARDING_HEADERS as DEVICE_FORWARDING_HEADERS,
  bearerOf,
  isLanAddress as isDeviceLanAddress,
  lanOnly,
  loadDeviceAllowlist,
  parseDeviceAllowedCidrs,
  type DevicePeerAllowlist,
  type DeviceRequest,
} from '../devices/gate.js'
import { ClockDeviceRegistry, normaliseDeviceName, type ClockDevice, type ClockScope } from './registry.js'
import { buildClockState } from './state.js'

export interface ClockDeviceRouterOptions {
  db: Database
  /** The app's shared interactions service (same path as a tap in the app). */
  getInteractions: () => InteractionsService
  /**
   * Comma separated CIDRs the clock may connect from. Defaults to
   * `DEVICE_ALLOWED_CIDRS`, else the old name `CLOCK_ALLOWED_CIDRS`, else
   * {@link CLOCK_DEFAULT_ALLOWED_CIDRS}.
   */
  allowedCidrs?: string
}

interface ClockRequest extends DeviceRequest {
  clockDevice?: ClockDevice
}

// The LAN gate, the answer rule and the token check moved to ../devices/
// (shared with GET /api/status). The clock names stay exported as aliases.

/** See devices/gate.ts: private, non-loopback LAN address. Used for the wake target (notifier.ts). */
export const isLanAddress = isDeviceLanAddress
/** Default peers of the clock gate; the same default as every device gate. */
export const CLOCK_DEFAULT_ALLOWED_CIDRS = DEVICE_DEFAULT_ALLOWED_CIDRS
/** Peer allowlist of the clock gate (the device gate's). */
export type ClockPeerAllowlist = DevicePeerAllowlist
export const parseClockAllowedCidrs = parseDeviceAllowedCidrs
export const FORWARDING_HEADERS = DEVICE_FORWARDING_HEADERS
type ClockAnswerBody = DeviceAnswerBody
export function parseClockAnswerBody(body: unknown): ClockAnswerBody | null {
  return parseDeviceAnswerBody(body)
}

/**
 * Bearer check of the clock routes: only clock tokens (kind `clock`), with the
 * clock scope name. A dashboard token is a 401 here, exactly like before.
 */
function requireClockToken(registry: ClockDeviceRegistry, scope: ClockScope) {
  return (req: ClockRequest, res: Response, next: NextFunction): void => {
    const token = bearerOf(req)
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
  const allowlist = loadDeviceAllowlist(options.allowedCidrs, 'clock-device')
  const lanGate = lanOnly(allowlist, 'The clock API is only reachable from the local network')

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
    // The clock may only answer what the state endpoint would show it; the
    // shared device rule refuses everything else before the service sees it.
    const outcome = applyDeviceAnswer({
      db,
      interactions: options.getInteractions(),
      device,
      body,
      clientNamespace: 'clock',
      logTag: 'clock-device',
    })
    res.status(outcome.status).json(outcome.body)
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
