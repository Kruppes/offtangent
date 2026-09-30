import type { Request, Response } from 'express'
import { parseConnectorClientPayload } from '@axiom/core/contracts'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createConnectorsService } from './service.js'
import type { ConnectorsServiceOptions } from './service.js'

/**
 * Fixed page the callback returns to. Never assembled from a request parameter
 * — an attacker-controlled `redirect`/`next` would be an open redirect.
 */
const CONNECTORS_PAGE = '/connectors'

/** Express types the route param as `string | string[]`; the route only ever binds one. */
function paramId(req: Request): string {
  const value = req.params.id
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

/**
 * The request host is NOT a source for the redirect URI.
 *
 * `Host` and `X-Forwarded-Host` are attacker controlled; deriving the OAuth
 * redirect from them lets a forged header point the consent screen at a foreign
 * origin. Everything is built from the configured `PUBLIC_BASE_URL` instead, so
 * this returns an empty string on purpose.
 */
function requestBaseUrl(_req: Request): string {
  return ''
}

export function createConnectorsController(options: ConnectorsServiceOptions = {}) {
  const service = createConnectorsService(options)

  return {
    list(req: AuthenticatedRequest, res: Response): void {
      const base = requestBaseUrl(req as Request)
      res.json({ connectors: service.list(base), baseUrl: service.baseUrl(base) })
    },

    setClient(req: AuthenticatedRequest, res: Response): void {
      const parsed = parseConnectorClientPayload(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }
      const connector = service.setClient(paramId(req as Request), parsed.value, requestBaseUrl(req as Request))
      if (!connector) {
        res.status(404).json({ error: 'Connector not found' })
        return
      }
      res.json({ connector })
    },

    /**
     * Starts the flow. A browser navigation gets the 302 to the upstream
     * consent screen; an XHR that asks for JSON gets the URL and navigates
     * itself — that way the admin JWT stays in the header and never lands in a
     * URL (and never in an upstream `Referer`).
     */
    authorize(req: AuthenticatedRequest, res: Response): void {
      const result = service.startAuthorize(paramId(req as Request), requestBaseUrl(req as Request))
      if ('error' in result) {
        res.status(result.error === 'unknown_connector' ? 404 : 409).json({ error: result.error })
        return
      }
      if ((req.headers.accept ?? '').includes('application/json')) {
        res.json({ url: result.url })
        return
      }
      res.redirect(result.url)
    },

    /**
     * The only connector endpoint without an admin JWT — the browser arrives
     * here straight from the upstream consent screen. A valid, single-use
     * `state` is the whole authorisation, and the answer is always a redirect
     * to the fixed page with a coarse code.
     */
    async callback(req: Request, res: Response): Promise<void> {
      const id = paramId(req as Request)
      const outcome = await service.handleCallback(id, {
        state: typeof req.query.state === 'string' ? req.query.state : undefined,
        code: typeof req.query.code === 'string' ? req.query.code : undefined,
        error: typeof req.query.error === 'string' ? req.query.error : undefined,
      })
      const params = outcome.kind === 'connected'
        ? new URLSearchParams({ connected: outcome.connectorId })
        : new URLSearchParams({ error: outcome.error })
      res.redirect(`${CONNECTORS_PAGE}?${params.toString()}`)
    },

    async test(req: AuthenticatedRequest, res: Response): Promise<void> {
      const result = await service.test(paramId(req as Request))
      if (!result) {
        res.status(404).json({ error: 'Connector not found' })
        return
      }
      res.json({ ok: result.ok, detail: result.detail ?? '' })
    },

    async localModel(_req: AuthenticatedRequest, res: Response): Promise<void> {
      res.json(await service.localModel())
    },

    /**
     * Only a strictly local pair may be written; the service asks
     * `isStrictlyLocalModel` and a rejected pair comes back as 400.
     */
    async setLocalModel(req: AuthenticatedRequest, res: Response): Promise<void> {
      const body = (req.body ?? {}) as { providerId?: unknown; modelId?: unknown }
      const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
      const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : ''
      if (!providerId || !modelId) {
        res.status(400).json({ error: 'providerId and modelId are required' })
        return
      }
      const result = await service.setLocalModel({ providerId, modelId })
      if ('error' in result) {
        res.status(400).json({ error: result.error })
        return
      }
      res.json(result)
    },

    async disconnect(req: AuthenticatedRequest, res: Response): Promise<void> {
      const removed = await service.disconnect(paramId(req as Request))
      if (!removed) {
        res.status(404).json({ error: 'Connector not found' })
        return
      }
      const connector = service.get(paramId(req as Request), requestBaseUrl(req as Request))
      res.json({ connector })
    },
  }
}
