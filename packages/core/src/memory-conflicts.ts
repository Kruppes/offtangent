/**
 * Deterministic contradiction detection between facts that sit on the same
 * memory node (SPEC 6.4). No model call, no randomness: the same input set
 * always produces the same conflict pairs, which is what makes this unit
 * testable and safe to cache.
 *
 * Three rules, applied in this order per unordered pair (a.id < b.id):
 *
 *   1. `same_subject_key` - both facts are active and carry the same
 *      `supersession_key`. The write path (SPEC 11.4) retires the previous
 *      fact for a key, so two active rows on one key are a real contradiction.
 *   2. `negation` - the contents agree on their significant tokens but exactly
 *      one of them is negated.
 *   3. `value_mismatch` - the contents agree on their non-numeric tokens but
 *      state different numbers.
 *
 * The first matching rule wins, so every pair has exactly one reason.
 */

export type ConflictReason = 'same_subject_key' | 'negation' | 'value_mismatch'

export interface ConflictCandidate {
  id: number
  content: string
  status: 'active' | 'superseded'
  supersessionKey: string | null
}

export interface ConflictLink {
  id: number
  reason: ConflictReason
}

export interface DetectConflictsOptions {
  /**
   * Upper bound on how many facts are compared inside one node. The check is
   * quadratic, so an unbounded bucket (for example the "unassigned" node of a
   * large instance) would dominate the index build. Facts are expected to be
   * pre-sorted by relevance (newest first); everything past the window is
   * reported without conflicts.
   */
  maxScan?: number
  /** Minimum token overlap for rules 2 and 3. */
  minSimilarity?: number
}

export const CONFLICT_SCAN_MAX = 150
const MIN_SIMILARITY = 0.6
const MIN_SHARED_TOKENS = 2
const MIN_TOKEN_LENGTH = 3

/**
 * Negation markers. German entries are intentional: the stored facts of a
 * running instance are written in the language the owner speaks, so an
 * English-only marker list would silently detect nothing.
 */
const NEGATION_TOKENS = new Set([
  'no', 'not', 'never', 'none', 'without', 'nothing', 'cannot',
  'nicht', 'kein', 'keine', 'keinen', 'keiner', 'keinem', 'nie', 'niemals', 'ohne',
])

const NEGATION_PHRASES = [
  'no longer', 'not any more', 'is not', 'does not', 'did not', 'will not',
  'nicht mehr', 'kein mehr',
]

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'from', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'does', 'did', 'will', 'would',
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'und', 'oder', 'aber', 'fuer', 'mit', 'von', 'vom', 'dass', 'ist', 'sind', 'war', 'waren',
  'wird', 'wurde', 'hat', 'haben', 'hatte', 'auf', 'nach', 'bei', 'als', 'auch', 'sich', 'wie',
])

function foldDiacritics(text: string): string {
  return text
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
}

export function normalizeForConflicts(content: string): string {
  return foldDiacritics(content.toLowerCase()).replace(/[^\p{L}\p{N}.,:/-]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

function isNegated(normalized: string): boolean {
  if (NEGATION_PHRASES.some(phrase => normalized.includes(phrase))) return true
  return normalized.split(' ').some(token => NEGATION_TOKENS.has(token))
}

interface TokenizedFact {
  fact: ConflictCandidate
  normalized: string
  negated: boolean
  /** Significant word tokens without negation markers and without numbers. */
  words: Set<string>
  /** Numeric tokens (bare numbers, versions, dates, amounts). */
  numbers: Set<string>
}

function stripTrailingPunctuation(token: string): string {
  return token.replace(/^[.,:/-]+/, '').replace(/[.,:/-]+$/, '')
}

function tokenize(fact: ConflictCandidate): TokenizedFact {
  const normalized = normalizeForConflicts(fact.content)
  const words = new Set<string>()
  const numbers = new Set<string>()

  for (const raw of normalized.split(' ')) {
    const token = stripTrailingPunctuation(raw)
    if (!token) continue
    if (/\d/.test(token)) {
      numbers.add(token)
      continue
    }
    if (token.length < MIN_TOKEN_LENGTH) continue
    if (STOPWORDS.has(token)) continue
    if (NEGATION_TOKENS.has(token)) continue
    words.add(token)
  }

  return { fact, normalized, negated: isNegated(normalized), words, numbers }
}

function similarity(a: Set<string>, b: Set<string>): { jaccard: number; shared: number } {
  if (a.size === 0 || b.size === 0) return { jaccard: 0, shared: 0 }
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const token of small) {
    if (large.has(token)) shared += 1
  }
  const union = a.size + b.size - shared
  return { jaccard: union === 0 ? 0 : shared / union, shared }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

function reasonFor(a: TokenizedFact, b: TokenizedFact, minSimilarity: number): ConflictReason | null {
  if (
    a.fact.supersessionKey
    && a.fact.supersessionKey === b.fact.supersessionKey
    && a.fact.status === 'active'
    && b.fact.status === 'active'
  ) {
    return 'same_subject_key'
  }

  const overlap = similarity(a.words, b.words)
  if (overlap.shared < MIN_SHARED_TOKENS || overlap.jaccard < minSimilarity) return null

  if (a.negated !== b.negated) return 'negation'
  if ((a.numbers.size > 0 || b.numbers.size > 0) && !setsEqual(a.numbers, b.numbers)) return 'value_mismatch'
  return null
}

/**
 * Returns conflict links keyed by fact id. Both directions of a pair are
 * present, each list sorted by fact id so the output is stable.
 */
export function detectFactConflicts(
  facts: readonly ConflictCandidate[],
  options: DetectConflictsOptions = {},
): Map<number, ConflictLink[]> {
  const maxScan = Math.max(0, options.maxScan ?? CONFLICT_SCAN_MAX)
  const minSimilarity = options.minSimilarity ?? MIN_SIMILARITY
  const scanned = facts.slice(0, maxScan).map(tokenize)
  const links = new Map<number, ConflictLink[]>()

  const push = (id: number, link: ConflictLink): void => {
    const list = links.get(id)
    if (list) list.push(link)
    else links.set(id, [link])
  }

  for (let i = 0; i < scanned.length; i += 1) {
    for (let j = i + 1; j < scanned.length; j += 1) {
      const [a, b] = scanned[i].fact.id <= scanned[j].fact.id
        ? [scanned[i], scanned[j]]
        : [scanned[j], scanned[i]]
      const reason = reasonFor(a, b, minSimilarity)
      if (!reason) continue
      push(a.fact.id, { id: b.fact.id, reason })
      push(b.fact.id, { id: a.fact.id, reason })
    }
  }

  for (const list of links.values()) {
    list.sort((x, y) => x.id - y.id)
  }

  return links
}
