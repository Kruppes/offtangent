/**
 * capture-guards.ts: the three gates a capture passes before it is filed.
 *
 * All three answer the same question from different angles: who is actually
 * talking, and does the text carry anything worth filing? They live here and
 * not in the captures service because they are pure decisions over text, a
 * source name and (for two of them) one small read of the database. That makes
 * them testable without an HTTP server, and it keeps the service the place
 * where state changes happen.
 *
 *  1. {@link explicitTargetVerdict}: who may name a strand by hand.
 *  2. {@link findDeviceAffinity}: where the previous capture of the same
 *     client went, offered to the router as a hint.
 *  3. {@link isFillerCapture}: a short capture that says nothing.
 *
 * Every incident these guards were written for is in the live database; the
 * doc comments name the row so the reasoning stays checkable.
 */
import type { Database } from './database.js'
import { loadHeuristics } from './heuristics.js'

/**
 * Sources that are a real user interface: a person is looking at a screen, has
 * a session, and picked the strand with a finger or a mouse.
 *
 * `web` is the default of `POST /api/captures` and the value the frontend
 * sends, `android` and `ios` are the companion apps. Everything else is a
 * program: a bench harness, a test, a device firmware, a background task.
 *
 * The list is code and not a setting on purpose. A configurable allowlist
 * would let exactly the caller that must not have the privilege hand itself
 * the privilege, and the whole point of the guard is that a client cannot
 * declare itself a user. Adding a surface is a code change and a review.
 */
export const USER_SURFACE_SOURCES = ['web', 'android', 'ios'] as const

/** True when the capture came from a surface a human was looking at. */
export function isUserSurfaceSource(source: string): boolean {
  return (USER_SURFACE_SOURCES as readonly string[]).includes(source.trim().toLowerCase())
}

/** Error code of a rejected explicit target, sent as 400 by the service. */
export const EXPLICIT_TARGET_FORBIDDEN = 'explicit_strand_not_allowed'

/**
 * Rationale of an explicit filing that a program, not a person, asked for.
 * Deliberately its own sentence, because the one it replaces was a false
 * statement: on 18 September a background task posted capture
 * `b008c981-a62c-4525-96dc-e5392541c596` (`source: 'bench'`) into a strand the
 * product owner was using at that moment, and the decision row claimed
 * `model: 'explicit'`, `confidence: 1.0`, `rationale: 'Strand chosen by the
 * user'`. No user had chosen anything. A decision row that lies about its own
 * origin cannot be audited, so the two cases now read differently and count
 * separately (`WHERE model = 'explicit-client'`).
 */
export const CLIENT_TARGET_RATIONALE = 'Strand created by this client'

/** Model value written for an explicit filing by a programmatic caller. */
export const CLIENT_TARGET_MODEL = 'explicit-client'

export type ExplicitTargetVerdict =
  /** A person picked the strand: the existing path, rationale unchanged. */
  | { kind: 'user' }
  /** A program picked a strand it created itself: allowed, honest rationale. */
  | { kind: 'client' }
  /** A program picked somebody else's strand: 400. */
  | { kind: 'forbidden'; code: typeof EXPLICIT_TARGET_FORBIDDEN; message: string }

/**
 * Did a capture from this very source open this strand? Then a later capture
 * from the same source may append to it: the client is writing into its own
 * conversation, not into the user's.
 *
 * The evidence is `router_decisions.created_strand_id`, the column the service
 * writes when a filing really created the strand. It is not a claim of the
 * caller, it is what the server did, which is the only kind of ownership worth
 * trusting here.
 */
