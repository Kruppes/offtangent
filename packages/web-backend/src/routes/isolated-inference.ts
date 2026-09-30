/**
 * POST /v1/isolated/infer — the ONLY externally reachable inference route for
 * a registered service (contract `isolated-inference.v1`).
 *
 * This router is mounted OUTSIDE the JWT gate on purpose: it has its own,
 * service scoped bearer credential and it exposes exactly one POST. It is not
 * a proxy for the admin or agent API — nothing here can reach a chat, a
 * strand, memory, a tool, a task or the database. The router does not receive
 * the `Database` handle at all, which keeps that structural.
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import express from 'express'
import {
  ISOLATED_INFERENCE_CONTRACT,
  IsolatedInferenceError,
  authenticateIsolatedService,
  loadIsolatedInferenceConfig,
  parseIsolatedRequest,
  runIsolatedInference,
  type IsolatedInferenceService,
} from '@axiom/core'

/**
 * Body cap for this route. The profile allows 80.000 characters, which is up to
 * ~320 kB in UTF-8 for non ASCII text, so the cap must be larger than the
 * character limit in bytes — otherwise a legal German or CJK input dies in the
 * parser with an HTML 413 instead of the contract error. The character ceiling
 * itself is enforced in the core (`input_too_large`).
 */
export const ISOLATED_BODY_LIMIT = '512kb'

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : null
}

function fail(res: Response, error: IsolatedInferenceError): void {
  res.status(error.status).json({
    contract: ISOLATED_INFERENCE_CONTRACT,
    error: { code: error.code, message: error.message },
  })
}

/** Mount prefix in `app.ts` and the ONE absolute path of this endpoint. */
export const ISOLATED_INFER_MOUNT = '/v1/isolated'
export const ISOLATED_INFER_PATH = `${ISOLATED_INFER_MOUNT}/infer`

export function createIsolatedInferenceRouter(): Router {
  // Case sensitive and strict inside the router. The MOUNT prefix of
  // `app.use()` is matched case insensitively by express, so the exact path is
  // additionally checked against `originalUrl` below: a path keyed control in
  // front of the app (proxy rate limit, WAF rule, log filter pinned to the
  // exact path) must not be evadable with `/V1/ISOLATED/INFER`.
  const router = Router({ caseSensitive: true, strict: true })

  // Gate FIRST, parse second. The 512 kb parser must not run for a request
  // that is rejected anyway: without the bearer check in front of it an
  // unauthenticated client could force repeated 512 kb reads plus JSON.parse
  // on the very first middleware of the app.
  router.all('/infer', (req: Request, res: Response, next: NextFunction) => {
    // No cookies, no CORS credentials, nothing cacheable: this endpoint is
    // reached by a server side client with a bearer token only. Answering a
    // browser origin would turn a logged-in user's cookie into a way to spend
    // the budget, so the credentialed CORS headers of the app never apply here.
    res.setHeader('Cache-Control', 'no-store')
    // Exactly one spelling of the path reaches the endpoint.
    if ((req.originalUrl.split('?')[0] ?? '') !== ISOLATED_INFER_PATH) {
      res.status(404).json({
        contract: ISOLATED_INFERENCE_CONTRACT,
        error: { code: 'not_found', message: 'unknown path' },
      })
      return
    }
    res.setHeader('Access-Control-Allow-Origin', '')
    res.removeHeader('Access-Control-Allow-Credentials')
    if (req.method !== 'POST') {
      res.status(405).json({
        contract: ISOLATED_INFERENCE_CONTRACT,
        error: { code: 'method_not_allowed', message: 'use POST' },
      })
      return
    }
    if (!bearerToken(req)) {
      fail(res, new IsolatedInferenceError('unauthorized', 401, 'unauthorized'))
      return
    }
    next()
  })

  // Own parser with its own limit, bound to exactly `POST /infer`. The router
  // is mounted BEFORE the generic `express.json()` of the app (see app.ts),
  // otherwise body-parser would skip it — `req.body` would already be set and
  // the limit here would be dead code. `router.post('/infer', ...)` instead of
  // `router.use('/infer', ...)` keeps the larger limit off any future subpath
  // under `/v1/isolated/infer/…`.
  router.post(
    '/infer',
    express.json({ limit: ISOLATED_BODY_LIMIT, type: 'application/json' }),
    (req: Request, res: Response) => {
      void handleInfer(req, res)
    },
  )

  // Anything else below the mount is a 404 IN THE CONTRACT SHAPE. Without
  // this the request falls through to the app default handler, which answers
  // an HTML page: a calling service cannot tell a typo in the path from a
  // broken proxy in front of the app (found in the 30.09.2026 acceptance run).
  // No auth, no body parsing, no timing difference — this leaks nothing beyond
  // "this prefix exists", which the canonical path already tells everyone.
  router.all(/.*/, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.status(404).json({
      contract: ISOLATED_INFERENCE_CONTRACT,
      error: { code: 'not_found', message: 'unknown path' },
    })
  })

  // A body-parser failure must answer in the contract shape too. Without this
  // express' default handler answers an HTML page, which is indistinguishable
  // from a broken proxy for the calling service.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const type = (err as { type?: string } | null)?.type
    if (type === 'entity.too.large') {
      fail(res, new IsolatedInferenceError('input_too_large', 413, 'request body exceeds the limit'))
      return
    }
    if (type === 'entity.parse.failed' || type === 'charset.unsupported' || type === 'encoding.unsupported') {
      fail(res, new IsolatedInferenceError('invalid_request', 400, 'body must be a JSON object'))
      return
    }
    next(err)
  })

  return router
}

async function handleInfer(req: Request, res: Response): Promise<void> {
  let service: IsolatedInferenceService | null
  try {
    service = authenticateIsolatedService(bearerToken(req), loadIsolatedInferenceConfig())
  } catch {
    service = null
  }
  if (!service) {
    fail(res, new IsolatedInferenceError('unauthorized', 401, 'unauthorized'))
    return
  }
  const rawKey = req.headers['idempotency-key']
  const idempotencyKey = typeof rawKey === 'string' && IDEMPOTENCY_KEY_PATTERN.test(rawKey.trim())
    ? rawKey.trim()
    : null
  try {
    const request = parseIsolatedRequest(req.body, service)
    const result = await runIsolatedInference(service, request, { idempotencyKey })
    res.json(result)
  } catch (err) {
    if (err instanceof IsolatedInferenceError) {
      fail(res, err)
      return
    }
    // Never leak an internal stack, provider URL or key material.
    console.error('[isolated-inference] unexpected failure', err)
    fail(res, new IsolatedInferenceError('upstream_failed', 502, 'inference failed'))
  }
}
