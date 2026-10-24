import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import {
  CLIENT_INTERACTION_TELEMETRY_EVENTS,
  isInteractionTelemetryEvent,
  normalizeInteractionChannel,
  recordInteractionEvent,
} from '@axiom/core'
import {
  INTERACTION_STATUS_FILTERS,
  isInteractionId,
  parseAnswerByIdBody,
  parseAnswerInteractionBody,
  parseDraftBody,
} from './schema.js'
import type { InteractionStatus, InteractionSurface } from '@axiom/core'
import { InteractionServiceError, type InteractionActor, type InteractionsService } from './service.js'

export interface InteractionsController {
  answer: (req: AuthenticatedRequest, res: Response) => void
  telemetry: (req: AuthenticatedRequest, res: Response) => void
  answerById: (req: AuthenticatedRequest, res: Response) => void
  dismiss: (req: AuthenticatedRequest, res: Response) => void
  saveDraft: (req: AuthenticatedRequest, res: Response) => void
  listForStrand: (req: AuthenticatedRequest, res: Response) => void
}

/** The caller with its admin flag: a card without owner is visible to an admin only (review 1, finding 1). */
export function requestActor(req: AuthenticatedRequest): InteractionActor {
  return { userId: req.user!.userId, admin: req.user?.role === 'admin' }
}

/** The surface a close is recorded with (`closed_surface`). */
export function requestInteractionSurface(req: AuthenticatedRequest): InteractionSurface {
  return requestInteractionChannel(req) === 'android' ? 'android' : 'web'
}

function sendServiceError(res: Response, err: unknown, what: string): void {
  if (err instanceof InteractionServiceError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ?? {}) })
    return
  }
  console.error(`[interactions] Failed to ${what}:`, err)
  res.status(500).json({ error: `Failed to ${what}: ${(err as Error).message}` })
}

function interactionIdParam(req: AuthenticatedRequest, res: Response): string | null {
  const id = String(req.params?.id ?? '')
  if (!isInteractionId(id)) {
    res.status(404).json({ error: 'No such interaction', code: 'unknown_interaction' })
    return null
  }
  return id
}

/**
 * Which surface sent the request, for the S0-B counters only: an explicit
 * `channel` in the body wins, then the Android HTTP client's user agent.
 */
export function requestInteractionChannel(req: AuthenticatedRequest): string {
  const body = req.body as { channel?: unknown } | undefined
  if (typeof body?.channel === 'string') return normalizeInteractionChannel(body.channel)
  const agent = String(req.headers?.['user-agent'] ?? '').toLowerCase()
  if (agent.includes('okhttp') || agent.includes('offtangent-android')) return 'android'
  return 'web'
}

/** Surfaces that report client events themselves (review 8: enum only). */
export const TELEMETRY_CLIENT_CHANNELS = ['web', 'android'] as const
/** Largest `count` one report may carry: a batch of a few events, no more. */
export const TELEMETRY_MAX_COUNT = 20
/** Reports per user within one window; the next one answers 429. */
export const TELEMETRY_RATE_LIMIT = 60
export const TELEMETRY_RATE_WINDOW_MS = 60_000
const TELEMETRY_BODY_KEYS = new Set(['channel', 'event', 'count'])

export type TelemetryBody = {
  channel: typeof TELEMETRY_CLIENT_CHANNELS[number]
  event: typeof CLIENT_INTERACTION_TELEMETRY_EVENTS[number]
  count: number
}

/**
 * Strict reading of a telemetry report: an object with exactly the known keys,
 * a channel of the enum, an event of the client list and a small positive
 * integer count. Anything else is refused, so no free value reaches a counter.
 */
export function parseTelemetryBody(raw: unknown): { ok: true; value: TelemetryBody } | { ok: false; code: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid_body' }
  const body = raw as Record<string, unknown>
  if (Object.keys(body).some(key => !TELEMETRY_BODY_KEYS.has(key))) return { ok: false, code: 'invalid_body' }
  if (typeof body.channel !== 'string' || !(TELEMETRY_CLIENT_CHANNELS as readonly string[]).includes(body.channel)) {
    return { ok: false, code: 'invalid_channel' }
  }
  if (!isInteractionTelemetryEvent(body.event) || !CLIENT_INTERACTION_TELEMETRY_EVENTS.includes(body.event)) {
    return { ok: false, code: 'invalid_event' }
  }
  const count = body.count === undefined ? 1 : body.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > TELEMETRY_MAX_COUNT) {
    return { ok: false, code: 'invalid_count' }
  }
  return { ok: true, value: { channel: body.channel as TelemetryBody['channel'], event: body.event, count } }
}

