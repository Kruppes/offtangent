/**
 * Shared contract for sealed secret handles (plan 2026-09-26, step 1).
 *
 * This file is deliberately pure: no fs, no crypto, no database. It is the
 * only part of the secret machinery the browser bundle may import, so the web
 * UI and the backend agree on the slug charset, the handle syntax, the allowed
 * kinds and the size limit without duplicating regexes.
 *
 * The runtime side of the store lives in `secret-store.ts`, the boundary in
 * `secret-boundary.ts`; both of them read Node APIs and stay server-only.
 */

/**
 * Kinds a handle can be filed under. The list is a whitelist: the API refuses
 * anything else, so a slug prefix can never be smuggled in through `kind`.
 *
 * The first 15 entries mirror the classes the detector produces
 * (`secret-detect.ts`) plus `vaultwarden` for values the boundary lifts out of
 * a password-manager CLI output, the last one is the catch-all for a value a
 * person files manually through the form.
 */
export const SECRET_HANDLE_KINDS = [
  'password',
  'token',
  'api-key',
  'github-token',
  'gitlab-token',
  'anthropic-key',
  'openai-key',
  'google-api-key',
  'aws-access-key',
  'slack-token',
  'jwt',
  'private-key',
  'url-password',
  'card-number',
  'pin',
  'vaultwarden',
  'secret',
] as const

export type SecretHandleKind = (typeof SECRET_HANDLE_KINDS)[number]

/** True when `kind` is one of the allowed classes. */
export function isSecretHandleKind(kind: unknown): kind is SecretHandleKind {
  return typeof kind === 'string' && (SECRET_HANDLE_KINDS as readonly string[]).includes(kind)
}

/** Slug charset, as a string so it can be reused in an `input[pattern]`. */
export const SECRET_HANDLE_SLUG_PATTERN = '[a-z0-9][a-z0-9-]{0,63}'

/** Anchored slug matcher. Non-global on purpose: no shared `lastIndex`. */
export const SECRET_HANDLE_SLUG_RE = new RegExp(`^${SECRET_HANDLE_SLUG_PATTERN}$`)

/** True when `slug` is a syntactically valid handle slug. */
export function isSecretHandleSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SECRET_HANDLE_SLUG_RE.test(slug)
}

/**
 * Source pattern of a handle inside text. Kept as a string so both the
 * server-side `SECRET_HANDLE_RE` and the UI renderer can be built from it; a
 * core test asserts the two stay identical.
 */
export const SECRET_HANDLE_PATTERN = `\\{\\{secret:(${SECRET_HANDLE_SLUG_PATTERN})\\}\\}`

/**
 * A fresh global matcher for handles in text. Always call this instead of
 * sharing one instance — a global regex carries `lastIndex` between callers.
 */
export function createSecretHandleRegex(): RegExp {
  return new RegExp(SECRET_HANDLE_PATTERN, 'g')
}

/**
 * Maximum plaintext length accepted through the form. Long enough for a PEM
 * private key (a 4096-bit RSA key is ~3.2 KB), short enough that nobody pastes
 * a file into the config.
 */
export const SECRET_HANDLE_MAX_VALUE_LENGTH = 8192

/**
 * Minimum length of a value that may be sealed through the API, and the lower
 * bound for global known-value redaction (F5 of the review triage 2026-09-26
 * 19:25).
 *
 * Below six characters, redaction turns into vandalism: a 4-digit PIN in the
 * store would rewrite every occurrence of those digits in every tool output —
 * dates, ports, line numbers. Resolving such a value THROUGH ITS HANDLE keeps
 * working; only the global search-and-replace has this floor.
 */
export const SECRET_HANDLE_MIN_VALUE_LENGTH = 6

/** Metadata of one sealed secret. Never carries the value. */
export interface SecretHandleMeta {
  slug: string
  kind: string
  source: string
  createdAt: string
  lastSeenAt?: string
  length: number
}
