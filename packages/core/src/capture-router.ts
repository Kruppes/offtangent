/**
 * capture-router.ts: the router (SPEC 4). It runs for exactly one situation,
 * a capture that arrives without a strand, and produces a filing proposal:
 * append to a strand, open a new one, or append and link two strands.
 *
 * The prompt is assembled server side (4.2), the answer must be one JSON
 * object (4.3), a malformed answer gets one repair retry, and every failure
 * degrades to a synthetic low confidence decision so the capture is never
 * blocked. Confidence bands (4.4) are decided here, applying them is the
 * job of the capture service.
 */
import type { Database } from './database.js'
import { completeSimple } from './pi-models.js'
import { resolveBackgroundReasoning } from './thinking-level.js'
import { getLatestSessionSummary } from './session-summary-store.js'
import { renderSummaryMarkdown } from './session-summary-schema.js'
import { getNowSet, getStrandTags, listTags } from './strand-store.js'
import type { DecisionAlternative, ProjectSuggestion, RouterAction, RouterIntent } from './strand-store.js'
import { buildRouterModel, resolveRouterChain } from './router-model.js'
import type { ResolvedRouterModel } from './router-model.js'
import { deriveStrandTitle } from './strand-title.js'

export const ROUTER_CANDIDATE_CAP = 25
export const ROUTER_RECENT_STRANDS = 20
export const ROUTER_TAIL_LINES = 2
export const ROUTER_SUMMARY_CHARS = 240
/** Hard cap for the content excerpt of a candidate, token budget over detail. */
export const ROUTER_LAST_MESSAGE_CHARS = 160
export const ROUTER_TITLE_MAX = 60
export const CONFIDENCE_HIGH = 0.7
export const CONFIDENCE_MEDIUM = 0.4
/**
 * Active projects offered to the router, stable order, prompt cache friendly
 * (SPEC 4.2b). The cap exists to bound the prompt, not to curate: a truncated
 * alphabetical list silently hides the busiest containers (the first real
 * account crossed 20 within a day and lost the last names in the alphabet),
 * and a project the router cannot see is a project that never gets used.
 * A name costs a few tokens, so the ceiling is generous on purpose.
 */
export const ROUTER_PROJECT_CAP = 40
/**
 * A project suggestion for an existing strand is a proposal the product owner
 * taps, so it has to be worth a tap. Below this it is dropped instead of
 * stored: an unsure hint that is never applied is only noise (SPEC 4.2b).
 */
export const PROJECT_SUGGESTION_MIN_CONFIDENCE = 0.55
/**
 * Marker written into the rationale (and the notes) when the guard below
 * turned a low confidence `append`/`link` into a new strand. It keeps the
 * `router_decisions` row honest: the stored action is what happened, this
 * sentence plus the first alternative say what the model actually proposed.
 */
export const LOW_CONFIDENCE_APPEND_MARKER = 'router guard: append below the high band'

export type ConfidenceBand = 'high' | 'medium' | 'low'

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= CONFIDENCE_HIGH) return 'high'
  if (confidence >= CONFIDENCE_MEDIUM) return 'medium'
  return 'low'
}

export interface RouterCandidate {
  strandId: string
  title: string | null
  personaId: string
  /** Project the strand already belongs to, null when it is unassigned. */
  projectId: string | null
  /** Name of that project, null when unassigned or when the project is gone. */
  projectName: string | null
  tags: string[]
  lastActivity: string
  summary: string
  tail: string[]
  /** Last user message of the strand, collapsed and hard capped. Evidence. */
  lastMessage: string
}

/** One entry of the project list handed to the router (id and name only). */
export interface RouterProject {
  id: string
  name: string
}

export interface RouterCaptureInput {
  id: string
  text: string
  kind: string
  personaHint: string | null
  createdAt: string
}

/**
 * The strand the previous capture of the same client went into (SPEC 4.2,
 * device affinity). A hint, never an instruction: see
 * {@link findDeviceAffinity} for why an automatic append would be the more
 * expensive mistake.
 */
export interface RouterDeviceHint {
  strandId: string
  source: string
  ageMinutes: number
}

export interface RouterInput {
  capture: RouterCaptureInput
  candidates: RouterCandidate[]
  /** Active projects of the user, stable order, at most {@link ROUTER_PROJECT_CAP}. */
  projects: RouterProject[]
  nowSet: string[]
  knownTags: string[]
  personas: string[]
  defaultPersona: string
  now: string
  /**
   * Continuation hint of a device conversation, absent when the capture is the
   * first one of its client within the window.
   */
  deviceHint?: RouterDeviceHint | null
}

export interface RouterProposal {
  action: RouterAction
  strandId: string | null
  secondaryStrandId: string | null
  newStrand: { title: string; personaId: string; tags: string[]; projectId: string | null } | null
  intent: RouterIntent
  confidence: number
  tags: string[]
  rationale: string
  alternatives: DecisionAlternative[]
  /**
   * Project proposed for an EXISTING strand that has none yet. Never applied
   * by the server, only stored and delivered with the decision (SPEC 4.2b).
   */
  projectSuggestion: ProjectSuggestion | null
}

export interface RouterResult {
  proposal: RouterProposal
  /** `providerId:modelId` that produced the proposal, `synthetic` when none did. */
  model: string
  latencyMs: number
  /** Non fatal problems on the way (skipped chain entries, repair retries). */
  notes: string[]
}

const COMMON_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'das', 'der', 'die', 'ein', 'eine', 'einer', 'einem', 'einen',
  'for', 'from', 'i', 'ich', 'in', 'is', 'it', 'mit', 'of', 'on', 'or', 'the', 'to', 'und', 'with', 'was', 'wir',
  'hat', 'ist', 'nicht', 'auch', 'noch', 'dass', 'this', 'that', 'have', 'has', 'you', 'your', 'mal', 'bitte',
])

