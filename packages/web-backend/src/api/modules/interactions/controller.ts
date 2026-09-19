import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { parseAnswerInteractionBody } from './schema.js'
import { InteractionServiceError, type InteractionsService } from './service.js'

export interface InteractionsController {
  answer: (req: AuthenticatedRequest, res: Response) => void
}

export function createInteractionsController(service: InteractionsService): InteractionsController {
  return {
    answer(req, res) {
      const parsed = parseAnswerInteractionBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        res.json(service.answer(req.user!.userId, parsed.value))
      } catch (err) {
        if (err instanceof InteractionServiceError) {
          // 409 carries the stored answer so the card can show it instead of
          // an error; 410 carries only the reason.
          res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ?? {}) })
          return
        }
        console.error('[interactions] Failed to apply the answer:', err)
        res.status(500).json({ error: `Failed to apply the answer: ${(err as Error).message}` })
      }
    },
  }
}
