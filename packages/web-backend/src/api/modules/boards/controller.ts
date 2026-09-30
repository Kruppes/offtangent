import type { Request, Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { verifyAccessToken } from '../../../auth.js'
import { BOARD_TOKEN_CURRENT_REVISION, verifyBoardToken } from '../../../board-token.js'
import { parseBoardKey, parseBoardSeriesQuery, parseRevisionNumber } from './schema.js'
import { BoardServiceError, type BoardsService } from './service.js'

export interface BoardsController {
  list: (req: AuthenticatedRequest, res: Response) => void
  get: (req: AuthenticatedRequest, res: Response) => void
  content: (req: Request, res: Response) => void
  revisionContent: (req: Request, res: Response) => void
  revisions: (req: AuthenticatedRequest, res: Response) => void
  revision: (req: AuthenticatedRequest, res: Response) => void
  series: (req: AuthenticatedRequest, res: Response) => void
  remove: (req: AuthenticatedRequest, res: Response) => void
}

function sendError(res: Response, err: unknown, context: string): void {
  if (err instanceof BoardServiceError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return
  }
  console.error(`[boards] ${context}:`, err)
  res.status(500).json({ error: `${context}: ${(err as Error).message}` })
}

/**
 * Who may read the document of an `html_view.v1` board.
 *
 * Two credentials, in this order:
 *  1. `?t=` — the short lived capability token minted by `GET /api/boards/:key`
 *     (or by the revision route). This is what an iframe or a WebView uses,
 *     because neither can send an Authorization header, and because the access
 *     token must never end up in a URL the document itself can read.
 *  2. `Authorization: Bearer` — for programmatic clients and for an app that
 *     fetches the bytes itself.
 *
 * A query `?token=` access token is deliberately NOT accepted here (unlike
 * `/api/uploads`): skill written HTML can read its own URL.
 */
function resolveContentUserId(req: Request, key: string, revision: number | null): number | null {
  const capability = verifyBoardToken(req.query.t)
  if (capability) {
    if (capability.key !== key) return null
    const wanted = revision ?? BOARD_TOKEN_CURRENT_REVISION
    // A token for the current state does not unlock the archive and vice versa.
    if (capability.revision !== wanted) return null
    return capability.userId
  }

  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const payload = verifyAccessToken(header.slice(7))
    if (payload) return payload.userId
  }
  return null
}

function serveContent(service: BoardsService, req: Request, res: Response, revision: number | null): void {
  const key = parseBoardKey(req.params.key)
  if (!key.ok) {
    res.status(404).json({ error: key.error, code: key.code })
    return
  }
  const userId = resolveContentUserId(req, key.value, revision)
  if (userId === null) {
    res.status(401).json({ error: 'Missing or invalid board content token', code: 'board_unauthorized' })
    return
  }
  try {
    const { html, headers } = service.content(userId, key.value, revision)
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
    res.status(200).end(Buffer.from(html, 'utf8'))
  } catch (err) {
    sendError(res, err, 'Failed to read the board document')
  }
}

export function createBoardsController(service: BoardsService): BoardsController {
  return {
    list(req, res) {
      try {
        res.json(service.list(req.user!.userId))
      } catch (err) {
        sendError(res, err, 'Failed to list boards')
      }
    },

    get(req, res) {
      const key = parseBoardKey(req.params.key)
      if (!key.ok) {
        res.status(404).json({ error: key.error, code: key.code })
        return
      }
      try {
        res.json(service.get(req.user!.userId, key.value))
      } catch (err) {
        sendError(res, err, 'Failed to read the board')
      }
    },

    revisions(req, res) {
      const key = parseBoardKey(req.params.key)
      if (!key.ok) {
        res.status(404).json({ error: key.error, code: key.code })
        return
      }
      try {
        res.json(service.revisions(req.user!.userId, key.value))
      } catch (err) {
        sendError(res, err, 'Failed to list board revisions')
      }
    },

    revision(req, res) {
      const key = parseBoardKey(req.params.key)
      if (!key.ok) {
        res.status(404).json({ error: key.error, code: key.code })
        return
      }
      const revision = parseRevisionNumber(req.params.revision)
      if (!revision.ok) {
        res.status(404).json({ error: revision.error, code: revision.code })
        return
      }
      try {
        res.json(service.revision(req.user!.userId, key.value, revision.value))
      } catch (err) {
        sendError(res, err, 'Failed to read the board revision')
      }
    },

    content(req, res) {
      serveContent(service, req, res, null)
    },

    revisionContent(req, res) {
      const revision = parseRevisionNumber(req.params.revision)
      if (!revision.ok) {
        res.status(404).json({ error: revision.error, code: revision.code })
        return
      }
      serveContent(service, req, res, revision.value)
    },

    series(req, res) {
      const key = parseBoardKey(req.params.key)
      if (!key.ok) {
        res.status(404).json({ error: key.error, code: key.code })
        return
      }
      const query = parseBoardSeriesQuery(req.query as Record<string, unknown>)
      if (!query.ok) {
        res.status(400).json({ error: query.error, code: query.code })
        return
      }
      try {
        res.json(service.series(req.user!.userId, key.value, query.value.series, query.value.days))
      } catch (err) {
        sendError(res, err, 'Failed to read the board series')
      }
    },

    remove(req, res) {
      // Deleting a board destroys its whole history, so it stays with the
      // admin role — the same rule the other destructive endpoints use.
      if (req.user?.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required', code: 'forbidden' })
        return
      }
      const key = parseBoardKey(req.params.key)
      if (!key.ok) {
        res.status(404).json({ error: key.error, code: key.code })
        return
      }
      try {
        service.remove(req.user.userId, key.value)
        res.status(204).end()
      } catch (err) {
        sendError(res, err, 'Failed to delete the board')
      }
    },
  }
}
