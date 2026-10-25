/**
 * The general status API and the owner side of the device tokens.
 *
 * `/api/status` (mounted by app.ts):
 *   GET  /         Bearer <device token, scope status:read>  (LAN only)
 *                  or Bearer <user JWT>                       (anywhere the app reaches)
 *                  -> 200 StatusPayload (devices/status.ts), ETag = "rev"
 *                     304 when If-None-Match matches the current rev
 *   POST /answer   Bearer <device token, scope interactions:answer> (LAN only)
 *                  { message_id, block_id, value, client_id }
 *                  -> 200 { applied: true, idempotent }
 *                     400 invalid_body | 401 unauthorized | 403 not_lan | forbidden_scope | not_allowed
 *                     404 unknown_message | unknown_block | 409 already_answered | 410 stale
 *
 * `/api/devices` (owner, user JWT):
 *   GET    /                                       -> { devices }   (every kind, clocks included)
 *   POST   / { name?, kind?, scopes?, privacy? }   -> 201 { device, token }  (token shown ONCE)
 *   PATCH  /:id { privacy?, scopes? }              -> { device }
 *   DELETE /:id                                    -> { revoked: true }       (immediate)
 *
 * Device-token requests pass the same LAN gate as the clock (socket peer in
 * DEVICE_ALLOWED_CIDRS / CLOCK_ALLOWED_CIDRS, no proxy header). A user JWT on
 * GET /api/status skips that gate on purpose: it is the app's own credential
 * and already valid on every other route behind the tunnel.
 */
import { Router, type NextFunction, type Response } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware, verifyAccessToken, type AuthenticatedRequest } from '../../../auth.js'
import type { InteractionsService } from '../interactions/service.js'
import { applyDeviceAnswer, parseDeviceAnswerBody } from './answer.js'
import { bearerOf, isDirectLanRequest, lanOnly, loadDeviceAllowlist, requireDeviceToken, type DeviceRequest } from './gate.js'
import { StatusNoteSource } from './note.js'
import {
  DeviceRegistry,
  deviceOwnerView,
  isDeviceToken,
  normaliseName,
  parseDeviceKind,
  parseScopeInput,
  type DeviceKind,
  type DeviceScope,
} from './registry.js'
import { buildStatus } from './status.js'

export interface StatusRouterOptions {
  db: Database
  getInteractions: () => InteractionsService
  /** CIDRs device tokens may connect from; default DEVICE_ALLOWED_CIDRS, then CLOCK_ALLOWED_CIDRS. */
  allowedCidrs?: string
  /** Directory of the per-user notes from Main (`note-<userId>.json`); default `${DATA_DIR}/status`. */
  noteDir?: string
}

const DEFAULT_SCOPES: Record<DeviceKind, DeviceScope[]> = {
  clock: ['status:read', 'interactions:answer'],
  dashboard: ['status:read', 'interactions:answer'],
  generic: ['status:read'],
}

const NOT_LAN = 'Device tokens are only accepted from the local network'
const UNKNOWN_TOKEN = 'Unknown or revoked device token'

