/**
 * In-process fixed-window rate limit per user, the same pattern the secret
 * handles route uses (there is no rate-limit middleware in this repository,
 * and a single-process server does not need one). Used by the W5b routes:
 * message search and "fork at this message".
 */
import type { NextFunction, Response } from 'express'
import type { AuthenticatedRequest } from '../auth.js'

export interface FixedWindowOptions {
  windowMs: number
  max: number
  /** Error code of the 429 body. */
  code?: string
  now?: () => number
}

/**
 * Express middleware; must run AFTER the JWT middleware (the window is keyed
 * by `req.user.userId`). A request without a user passes through untouched
 * so the auth layer stays the one that answers 401.
 */
export function perUserRateLimit(options: FixedWindowOptions) {
  const windows = new Map<number, { startedAt: number; count: number }>()
  const now = options.now ?? Date.now
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const userId = req.user?.userId
    if (userId === undefined) { next(); return }
    const t = now()
    const window = windows.get(userId)
    if (!window || t - window.startedAt >= options.windowMs) {
      windows.set(userId, { startedAt: t, count: 1 })
      // Keep the map bounded: drop windows that are long over.
      if (windows.size > 1000) {
        for (const [key, value] of windows) if (t - value.startedAt >= options.windowMs) windows.delete(key)
      }
      next()
      return
    }
    if (window.count >= options.max) {
      const retryAfter = Math.max(1, Math.ceil((window.startedAt + options.windowMs - t) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      res.status(429).json({ error: 'Too many requests, try again shortly', code: options.code ?? 'rate_limited' })
      return
    }
    window.count++
    next()
  }
}
