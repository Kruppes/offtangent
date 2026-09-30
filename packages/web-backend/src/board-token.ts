/**
 * board-token.ts — short lived capability tokens for one board document.
 *
 * The `html_view.v1` content route serves model/skill written HTML that a
 * browser executes, so it follows the artifact rule to the letter: the access
 * JWT must never appear in a URL that untrusted markup can read
 * (`location.href`). The credential is an opaque HMAC over
 * (board key, revision, owner, expiry) instead — good for exactly one document
 * for a few minutes. The worst a board page can do with its own token is read
 * itself, which it is already rendering.
 *
 * `revision = 0` means "whatever the current revision is", which is what the
 * board screen mints; a history view mints a token for its concrete revision.
 * Nothing is stored: the signature is the state, revocation is the expiry.
 */
import crypto from 'node:crypto'

const VERSION = 'b1'

/** Long enough to open a board from a list, short enough to be worthless later. */
export const BOARD_TOKEN_TTL_SECONDS = 600

/** `0` = the current revision, whatever it is at read time. */
export const BOARD_TOKEN_CURRENT_REVISION = 0

export interface BoardTokenClaims {
  key: string
  revision: number
  userId: number
  expiresAt: number
}

function secret(): Buffer {
  const base = process.env.BOARD_TOKEN_SECRET
    ?? process.env.ARTIFACT_TOKEN_SECRET
    ?? process.env.JWT_SECRET
    ?? 'axiom-dev-secret-change-me'
  // Domain separated from both the JWT key and the artifact key: a board token
  // must never verify as an access token or as an artifact token, even when
  // all three derive from JWT_SECRET on a default install.
  return crypto.createHmac('sha256', base).update('offtangent:board-content:v1').digest()
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function mintBoardToken(
  key: string,
  revision: number,
  userId: number,
  ttlSeconds = BOARD_TOKEN_TTL_SECONDS,
): { token: string; expiresAt: string } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${VERSION}.${key}.${revision}.${userId}.${expiresAt}`
  return {
    token: `${payload}.${sign(payload)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  }
}

export function verifyBoardToken(token: unknown): BoardTokenClaims | null {
  if (typeof token !== 'string' || token.length > 512) return null
  const parts = token.split('.')
  if (parts.length !== 6) return null
  const [version, key, rawRevision, rawUserId, rawExpiry, signature] = parts
  if (version !== VERSION) return null
  // The board key pattern excludes '.', so the split above cannot be ambiguous.
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(key)) return null
  if (!/^\d{1,9}$/.test(rawRevision)) return null
  if (!/^\d{1,15}$/.test(rawUserId) || !/^\d{1,15}$/.test(rawExpiry)) return null

  const expected = sign(`${version}.${key}.${rawRevision}.${rawUserId}.${rawExpiry}`)
  const given = Buffer.from(signature)
  const want = Buffer.from(expected)
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null

  const expiresAt = Number(rawExpiry)
  if (expiresAt * 1000 <= Date.now()) return null

  return { key, revision: Number(rawRevision), userId: Number(rawUserId), expiresAt }
}