/** ETag values are quoted; accept a plain rev too (simple pollers). */
function matchesRev(header: string | undefined, rev: string): boolean {
  if (!header) return false
  return header.split(',').map(part => part.trim().replace(/^W\//, '').replace(/^"|"$/g, '')).includes(rev)
}

export function createStatusRouter(options: StatusRouterOptions): Router {
  const { db } = options
  const registry = new DeviceRegistry(db)
  const allowlist = loadDeviceAllowlist(options.allowedCidrs, 'status')
  const notes = new StatusNoteSource(options.noteDir)
  const router = Router()

  /** Device token (LAN gate + scope) or user JWT; sets who is asking and with which privacy. */
  function statusAuth(req: DeviceRequest & AuthenticatedRequest, res: Response, next: NextFunction): void {
    const token = bearerOf(req)
    if (token && isDeviceToken(token)) {
      if (!isDirectLanRequest(req, allowlist)) {
        res.status(403).json({ error: NOT_LAN, code: 'not_lan' })
        return
      }
      requireDeviceToken(registry, 'status:read', UNKNOWN_TOKEN)(req, res, next)
      return
    }
    const payload = token ? verifyAccessToken(token) : null
    if (!payload) {
      res.status(401).json({ error: 'Device token or user login required', code: 'unauthorized' })
      return
    }
    req.user = payload
    next()
  }

  router.get('/', statusAuth, (req: DeviceRequest & AuthenticatedRequest, res) => {
    const userId = req.device?.userId ?? req.user!.userId
    const privacy = req.device?.privacy ?? false
    const status = buildStatus(db, { userId, privacy, note: notes.read(userId) })
    const etag = `"${status.rev}"`
    res.set('Cache-Control', 'no-store')
    res.set('ETag', etag)
    if (matchesRev(req.headers['if-none-match'], status.rev)) {
      res.status(304).end()
      return
    }
    res.json(status)
  })

  router.post(
    '/answer',
    lanOnly(allowlist, NOT_LAN),
    requireDeviceToken(registry, 'interactions:answer', UNKNOWN_TOKEN),
    (req: DeviceRequest, res) => {
      const device = req.device!
      const body = parseDeviceAnswerBody(req.body)
      if (!body) {
        res.status(400).json({ error: 'message_id, block_id, value and client_id are required', code: 'invalid_body' })
        return
      }
      const outcome = applyDeviceAnswer({
        db,
        interactions: options.getInteractions(),
        device,
        body,
        clientNamespace: 'device',
        logTag: 'status',
      })
      res.status(outcome.status).json(outcome.body)
    },
  )

  return router
}

export function createDevicesRouter(options: { db: Database }): Router {
  const registry = new DeviceRegistry(options.db)
  const router = Router()
  router.use(jwtMiddleware)

  router.get('/', (req: AuthenticatedRequest, res) => {
    res.json({ devices: registry.listForUser(req.user!.userId).map(deviceOwnerView) })
  })

  router.post('/', (req: AuthenticatedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const kind = body.kind === undefined ? 'dashboard' : parseDeviceKind(body.kind)
    if (!kind) {
      res.status(400).json({ error: 'kind must be clock, dashboard or generic', code: 'invalid_kind' })
      return
    }
    const name = normaliseName(body.name, kind === 'clock' ? 'TC002' : 'Dashboard')
    if (!name) {
      res.status(400).json({ error: 'name must be 1-40 characters', code: 'invalid_name' })
      return
    }
    const scopes = body.scopes === undefined ? DEFAULT_SCOPES[kind] : parseScopeInput(body.scopes)
    if (!scopes) {
      res.status(400).json({ error: 'scopes must be a non-empty list of status:read, interactions:answer', code: 'invalid_scopes' })
      return
    }
    if (body.privacy !== undefined && typeof body.privacy !== 'boolean') {
      res.status(400).json({ error: 'privacy must be a boolean', code: 'invalid_privacy' })
      return
    }
    const { device, token } = registry.create(req.user!.userId, { name, kind, scopes, privacy: body.privacy === true })
    res.set('Cache-Control', 'no-store')
    res.status(201).json({ device: deviceOwnerView(device), token })
  })

  router.patch('/:id', (req: AuthenticatedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const change: { privacy?: boolean; scopes?: DeviceScope[] } = {}
    if (body.privacy !== undefined) {
      if (typeof body.privacy !== 'boolean') {
        res.status(400).json({ error: 'privacy must be a boolean', code: 'invalid_privacy' })
        return
      }
      change.privacy = body.privacy
    }
    if (body.scopes !== undefined) {
      const scopes = parseScopeInput(body.scopes)
      if (!scopes) {
        res.status(400).json({ error: 'scopes must be a non-empty list of status:read, interactions:answer', code: 'invalid_scopes' })
        return
      }
      change.scopes = scopes
    }
    if (change.privacy === undefined && change.scopes === undefined) {
      res.status(400).json({ error: 'privacy or scopes required', code: 'invalid_body' })
      return
    }
    const device = registry.update(req.user!.userId, String(req.params.id), change)
    if (!device) {
      res.status(404).json({ error: 'No such active device', code: 'unknown_device' })
      return
    }
    res.json({ device: deviceOwnerView(device) })
  })

  router.delete('/:id', (req: AuthenticatedRequest, res) => {
    if (!registry.revoke(req.user!.userId, String(req.params.id))) {
      res.status(404).json({ error: 'No such active device', code: 'unknown_device' })
      return
    }
    res.json({ revoked: true })
  })

  return router
}
