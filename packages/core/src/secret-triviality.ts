/**
 * Which AUTOMATIC detector findings are too trivial to become a new LASTING
 * handle (they are still redacted on the spot)
 * (fix 2026-10-19, "plain words redacted"; narrowed after review 2026-10-19).
 *
 * The URL-credential rule of `secret-detect.ts` reads the part after the
 * colon of `scheme://user:<value>@host`. In documentation, READMEs and help
 * texts that value is a placeholder (`postgres://user:password@host`), and
 * sealing it into the store turned plain English words into handles that the
 * global redaction then rewrote in every later output.
 *
 * Guiding rule: an exception may NEVER lift the redaction of a real,
 * deliberately stored secret. So this module does NOT filter the known-value
 * index, explicit handles (form, vault, provider keys) or detector findings
 * in general. It is consulted at exactly one place: `sealText()` in
 * `secret-boundary.ts`, before a NEW handle is created for a `url-password`
 * finding in a tool output (`tool:*` source) whose value is not already a
 * stored handle. Such a finding is replaced by the anonymous handle
 * (`REDACTED_HANDLE`) instead of a slug — the plaintext never passes, only
 * the global re-redaction of later occurrences is skipped (re-review N1).
 * Everything that is already stored is always redacted.
 *
 * Rules (case-insensitive, trimmed):
 *
 * 1. a placeholder or ordinary word from {@link TRIVIAL_SECRET_WORDS};
 * 2. a placeholder shape (`$VAR`, `${VAR}`, `<password>`, `[hidden]`,
 *    `{{name}}`, one repeated character such as `xxxxxxxx`).
 *
 * The form route (`POST /api/secrets/handles`) uses the same check only to
 * attach a warning to its response; it never refuses a weak password.
 */

/**
 * Words that show up as URL "passwords" only because the detector caught a
 * documentation placeholder. Lower-case; compared against the lower-cased,
 * trimmed value.
 */
export const TRIVIAL_SECRET_WORDS: ReadonlySet<string> = new Set([
  // placeholders / documentation
  'secret', 'secrets', 'password', 'passwords', 'passwort', 'passwoerter', 'passphrase',
  'changeme', 'change-me', 'changeit', 'placeholder', 'example', 'redacted', 'hidden',
  'your-password', 'yourpassword', 'mypassword', 'my-password', 'your_password',
  'password123', 'secret123', 'example-password', 'example-secret', 'dummy', 'testing',
  'username', 'user:password', 'token', 'apikey', 'api-key', 'api_key',
  // ordinary words seen as URL "passwords" in tool output
  'finished', 'session', 'sessions', 'default', 'unknown', 'localhost', 'undefined',
  'nothing', 'something', 'anything', 'everything', 'enabled', 'disabled',
  'admin', 'administrator', 'postgres',
])

/** Shapes that are placeholders, not values. */
const PLACEHOLDER_RES: readonly RegExp[] = [
  /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/, // $VAR, ${VAR}
  /^<[^<>]{1,64}>$/, // <password>
  /^\[[^[\]]{1,64}\]$/, // [hidden]
  /^\{\{[^{}]{1,64}\}\}$/, // {{placeholder}}
  /^(.)\1+$/, // xxxxxxxx, ********, 00000000
]

/**
 * True when `value` looks like a documentation placeholder or an ordinary
 * word rather than a credential. Pure; no I/O.
 *
 * Only for the two call sites named in the module docs — never use it to
 * skip a value that is already stored.
 */
export function isTrivialSecretValue(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  if (TRIVIAL_SECRET_WORDS.has(trimmed.toLowerCase())) return true
  return PLACEHOLDER_RES.some(re => re.test(trimmed))
}

/** Detector kinds whose NEW automatic findings are checked for triviality. */
export const TRIVIALITY_CHECKED_KINDS: ReadonlySet<string> = new Set(['url-password'])

/**
 * True when a new automatic finding must not create a lasting handle (the
 * caller still replaces it with the anonymous handle): only a
 * `url-password` finding from a tool output (`tool:<name>` source) with a
 * trivial value. Chat input, system-prompt text, the form and the vault CLI
 * are never filtered.
 */
export function skipTrivialAutomaticFinding(value: string, kind: string, source: string): boolean {
  if (!source.startsWith('tool:')) return false
  if (!TRIVIALITY_CHECKED_KINDS.has(kind)) return false
  return isTrivialSecretValue(value)
}
