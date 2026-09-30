/**
 * Deterministic secret detection — no LLM, no I/O.
 *
 * Privacy step 1 (plan 2026-09-26, decisions D1/D2): passwords, tokens, keys
 * and credentials must never reach a model. Detection runs as a pure function
 * over text so it can be used in front of storage, in front of the router and
 * on tool results without a network round trip and without side effects.
 *
 * Two rule tiers (D2):
 * - `strong`: only structured formats with a prefix/shape (GitHub, OpenAI,
 *   AWS, Slack, GitLab, Google, JWT, PEM, credentials in URLs, payment cards
 *   with Luhn). Safe everywhere, including code and logs.
 * - `user`: `strong` plus context rules ("Passwort ist X", "password: X",
 *   "PIN X"). Only for text a human typed or dictated, because these rules
 *   produce false positives in source code and log output.
 *
 * There is deliberately **no free entropy rule** (D2): it would swallow git
 * SHAs, UUIDs, sha256 digests, base64 blobs and npm integrity strings. An
 * IBAN is deliberately **not** a secret (D1) — it is personal data, and the
 * protection for personal data is the model choice, not redaction.
 */

/** Rule tier, see module docs. */
export type SecretTier = 'strong' | 'user'

/**
 * A detected secret occurrence in the input text.
 *
 * `start`/`end` are character offsets into the input, `end` exclusive, so
 * `text.slice(start, end)` is exactly the secret value that must be sealed.
 */
export interface SecretSpan {
  /** Stable rule identifier, e.g. `github-token` or `context-password`. */
  ruleId: string
  /** Secret class used for handle slugs, e.g. `github-token`. */
  kind: string
  /** Start offset (inclusive). */
  start: number
  /** End offset (exclusive). */
  end: number
}

export interface DetectSecretsOptions {
  tier: SecretTier
}

interface PatternRule {
  ruleId: string
  kind: string
  pattern: RegExp
  /**
   * Optional refinement. Returns the span to report (offsets relative to the
   * match start) or `null` to reject the match.
   */
  refine?: (match: RegExpExecArray) => { start: number; end: number } | null
}

/**
 * Structured token formats. Every rule needs a fixed prefix or a verifiable
 * structure — that is what keeps the false-positive rate at zero on the
 * negative corpus (see secret-corpus.fixture.ts).
 */
const STRONG_RULES: PatternRule[] = [
  {
    // ghp_/gho_/ghs_/ghu_ + 36+ chars (classic and installation tokens)
    ruleId: 'github-token',
    kind: 'github-token',
    pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,255}\b/g,
  },
  {
    // fine-grained PAT: github_pat_<22 chars>_<59 chars>
    ruleId: 'github-pat',
    kind: 'github-token',
    pattern: /\bgithub_pat_[A-Za-z0-9]{20,}_[A-Za-z0-9]{20,}\b/g,
  },
  {
    ruleId: 'anthropic-key',
    kind: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    // OpenAI style: sk-… and project keys sk-proj-…
    ruleId: 'openai-key',
    kind: 'openai-key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    ruleId: 'aws-access-key-id',
    kind: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    ruleId: 'slack-token',
    kind: 'slack-token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    ruleId: 'gitlab-pat',
    kind: 'gitlab-token',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g,
  },
  {
    ruleId: 'google-api-key',
    kind: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    ruleId: 'jwt',
    kind: 'jwt',
    // Three base64url segments; the header must decode to a JSON object with
    // an `alg` field (checked in refine). Anchoring on `eyJ` keeps the scan
    // cheap: a JWT header always starts with `{"`.
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}/g,
    refine: (match) => (isJwt(match[0]) ? { start: 0, end: match[0].length } : null),
  },
  {
    ruleId: 'private-key-block',
    kind: 'private-key',
    // PEM private key block, including the BEGIN/END lines.
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    ruleId: 'url-credentials',
    kind: 'url-password',
    // scheme://user:password@host — only the password is sealed, so the URL
    // stays readable and the user name is not destroyed.
    pattern: /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/:@]{1,128}:([^\s/:@]{1,256})@/g,
    refine: (match) => {
      const password = match[1]
      if (!password) return null
      const offset = match[0].lastIndexOf('@' + '')
      const start = offset - password.length
      return { start, end: offset }
    },
  },
  {
    ruleId: 'payment-card',
    kind: 'card-number',
    // Digit groups with optional single space/dash separators. Length, brand
    // prefix and Luhn are all verified in refine, so IBANs, phone numbers,
    // epoch millis and order ids do not match.
    pattern: /(?<![0-9A-Za-z])(?:\d[ -]?){12,21}\d(?![0-9A-Za-z])/g,
    refine: (match) => (isPaymentCard(match[0]) ? { start: 0, end: match[0].length } : null),
  },
]

