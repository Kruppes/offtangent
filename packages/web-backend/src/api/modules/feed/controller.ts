import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { parseAskFeedBody, parseFeedItemId, parseListFeedQuery } from './schema.js'
import { FeedServiceError, type FeedService } from './service.js'

export interface FeedController {
  list: (req: AuthenticatedRequest, res: Response) => void
  read: (req: AuthenticatedRequest, res: Response) => void
  readAll: (req: AuthenticatedRequest, res: Response) => void
  unreadCount: (req: AuthenticatedRequest, res: Response) => void
  ask: (req: AuthenticatedRequest, res: Response) => Promise<void>
}

function sendError(res: Response, err: unknown, context: string): void {
  if (err instanceof FeedServiceError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return
  }
  console.error(`[feed] ${context}:`, err)
  res.status(500).json({ error: `${context}: ${(err as Error).message}` })
}

export function createFeedController(service: FeedService): FeedController {
  return {
    list(req, res) {
      const parsed = parseListFeedQuery(req.query as Record<string, unknown>)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        res.json(service.list(req.user!.userId, parsed.value))
      } catch (err) {
        sendError(res, err, 'Failed to list the feed')
      }
    },

    read(req, res) {
      const id = parseFeedItemId(req.params.id)
      if (!id.ok) {
        res.status(404).json({ error: id.error, code: id.code })
        return
      }
      try {
        service.markRead(req.user!.userId, id.value)
        res.status(204).end()
      } catch (err) {
        sendError(res, err, 'Failed to mark the feed item read')
      }
    },

    readAll(req, res) {
      try {
        service.markAllRead(req.user!.userId)
        res.status(204).end()
      } catch (err) {
        sendError(res, err, 'Failed to mark the feed read')
      }
    },

    unreadCount(req, res) {
      try {
        res.json(service.unreadCount(req.user!.userId))
      } catch (err) {
        sendError(res, err, 'Failed to count unread feed items')
      }
    },

    async ask(req, res) {
      const id = parseFeedItemId(req.params.id)
      if (!id.ok) {
        res.status(404).json({ error: id.error, code: id.code })
        return
      }
      const parsed = parseAskFeedBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        const result = await service.ask(req.user!.userId, id.value, parsed.value)
        res.status(201).json({ capture: result.capture, decision: result.decision })
      } catch (err) {
        sendError(res, err, 'Failed to ask about the feed item')
      }
    },
  }
}
