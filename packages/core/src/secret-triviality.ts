/**
 * Which known values are too trivial for the GLOBAL search-and-replace of the
 * secret boundary (fix 2026-10-19, "model IDs and plain words redacted").
 *
 * The known-value index in `secret-boundary.ts` rewrites every occurrence of a
 * stored value in every tool output, message and system prompt. That is right
 * for an API key and vandalism for an ordinary word: a URL detector hit on
 * `postgres://user:password@host` (a documentation placeholder) or a `bw`
 * status line sealed as a "session" turned plain English words into handles
 * everywhere, and an env file holding a model id (`*_MODEL=claude-…`) made a
 * model id unreadable for the agent.
 *
 * Rules (case-insensitive):
 *
 * 1. a common word or placeholder from {@link TRIVIAL_SECRET_WORDS};
 * 2. a placeholder shape (`${VAR}`, `<password>`, `***`, `xxxx`);
 * 3. a model id configured in providers.json (passed in by the caller, which
 *    owns that file — see `secret-boundary.ts`);
 * 4. a Bitwarden CLI status/error line ({@link VAULT_CLI_MESSAGE_RE}).
 *
 * The length floor (`SECRET_HANDLE_MIN_VALUE_LENGTH`, 6) stays where it
 * was, in the boundary: it applies to the global replacement only, so a 4-digit
 * PIN the user-tier detector finds is still sealed into a handle. A length or
 * character-class rule here was considered and rejected — it would have lifted
 * the deliberate 6-character floor of review F5.
 *
 * Scope: this ONLY decides what the global redaction and the structural
 * detector skip. A handle that already exists keeps resolving (`resolveSecret`),
 * and the vault CLI still seals every `bw get password` output whole, so the
 * first read of a short vault password never reaches the model.
 */

/**
 * Words that show up as "secrets" only because a detector or a CLI status line
 * caught them: placeholders in docs and examples, CLI vocabulary, booleans.
 * Lower-case; compared against the lower-cased, trimmed value.
 */
export const TRIVIAL_SECRET_WORDS: ReadonlySet<string> = new Set([
  // placeholders / documentation
  'secret', 'secrets', 'password', 'passwords', 'passwort', 'passwoerter', 'passphrase',
  'changeme', 'change-me', 'changeit', 'placeholder', 'example', 'redacted', 'hidden',
  'your-password', 'yourpassword', 'mypassword', 'my-password', 'your_password',
  'password123', 'secret123', 'example-password', 'example-secret', 'dummy', 'testing',
  'username', 'user:password', 'token', 'apikey', 'api-key', 'api_key',
  // ordinary words that ended up in the store
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
 * Status and error lines of the Bitwarden CLI. A `bw unlock --raw` or
 * `bw get password` that fails prints one of these instead of a value, and
 * the vault boundary seals the whole output fail-closed — correct for that
 * one output, but as a known value the line then rewrote every later echo of
 * the same English sentence. A real session key or password never starts
 * like this.
 */
const VAULT_CLI_MESSAGE_RE = /^(?:\?\s*)?(?:your vault is|vault is (?:locked|unlocked)|you are (?:already )?(?:not )?logged|you are logged out|session key is invalid|not found\.?$|more than one result was found|syncing complete|logged in|saved setting|invalid master password|username or password is incorrect|master password|mac failed|mac comparison failed|you must (?:login|unlock)|unexpected token|error:|failed to)/i

const VAULT_CLI_MESSAGE_MAX_LENGTH = 120
/** A run that looks like a key, session token or hash. */
const TOKEN_RUN_RE = /[A-Za-z0-9+/=_-]{16,}/

/**
 * True when `value` must not be used for the global search-and-replace.
 *
 * Model ids from providers.json are passed in by the caller so this module
 * stays free of config I/O.
 */
export function isTrivialSecretValue(value: string, extraDenied?: ReadonlySet<string>): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  const lower = trimmed.toLowerCase()
  if (TRIVIAL_SECRET_WORDS.has(lower)) return true
  if (extraDenied && (extraDenied.has(trimmed) || extraDenied.has(lower))) return true
  // Only short prose: an error line that quotes a token or a long output is
  // kept as a secret (fail closed).
  if (trimmed.length <= VAULT_CLI_MESSAGE_MAX_LENGTH && !TOKEN_RUN_RE.test(trimmed) && VAULT_CLI_MESSAGE_RE.test(trimmed)) return true
  return PLACEHOLDER_RES.some(re => re.test(trimmed))
}
