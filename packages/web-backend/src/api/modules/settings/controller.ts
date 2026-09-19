import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import type { SettingsRouterOptions } from './types.js'
import { createSettingsService, SettingsValidationError } from './service.js'

export interface SettingsController {
  getSettings: (req: AuthenticatedRequest, res: Response) => void
  putSettings: (req: AuthenticatedRequest, res: Response) => void
}

export function createSettingsController(options: SettingsRouterOptions = {}): SettingsController {
  const service = createSettingsService(options)

  return {
    getSettings(_req, res) {
      try {
        const payload = service.readSettings()
        res.json(payload)
      } catch (err) {
        res.status(500).json({ error: `Failed to read settings: ${(err as Error).message}` })
      }
    },

    putSettings(req, res) {
      try {
        const payload = service.updateSettings((req.body ?? {}) as Record<string, unknown>)
        res.json(payload)
      } catch (err) {
        if (err instanceof SettingsValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to update settings: ${(err as Error).message}` })
      }
    },
  }
}