export function clientCreatedStrand(db: Database, userId: string, source: string, strandId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM router_decisions d
       JOIN captures c ON c.id = d.capture_id
      WHERE d.created_strand_id = ? AND c.user_id = ? AND c.source = ?
      LIMIT 1`,
  ).get(strandId, userId, source)
  return !!row
}

/**
 * May this caller name the target strand itself (SPEC 4.1, "explicit beats
 * heuristic")?
 *
 * The rule the incident above forces: explicit targeting is a user gesture, so
 * it needs a user surface. A program keeps it only for a strand it created
 * itself; for anything else the answer is 400 and the caller has to go through
 * the router like every other capture, which is exactly the path that would
 * have kept the bench harness out of the product owner's strand.
 */
export function explicitTargetVerdict(
  db: Database,
  input: { userId: string; source: string; strandId: string },
): ExplicitTargetVerdict {
  if (isUserSurfaceSource(input.source)) return { kind: 'user' }
  if (clientCreatedStrand(db, input.userId, input.source, input.strandId)) return { kind: 'client' }
  return {
    kind: 'forbidden',
    code: EXPLICIT_TARGET_FORBIDDEN,
    message: `Source "${input.source}" may not target a strand it did not create; omit strandId and let the router decide`,
  }
}

/** What the router is told about the previous capture of the same client. */
export interface DeviceAffinityHint {
  /** Strand the previous capture of this source was filed into. */
  strandId: string
  /** The source both captures came from, echoed for the prompt. */
  source: string
  /** Age of that capture in whole minutes, rounded down. */
  ageMinutes: number
}

/**
 * Where did the previous capture from this client go?
 *
 * A Puck sends one utterance per capture. In the night of 17/18 September six
 * consecutive voice captures from the same device opened six strands, because
 * each of them was routed stone cold with no knowledge that the one a minute
 * earlier existed. A device conversation is one conversation, and the router
 * had no way to see it.
 *
 * This is a hint and nothing more. It is handed to the model with the
 * candidate it points at, and the model may ignore it, because the second
 * sentence someone speaks into a device can absolutely be a new subject. An
 * automatic append would trade six wrong strands for six wrong appends, and an
 * append into a foreign history is the more expensive mistake (SPEC 4.4).
 *
 * `windowMinutes` comes from `heuristics.captureGuards.deviceAffinityMinutes`;
 * 0 disables the hint entirely.
 */
export function findDeviceAffinity(
  db: Database,
  userId: string,
  input: { source: string; now?: Date; windowMinutes?: number; excludeCaptureId?: string },
): DeviceAffinityHint | null {
  const windowMinutes = input.windowMinutes ?? loadHeuristics().captureGuards.deviceAffinityMinutes
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return null
  const now = input.now ?? new Date()
  const since = new Date(now.getTime() - windowMinutes * 60_000).toISOString()

  // Only a capture that really landed somewhere can point at a strand, and
  // only a strand that is still open can take another one: an archived strand
  // as a hint would push the conversation back into a drawer the user closed.
  const row = db.prepare(
    `SELECT c.strand_id AS strandId, c.created_at AS createdAt
       FROM captures c
       JOIN sessions s ON s.id = c.strand_id
      WHERE c.user_id = ? AND c.source = ? AND c.strand_id IS NOT NULL
        AND c.id != ?
        AND c.status IN ('filed', 'needs_review', 'moved')
        AND s.archived = 0
        AND datetime(c.created_at) >= datetime(?)
      ORDER BY datetime(c.created_at) DESC, c.rowid DESC
      LIMIT 1`,
  ).get(userId, input.source, input.excludeCaptureId ?? '', since) as { strandId: string; createdAt: string } | undefined
  if (!row) return null

  // SQLite stores `created_at` as a naive UTC string; `Z` makes the parse
  // explicit instead of letting the host timezone decide.
  const stamp = row.createdAt.includes('T') ? row.createdAt : `${row.createdAt.replace(' ', 'T')}Z`
  const age = Math.max(0, now.getTime() - new Date(stamp).getTime())
  return { strandId: row.strandId, source: input.source, ageMinutes: Math.floor(age / 60_000) }
}

/**
 * Words that are pure social protocol: a thank you, a greeting, an
 * acknowledgement. At least one of them has to be in the text before it counts
 * as filler, which is what keeps the guard from firing on a sentence that is
 * merely built from short words.
 *
 * The list stays short and boring on purpose. Every word added here is a word
 * that can swallow a real thought, and a swallowed thought is invisible.
 */
const COURTESY_WORDS = new Set([
  // German
  'danke', 'dank', 'dankeschon', 'merci', 'bitte', 'gern', 'gerne',
  'hallo', 'hi', 'hey', 'moin', 'servus', 'tschuss', 'ciao',
  'klar', 'genau', 'stimmt', 'super', 'prima', 'perfekt', 'klasse',
  'mhm', 'hm', 'hmm', 'aha', 'achso', 'entschuldigung',
  // English
  'thanks', 'thank', 'thx', 'ty', 'cheers', 'welcome',
  'cool', 'nice', 'great', 'awesome', 'perfect', 'alright', 'sorry',
  'hello', 'bye', 'goodbye',
])

/**
 * Words that may stand next to a courtesy word without turning the text into a
 * statement: the "vielen" of "vielen Dank", the "very much" of "thank you very
 * much", the "alles" of "alles klar". On their own they say nothing either, so
 * a text made only of these is not filler, it is not a capture at all and the
 * courtesy condition above rejects it.
 */
const FILLER_GLUE = new Set([
  'vielen', 'herzlichen', 'besten', 'tausend', 'viel', 'sehr', 'schon', 'nochmal', 'noch',
  'dir', 'euch', 'ihnen', 'alles', 'das', 'es', 'ist', 'war', 'und', 'so', 'na', 'auch',
  'ja', 'ok', 'okay', 'gut', 'mal', 'dann', 'bis', 'wieder',
  'you', 'very', 'much', 'all', 'that', 'is', 'it', 'was', 'and', 'so', 'again', 'good',
  'yes', 'yeah', 'yep', 'sure', 'right', 'fine', 'then',
])

/**
 * Bare acknowledgements that must NOT be swallowed. A lone "ja" or "ok" is
 * social protocol in a vacuum, but in a device conversation it is the answer
 * to the question the persona just asked, and throwing away an answer is a
 * worse bug than filing a meaningless one. They reach the router, where the
 * affinity hint above puts them back into the conversation they belong to.
 */
const BARE_ANSWERS = new Set(['ja', 'nein', 'ok', 'okay', 'yes', 'no', 'yep', 'nope', 'doch', 'sure'])

/** Lowercase, strip accents and punctuation, collapse whitespace. */
function normaliseWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** Why a capture was put down without routing; stored on its decision. */
export const FILLER_GUARD_MARKER = 'filler guard: the capture carries no content'

/**
 * Is this capture pure courtesy?
 *
 * The incident: capture `ffd77c2b-4fe8-4be0-ac62-b13c4a537c6e`, the single
 * word "Vielen Dank." spoken into a Puck, was appended to an unrelated strand
 * with confidence 0.87. A model asked to place a thought will always place it
 * somewhere, and a thank you matches everything equally badly, so a high
 * confidence on such a text is meaningless by construction. The cheapest fix
 * is not to ask: a text without a single content word never reaches the
 * router, so it can neither be appended with authority nor open a strand.
 *
 * Three conditions, all of them narrow:
 *  - at most `maxChars` characters (`heuristics.captureGuards.fillerMaxChars`,
 *    0 disables the guard), because a long text always says something,
 *  - every word is courtesy or glue AND at least one is courtesy, so "danke
 *    fuer die Bremsbelaege" is a real capture,
 *  - it is not a bare answer (see {@link BARE_ANSWERS}).
 *
 * Whisper artefacts like `* Musik *` are NOT this guard's business: they are
 * caught one step earlier by `isSilenceTranscript`, which knows the bracket
 * shapes. This guard is about words a human really said.
 */
export function isFillerCapture(text: string, options: { maxChars?: number } = {}): boolean {
  const maxChars = options.maxChars ?? loadHeuristics().captureGuards.fillerMaxChars
  if (!Number.isFinite(maxChars) || maxChars <= 0) return false
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > maxChars) return false
  const words = normaliseWords(trimmed)
  if (words.length === 0) return false
  if (words.every(w => BARE_ANSWERS.has(w))) return false
  if (!words.some(w => COURTESY_WORDS.has(w))) return false
  return words.every(w => COURTESY_WORDS.has(w) || FILLER_GLUE.has(w))
}
