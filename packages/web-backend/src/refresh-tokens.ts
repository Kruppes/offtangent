import { createHash } from 'node:crypto'
import type { Database } from '@axiom/core'
import { toIsoUtcOrNull } from '@axiom/core'
import { REFRESH_TOKEN_TTL_DAYS, generateRefreshToken } from './auth.js'
import type { JwtPayload } from './auth.js'

/**
 * Server-side refresh token store.
 *
 * The refresh token itself stays a JWT (so existing clients keep working), but
 * every issued token now also has a row here. That gives us rotation, explicit
 * revocation (logout / session kill) and OAuth-style reuse detection.
 * Only the sha256 hash of the token is persisted — a database leak does not
 * hand out usable tokens.
 */

export interface RefreshTokenRow {
  id: number
  user_id: number
  token_hash: string
  device_name: string | null
  created_at: string
  last_used_at: string | null
  expires_at: string
  revoked_at: string | null
  replaced_by: number | null
}

export interface SessionSummary {
  id: number
  deviceName: string | null
  createdAt: string
  lastUsedAt: string | null
  current: boolean
}

export const MAX_DEVICE_NAME_LENGTH = 80

/** Hash a refresh token for storage/lookup. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Normalize a client supplied device name (trimmed, capped, empty → null). */
export function normalizeDeviceName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, MAX_DEVICE_NAME_LENGTH)
}

/**
 * SQLite stores our timestamps as `YYYY-MM-DD HH:MM:SS` in UTC. Clients
 * (especially the Android app) want ISO 8601, so convert on the way out.
 * Thin wrapper over the shared {@link toIsoUtcOrNull} so there is exactly one
 * implementation of "what does this timestamp mean" in the codebase.
 */
export function toIsoTimestamp(value: string | null): string | null {
  return toIsoUtcOrNull(value)
}

export function findByToken(db: Database, token: string): RefreshTokenRow | null {
  const row = db
    .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
    .get(hashToken(token)) as RefreshTokenRow | undefined
  return row ?? null
}

export function findById(db: Database, id: number): RefreshTokenRow | null {
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE id = ?').get(id) as
    | RefreshTokenRow
    | undefined
  return row ?? null
}

export function isExpired(row: RefreshTokenRow): boolean {
  const expires = toIsoTimestamp(row.expires_at)
  if (!expires) return true
  return new Date(expires).getTime() <= Date.now()
}

interface InsertOptions {
  userId: number
  tokenHash: string
  deviceName: string | null
}

function insertRow(db: Database, options: InsertOptions): number {
  const result = db
    .prepare(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_name, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now', ?))`
    )
    .run(options.userId, options.tokenHash, options.deviceName, `+${REFRESH_TOKEN_TTL_DAYS} days`)
  return Number(result.lastInsertRowid)
}

export interface IssuedRefreshToken {
  token: string
  row: RefreshTokenRow
}

/**
 * Issue a brand new refresh token (login, or migration of a legacy token) and
 * persist its hash.
 */
export function issueRefreshToken(
  db: Database,
  user: { id: number; username: string; role: string },
  deviceName: string | null
): IssuedRefreshToken {
  const payload: JwtPayload = { userId: user.id, username: user.username, role: user.role }
  const { token } = generateRefreshToken(payload)
  const id = insertRow(db, { userId: user.id, tokenHash: hashToken(token), deviceName })
  const row = findById(db, id)
  if (!row) throw new Error('Failed to persist refresh token')
  return { token, row }
}

/**
 * Rotate an existing refresh token row: issue a successor and mark the old row
 * as revoked + replaced. Returns the new token and row.
 */
export function rotateRefreshToken(
  db: Database,
  previous: RefreshTokenRow,
  user: { id: number; username: string; role: string }
): IssuedRefreshToken {
  const issued = issueRefreshToken(db, user, previous.device_name)
  db.prepare(
    `UPDATE refresh_tokens
     SET revoked_at = COALESCE(revoked_at, datetime('now')),
         last_used_at = datetime('now'),
         replaced_by = ?
     WHERE id = ?`
  ).run(issued.row.id, previous.id)
  return issued
}

/**
 * Migrate a refresh JWT that was issued before the store existed (no `jti`,
 * no row). The legacy token is recorded as an already-revoked row so a second
 * presentation is caught by reuse detection, and a fresh token is issued.
 */
export function migrateLegacyToken(
  db: Database,
  legacyToken: string,
  user: { id: number; username: string; role: string },
  deviceName: string | null
): IssuedRefreshToken {
  const issued = issueRefreshToken(db, user, deviceName)
  db.prepare(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_name, created_at, last_used_at, expires_at, revoked_at, replaced_by)
     VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'), ?)`
  ).run(user.id, hashToken(legacyToken), deviceName, issued.row.id)
  return issued
}

/**
 * Revoke a single row (idempotent).
 */
export function revokeRow(db: Database, id: number): void {
  db.prepare(
    "UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?"
  ).run(id)
}

/**
 * Revoke the whole rotation chain starting at `row` (the row itself plus every
 * successor reachable via replaced_by). Used on reuse detection: a replayed
 * token means the chain is compromised, so the still-active descendant must die
 * as well.
 */
export function revokeChain(db: Database, row: RefreshTokenRow): number {
  let current: RefreshTokenRow | null = row
  const seen = new Set<number>()
  let revoked = 0
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    revokeRow(db, current.id)
    revoked++
    current = current.replaced_by ? findById(db, current.replaced_by) : null
  }
  return revoked
}

/**
 * Follow replaced_by until the newest row of a chain. Used to resolve the
 * `sid` embedded in an access token to the refresh row that is currently alive.
 */
export function resolveChainHead(db: Database, id: number): RefreshTokenRow | null {
  let current = findById(db, id)
  const seen = new Set<number>()
  while (current && current.replaced_by && !seen.has(current.id)) {
    seen.add(current.id)
    const next: RefreshTokenRow | null = findById(db, current.replaced_by)
    if (!next) break
    current = next
  }
  return current
}

/** Active (not revoked, not expired) refresh rows of a user, newest first. */
export function listActiveSessions(
  db: Database,
  userId: number,
  currentSid?: number
): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM refresh_tokens
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
       ORDER BY datetime(created_at) DESC, id DESC`
    )
    .all(userId) as RefreshTokenRow[]

  const currentId = currentSid === undefined ? null : resolveChainHead(db, currentSid)?.id ?? null

  return rows.map((row) => ({
    id: row.id,
    deviceName: row.device_name,
    createdAt: toIsoTimestamp(row.created_at) ?? row.created_at,
    lastUsedAt: toIsoTimestamp(row.last_used_at),
    current: currentId !== null && row.id === currentId,
  }))
}
