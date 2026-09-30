import bcrypt from 'bcrypt'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'
import type { Database } from '@axiom/core'

const SALT_ROUNDS = 10
const JWT_EXPIRY = '1h'
export const JWT_REFRESH_EXPIRY = '7d'
/** Must stay in sync with JWT_REFRESH_EXPIRY — used for the store row's expires_at. */
export const REFRESH_TOKEN_TTL_DAYS = 7

export type TokenType = 'access' | 'refresh'

export interface JwtPayload {
  userId: number
  username: string
  role: string
  /**
   * Token kind. Absent on tokens issued before the auth hardening change —
   * those are treated as access tokens so running web sessions keep working.
   */
  type?: TokenType
  /**
   * Access tokens only: id of the refresh_tokens row whose chain issued this
   * access token. Used by GET /api/auth/sessions to flag the current session.
   */
  sid?: number
  /** Refresh tokens only: unique token id, mirrored by the refresh_tokens row. */
  jti?: string
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload
}

function getJwtSecret(): string {
  return process.env.JWT_SECRET ?? 'axiom-dev-secret-change-me'
}

/**
 * Ensure admin user exists on first boot
 */
export function ensureAdminUser(db: Database): void {
  const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('admin')
  if (existing) return

  const username = process.env.ADMIN_USERNAME ?? 'admin'
  const password = process.env.ADMIN_PASSWORD ?? 'admin'
  const hash = bcrypt.hashSync(password, SALT_ROUNDS)

  db.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(username, hash, 'admin')

  console.log(`[axiom] Admin user "${username}" created.`)
}

/**
 * Validate credentials and return user or null
 */
export function validateCredentials(
  db: Database,
  username: string,
  password: string
): { id: number; username: string; role: string } | null {
  const row = db.prepare(
    'SELECT id, username, password_hash, role FROM users WHERE username = ?'
  ).get(username) as { id: number; username: string; password_hash: string; role: string } | undefined

  if (!row) return null
  if (!bcrypt.compareSync(password, row.password_hash)) return null

  return { id: row.id, username: row.username, role: row.role }
}

/**
 * Generate JWT access token. `sid` (refresh_tokens.id) is carried through when
 * present so the sessions endpoint can mark the current session.
 */
export function generateAccessToken(payload: JwtPayload): string {
  const body: JwtPayload = {
    userId: payload.userId,
    username: payload.username,
    role: payload.role,
    type: 'access',
  }
  if (payload.sid !== undefined) body.sid = payload.sid
  return jwt.sign(body, getJwtSecret(), { expiresIn: JWT_EXPIRY })
}

/**
 * Generate JWT refresh token. Always carries a `jti` so the server-side store
 * can identify (and revoke) exactly this token.
 */
export function generateRefreshToken(payload: JwtPayload): { token: string; jti: string } {
  const jti = payload.jti ?? randomUUID()
  const token = jwt.sign(
    {
      userId: payload.userId,
      username: payload.username,
      role: payload.role,
      type: 'refresh',
      jti,
    } satisfies JwtPayload,
    getJwtSecret(),
    { expiresIn: JWT_REFRESH_EXPIRY }
  )
  return { token, jti }
}

/**
 * Verify and decode JWT token (any kind).
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload
    const payload: JwtPayload = {
      userId: decoded.userId,
      username: decoded.username,
      role: decoded.role,
    }
    if (decoded.type === 'access' || decoded.type === 'refresh') payload.type = decoded.type
    if (typeof decoded.sid === 'number') payload.sid = decoded.sid
    if (typeof decoded.jti === 'string') payload.jti = decoded.jti
    return payload
  } catch {
    return null
  }
}

/**
 * Verify a token and require it to be usable as an access token.
 * Refresh tokens are rejected; tokens without a `type` claim (issued before
 * auth hardening) are accepted as access tokens for backwards compatibility.
 */
export function verifyAccessToken(token: string): JwtPayload | null {
  const payload = verifyToken(token)
  if (!payload) return null
  if (payload.type === 'refresh') return null
  return payload
}

/**
 * Extract a bearer token from the Authorization header, falling back to the
 * `?token=` query parameter. The query fallback exists for browser contexts
 * that cannot set headers (`<img src>`, WebSocket).
 */
export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  const queryToken = req.query?.token
  if (typeof queryToken === 'string' && queryToken.length > 0) return queryToken
  return null
}

/**
 * Express middleware to require JWT authentication
 */
export function jwtMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' })
    return
  }

  const token = authHeader.slice(7)
  const payload = verifyAccessToken(token)
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  req.user = payload
  next()
}

/**
 * Like {@link jwtMiddleware}, but also accepts `?token=<jwt>`. Used for
 * `/api/uploads/*`, which is loaded through `<img src>` / `<a href>` where no
 * Authorization header can be attached.
 */
export function jwtHeaderOrQueryMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const token = extractToken(req)
  if (!token) {
    res.status(401).json({ error: 'Missing or invalid authorization header' })
    return
  }

  const payload = verifyAccessToken(token)
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  req.user = payload
  next()
}
