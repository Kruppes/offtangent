import type { Response } from 'express'
import { isSessionAccessError } from '@axiom/core'
import type { AuthenticatedRequest } from '../../../auth.js'
import { parseApplyCaptureBody, parseCreateCaptureBody, parseListCapturesQuery, parseRouterPreviewBody, parseUndoCaptureBody } from './schema.js'
import { CaptureServiceError, type CapturesService } from './service.js'

export interface CapturesController {
  create: (req: AuthenticatedRequest, res: Response) => Promise<void>
  list: (req: AuthenticatedRequest, res: Response) => void
  apply: (req: AuthenticatedRequest, res: Response) => void
  undo: (req: AuthenticatedRequest, res: Response) => void
  dismiss: (req: AuthenticatedRequest, res: Response) => void
  preview: (req: AuthenticatedRequest, res: Response) => Promise<void>
}

function sendError(res: Response, err: unknown, context: string): void {
  if (err instanceof CaptureServiceError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return
  }
  if (isSessionAccessError(err)) {
    res.status(400).json({ error: err.message, code: 'invalid_strand' })
    return
  }
  console.error(`[captures] ${context}:`, err)
  res.status(500).json({ error: `${context}: ${(err as Error).message}` })
}

export function createCapturesController(service: CapturesService): CapturesController {
  return {
    async create(req, res) {
      const parsed = parseCreateCaptureBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        const result = await service.createCapture(req.user!.userId, parsed.value)
        // `turn` (plan 2026-09-19, D5): null when no answer turn was started
        // or when it started right away; an object when it has to wait, so the
        // client can say what it waits for instead of showing a mute card.
        res.status(result.created ? 201 : 200).json({
          capture: result.capture,
          decision: result.decision,
          turn: result.turn ?? null,
        })
      } catch (err) {
        sendError(res, err, 'Failed to accept capture')
      }
    },

    list(req, res) {
      const parsed = parseListCapturesQuery(req.query as Record<string, unknown>)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        res.json(service.list(req.user!.userId, parsed.value))
      } catch (err) {
        sendError(res, err, 'Failed to list captures')
      }
    },

    apply(req, res) {
      const parsed = parseApplyCaptureBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        const result = service.apply(req.user!.userId, String(req.params.id), parsed.value)
        res.json({ capture: result.capture, decision: result.decision, turn: result.turn ?? null })
      } catch (err) {
        sendError(res, err, 'Failed to apply decision')
      }
    },

    undo(req, res) {
      const parsed = parseUndoCaptureBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        const result = service.undo(req.user!.userId, String(req.params.id), parsed.value)
        res.json({ capture: result.capture, decision: result.decision, turn: result.turn ?? null })
      } catch (err) {
        sendError(res, err, 'Failed to undo decision')
      }
    },

    dismiss(req, res) {
      try {
        const result = service.dismiss(req.user!.userId, String(req.params.id))
        res.json({ capture: result.capture, decision: result.decision, turn: result.turn ?? null })
      } catch (err) {
        sendError(res, err, 'Failed to discard capture')
      }
    },

    async preview(req, res) {
      const parsed = parseRouterPreviewBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        res.json(await service.preview(req.user!.userId, parsed.value))
      } catch (err) {
        sendError(res, err, 'Router preview failed')
      }
    },
  }
}
