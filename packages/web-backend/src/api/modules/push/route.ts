/**
 * /api/push/devices (PROTOCOL chapter 7, slice 1).
 *
 *   POST   /api/push/devices          { token, platform?, appVersion? } -> 200 { device }
 *   DELETE /api/push/devices/:token   -> 204, 404 when the token is not this user's
 *   GET    /api/push/devices          -> { devices } (own devices only)
 *
 * All three require a user JWT. The token in the path is URL encoded by the
 * client; Express decodes it before the handler sees it.
 */
import { Router } from 'express'
import type { Response } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { PushDeviceRegistry } from '../../../push/device-registry.js'
import { parseRegisterDeviceBody } from './schema.js'

export interface PushRouterOptions {
  db: Database
  /** Injected in tests. */
  registry?: PushDeviceRegistry
}

export function createPushRouter(options: PushRouterOptions): Router {
  const registry = options.registry ?? new PushDeviceRegistry(options.db)
  const router = Router()
  router.use(jwtMiddleware)

  router.post('/devices', (req: AuthenticatedRequest, res: Response) => {
    const parsed = parseRegisterDeviceBody(req.body)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, code: parsed.code })
      return
    }
    try {
      const device = registry.register(req.user!.userId, parsed.value)
      res.json({ device: publicDevice(device) })
    } catch (err) {
      console.error('[push] Failed to register device:', err)
      res.status(500).json({ error: `Failed to register device: ${(err as Error).message}` })
    }
  })

  router.get('/devices', (req: AuthenticatedRequest, res: Response) => {
    try {
      res.json({ devices: registry.listForUser(req.user!.userId).map(publicDevice) })
    } catch (err) {
      console.error('[push] Failed to list devices:', err)
      res.status(500).json({ error: `Failed to list devices: ${(err as Error).message}` })
    }
  })

  router.delete('/devices/:token', (req: AuthenticatedRequest, res: Response) => {
    const token = String(req.params.token ?? '').trim()
    if (!token) {
      res.status(400).json({ error: 'token is required', code: 'token_required' })
      return
    }
    try {
      const removed = registry.unregister(req.user!.userId, token)
      if (!removed) {
        res.status(404).json({ error: 'Device not found', code: 'device_not_found' })
        return
      }
      res.status(204).end()
    } catch (err) {
      console.error('[push] Failed to unregister device:', err)
      res.status(500).json({ error: `Failed to unregister device: ${(err as Error).message}` })
    }
  })

  return router
}

/**
 * The registry row without the token. The client already knows its own token
 * and nothing good comes from echoing a device address back over the wire.
 */
function publicDevice(device: { id: string; platform: string; appVersion: string | null; createdAt: string; lastSeenAt: string; lastSuccessAt: string | null; failureCount: number; disabledAt: string | null }) {
  return {
    id: device.id,
    platform: device.platform,
    appVersion: device.appVersion,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    lastSuccessAt: device.lastSuccessAt,
    failureCount: device.failureCount,
    disabled: device.disabledAt !== null,
  }
}
