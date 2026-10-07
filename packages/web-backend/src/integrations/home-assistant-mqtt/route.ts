import { Router } from 'express'
import type { AuthenticatedRequest } from '../../auth.js'
import { jwtMiddleware } from '../../auth.js'
import { publicSettings, readSettings, saveSettings, validateUpdate } from './config.js'
import type { HomeAssistantMqttService } from './service.js'

export function createHomeAssistantMqttRouter(service: HomeAssistantMqttService): Router {
  const router = Router()
  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return }
    next()
  })
  router.get('/', (_req, res) => res.json({ ...publicSettings(), ...service.getStatus() }))
  router.put('/', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>
      const next = validateUpdate(body)
      saveSettings(next, body)
      service.apply(next)
      res.json({ ...publicSettings(next), ...service.getStatus() })
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid MQTT settings' }) }
  })
  router.post('/test', async (_req, res) => {
    try { res.json({ connected: await service.test(readSettings()) }) }
    catch { res.json({ connected: false }) }
  })
  return router
}