/** Fixed-window limiter per user id, in memory (the counters are too). */
export function createTelemetryRateLimiter(options: { limit?: number; windowMs?: number; now?: () => number } = {}) {
  const limit = options.limit ?? TELEMETRY_RATE_LIMIT
  const windowMs = options.windowMs ?? TELEMETRY_RATE_WINDOW_MS
  const now = options.now ?? Date.now
  const windows = new Map<number, { start: number; used: number }>()
  return {
    allow(userId: number): boolean {
      const at = now()
      const current = windows.get(userId)
      if (!current || at - current.start >= windowMs) {
        // Drop finished windows so the map does not grow with every user ever seen.
        for (const [id, w] of windows) if (at - w.start >= windowMs) windows.delete(id)
        windows.set(userId, { start: at, used: 1 })
        return true
      }
      if (current.used >= limit) return false
      current.used += 1
      return true
    },
  }
}

export function createInteractionsController(
  service: InteractionsService,
  options: { telemetryLimiter?: ReturnType<typeof createTelemetryRateLimiter> } = {},
): InteractionsController {
  const telemetryLimiter = options.telemetryLimiter ?? createTelemetryRateLimiter()
  return {
    answer(req, res) {
      const parsed = parseAnswerInteractionBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        const result = service.answer(requestActor(req), parsed.value, requestInteractionSurface(req))
        if (!result.idempotent) recordInteractionEvent(requestInteractionChannel(req), 'answered')
        res.json(result)
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

    /**
     * `POST /api/interactions/telemetry` `{ channel, event, count? }` (S0-B/B1).
     * Counters only, read strictly (`parseTelemetryBody`) and rate limited per
     * user, so a client can neither send content along nor inflate a counter.
     */
    telemetry(req, res) {
      const parsed = parseTelemetryBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: 'invalid telemetry report', code: parsed.code })
        return
      }
      if (!telemetryLimiter.allow(req.user!.userId)) {
        res.status(429).json({ error: 'too many telemetry reports', code: 'rate_limited' })
        return
      }
      recordInteractionEvent(parsed.value.channel, parsed.value.event, parsed.value.count)
      res.status(204).end()
    },

    /** `POST /api/interactions/:id/answer` `{ value, clientRequestId }` (S1-A). */
    answerById(req, res) {
      const id = interactionIdParam(req, res)
      if (!id) return
      const parsed = parseAnswerByIdBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        const result = service.answerById(requestActor(req), id, { ...parsed.value, surface: requestInteractionSurface(req) })
        if (!result.idempotent) recordInteractionEvent(requestInteractionChannel(req), 'answered')
        res.json(result)
      } catch (err) {
        sendServiceError(res, err, 'apply the answer')
      }
    },

    /** `POST /api/interactions/:id/dismiss` (S1-A): closes the card, starts no turn. */
    dismiss(req, res) {
      const id = interactionIdParam(req, res)
      if (!id) return
      try {
        const result = service.dismiss(requestActor(req), id, requestInteractionSurface(req))
        res.json({ dismissed: true, idempotent: result.idempotent, interaction: result.interaction })
      } catch (err) {
        sendServiceError(res, err, 'dismiss the question')
      }
    },

    /** `PUT /api/interactions/:id/draft` `{ answers }` (S1-A). */
    saveDraft(req, res) {
      const id = interactionIdParam(req, res)
      if (!id) return
      const parsed = parseDraftBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      try {
        res.json({ interaction: service.saveDraft(requestActor(req), id, parsed.value.answers) })
      } catch (err) {
        sendServiceError(res, err, 'save the draft')
      }
    },

    /** `GET /api/strands/:id/interactions?status=open` (S1-A). */
    listForStrand(req, res) {
      const rawStatus = req.query?.status
      let status: InteractionStatus | undefined
      if (rawStatus !== undefined) {
        if (typeof rawStatus !== 'string' || !(INTERACTION_STATUS_FILTERS as readonly string[]).includes(rawStatus)) {
          res.status(400).json({ error: 'unknown status filter', code: 'invalid_status' })
          return
        }
        status = rawStatus as InteractionStatus
      }
      try {
        const interactions = service.listForStrand(requestActor(req), String(req.params?.id ?? ''), status)
        res.json({ interactions })
      } catch (err) {
        sendServiceError(res, err, 'list the interactions')
      }
    },
  }
}
