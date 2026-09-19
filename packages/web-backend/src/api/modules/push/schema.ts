/** Body parsing for the push device registry. */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: string }

export interface RegisterDeviceBody {
  token: string
  platform: string
  appVersion: string | null
}

/** FCM registration tokens are long opaque strings; guard against obvious junk. */
const MAX_TOKEN_LENGTH = 4096
const ALLOWED_PLATFORMS = new Set(['android', 'ios', 'web'])

export function parseRegisterDeviceBody(body: unknown): ParseResult<RegisterDeviceBody> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body must be an object', code: 'invalid_body' }
  }
  const record = body as Record<string, unknown>
  const rawToken = record.token
  if (typeof rawToken !== 'string' || rawToken.trim().length === 0) {
    return { ok: false, error: 'token is required', code: 'token_required' }
  }
  const token = rawToken.trim()
  if (token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: 'token is too long', code: 'token_too_long' }
  }

  let platform = 'android'
  if (record.platform !== undefined && record.platform !== null) {
    if (typeof record.platform !== 'string') {
      return { ok: false, error: 'platform must be a string', code: 'invalid_platform' }
    }
    platform = record.platform.trim().toLowerCase()
    if (!ALLOWED_PLATFORMS.has(platform)) {
      return { ok: false, error: `platform must be one of ${[...ALLOWED_PLATFORMS].join(', ')}`, code: 'invalid_platform' }
    }
  }

  let appVersion: string | null = null
  if (record.appVersion !== undefined && record.appVersion !== null) {
    if (typeof record.appVersion !== 'string') {
      return { ok: false, error: 'appVersion must be a string', code: 'invalid_app_version' }
    }
    appVersion = record.appVersion.trim().slice(0, 64) || null
  }

  return { ok: true, value: { token, platform, appVersion } }
}
