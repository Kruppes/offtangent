import { Router } from 'express'
import type { Database } from '@axiom/core'
import {
  validateCredentials,
  generateAccessToken,
  verifyToken,
  verifyAccessToken,
  jwtMiddleware,
} from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'
import {
  findByToken,
  isExpired,
  issueRefreshToken,
  listActiveSessions,
  migrateLegacyToken,
  normalizeDeviceName,
  revokeChain,
  revokeRow,
  rotateRefreshToken,
} from '../refresh-tokens.js'

interface UserRow {
  id: number
  username: string
  role: string
}

export function createAuthRouter(db: Database): Router {
  const router = Router()

  function loadUser(userId: number): UserRow | null {
    const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId) as
      | UserRow
      | undefined
    return user ?? null
  }

  /**
   * POST /api/auth/login
   * Body: { username, password, deviceName? }
   * Returns: { accessToken, refreshToken, user }
   */
  router.post('/login', (req, res) => {
    const { username, password, deviceName } = req.body as {
      username?: string
      password?: string
      deviceName?: string
    }

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' })
      return
    }

    const user = validateCredentials(db, username, password)
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    const issued = issueRefreshToken(db, user, normalizeDeviceName(deviceName))
    const accessToken = generateAccessToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      sid: issued.row.id,
    })

    res.json({
      accessToken,
      refreshToken: issued.token,
      user: { id: user.id, username: user.username, role: user.role },
    })
  })

  /**
   * POST /api/auth/refresh
   * Body: { refreshToken }
   * Returns: { accessToken, refreshToken, user }
   *
   * Rotates the refresh token: the presented row is revoked and linked to its
   * successor. Replaying an already rotated token revokes the whole chain
   * (OAuth-style reuse detection).
   */
  router.post('/refresh', (req, res) => {
    const { refreshToken } = req.body as { refreshToken?: string }

    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token is required' })
      return
    }

    const payload = verifyToken(refreshToken)
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired refresh token' })
      return
    }

    // Access tokens must never be exchanged for a new session.
    if (payload.type === 'access') {
      res.status(401).json({ error: 'Invalid or expired refresh token' })
      return
    }

    const user = loadUser(payload.userId)
    if (!user) {
      res.status(401).json({ error: 'User no longer exists' })
      return
    }

    const row = findByToken(db, refreshToken)

    if (!row && payload.jti) {
      // Issued by this server generation but no longer known → treat as invalid.
      res.status(401).json({ error: 'Invalid or expired refresh token' })
      return
    }

    let issued
    if (!row) {
      // Legacy refresh JWT from before the store existed: accept exactly once
      // and migrate it into the store so the browser session survives a deploy.
      issued = migrateLegacyToken(db, refreshToken, user, null)
    } else {
      if (row.user_id !== user.id) {
        res.status(401).json({ error: 'Invalid or expired refresh token' })
        return
      }
      if (row.revoked_at) {
        // Replaying a token that was already rotated away means the chain is
        // compromised (OAuth reuse detection): kill every successor too.
        // A row revoked without a successor is just a logged-out session.
        if (row.replaced_by) {
          console.warn(
            `[auth] refresh token reuse detected (user=${user.id}, token=${row.id}) — revoking session chain`
          )
          revokeChain(db, row)
        }
        res.status(401).json({ error: 'Invalid or expired refresh token' })
        return
      }
      if (isExpired(row)) {
        revokeRow(db, row.id)
        res.status(401).json({ error: 'Invalid or expired refresh token' })
        return
      }
      issued = rotateRefreshToken(db, row, user)
    }

    const accessToken = generateAccessToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      sid: issued.row.id,
    })

    res.json({
      accessToken,
      refreshToken: issued.token,
      user: { id: user.id, username: user.username, role: user.role },
    })
  })

  /**
   * GET /api/auth/me
   * Returns: { user: { id, username, role } }
   * Validates the current access token and confirms the user still exists.
   */
  router.get('/me', jwtMiddleware, (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }

    // Verify user still exists in the database
    const user = loadUser(req.user.userId)
    if (!user) {
      res.status(401).json({ error: 'User no longer exists' })
      return
    }

    res.json({
      user: { id: user.id, username: user.username, role: user.role },
    })
  })

  /**
   * POST /api/auth/logout
   * Auth: Bearer access token OR a signed refresh token in the body.
   * Body: { refreshToken }
   * Revokes the refresh token of this device. Idempotent → 204.
   *
   * The refresh-token-only path exists for mobile clients: once the access
   * token has expired, an access-token-only logout would leave the refresh
   * token alive forever on the server (the app could never log out cleanly).
   * The body token must still carry a valid signature and must not be an
   * access token, so this is authentication, not an open revoke endpoint.
   *
   * Unknown / foreign / already revoked tokens answer 204 all the same: the
   * endpoint must not reveal whether a token exists.
   */
  router.post('/logout', (req: AuthenticatedRequest, res) => {
    const { refreshToken } = req.body as { refreshToken?: string }

    const authHeader = req.headers.authorization
    const accessPayload = authHeader?.startsWith('Bearer ')
      ? verifyAccessToken(authHeader.slice(7))
      : null

    if (accessPayload) {
      // Unchanged behaviour for clients that still hold a valid access token.
      if (!refreshToken) {
        res.status(400).json({ error: 'Refresh token is required' })
        return
      }
      const row = findByToken(db, refreshToken)
      if (row && row.user_id === accessPayload.userId) {
        revokeRow(db, row.id)
      }
      res.status(204).end()
      return
    }

    // No usable access token: the refresh token itself has to authenticate.
    if (!refreshToken) {
      res.status(401).json({ error: 'Missing or invalid authorization header' })
      return
    }
    const refreshPayload = verifyToken(refreshToken)
    if (!refreshPayload || refreshPayload.type === 'access') {
      res.status(401).json({ error: 'Invalid or expired refresh token' })
      return
    }

    const row = findByToken(db, refreshToken)
    if (row && row.user_id === refreshPayload.userId) {
      revokeRow(db, row.id)
    }

    res.status(204).end()
  })

  /**
   * GET /api/auth/sessions
   * Auth: Bearer access token.
   * Returns: { sessions: [{ id, deviceName, createdAt, lastUsedAt, current }] }
   */
  router.get('/sessions', jwtMiddleware, (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }

    res.json({ sessions: listActiveSessions(db, req.user.userId, req.user.sid) })
  })

  /**
   * DELETE /api/auth/sessions/:id
   * Auth: Bearer access token. Revokes one of the caller's own sessions.
   * Foreign or unknown sessions → 404.
   */
  router.delete('/sessions/:id', jwtMiddleware, (req: AuthenticatedRequest, res) => {
    const rawId = req.params.id
    const id = Number.parseInt(Array.isArray(rawId) ? rawId[0] : rawId, 10)
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid session id' })
      return
    }

    const row = db.prepare('SELECT id, user_id FROM refresh_tokens WHERE id = ?').get(id) as
      | { id: number; user_id: number }
      | undefined

    if (!row || row.user_id !== req.user?.userId) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    revokeRow(db, row.id)
    res.status(204).end()
  })

  return router
}
