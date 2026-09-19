import type { Request, Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { verifyAccessToken } from '../../../auth.js'
import { verifyArtifactToken } from '../../../artifact-token.js'
import { ArtifactServiceError, artifactContentHeaders } from './service.js'
import type { ArtifactsService } from './service.js'
import { isArtifactId, parseListArtifactsQuery } from './schema.js'

export interface ArtifactsController {
  list: (req: AuthenticatedRequest, res: Response) => void
  detail: (req: AuthenticatedRequest, res: Response) => void
  content: (req: Request, res: Response) => void
}

function run(res: Response, context: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    if (err instanceof ArtifactServiceError) {
      res.status(err.status).json({ error: err.message, code: err.code })
      return
    }
    console.error(`[artifacts] ${context}:`, err)
    res.status(500).json({ error: `${context}: ${(err as Error).message}` })
  }
}

/**
 * Who may read the raw bytes.
 *
 * Two credentials, in this order:
 *  1. `?t=` — the short lived capability token minted by `GET /api/artifacts/:id`.
 *     This is what an iframe or a WebView uses, because neither can send an
 *     Authorization header, and because the access token must never end up in
 *     a URL the artifact itself can read.
 *  2. `Authorization: Bearer` — for programmatic clients and for an app that
 *     fetches the bytes itself before handing them to a WebView.
 *
 * A query `?token=` access token is deliberately NOT accepted here (unlike
 * `/api/uploads`): LLM written HTML can read its own URL.
 */
function resolveUserId(req: Request, artifactId: string): number | null {
  const capability = verifyArtifactToken(req.query.t)
  if (capability) return capability.artifactId === artifactId ? capability.userId : null

  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const payload = verifyAccessToken(header.slice(7))
    if (payload) return payload.userId
  }
  return null
}

export function createArtifactsController(service: ArtifactsService): ArtifactsController {
  return {
    list(req, res) {
      const parsed = parseListArtifactsQuery(req.query as Record<string, unknown>)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to list artifacts', () => {
        res.json({ artifacts: service.list(req.user!.userId, parsed.value) })
      })
    },

    detail(req, res) {
      const id = String(req.params.id)
      if (!isArtifactId(id)) {
        res.status(404).json({ error: 'Artifact not found', code: 'artifact_not_found' })
        return
      }
      run(res, 'Failed to read artifact', () => {
        res.json(service.detail(req.user!.userId, id))
      })
    },

    content(req, res) {
      const id = String(req.params.id)
      if (!isArtifactId(id)) {
        res.status(404).json({ error: 'Artifact not found', code: 'artifact_not_found' })
        return
      }
      const userId = resolveUserId(req, id)
      if (userId === null) {
        res.status(401).json({ error: 'Missing or invalid artifact token', code: 'artifact_unauthorized' })
        return
      }
      run(res, 'Failed to read artifact content', () => {
        const { artifact, body } = service.content(userId, id)
        for (const [name, value] of Object.entries(artifactContentHeaders(artifact))) {
          res.setHeader(name, value)
        }
        res.status(200).end(body)
      })
    },
  }
}
