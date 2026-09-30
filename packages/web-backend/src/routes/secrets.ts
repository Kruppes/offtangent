import { Router } from 'express'
import {
  loadSecretsMasked,
  setSecrets,
  deleteSecret,
  injectSecretsIntoEnv,
} from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export function createSecretsRouter(): Router {
  const router = Router()

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  /**
   * GET /api/secrets
   * Returns masked secrets — never returns real values
   */
  router.get('/', (_req, res) => {
    try {
      const secrets = loadSecretsMasked()
      res.json({ secrets })
    } catch (err) {
      res.status(500).json({ error: `Failed to read secrets: ${(err as Error).message}` })
    }
  })

  /**
   * PUT /api/secrets
   * Set one or more secrets. Only non-empty values are updated.
   * Body: { secrets: { KEY: "value", KEY2: "value2" } }
   */
  router.put('/', (req: AuthenticatedRequest, res) => {
    const body = req.body as { secrets?: Record<string, string> }

    if (!body.secrets || typeof body.secrets !== 'object') {
      res.status(400).json({ error: 'Body must contain a "secrets" object with key-value pairs' })
      return
    }

    // Validate keys: only alphanumeric + underscore
    for (const key of Object.keys(body.secrets)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
        res.status(400).json({ error: `Invalid secret key "${key}". Keys must be uppercase with underscores only.` })
        return
      }
    }

    try {
      setSecrets(body.secrets)
      // Re-inject into process.env so changes take effect immediately
      injectSecretsIntoEnv()
      const updated = loadSecretsMasked()
      res.json({ message: 'Secrets updated', secrets: updated })
    } catch (err) {
      res.status(500).json({ error: `Failed to update secrets: ${(err as Error).message}` })
    }
  })

  /**
   * DELETE /api/secrets/:key
   * Remove a single secret
   */
  router.delete('/:key', (req: AuthenticatedRequest, res) => {
    const key = req.params.key as string

    if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
      res.status(400).json({ error: 'Invalid secret key' })
      return
    }

    try {
      deleteSecret(key)
      // Remove from process.env
      delete process.env[key]
      const updated = loadSecretsMasked()
      res.json({ message: `Secret "${key}" deleted`, secrets: updated })
    } catch (err) {
      res.status(500).json({ error: `Failed to delete secret: ${(err as Error).message}` })
    }
  })

  return router
}
