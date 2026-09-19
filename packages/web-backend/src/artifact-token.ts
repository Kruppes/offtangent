/**
 * artifact-token.ts — short lived, single artifact capability tokens.
 *
 * ## Why the JWT must never appear in an artifact URL
 *
 * The canvas renders LLM written HTML. That document can read its own URL
 * (`location.href`, `document.URL`) no matter how tightly it is sandboxed, so
 * a `?token=<access JWT>` on the content route — the pattern `/api/uploads`
 * uses for `<img src>` — would hand the whole account to untrusted code.
 *
 * A content token is therefore NOT the session: it is an opaque capability for
 * exactly one artifact id, for a few minutes. The worst an artifact can do
 * with its own token is read itself, which it is already rendering.
 *
 * The token is an HMAC over (artifact id, owner, expiry). Nothing is stored:
 * the signature is the state, revocation is the expiry.
 */
import crypto from 'node:crypto'

const VERSION = 'v1'
/** Long enough to open a canvas from a list, short enough to be worthless later. */
export const ARTIFACT_TOKEN_TTL_SECONDS = 600

export interface ArtifactTokenClaims {
  artifactId: string
  userId: number
  expiresAt: number
}

function secret(): Buffer {
  const base = process.env.ARTIFACT_TOKEN_SECRET
    ?? process.env.JWT_SECRET
    ?? 'axiom-dev-secret-change-me'
  // Domain separated from the JWT signing key: an artifact token must never
  // verify as an access token and vice versa, even when both derive from
  // JWT_SECRET on a default install.
  return crypto.createHmac('sha256', base).update('offtangent:artifact-content:v1').digest()
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function mintArtifactToken(
  artifactId: string,
  userId: number,
  ttlSeconds = ARTIFACT_TOKEN_TTL_SECONDS,
): { token: string; expiresAt: string } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${VERSION}.${artifactId}.${userId}.${expiresAt}`
  return {
    token: `${payload}.${sign(payload)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  }
}

export function verifyArtifactToken(token: unknown): ArtifactTokenClaims | null {
  if (typeof token !== 'string' || token.length > 512) return null
  const parts = token.split('.')
  if (parts.length !== 5) return null
  const [version, artifactId, rawUserId, rawExpiry, signature] = parts
  if (version !== VERSION) return null
  if (!/^[0-9a-fA-F-]{36}$/.test(artifactId)) return null
  if (!/^\d{1,15}$/.test(rawUserId) || !/^\d{1,15}$/.test(rawExpiry)) return null

  const expected = sign(`${version}.${artifactId}.${rawUserId}.${rawExpiry}`)
  const given = Buffer.from(signature)
  const want = Buffer.from(expected)
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null

  const expiresAt = Number(rawExpiry)
  if (expiresAt * 1000 <= Date.now()) return null

  return { artifactId, userId: Number(rawUserId), expiresAt }
}