/** Base64url decode without throwing. */
function decodeBase64Url(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/** A JWT is only a JWT when its header really is `{"alg": …}`. */
function isJwt(candidate: string): boolean {
  const parts = candidate.split('.')
  if (parts.length !== 3) return false
  const header = decodeBase64Url(parts[0])
  if (!header || !header.startsWith('{')) return false
  try {
    const parsed = JSON.parse(header) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const alg = (parsed as Record<string, unknown>).alg
    return typeof alg === 'string' && alg.length > 0
  } catch {
    return false
  }
}

/** Luhn checksum over a digit string. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Brand prefixes with the card number lengths they actually use. A candidate
 * must match one of these *and* pass Luhn to count as a card number.
 */
const CARD_BRANDS: Array<{ prefix: RegExp; lengths: number[] }> = [
  // Visa: 13-digit legacy cards are deliberately NOT accepted — a 13-digit
  // run starting with 4 is far more often a phone number ("+49 151 …") or an
  // order id, and the false positives would be worse than the miss.
  { prefix: /^4/, lengths: [16, 19] }, // Visa
  { prefix: /^5[1-5]/, lengths: [16] }, // Mastercard
  { prefix: /^2[2-7]/, lengths: [16] }, // Mastercard 2-series
  { prefix: /^3[47]/, lengths: [15] }, // American Express
  { prefix: /^3(?:0[0-5]|[689])/, lengths: [14, 16, 19] }, // Diners / JCB-ish
  { prefix: /^6(?:011|5|4[4-9]|22)/, lengths: [16, 19] }, // Discover / UnionPay
]

/**
 * Separators must look like a printed card number: either none at all, or a
 * single separator kind splitting the digits into 4-4-4-4(-xxx) groups (Amex
 * 4-6-5). Anything else — "+49 151 2345678", "DE89 3704 0044 0532 0130 00",
 * "2026-09-26" — is rejected before Luhn ever runs.
 */
function hasCardGrouping(candidate: string): boolean {
  if (!/[ -]/.test(candidate)) return true
  if (/ /.test(candidate) && /-/.test(candidate)) return false
  const groups = candidate.split(/[ -]/)
  const sizes = groups.map(g => g.length)
  const allFour = sizes.every(s => s === 4)
  const amex = sizes.length === 3 && sizes[0] === 4 && sizes[1] === 6 && sizes[2] === 5
  return allFour || amex
}

function isPaymentCard(candidate: string): boolean {
  if (!hasCardGrouping(candidate)) return false
  const digits = candidate.replace(/[ -]/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  const brand = CARD_BRANDS.find(b => b.prefix.test(digits))
  if (!brand || !brand.lengths.includes(digits.length)) return false
  return passesLuhn(digits)
}

/**
 * Context rules for user input (tier `user`).
 *
 * Shape: a label ("Passwort", "password", "PIN", "Token", "API-Key", …), an
 * optional separator (":", "=", "ist", "lautet", "is") and the value as the
 * next non-space token. The value must look like a credential (see
 * {@link looksLikeCredential}) unless it is quoted, otherwise German and
 * English prose like "Das Passwort ist abgelaufen" would be sealed.
 */
interface ContextRule {
  ruleId: string
  kind: string
  /** Label alternatives, matched case-insensitively. */
  label: string
  /** Minimum value length. */
  minLength: number
  /** Value must be 4–12 digits (PIN). */
  digitsOnly?: boolean
  /**
   * Accept a bare space as separator ("pw Nordwind-42", "PIN 4711").
   * Only for labels where that phrasing is idiomatic; the value guards
   * (stopwords, {@link looksLikeCredential}, length) carry the precision.
   */
  spaceSeparator?: boolean
}

const CONTEXT_RULES: ContextRule[] = [
  { ruleId: 'context-pin', kind: 'pin', label: '(?:pin|geheimzahl)(?:[ -]?code)?', minLength: 4, digitsOnly: true, spaceSeparator: true },
  {
    ruleId: 'context-password',
    kind: 'password',
    label: '(?:passwor[dt]|kennwort|passphrase|pass[ -]?phrase|passwd|pwd|pw)',
    minLength: 6,
    spaceSeparator: true,
  },
  {
    ruleId: 'context-token',
    kind: 'token',
    label: '(?:api[ _-]?key|api[ _-]?schl(?:ü|ue)ssel|access[ _-]?token|auth[ _-]?token|token|secret|client[ _-]?secret|geheimnis)',
    minLength: 8,
  },
]

/**
 * Words that frequently follow a credential label in prose. They are never a
 * value, so rejecting them removes the most common false positives without
 * needing a dictionary.
 */
const CONTEXT_STOPWORDS = new Set([
  'abgelaufen', 'ändern', 'aendern', 'geändert', 'geaendert', 'vergessen', 'falsch', 'richtig',
  'korrekt', 'sicher', 'geheim', 'unbekannt', 'leer', 'gesetzt', 'nicht', 'kein', 'keine',
  'notwendig', 'erforderlich', 'ungültig', 'ungueltig', 'gespeichert', 'bekannt', 'zurücksetzen',
  'zuruecksetzen', 'eingeben', 'benötigt', 'benoetigt', 'fehlt', 'fehlerhaft', 'verloren',
  'expired', 'invalid', 'wrong', 'correct', 'missing', 'empty', 'unset', 'required', 'changed',
  'rotated', 'revoked', 'forgotten', 'reset', 'stored', 'unknown', 'null', 'undefined', 'none',
  'true', 'false', 'yes', 'no', 'todo', 'tbd', 'redacted', 'hidden',
])

/**
 * Heuristic that separates a credential from a prose word: a credential has a
 * digit, a symbol, or mixed case. Lower-case pure-letter words are treated as
 * prose. Quoted values skip this check.
 */
/**
 * Values that are visibly *not* the secret: masked output (`****`),
 * placeholders (`<redacted>`, `…`), variable references (`$PASSWORD`,
 * `${DB_PASSWORD}`, `process.env.X`) and handles that are already sealed.
 */
/**
 * A `{{secret:<slug>}}` handle, whole or with the braces already trimmed off
 * (`secret:slug`, `{{secret:slug`). A handle is OUTPUT of the secret boundary,
 * so no tier may ever read one back as a value — not even after
 * {@link trimValue} removed the braces (F10, report Integration 2, point 1).
 */
const HANDLE_VALUE_RE = /^\{{0,2}secret:[a-z0-9][a-z0-9-]{0,63}\}{0,2}$/

function isPlaceholderValue(value: string): boolean {
  if (/^[*•x×.\-_?#•…]+$/i.test(value)) return true
  if (/^<[^>]*>$/.test(value)) return true
  if (/^\[[^\]]*\]$/.test(value)) return true
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return true
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(value)) return true
  if (/^(?:process\.env|os\.environ|env)[.[]/i.test(value)) return true
  if (HANDLE_VALUE_RE.test(value)) return true
  return false
}

function looksLikeCredential(value: string): boolean {
  if (/\d/.test(value)) return true
  if (/[^\p{L}\p{N}]/u.test(value)) return true
  if (/\p{Lu}/u.test(value) && /\p{Ll}/u.test(value)) return true
  return false
}

const CONTEXT_SEPARATOR = '(?:\\s*(?::|=|=>|->)\\s*|\\s+(?:ist|lautet|war|is|was|equals)\\s+(?:jetzt\\s+|now\\s+)?)'
const CONTEXT_SEPARATOR_SPACE = '(?:\\s*(?::|=|=>|->)\\s*|\\s+(?:ist|lautet|war|is|was|equals)\\s+(?:jetzt\\s+|now\\s+)?|\\s+)'
const VALUE_TOKEN = '(?:"([^"\\n]{1,256})"|\'([^\'\\n]{1,256})\'|`([^`\\n]{1,256})`|(\\S{1,256}))'

const CONTEXT_PATTERNS: Array<{ rule: ContextRule; pattern: RegExp }> = CONTEXT_RULES.map(rule => ({
  rule,
  pattern: new RegExp(
    `(?<![\\p{L}\\p{N}])${rule.label}${rule.spaceSeparator ? CONTEXT_SEPARATOR_SPACE : CONTEXT_SEPARATOR}${VALUE_TOKEN}`,
    'giu',
  ),
}))

/** Trailing punctuation that belongs to the sentence, not to the value. */
function trimValue(raw: string): { value: string; offset: number } {
  let value = raw
  let offset = 0
  // A handle is never trimmed: cutting `{{`/`}}` off turns it into the bare
  // slug, and the placeholder check would no longer recognise it (F10).
  if (raw.includes('{{secret:')) return { value: raw, offset: 0 }
  const lead = /^[([{<]+/.exec(value)
  if (lead) {
    offset += lead[0].length
    value = value.slice(lead[0].length)
  }
  // `!` and `?` stay part of the value: they are common password characters,
  // and a sentence that ends right after a password is rarer than a password
  // ending in `!`. `.` and `,` are the other way round.
  const trail = /[.,;:)\]}>'"`]+$/.exec(value)
  if (trail) value = value.slice(0, value.length - trail[0].length)
  return { value, offset }
}

function detectContext(text: string): SecretSpan[] {
  const spans: SecretSpan[] = []
  for (const { rule, pattern } of CONTEXT_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex++
        continue
      }
      const quoted = match[1] ?? match[2] ?? match[3]
      const bare = match[4]
      const raw = quoted ?? bare
      if (!raw) continue
      // Check the untrimmed token first: `{{secret:x}}` and `<redacted>` must
      // not survive trimming into something that looks like a value.
      if (isPlaceholderValue(raw)) continue
      const rawIndex = match.index + match[0].lastIndexOf(raw)
      let value = raw
      let start = rawIndex
      if (quoted === undefined) {
        const trimmed = trimValue(raw)
        value = trimmed.value
        start = rawIndex + trimmed.offset
      }
      if (!value) continue
      if (isPlaceholderValue(value)) continue
      if (rule.digitsOnly) {
        if (!/^\d{4,12}$/.test(value)) continue
      } else {
        if (value.length < rule.minLength) continue
        if (CONTEXT_STOPWORDS.has(value.toLowerCase())) continue
        if (quoted === undefined && !looksLikeCredential(value)) continue
        // A bare word that is a plain sentence continuation ("Passwort ist
        // Nicht-Gesetzt") stays prose; quoted values are always taken.
      }
      spans.push({ ruleId: rule.ruleId, kind: rule.kind, start, end: start + value.length })
    }
  }
  return spans
}

function detectPatterns(text: string): SecretSpan[] {
  const spans: SecretSpan[] = []
  for (const rule of STRONG_RULES) {
    rule.pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = rule.pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        rule.pattern.lastIndex++
        continue
      }
      const refined = rule.refine ? rule.refine(match) : { start: 0, end: match[0].length }
      if (!refined) continue
      const start = match.index + refined.start
      const end = match.index + refined.end
      if (end <= start) continue
      spans.push({ ruleId: rule.ruleId, kind: rule.kind, start, end })
    }
  }
  return spans
}

