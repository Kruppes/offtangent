/**
 * Which known values may enter the global search-and-replace index of the
 * secret boundary (S0-A / A1, UX report 2026-10-23 § 6.3).
 *
 * The known-value index in `secret-boundary.ts` replaces every occurrence of a
 * stored value in every tool output, every message and the outgoing context.
 * That is only safe for values that cannot appear by accident. In October 2026
 * the index matched the project word `offtangent` and the boundary rewrote the
 * fence language of the interactive-block instructions in the system prompt
 * eight times — the model got the instruction to open a fence with a
 * placeholder instead of `offtangent`. (Which stored entry carried the word is
 * not recorded; the A2 telemetry makes such an entry visible next time.)
 *
 * Two filters, both only for the GLOBAL replacement. Resolving a value through
 * its handle (`resolveHandles`) is never affected, exactly like the minimum
 * length floor (F5):
 *
 * 1. **Allowlist** of project words and protocol terms that are part of the
 *    harness itself: the fence language, interaction-block kinds, board kinds,
 *    package names. Matched exactly against the whole value; a case variant
 *    stays a real value.
 * 2. **Entropy floor** (automatic origins only — a value the user filed on
 *    purpose stays redacted however weak, secret-triviality.test.ts): a value made of one or two distinct characters, or with
 *    a Shannon entropy below {@link MIN_VALUE_ENTROPY_BITS} bits per character
 *    (`00000000`, `--------`, `aaaaaaab`), matches separators, padding and
 *    zero runs everywhere and is never a credential worth that collateral.
 *
 * The decision is deliberately conservative: a real password that happens to
 * be on the allowlist (someone files `offtangent` as a password) is still
 * stored and still resolvable — it is only no longer scrubbed from every text.
 */

import { INTERACTION_BLOCK_KINDS, INTERACTION_FENCE_LANGUAGE } from './contracts/interaction-blocks.js'

/** Minimum Shannon entropy (bits per character) of a globally redacted value. */
export const MIN_VALUE_ENTROPY_BITS = 1.5

/** Minimum number of distinct characters of a globally redacted value. */
export const MIN_VALUE_DISTINCT_CHARS = 3

/** Text the `shell` tool returns for an empty, successful command. */
export const SHELL_EMPTY_OUTPUT_TEXT = '(no ' + 'output)'
/** Text the `shell` tool returns for an empty, failed command. */
export const SHELL_FAILED_OUTPUT_TEXT = 'Command ' + 'failed'

/**
 * Tool placeholders that are harness text, not output. Before S0-A the vault
 * CLI path sealed them as `vw-session-*` values whenever a command only
 * mentioned the CLI, and from then on the global index rewrote every empty
 * shell result into a handle.
 */
export const HARNESS_PLACEHOLDER_TEXTS: readonly string[] = [SHELL_EMPTY_OUTPUT_TEXT, SHELL_FAILED_OUTPUT_TEXT]

/**
 * Project words and protocol terms that are never redacted globally.
 *
 * Kept as literals instead of importing the board modules, so the secret
 * boundary does not pull the board/renderer stack into every import chain.
 * `secret-index-filter.test.ts` checks the literals against the exported
 * constants, so a renamed kind fails a test instead of silently falling out.
 */
const PROTOCOL_TERMS: readonly string[] = [
  ...HARNESS_PLACEHOLDER_TEXTS,
  // Product and package names (the fence language is added below from
  // contracts/interaction-blocks.ts).
  'offtangent',
  'axiom',
  '@axiom/core',
  '@axiom/web-backend',
  '@axiom/web-frontend',
  '@axiom/telegram',
  // Board kinds shipped with the core.
  'news_digest.v1',
  'news_digest.v2',
  'portfolio_digest.v1',
  'html_view.v1',
  // Secret-boundary vocabulary itself.
  'redacted',
  'vaultwarden',
]

export const SECRET_INDEX_ALLOWLIST: ReadonlySet<string> = new Set(
  [...PROTOCOL_TERMS, INTERACTION_FENCE_LANGUAGE, ...INTERACTION_BLOCK_KINDS],
)

/**
 * Host names from the configuration (`PUBLIC_BASE_URL`, `APP_URL`): they are
 * printed in links, logs and prompts and are never a credential. Read per call
 * so a test or a restart with another value is honoured.
 */
export function configuredHostTerms(env: NodeJS.ProcessEnv = process.env): string[] {
  const terms: string[] = []
  for (const name of ['PUBLIC_BASE_URL', 'APP_URL', 'BASE_URL']) {
    const raw = env[name]
    if (!raw) continue
    try {
      const host = new URL(raw).hostname.toLowerCase()
      if (host) terms.push(host, host.split('.')[0]!)
    } catch {
      // not a URL — ignore
    }
  }
  return terms
}

/** True when `value` is a project word, protocol term or configured host. */
export function isAllowlistedTerm(value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!value) return false
  // Exact match on purpose: the harness only ever writes these terms in this
  // spelling. A case variant (`OFFTANGENT` as a token in a secret file) or a
  // credential that merely contains the term is a real value and stays
  // redacted (secret-files.test.ts).
  return SECRET_INDEX_ALLOWLIST.has(value) || configuredHostTerms(env).includes(value)
}

/** Shannon entropy of `value` in bits per character. */
export function shannonEntropy(value: string): number {
  if (!value) return 0
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  const length = [...value].length
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

export type IndexSkipReason = 'too-short' | 'allowlisted' | 'low-entropy'

/**
 * Why `value` must stay out of the global index, or `null` when it may enter.
 * `minLength` is the floor of the value's source (6 for handles, 8 for env).
 */
export function indexSkipReason(
  value: string,
  minLength: number,
  opts: { entropyFloor?: boolean } = {},
): IndexSkipReason | null {
  if (!value || value.length < minLength) return 'too-short'
  if (isAllowlistedTerm(value)) return 'allowlisted'
  if (opts.entropyFloor === false) return null
  const distinct = new Set(value).size
  if (distinct < MIN_VALUE_DISTINCT_CHARS || shannonEntropy(value) < MIN_VALUE_ENTROPY_BITS) return 'low-entropy'
  return null
}