/**
 * The project list of an input. Read through this everywhere: the router must
 * degrade, never throw, and a caller built against the pre project shape of
 * `RouterInput` simply has no projects.
 */
function activeProjects(input: RouterInput): RouterProject[] {
  return Array.isArray(input.projects) ? input.projects : []
}

/** Keywords of a capture for the tag match step of the candidate selection. */
export function captureKeywords(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(w => w.length >= 3 && !COMMON_WORDS.has(w))
  return Array.from(new Set(words)).slice(0, 24)
}

function toIso(value: string): string {
  const normalized = value.includes('Z') || value.includes('+') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

interface StrandRow {
  id: string
  agent_id: string | null
  title: string | null
  project_id: string | null
  started_at: string
  last_activity: string | null
}

function summaryOf(db: Database, strandId: string): string {
  const latest = getLatestSessionSummary(db, strandId)
  if (!latest) return ''
  const text = renderSummaryMarkdown(latest.summary).replace(/\s+/g, ' ').trim()
  return text.length > ROUTER_SUMMARY_CHARS ? `${text.slice(0, ROUTER_SUMMARY_CHARS - 1)}…` : text
}

function tailOf(db: Database, strandId: string): string[] {
  const rows = db.prepare(
    `SELECT role, content FROM chat_messages WHERE session_id = ? AND role IN ('user','assistant')
     ORDER BY id DESC LIMIT ?`,
  ).all(strandId, ROUTER_TAIL_LINES) as { role: string; content: string }[]
  return rows.reverse().map(r => {
    const line = r.content.replace(/\s+/g, ' ').trim()
    return `${r.role}: ${line.length > 160 ? `${line.slice(0, 159)}…` : line}`
  })
}

function lastUserMessageOf(db: Database, strandId: string): string {
  const row = db.prepare(
    `SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
  ).get(strandId) as { content: string } | undefined
  const line = (row?.content ?? '').replace(/\s+/g, ' ').trim()
  if (!line) return ''
  return line.length > ROUTER_LAST_MESSAGE_CHARS ? `${line.slice(0, ROUTER_LAST_MESSAGE_CHARS - 1)}…` : line
}

function toCandidate(db: Database, row: StrandRow, projectNames: Map<string, string>): RouterCandidate {
  const projectId = row.project_id ?? null
  return {
    strandId: row.id,
    title: row.title ?? null,
    personaId: row.agent_id ?? 'main',
    projectId,
    projectName: projectId ? projectNames.get(projectId) ?? null : null,
    tags: getStrandTags(db, row.id),
    lastActivity: toIso(row.last_activity ?? row.started_at),
    summary: summaryOf(db, row.id),
    tail: tailOf(db, row.id),
    lastMessage: lastUserMessageOf(db, row.id),
  }
}

/**
 * Does this strand tell the router anything at all? A strand without a title,
 * without tags and without a project is a blank row in the prompt: the model
 * cannot match against it, it can only guess, and a guess that lands is a
 * capture buried in a foreign history. Blank strands are therefore not offered
 * as candidates (the now set is exempt, that is an explicit user choice).
 */
function hasSubstance(db: Database, row: StrandRow): boolean {
  if ((row.title ?? '').trim() !== '') return true
  if (row.project_id) return true
  return getStrandTags(db, row.id).length > 0
}

const STRAND_COLUMNS = 'id, agent_id, title, project_id, started_at, last_activity'
const OWNER = '(session_user = ? OR CAST(user_id AS TEXT) = ?)'

/**
 * Active projects of one user for the router prompt (SPEC 4.2b): same stable
 * order as `/api/projects` (name, then id), capped at
 * {@link ROUTER_PROJECT_CAP}. Archived projects are left out; the router must
 * not file into a container the product owner has put away.
 */
export function listRouterProjects(db: Database, userId: string): RouterProject[] {
  return db.prepare(
    `SELECT id, name FROM projects WHERE user_id = ? AND archived = 0
     ORDER BY name COLLATE NOCASE ASC, id ASC LIMIT ?`,
  ).all(userId, ROUTER_PROJECT_CAP) as RouterProject[]
}

/** Names of ALL projects of a user, archived included, to label candidates. */
function projectNameMap(db: Database, userId: string): Map<string, string> {
  const rows = db.prepare('SELECT id, name FROM projects WHERE user_id = ?').all(userId) as RouterProject[]
  return new Map(rows.map(r => [r.id, r.name]))
}

/**
 * Deterministic candidate selection (SPEC 4.2): now set first, then the 20
 * most recently active non archived strands, then strands whose tags match a
 * keyword of the capture. Hard cap of 25. Everything outside the now set must
 * carry substance (see {@link hasSubstance}).
 */
export function selectCandidates(
  db: Database,
  userId: string,
  captureText: string,
  options: { pinnedStrandId?: string | null } = {},
): RouterCandidate[] {
  const picked = new Map<string, StrandRow>()
  const push = (row: StrandRow | undefined, requireSubstance = true) => {
    if (!row || picked.has(row.id) || picked.size >= ROUTER_CANDIDATE_CAP) return
    if (requireSubstance && !hasSubstance(db, row)) return
    picked.set(row.id, row)
  }
  const byId = db.prepare(
    `SELECT ${STRAND_COLUMNS} FROM sessions WHERE id = ? AND type = 'interactive' AND archived = 0 AND ${OWNER}`,
  )
  // The device hint first and exempt from the substance rule: a strand a
  // device conversation opened a minute ago usually has neither tags nor a
  // title yet, and dropping it would leave the hint pointing at a candidate
  // the model cannot see. Same exemption as the now set, same reason.
  if (options.pinnedStrandId) push(byId.get(options.pinnedStrandId, userId, userId) as StrandRow | undefined, false)
  for (const id of getNowSet(db, userId)) push(byId.get(id, userId, userId) as StrandRow | undefined, false)

  const recent = db.prepare(
    `SELECT ${STRAND_COLUMNS} FROM sessions
     WHERE type = 'interactive' AND archived = 0 AND ${OWNER}
     ORDER BY COALESCE(last_activity, started_at) DESC LIMIT ?`,
  ).all(userId, userId, ROUTER_RECENT_STRANDS) as StrandRow[]
  for (const row of recent) push(row)

  const keywords = captureKeywords(captureText)
  if (keywords.length > 0 && picked.size < ROUTER_CANDIDATE_CAP) {
    const placeholders = keywords.map(() => '?').join(', ')
    const tagged = db.prepare(
      `SELECT DISTINCT s.id, s.agent_id, s.title, s.project_id, s.started_at, s.last_activity
       FROM sessions s
       JOIN strand_tags st ON st.strand_id = s.id
       JOIN tags t ON t.id = st.tag_id
       WHERE s.type = 'interactive' AND s.archived = 0 AND (s.session_user = ? OR CAST(s.user_id AS TEXT) = ?)
         AND t.user_id = ? AND t.name IN (${placeholders})
       ORDER BY COALESCE(s.last_activity, s.started_at) DESC`,
    ).all(userId, userId, userId, ...keywords) as StrandRow[]
    for (const row of tagged) push(row)
  }

  const projectNames = projectNameMap(db, userId)
  return Array.from(picked.values()).map(row => toCandidate(db, row, projectNames))
}

export function buildRouterInput(
  db: Database,
  userId: string,
  capture: RouterCaptureInput,
  options: { personas: string[]; defaultPersona: string; deviceHint?: RouterDeviceHint | null },
): RouterInput {
  const deviceHint = options.deviceHint ?? null
  const candidates = selectCandidates(db, userId, capture.text, { pinnedStrandId: deviceHint?.strandId ?? null })
  return {
    capture,
    candidates,
    projects: listRouterProjects(db, userId),
    nowSet: getNowSet(db, userId),
    knownTags: listTags(db, userId).map(t => t.name),
    personas: options.personas,
    defaultPersona: options.defaultPersona,
    now: new Date().toISOString(),
    // Only kept when the strand really made it into the candidate list. A hint
    // that names an id the model cannot inspect invites exactly the blind
    // append this guard exists to avoid.
    deviceHint: deviceHint && candidates.some(c => c.strandId === deviceHint.strandId) ? deviceHint : null,
  }
}

/**
 * The intent half of the prompt (SPEC 4.3). Split out so a test can hold it
 * against the rules instead of grepping the whole system prompt: a wrong
 * `note` costs the user the entire answer (the capture is filed in silence, no
 * turn, no doorbell), a wrong `ask` costs one superfluous reply.
 */
export const ROUTER_INTENT_RULES = `Intent:
- "intent" is "ask" whenever the capture expects something from you, "note" only for a pure self-note with no addressee. When unsure, choose "ask": a superfluous answer costs one paragraph, a missing one leaves the user waiting in silence in front of a chat that never replies.
- Markers of "ask", in German and in English: the user addresses you in the second person ("du", "dir", "dich", "dein", "you", "your"); an imperative or request ("schau dir das an", "mach mal", "pruef das", "have a look", "check this", "please fix"); a direct question ("warum ...?", "kannst du ...?", "why ...?"); a bug report, a complaint or a wish about something you built, which carries the expectation that you act on it.
- A real question is "ask" NO MATTER WHAT IT IS ABOUT. A question word plus a verb ("wie/was/wann/wo/warum/wieviel/welche ... ?", "how/what/when/where/why/which ... ?") or a yes-no question is somebody asking somebody, and you are the only one here — the subject being the user's private life, their house or their money changes nothing: "Wie viel kostet eigentlich ein neuer Dachstuhl?" is "ask". The one exception is a fragment with a question mark and no verb, which is a memo the user wrote for themselves: "Termin beim Zahnarzt am Montag?" stays "note".
- Examples of "ask": "Ich habe keine Push Notification bekommen, schau dir das bitte mal an." / "Kannst du den Zeilenumbruch im Recorder fixen?" / "Why is the deploy still red?" / "Wie viel kostet eigentlich ein neuer Dachstuhl?"
- Examples of "note": "Winterreifen kaufen." / "Bremsbelaege hinten sind durch." / "Call the roofer back next week, 4200 for the north side."
- A capture that reports a problem with your own work, or wishes for something in it ("X waere gut", "wir sollten X", "it would be nice if X"), is "ask", not "note", unless it says outright that it is only for the record ("nur als Notiz", "just for the record").
- The intent is independent of the action: a capture that opens a new strand can very well be an "ask", and an "ask" filed into an existing strand stays an "ask".`

/**
 * Words that put a listener into the sentence. Second person only: "du" is not
 * something one thinks, it is something one says to someone.
 *
 * Deliberately absent is the polite "Sie". Lowercased it cannot be told apart
 * from "sie" (she/they), and the capitalisation of a voice transcript is no
 * evidence either — a sentence may simply start with it. Keeping it would fire
 * on every third person note for a form of address the product owner never
 * uses. See FOLLOWUPS.md.
 *
 * "ihr"/"euch" do overlap with the dative "ihr" (= to her). That misfire costs
 * one superfluous answer, a missed address costs the whole answer, so they stay.
 */
const SECOND_PERSON_GERMAN = [
  'du', 'dir', 'dich', 'dein', 'deine', 'deinen', 'deinem', 'deiner', 'deines',
  'ihr', 'euch', 'euer', 'eure', 'euren', 'eurem', 'eurer', 'eures',
]
const SECOND_PERSON_ENGLISH = ['you', 'your', 'yours']
const SECOND_PERSON_WORDS = new Set([...SECOND_PERSON_GERMAN, ...SECOND_PERSON_ENGLISH])

/**
 * Imperatives: the handful of verbs the product owner actually dictates when
 * something should happen.
 *
 * Only the bare German stem is listed, never the "-e" form: "pruefe",
 * "schaue", "zeige" are homographs of the first person present, so "Ich pruefe
 * das morgen" — a self-note if there ever was one — would read as an order.
 * The stem is unambiguous enough, and a to-do list does not use it.
 *
 * Absent on purpose are the all-purpose imperatives of a to-do list ("kaufen",
 * "anrufen", "call", "book"): a note is full of them and none addresses anyone.
 *
 * "kannst du", "can you", "could you" need no entry of their own — each of them
 * carries a second person word, which already settles the question.
 */
const IMPERATIVE_GERMAN = [
  'schau', 'guck', 'mach', 'prüf', 'pruef', 'bau', 'zeig',
  'änder', 'aender', 'erklär', 'erklaer',
]
const IMPERATIVE_ENGLISH = ['fix', 'check', 'look']
const IMPERATIVE_WORDS = new Set([...IMPERATIVE_GERMAN, ...IMPERATIVE_ENGLISH])

/**
 * The two words that turn any sentence into a request. Their own class, apart
 * from {@link IMPERATIVE_WORDS}, because each of them alone is weak evidence
 * and the pair is strong: "Bitte nicht vergessen: Müll rausstellen" is a note
 * to oneself, "Ich mach das morgen" is a note to oneself, but "please check
 * the logs" is an order to somebody. Counting them as one class would file the
 * pair with the singles.
 */
const POLITENESS_GERMAN = ['bitte']
const POLITENESS_ENGLISH = ['please']
const POLITENESS_WORDS = new Set([...POLITENESS_GERMAN, ...POLITENESS_ENGLISH])

/**
 * The way out for the user: a capture that says of itself that it is only a
 * note stays a note, no matter who it is phrased at ("Nur als Notiz: du musst
 * noch die Reifen wechseln"). Matched as a phrase on the collapsed text, so a
 * line break inside it changes nothing.
 */
const SELF_NOTE_PHRASES = [
  'nur als notiz', 'nur zur info', 'nur notieren',
  'just for the record', 'note to self',
]

/**
 * Does the capture call itself a note? That is the user's own word about their
 * own text and it beats every heuristic — the same rule as a client that sets
 * `intent` explicitly (SPEC 4.1).
 *
 * Used twice: {@link addressStrength} stops at `none` for such a capture, and
 * the captures service skips the "should I answer this?" confirmation for it.
 * Asking somebody who just wrote "nur als Notiz" whether it is only a note is
 * the kind of question that makes people stop reading questions.
 */
export function declaresSelfNote(text: string): boolean {
  if (typeof text !== 'string' || text.trim() === '') return false
  const flat = text.toLowerCase().replace(/\s+/g, ' ')
  return SELF_NOTE_PHRASES.some(phrase => flat.includes(phrase))
}

/**
 * How strongly a text addresses somebody.
 *
 *  * `none`  — no marker at all, or the capture declares itself a note.
 *  * `weak`  — exactly one marker class: the text MIGHT be meant for the
 *    persona, and it might just as well be a memo with a question mark.
 *  * `strong` — two or more marker classes, which no self-note reaches by
 *    accident.
 */
export type AddressStrength = 'none' | 'weak' | 'strong'

/**
 * Does this text address someone, and how clearly? A purely textual second
 * opinion on the router's `intent`, evaluated by the server, not by the model.
 * The capture service uses it as a backstop (SPEC 4.1), which is why it lives
 * here and not next to the database: it is pure text, and both packages test it.
 *
 * Four marker classes, German and English: second person, an imperative, a
 * politeness particle ("bitte"/"please"), a question mark. The strength is the
 * NUMBER OF CLASSES, not the number of words — "schau mach zeig" is one class,
 * "schau dir das an" is two.
 *
 * Why the count and not a single marker: one marker fires on perfectly
 * ordinary notes. "Termin beim Zahnarzt am Montag?" is a memo with a question
 * mark, "Bitte nicht vergessen: Müll rausstellen" is a reminder to oneself,
 * "Ihr Auto muss zum TÜV" is not even a second person. Answering those costs a
 * reply nobody asked for; ignoring a real request costs the whole answer. The
 * three bands let the service pay the right price for each: answer the strong
 * ones, ask about the weak ones, stay silent for the rest.
 */
export function addressStrength(text: string): AddressStrength {
  if (typeof text !== 'string' || text.trim() === '') return 'none'
  const flat = text.toLowerCase().replace(/\s+/g, ' ')
  // The exception comes first, it is the user's explicit word about their own
  // capture and it beats every marker below.
  if (declaresSelfNote(text)) return 'none'
  // Whole words, and the tokenizer is what guarantees it: "durch" never yields
  // a "du", "direkt" no "dir", "Youtube" no "you". A \b regex would be the same
  // idea with more ways of getting it wrong, and this is the one thing this
  // function may not get wrong.
  const words = flat.match(/[\p{L}\p{N}]+/gu) ?? []
  let classes = 0
  if (flat.includes('?')) classes += 1
  if (words.some(word => SECOND_PERSON_WORDS.has(word))) classes += 1
  if (words.some(word => IMPERATIVE_WORDS.has(word))) classes += 1
  if (words.some(word => POLITENESS_WORDS.has(word))) classes += 1
  if (classes === 0) return 'none'
  return classes >= 2 ? 'strong' : 'weak'
}

/** The two languages a capture of this instance is written in. */
export type CaptureLanguage = 'de' | 'en'

/**
 * Function words that settle the language of a capture. Only tokens that
 * belong to one language and not to the other are listed: "was" (German
 * "what", English past tense), "an" (German preposition, English article),
 * "hat", "war" and "in" are deliberately absent, because a wrong hit here is
 * worse than a missing one.
 */
const GERMAN_WORDS = new Set([
  ...SECOND_PERSON_GERMAN, ...IMPERATIVE_GERMAN, ...POLITENESS_GERMAN,
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
  'und', 'oder', 'aber', 'nicht', 'noch', 'schon', 'auch', 'nur', 'mit', 'für', 'fuer',
  'von', 'vom', 'zum', 'zur', 'bei', 'beim', 'nach', 'vor', 'über', 'unter', 'aus', 'auf',
  'ist', 'sind', 'habe', 'hab', 'haben', 'wird', 'werden', 'muss', 'müssen', 'kann', 'können',
  'soll', 'sollen', 'ich', 'mir', 'mich', 'wir', 'uns', 'sie', 'ihm', 'ihn', 'mein', 'meine',
  'morgen', 'heute', 'gestern', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag',
  'samstag', 'sonntag', 'wieder', 'mal', 'danke', 'kein', 'keine', 'wie', 'wer',
  'wo', 'wann', 'warum', 'weil', 'dass', 'wenn', 'im', 'ins', 'gegen', 'ohne', 'bis', 'seit',
  'termin', 'nochmal', 'etwas', 'immer', 'jetzt', 'dann', 'sich', 'als', 'am',
])

const ENGLISH_WORDS = new Set([
  ...SECOND_PERSON_ENGLISH, ...IMPERATIVE_ENGLISH, ...POLITENESS_ENGLISH,
  'the', 'a', 'an', 'and', 'or', 'but', 'not', 'of', 'to', 'for', 'from', 'with', 'without',
  'this', 'that', 'these', 'those', 'is', 'are', 'were', 'be', 'been', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'it', 'its', 'i', 'my', 'me',
  'we', 'us', 'our', 'you', 'your', 'yours', 'he', 'she', 'they', 'them', 'his', 'her', 'their',
  'on', 'at', 'by', 'about', 'still', 'again', 'tomorrow', 'today', 'yesterday', 'monday',
  'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'why', 'what', 'who',
  'where', 'when', 'how', 'need', 'next', 'week', 'back',
])

/**
 * Which language a capture is written in. Deliberately minimal: this decides
 * nothing but the wording of one short question the service writes back, so a
 * word list beats a dependency, and a miss costs a German sentence in an
 * English strand, not a wrong filing.
 *
 * Markers (second person, imperatives, politeness) count as evidence too —
 * they are the words this module already knows — plus a German umlaut, which
 * no English capture contains.
 *
 * With no evidence at all ("Dachrinne?", a number, an empty string) the answer
 * is German: the captures of this instance are dictated in German, so that is
 * the cheaper miss.
 */
export function captureLanguage(text: string): CaptureLanguage {
  if (typeof text !== 'string') return 'de'
  const flat = text.toLowerCase().replace(/\s+/g, ' ')
  const words = flat.match(/[\p{L}\p{N}]+/gu) ?? []
  let de = /[äöüß]/.test(flat) ? 1 : 0
  let en = 0
  for (const word of new Set(words)) {
    if (GERMAN_WORDS.has(word)) de += 1
    if (ENGLISH_WORDS.has(word)) en += 1
  }
  return en > de ? 'en' : 'de'
}

export const ROUTER_SYSTEM_PROMPT = `You are the filing router of a personal thinking tool. The user dictates a thought without picking a destination. You decide where it belongs among the user's existing strands (threads of thought) and answer with ONE JSON object and nothing else: no prose, no markdown fences.

Schema:
{
  "action": "append" | "new_strand" | "link",
  "strandId": string | null,
  "secondaryStrandId": string | null,
  "newStrand": { "title": string, "personaId": string, "tags": string[], "projectId": string | null } | null,
  "intent": "note" | "ask",
  "confidence": number,
  "tags": string[],
  "rationale": string,
  "alternatives": [ { "action": "append" | "new_strand", "strandId": string | null, "title": string | null, "confidence": number, "reason": string } ],
  "projectSuggestion": { "projectId": string, "confidence": number, "reason": string } | null
}

Rules:
- "append" requires "strandId" from the candidates. "link" requires "strandId" (the primary strand the capture is appended to) and "secondaryStrandId" (a second candidate the capture explicitly refers to). "new_strand" requires "newStrand" with a title of at most 60 characters, a personaId from the persona list, and tags.
- Choose "new_strand" when no candidate is a real match and the capture introduces a subject that is absent from every candidate title, tag and summary. Prefer the capture's persona hint, else the persona of the closest candidate, else the default persona.
- "confidence" is a float between 0 and 1 for the chosen action. Be honest: 0.85 or more only for an unmistakable match, 0.4 to 0.7 when plausible but unsure, below 0.4 when guessing.
- "tags": one to three short lowercase slugs that describe the capture; reuse known tags where they fit.
- "alternatives": at most 3 entries, best first, never repeating the chosen action and target. May be empty.
- "rationale": one short sentence, same language as the capture.
- Candidates come with their persona, tags, last activity, a summary, the last lines and "lastMessage", the last thing the user wrote in that strand (shortened). Recent activity and membership in the now set are mild hints, content match is what counts.
- Evidence is content: "lastMessage", the summary, the tail, the tags. A title alone is a label, not evidence — when it is the only thing that seems to fit, you are guessing, so say so with a low confidence or choose "new_strand".
- An append that lands in the wrong strand buries the capture in a foreign conversation. When in doubt, "new_strand" is the cheap mistake: below 0.7 an append is not carried out anyway, it becomes a new strand with your target kept as a suggestion.
- "deviceHint", when present, names the strand into which the PREVIOUS capture from the same client went, and how many minutes ago. Someone speaking into a device sends one sentence per capture, so this is usually the same conversation continued and the named strand is the strongest candidate you have. It is still only a hint: a speaker can change the subject in the next breath, and when the capture has nothing to do with that strand you ignore the hint and route by content like always.

Projects:
- A project is a long lived container above the strands: one product, one vehicle, one house, alive for months, while a strand is a single thread of thought inside it. Every project the user has is listed at the top of the task with its id and name; when no list is there, the user has no projects and every project field stays null.
- "newStrand.projectId": an id from that list, and only when the new strand unmistakably belongs to that project. "no project" (null or omitted) is the right answer whenever nothing fits clearly, and it is the most common one. A wrong container is worse than none, and doing nothing costs nothing: the user can attach the strand later in one tap.
- The list gives you project names, not their contents. A name that merely sounds related to the capture is not evidence. Name a project when the capture mentions it, or when a candidate strand that already carries that project is about the same matter; otherwise null.
- "projectSuggestion": only for "append" or "link", only when the chosen candidate has "projectId": null, and only when the WHOLE strand belongs to a project from the list. Never for a candidate that already has a project, never as a way to move a strand. Confidence is your own honest estimate, below 0.55 it is thrown away, so send null instead of guessing. This suggestion is never applied automatically, the user taps it or ignores it.

${ROUTER_INTENT_RULES}`

/**
 * The user prompt. The project list is the FIRST block and carries no volatile
 * value (SPEC 11.5): the system prompt plus this block is a byte identical
 * prefix for every capture as long as the project list is unchanged, so it can
 * be cached, while the capture and the candidates below it change anyway. A
 * project rename or a new project invalidates the cache from this block on, not
 * the system prompt. Without projects the block is absent entirely, so a user
 * who does not use projects pays nothing.
 */
export function buildRouterUserPrompt(input: RouterInput): string {
  const payload = {
    capture: input.capture,
    candidates: input.candidates,
    ...(input.deviceHint ? { deviceHint: input.deviceHint } : {}),
    nowSet: input.nowSet,
    knownTags: input.knownTags,
    personas: input.personas,
    defaultPersona: input.defaultPersona,
    now: input.now,
  }
  const projects = activeProjects(input)
  const projectBlock = projects.length > 0
    ? `Projects of this user (id, name):\n${JSON.stringify(projects, null, 2)}\n\n`
    : ''
  return `${projectBlock}Route this capture.\n\n${JSON.stringify(payload, null, 2)}\n\nAnswer with the JSON object only.`
}

const REPAIR_PROMPT = 'Your previous answer was not a valid routing object. Reply again with exactly one JSON object matching the schema, no other text.'

function stripFences(text: string): string {
  const t = text.trim()
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return fenced[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) return t.slice(start, end + 1)
  return t
}

function clamp01(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}

function cleanTags(value: unknown, max = 5): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') continue
    const t = v.trim().toLowerCase()
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= max) break
  }
  return out
}

/**
 * A project suggestion for an existing strand (SPEC 4.2b). Anything unusable
 * is dropped, not rejected: it is an optional hint that the server never
 * applies, so a bad one must not cost a repair call. Dropped are a suggestion
 * for a `new_strand` (there the project belongs into `newStrand.projectId`), an
 * unknown or archived project, a target strand that already has a project, and
 * a confidence below {@link PROJECT_SUGGESTION_MIN_CONFIDENCE}.
 */
function parseProjectSuggestion(
  raw: unknown,
  input: RouterInput,
  action: RouterAction,
  targetStrandId: string | null,
): ProjectSuggestion | null {
  if (action === 'new_strand') return null
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  const projectId = typeof s.projectId === 'string' ? s.projectId.trim() : ''
  if (!projectId || !activeProjects(input).some(p => p.id === projectId)) return null
  const target = input.candidates.find(c => c.strandId === targetStrandId)
  if (!target || target.projectId !== null) return null
  const confidence = clamp01(s.confidence)
  if (confidence === null || confidence < PROJECT_SUGGESTION_MIN_CONFIDENCE) return null
  return {
    projectId,
    confidence,
    reason: typeof s.reason === 'string' ? s.reason.trim().slice(0, 200) : '',
  }
}

export type ParseRouterResult =
  | { ok: true; proposal: RouterProposal }
  | { ok: false; error: string }

/**
 * Strict parse of a router answer against SPEC 4.3. Unknown strand ids, a
 * missing target for the action or a missing new strand title are errors;
 * the caller retries once with the repair prompt.
 */
export function parseRouterOutput(text: string, input: RouterInput): ParseRouterResult {
  let raw: unknown
  try {
    raw = JSON.parse(stripFences(text))
  } catch {
    return { ok: false, error: 'not JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'not an object' }
  const obj = raw as Record<string, unknown>

  const action = obj.action
  if (action !== 'append' && action !== 'new_strand' && action !== 'link') return { ok: false, error: 'invalid action' }

  const known = new Set(input.candidates.map(c => c.strandId))
  const strandId = typeof obj.strandId === 'string' ? obj.strandId : null
  const secondaryStrandId = typeof obj.secondaryStrandId === 'string' ? obj.secondaryStrandId : null

  let newStrand: RouterProposal['newStrand'] = null
  if (action === 'append') {
    if (!strandId || !known.has(strandId)) return { ok: false, error: 'append needs a candidate strandId' }
  } else if (action === 'link') {
    if (!strandId || !known.has(strandId)) return { ok: false, error: 'link needs a candidate strandId' }
    if (!secondaryStrandId || !known.has(secondaryStrandId) || secondaryStrandId === strandId) {
      return { ok: false, error: 'link needs a distinct candidate secondaryStrandId' }
    }
  } else {
    const ns = obj.newStrand
    if (typeof ns !== 'object' || ns === null) return { ok: false, error: 'new_strand needs newStrand' }
    const nsObj = ns as Record<string, unknown>
    const title = typeof nsObj.title === 'string' ? nsObj.title.replace(/\s+/g, ' ').trim().slice(0, ROUTER_TITLE_MAX) : ''
    if (!title) return { ok: false, error: 'newStrand.title is required' }
    let personaId = typeof nsObj.personaId === 'string' ? nsObj.personaId.trim() : ''
    if (!input.personas.includes(personaId)) {
      personaId = input.capture.personaHint && input.personas.includes(input.capture.personaHint)
        ? input.capture.personaHint
        : input.defaultPersona
    }
    // Strict like `strandId` (SPEC 4.3): this project is really written on the
    // created strand, so an id the user does not own is a parse error.
    let projectId: string | null = null
    const rawProject = nsObj.projectId
    if (typeof rawProject === 'string' && rawProject.trim() !== '') {
      const candidate = rawProject.trim()
      if (!activeProjects(input).some(p => p.id === candidate)) {
        return { ok: false, error: 'newStrand.projectId is not one of the listed projects' }
      }
      projectId = candidate
    } else if (rawProject !== undefined && rawProject !== null && rawProject !== '') {
      return { ok: false, error: 'newStrand.projectId must be a project id or null' }
    }
    newStrand = { title, personaId, tags: cleanTags(nsObj.tags), projectId }
  }

  const confidence = clamp01(obj.confidence)
  if (confidence === null) return { ok: false, error: 'confidence must be a number' }

  const intent: RouterIntent = obj.intent === 'ask' ? 'ask' : 'note'
  const tags = cleanTags(obj.tags)
  if (newStrand) {
    for (const t of tags) if (!newStrand.tags.includes(t)) newStrand.tags.push(t)
  }
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 400) : ''

  const alternatives: DecisionAlternative[] = []
  if (Array.isArray(obj.alternatives)) {
    for (const alt of obj.alternatives) {
      if (typeof alt !== 'object' || alt === null) continue
      const a = alt as Record<string, unknown>
      const altAction = a.action === 'new_strand' ? 'new_strand' : a.action === 'append' || a.action === 'link' ? 'append' : null
      if (!altAction) continue
      const altStrand = typeof a.strandId === 'string' && known.has(a.strandId) ? a.strandId : null
      if (altAction === 'append' && !altStrand) continue
      if (altAction === 'append' && action !== 'new_strand' && altStrand === strandId) continue
      const altTitle = typeof a.title === 'string' ? a.title.trim().slice(0, ROUTER_TITLE_MAX) : null
      if (altAction === 'new_strand' && action === 'new_strand') continue
      alternatives.push({
        action: altAction,
        strandId: altAction === 'append' ? altStrand : null,
        title: altAction === 'new_strand' ? (altTitle || 'New strand') : null,
        confidence: clamp01(a.confidence) ?? 0,
        reason: typeof a.reason === 'string' ? a.reason.trim().slice(0, 200) : '',
      })
    }
  }
  alternatives.sort((x, y) => y.confidence - x.confidence)

  return {
    ok: true,
    proposal: {
      action,
      strandId: action === 'new_strand' ? null : strandId,
      secondaryStrandId: action === 'link' ? secondaryStrandId : null,
      newStrand,
      intent,
      confidence,
      tags,
      rationale,
      alternatives: alternatives.slice(0, 3),
      projectSuggestion: parseProjectSuggestion(obj.projectSuggestion, input, action, strandId),
    },
  }
}

/**
 * SPEC 4.4 hardening: an `append`/`link` below {@link CONFIDENCE_HIGH} is not
 * carried out. A wrong append costs the user a capture buried in a foreign
 * history without its context; a superfluous strand costs one merge. So the
 * proposal becomes a `new_strand` (title from the model's own new_strand
 * alternative, else derived from the capture — never a second model call) and
 * the proposed target survives as the first alternative, ready to be applied
 * by hand. Confidence is left untouched so the band logic and the stored
 * decision stay honest.
 */
export function guardLowConfidenceAppend(proposal: RouterProposal, input: RouterInput): RouterProposal {
  if (proposal.action !== 'append' && proposal.action !== 'link') return proposal
  if (proposal.confidence >= CONFIDENCE_HIGH || !proposal.strandId) return proposal

  const target = input.candidates.find(c => c.strandId === proposal.strandId) ?? null
  const suggestedTitle = proposal.alternatives.find(a => a.action === 'new_strand' && a.title)?.title ?? null
  const title = suggestedTitle
    || deriveStrandTitle(input.capture.text, ROUTER_TITLE_MAX)
    || 'New strand'
  const personaId = input.capture.personaHint && input.personas.includes(input.capture.personaHint)
    ? input.capture.personaHint
    : target && input.personas.includes(target.personaId)
      ? target.personaId
      : input.defaultPersona

  const kept: DecisionAlternative[] = [{
    action: 'append',
    strandId: proposal.strandId,
    title: null,
    confidence: proposal.confidence,
    reason: (proposal.rationale || `proposed target "${target?.title ?? proposal.strandId}"`).slice(0, 200),
  }]
  if (proposal.action === 'link' && proposal.secondaryStrandId) {
    kept.push({
      action: 'append',
      strandId: proposal.secondaryStrandId,
      title: null,
      confidence: proposal.confidence,
      reason: 'second strand of the proposed link',
    })
  }
  for (const alt of proposal.alternatives) {
    if (alt.action !== 'append' || !alt.strandId) continue
    if (kept.some(k => k.strandId === alt.strandId)) continue
    kept.push(alt)
  }

  const marker = `${LOW_CONFIDENCE_APPEND_MARKER} (${proposal.confidence.toFixed(2)} < ${CONFIDENCE_HIGH}), proposed ${proposal.action} into ${proposal.strandId}, opened a new strand instead.`
  const rationale = proposal.rationale ? `${marker} Model: ${proposal.rationale}` : marker

  return {
    action: 'new_strand',
    strandId: null,
    secondaryStrandId: null,
    // No project rides along: the router only ever proposed one for the
    // existing target, and a container the user never confirmed must not be
    // written onto a strand the guard created (SPEC 4.2b).
    newStrand: { title, personaId, tags: proposal.tags, projectId: null },
    intent: proposal.intent,
    confidence: proposal.confidence,
    tags: proposal.tags,
    rationale: rationale.slice(0, 400),
    alternatives: kept.slice(0, 3),
    projectSuggestion: null,
  }
}

/** The decision every failure degrades to (SPEC 4.3): unsorted, never applied. */
export function syntheticProposal(input: RouterInput, reason: string): RouterProposal {
  const title = deriveStrandTitle(input.capture.text, ROUTER_TITLE_MAX) || 'New strand'
  const personaId = input.capture.personaHint && input.personas.includes(input.capture.personaHint)
    ? input.capture.personaHint
    : input.defaultPersona
  return {
    action: 'new_strand',
    strandId: null,
    secondaryStrandId: null,
    newStrand: { title, personaId, tags: [], projectId: null },
    intent: 'note',
    confidence: 0,
    tags: [],
    rationale: reason,
    alternatives: [],
    projectSuggestion: null,
  }
}

/** One model call: the system prompt is fixed, `userPrompt` is the whole conversation. Answer text back. */
export type RouterCompletion = (
  entry: ResolvedRouterModel,
  userPrompt: string,
) => Promise<string>

export interface RunRouterOptions {
  /** Chain override (tests, `POST /api/router/preview`). Defaults to the configured chain. */
  chain?: ResolvedRouterModel[]
  /** Model call override (tests). Defaults to the pi-ai completion. */
  complete?: RouterCompletion
}

async function defaultCompletion(entry: ResolvedRouterModel, userPrompt: string): Promise<string> {
  const handle = await buildRouterModel(entry)
  if (!handle) throw new Error(`model ${entry.composite} is not available`)
  const response = await completeSimple(handle.model, {
    systemPrompt: ROUTER_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: userPrompt, timestamp: Date.now() }],
  }, {
    apiKey: handle.apiKey,
    reasoning: resolveBackgroundReasoning(),
  })
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw new Error(response.errorMessage ?? response.stopReason)
  }
  return response.content
    .filter(item => item.type === 'text')
    .map(item => (item as { type: 'text'; text: string }).text)
    .join('')
    .trim()
}

/** The repair prompt carries the original task and the rejected answer in one user message. */
export function buildRepairPrompt(userPrompt: string, rejected: string, error: string): string {
  return `${userPrompt}

Your previous answer was rejected (${error}):
${rejected.slice(0, 2000)}

${REPAIR_PROMPT}`
}

/**
 * Run the router chain for one input. Each entry gets one call and one
 * repair retry. An entry with a threshold hands over to the next one when
 * its confidence is below it; the best proposal seen wins at the end. When
 * nothing usable comes back the synthetic proposal is returned.
 */
export async function runRouter(input: RouterInput, options: RunRouterOptions = {}): Promise<RouterResult> {
  const startedAt = Date.now()
  const notes: string[] = []
  const chain = options.chain ?? resolveRouterChain()
  const complete = options.complete ?? defaultCompletion
  const userPrompt = buildRouterUserPrompt(input)

  if (input.candidates.length === 0) {
    // Nothing to match against: the answer is a new strand by definition and
    // a model call would only cost time. Kept at medium confidence so the
    // user sees the chip and can rename before anything else happens.
    const proposal = syntheticProposal(input, 'No existing strand to file into')
    return { proposal: { ...proposal, confidence: 0.5 }, model: 'synthetic', latencyMs: Date.now() - startedAt, notes }
  }
  if (chain.length === 0) {
    notes.push('router chain has no available entry')
    return { proposal: syntheticProposal(input, 'Router unavailable'), model: 'synthetic', latencyMs: Date.now() - startedAt, notes }
  }

  let best: { proposal: RouterProposal; model: string } | null = null
  for (const entry of chain) {
    let prompt = userPrompt
    let proposal: RouterProposal | null = null
    for (let attempt = 0; attempt < 2 && !proposal; attempt += 1) {
      let text: string
      try {
        text = await complete(entry, prompt)
      } catch (err) {
        notes.push(`${entry.composite}: ${(err as Error).message}`)
        break
      }
      const parsed = parseRouterOutput(text, input)
      if (parsed.ok) {
        proposal = parsed.proposal
      } else {
        notes.push(`${entry.composite}: malformed answer (${parsed.error})${attempt === 0 ? ', retrying with repair prompt' : ''}`)
        prompt = buildRepairPrompt(userPrompt, text, parsed.error)
      }
    }
    if (!proposal) continue
    if (!best || proposal.confidence > best.proposal.confidence) best = { proposal, model: entry.composite }
    if (entry.threshold !== null && proposal.confidence < entry.threshold) {
      notes.push(`${entry.composite}: confidence ${proposal.confidence.toFixed(2)} below threshold ${entry.threshold}, trying next entry`)
      continue
    }
    break
  }

  if (!best) {
    return { proposal: syntheticProposal(input, 'Router produced no usable decision'), model: 'synthetic', latencyMs: Date.now() - startedAt, notes }
  }
  const guarded = guardLowConfidenceAppend(best.proposal, input)
  if (guarded !== best.proposal) {
    notes.push(`${best.model}: ${LOW_CONFIDENCE_APPEND_MARKER}, ${best.proposal.action} into ${best.proposal.strandId} at ${best.proposal.confidence.toFixed(2)} became a new strand`)
  }
  return { proposal: guarded, model: best.model, latencyMs: Date.now() - startedAt, notes }
}