/**
 * Drop overlapping spans: the longest match wins, ties go to the earlier
 * start. Keeps the output deterministic and non-overlapping so callers can
 * replace spans back to front.
 */
function dedupeSpans(spans: SecretSpan[]): SecretSpan[] {
  const sorted = [...spans].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    const lenDiff = (b.end - b.start) - (a.end - a.start)
    if (lenDiff !== 0) return lenDiff
    return a.ruleId.localeCompare(b.ruleId)
  })
  const result: SecretSpan[] = []
  for (const span of sorted) {
    const overlaps = result.some(kept => span.start < kept.end && kept.start < span.end)
    if (!overlaps) result.push(span)
  }
  return result.sort((a, b) => a.start - b.start)
}

/**
 * Find secrets in `text`.
 *
 * Pure function: no I/O, no state, deterministic. Spans never overlap and are
 * ordered by `start`.
 */
export function detectSecrets(text: string, options: DetectSecretsOptions): SecretSpan[] {
  if (!text) return []
  const spans = detectPatterns(text)
  if (options.tier === 'user') spans.push(...detectContext(text))
  return dedupeSpans(spans).filter(span => !overlapsHandle(text, span))
}

/**
 * True when a span reaches into a `{{secret:<slug>}}` handle.
 *
 * The label of a context rule can sit INSIDE a handle (`secret:` of the handle
 * itself, or the `token` in a slug such as `github-token-1`), so the value the
 * rule reads is a piece of the slug. `sealText` already masks handles before
 * detecting; this makes a direct `detectSecrets` call behave the same way
 * (F10).
 */
function overlapsHandle(text: string, span: SecretSpan): boolean {
  if (!text.includes('{{secret:')) return false
  HANDLE_SPAN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HANDLE_SPAN_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (span.start < end && span.end > start) return true
  }
  return false
}

/** Handle pattern used by {@link overlapsHandle}; mirrors `SECRET_HANDLE_RE`. */
const HANDLE_SPAN_RE = /\{\{secret:[a-z0-9][a-z0-9-]{0,63}\}\}/g

/** Rule ids of the `strong` tier, for documentation and tests. */
export const STRONG_RULE_IDS: readonly string[] = STRONG_RULES.map(r => r.ruleId)
/** Rule ids of the additional `user` tier context rules. */
export const CONTEXT_RULE_IDS: readonly string[] = CONTEXT_RULES.map(r => r.ruleId)
