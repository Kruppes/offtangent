import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import {
  CLIENT_INTERACTION_TELEMETRY_EVENTS,
  isInteractionTelemetryEvent,
  normalizeInteractionChannel,
  recordInteractionEvent,
} from '@axiom/core'
import { parseAnswerInteractionBody } from './schema.js'
import { InteractionServiceError, type InteractionsService } from './service.js'

export interface InteractionsController {
  answer: (req: AuthenticatedRequest, res: Response) => void
  telemetry: (req: AuthenticatedRequest, res: Response) => void
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
        const result = service.answer(req.user!.userId, parsed.value)
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
  }
}
