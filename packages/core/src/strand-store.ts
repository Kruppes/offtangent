/**
 * strand-store.ts: data access for the Offtangent tables (SPEC 3.2): tags,
 * strand tags, now set, strand links, captures, router decisions and
 * resurface snoozes. Plain functions over the shared database, every read
 * and write is scoped by `userId` (the same string the `sessions.session_user`
 * column carries). Strands are `sessions` rows; this module never touches
 * `sessions` itself.
 */
import { randomUUID } from 'node:crypto'
import { DEFAULT_NOW_SET_MAX } from './contracts/settings.js'
import type { Database } from './database.js'
import { InvalidInputError } from './errors.js'
import type { UploadDescriptor } from './uploads.js'

/**
 * Default size of the now set. The effective limit is a setting
 * (`offtangent.nowSetMax`), resolved by the caller and passed in as `max`;
 * this constant is the fallback for callers that have no setting at hand.
 */
export const NOW_SET_MAX = DEFAULT_NOW_SET_MAX
export const TAG_NAME_MAX_LENGTH = 40
const TAG_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

export class NowSetTooLargeError extends Error {
  readonly code = 'now_set_too_large' as const
  readonly max: number
  constructor(max: number = NOW_SET_MAX, message = `The now set holds at most ${max} strands`) {
    super(message)
    this.name = 'NowSetTooLargeError'
    this.max = max
  }
}

export function isNowSetTooLargeError(err: unknown): err is NowSetTooLargeError {
  return err instanceof NowSetTooLargeError
    || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'now_set_too_large')
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.includes('Z') || value.includes('+') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface Tag {
  id: string
  name: string
  color: string | null
  archived: boolean
  createdAt: string
}

interface TagRow {
  id: string
  name: string
  color: string | null
  archived: number
  created_at: string
}

function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? null,
    archived: !!row.archived,
    createdAt: toIso(row.created_at) ?? row.created_at,
  }
}

/**
 * Tags are lowercase slugs (SPEC 2.4): trimmed, lowercased, inner whitespace
 * becomes a dash, anything that is not a letter, digit, dash or underscore is
 * dropped. Returns null when nothing usable is left.
 */
export function normalizeTagName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return null
  return slug.slice(0, TAG_NAME_MAX_LENGTH)
}

function normalizeTagColor(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || !TAG_COLOR_PATTERN.test(raw)) {
    throw new InvalidInputError('color must be a hex colour like #rrggbb')
  }
  return raw.toLowerCase()
}

export function listTags(db: Database, userId: string, options: { includeArchived?: boolean } = {}): Tag[] {
  const rows = db.prepare(
    `SELECT id, name, color, archived, created_at FROM tags
     WHERE user_id = ? ${options.includeArchived ? '' : 'AND archived = 0'}
     ORDER BY name ASC`,
  ).all(userId) as TagRow[]
  return rows.map(toTag)
}

export function getTag(db: Database, userId: string, id: string): Tag | null {
  const row = db.prepare('SELECT id, name, color, archived, created_at FROM tags WHERE user_id = ? AND id = ?')
    .get(userId, id) as TagRow | undefined
  return row ? toTag(row) : null
}

export function getTagByName(db: Database, userId: string, name: string): Tag | null {
  const row = db.prepare('SELECT id, name, color, archived, created_at FROM tags WHERE user_id = ? AND name = ?')
    .get(userId, name) as TagRow | undefined
  return row ? toTag(row) : null
}

/** Create a tag; an existing name returns the stored tag with `created: false`. */
export function createTag(
  db: Database,
  userId: string,
  input: { name: unknown; color?: unknown },
): { tag: Tag; created: boolean } {
  const name = normalizeTagName(input.name)
  if (!name) throw new InvalidInputError('name is required')
  const color = normalizeTagColor(input.color)
  const existing = getTagByName(db, userId, name)
  if (existing) return { tag: existing, created: false }
  const id = randomUUID()
  db.prepare('INSERT INTO tags (id, user_id, name, color) VALUES (?, ?, ?, ?)').run(id, userId, name, color)
  return { tag: getTag(db, userId, id)!, created: true }
}

export function updateTag(
  db: Database,
  userId: string,
  id: string,
  patch: { name?: unknown; color?: unknown; archived?: unknown },
): Tag | null {
  const existing = getTag(db, userId, id)
  if (!existing) return null
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    const name = normalizeTagName(patch.name)
    if (!name) throw new InvalidInputError('name must be a non-empty string')
    const clash = getTagByName(db, userId, name)
    if (clash && clash.id !== id) throw new InvalidInputError(`A tag named "${name}" already exists`)
    sets.push('name = ?')
    params.push(name)
  }
  if (patch.color !== undefined) {
    sets.push('color = ?')
    params.push(normalizeTagColor(patch.color))
  }
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== 'boolean') throw new InvalidInputError('archived must be a boolean')
    sets.push('archived = ?')
    params.push(patch.archived ? 1 : 0)
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params, id, userId)
  }
  return getTag(db, userId, id)
}

/** Resolve tag names to rows, creating unknown ones. Invalid names are skipped. */
export function ensureTags(db: Database, userId: string, names: unknown[]): Tag[] {
  const out: Tag[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const name = normalizeTagName(raw)
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(createTag(db, userId, { name }).tag)
  }
  return out
}

export function getStrandTags(db: Database, strandId: string): string[] {
  const rows = db.prepare(
    `SELECT t.name FROM strand_tags st JOIN tags t ON t.id = st.tag_id
     WHERE st.strand_id = ? ORDER BY t.name ASC`,
  ).all(strandId) as { name: string }[]
  return rows.map(r => r.name)
}

/** Replace the tag set of a strand (user action). Unknown tags are created. */
export function setStrandTags(db: Database, userId: string, strandId: string, names: unknown[]): string[] {
  const tags = ensureTags(db, userId, names)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM strand_tags WHERE strand_id = ?').run(strandId)
    const insert = db.prepare("INSERT OR IGNORE INTO strand_tags (strand_id, tag_id, source) VALUES (?, ?, 'user')")
    for (const tag of tags) insert.run(strandId, tag.id)
  })
  tx()
  return getStrandTags(db, strandId)
}

/** Add tags to a strand without removing existing ones (router suggestions). */
export function addStrandTags(
  db: Database,
  userId: string,
  strandId: string,
  names: unknown[],
  source: 'user' | 'router' = 'router',
): string[] {
  const tags = ensureTags(db, userId, names)
  const insert = db.prepare('INSERT OR IGNORE INTO strand_tags (strand_id, tag_id, source) VALUES (?, ?, ?)')
  for (const tag of tags) insert.run(strandId, tag.id, source)
  return getStrandTags(db, strandId)
}

/** Strand ids of one user carrying a tag (used by the strands list filter). */
export function strandIdsWithTag(db: Database, userId: string, tagName: string): string[] {
  const rows = db.prepare(
    `SELECT st.strand_id FROM strand_tags st JOIN tags t ON t.id = st.tag_id
     WHERE t.user_id = ? AND t.name = ?`,
  ).all(userId, tagName) as { strand_id: string }[]
  return rows.map(r => r.strand_id)
}

// ---------------------------------------------------------------------------
// Now set
// ---------------------------------------------------------------------------

/** Strand ids of the now set, ordered by rank (1 first). */
export function getNowSet(db: Database, userId: string): string[] {
  const rows = db.prepare('SELECT strand_id FROM now_set WHERE user_id = ? ORDER BY rank ASC')
    .all(userId) as { strand_id: string }[]
  return rows.map(r => r.strand_id)
}

export function getNowRank(db: Database, userId: string, strandId: string): number | null {
  const row = db.prepare('SELECT rank FROM now_set WHERE user_id = ? AND strand_id = ?')
    .get(userId, strandId) as { rank: number } | undefined
  return row ? row.rank : null
}

function writeNowSet(db: Database, userId: string, strandIds: string[]): string[] {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM now_set WHERE user_id = ?').run(userId)
    const insert = db.prepare("INSERT INTO now_set (user_id, strand_id, rank, updated_at) VALUES (?, ?, ?, datetime('now'))")
    strandIds.forEach((id, index) => insert.run(userId, id, index + 1))
  })
  tx()
  return getNowSet(db, userId)
}

/**
 * Replace the now set. Order of `strandIds` is the rank. More than `max`
 * distinct ids throws {@link NowSetTooLargeError}; the caller has already
 * verified that every id is a strand of this user. `max` defaults to
 * {@link NOW_SET_MAX}; callers that resolved the setting pass its value.
 */
export function setNowSet(db: Database, userId: string, strandIds: string[], max: number = NOW_SET_MAX): string[] {
  const distinct = Array.from(new Set(strandIds))
  if (distinct.length > max) throw new NowSetTooLargeError(max)
  return writeNowSet(db, userId, distinct)
}

/**
 * Add a strand at the end of the now set when there is room (SPEC 2.8: a
 * filed capture pulls its strand into play, but never evicts). Returns true
 * when the set changed. A set that already sits at or above `max` — possible
 * after the size setting was lowered — simply refuses the addition.
 */
export function addToNowSetIfRoom(db: Database, userId: string, strandId: string, max: number = NOW_SET_MAX): boolean {
  const current = getNowSet(db, userId)
  if (current.includes(strandId) || current.length >= max) return false
  writeNowSet(db, userId, [...current, strandId])
  return true
}

/**
 * Window the activity ranking looks back over. Older activity contributes
 * nothing at all. With a one-day half-life anything past ten days scores below
 * a thousandth of today, so fourteen days is the point where the window stops
 * changing the answer and only bounds the query.
 */
export const NOW_SET_RANKING_WINDOW_DAYS = 14

/**
 * Half-life of one active day, in days: a day's contribution halves every day.
 *
 * Measured against the live database on 23.09.2026 with the previous value of
 * five days: places 1 to 8 of the set were 52 to 124 hours old while every
 * strand of that day sat at place 9 and below — a thread that ran on four days
 * of the previous week outscored everything current. The product owner's words:
 * "total verwahrlost, nicht mehr im aktuellen Verlauf".
 *
 * One day keeps returning to something a real signal (today + yesterday +
 * the day before = 1.75 still beats a single fresh day = 1.0) while making
 * recency the dominant term, which is what the set is for.
 */
export const NOW_SET_RANKING_HALF_LIFE_DAYS = 1

export interface RankStrandsByActivityOptions {
  /** How many ids to return at most (the effective `offtangent.nowSetMax`). */
  max: number
  /** Reference point for the age of a message. Explicit so tests are deterministic. */
  now?: Date
  windowDays?: number
  halfLifeDays?: number
}

/** `YYYY-MM-DD HH:MM:SS` in UTC — the format `chat_messages.timestamp` carries. */
function toSqliteUtc(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * The now set, computed from what the user actually did (`offtangent.nowSetMode
 * = 'auto'`).
 *
 * Score of a strand = sum over the DISTINCT calendar days (UTC) it saw a user
 * message inside the window of `0.5 ^ (ageOfThatDay / halfLife)`, where the
 * day's age is that of its most recent user message.
 *
 * Distinct days instead of message count on purpose: a bench thread with 92
 * messages in two days must not outrank a strand the product owner came back
 * to on five separate days — returning to something is the signal, typing a
 * lot in one sitting is not. Only `role = 'user'` rows count, so cron runs,
 * task reports and system injections can never pull a strand into the set.
 *
 * Order: pinned strands first (among themselves by score), then the rest by
 * score, tie-broken by the most recent user activity and finally by id so the
 * list is stable between two reads. A strand without any score is only
 * included when it is pinned; a short (even empty) now set is a valid answer.
 */
export function rankStrandsByActivity(
  db: Database,
  userId: string,
  options: RankStrandsByActivityOptions,
): string[] {
  const max = Math.trunc(options.max)
  if (!Number.isFinite(max) || max <= 0) return []
  const windowDays = options.windowDays ?? NOW_SET_RANKING_WINDOW_DAYS
  const halfLifeDays = options.halfLifeDays ?? NOW_SET_RANKING_HALF_LIFE_DAYS
  const now = options.now ?? new Date()
  const nowStamp = toSqliteUtc(now)
  const windowStart = toSqliteUtc(new Date(now.getTime() - windowDays * 86_400_000))

  const rows = db.prepare(
    `WITH days AS (
       SELECT session_id,
              date(timestamp) AS d,
              min(julianday(?) - julianday(timestamp)) AS age
       FROM chat_messages
       WHERE role = 'user' AND timestamp > ?
       GROUP BY session_id, d
     ),
     sc AS (
       SELECT session_id, sum(pow(0.5, age / ?)) AS score, min(age) AS rec
       FROM days GROUP BY session_id
     )
     SELECT s.id AS id, s.pinned AS pinned, sc.score AS score, sc.rec AS rec
     FROM sessions s LEFT JOIN sc ON sc.session_id = s.id
     WHERE (s.session_user = ? OR CAST(s.user_id AS TEXT) = ?)
       AND s.type = 'interactive'
       AND s.archived = 0
       AND s.title IS NOT NULL AND trim(s.title) <> ''
       AND (sc.score IS NOT NULL OR s.pinned = 1)
     ORDER BY s.pinned DESC, score DESC, rec ASC, s.id ASC
     LIMIT ?`,
  ).all(nowStamp, windowStart, halfLifeDays, userId, userId, max) as {
    id: string
    pinned: number
    score: number | null
    rec: number | null
  }[]
  return rows.map(row => row.id)
}

/**
 * Removal never enforces the size limit: a set that is over the current limit
 * (because the setting was lowered under it) has to stay removable, and
 * shrinking it must never fail.
 */
export function removeFromNowSet(db: Database, userId: string, strandId: string): boolean {
  const current = getNowSet(db, userId)
  if (!current.includes(strandId)) return false
  writeNowSet(db, userId, current.filter(id => id !== strandId))
  return true
}

// ---------------------------------------------------------------------------
// Strand links
// ---------------------------------------------------------------------------

export type StrandLinkKind = 'reference' | 'moved_from' | 'handover'

export function createStrandLink(
  db: Database,
  input: { fromStrand: string; toStrand: string; captureId?: string | null; kind?: StrandLinkKind },
): string {
  const id = randomUUID()
  db.prepare('INSERT INTO strand_links (id, from_strand, to_strand, capture_id, kind) VALUES (?, ?, ?, ?, ?)')
    .run(id, input.fromStrand, input.toStrand, input.captureId ?? null, input.kind ?? 'reference')
  return id
}

export function countStrandLinks(db: Database, strandId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM strand_links WHERE from_strand = ? OR to_strand = ?')
    .get(strandId, strandId) as { count: number }
  return row.count
}

// ---------------------------------------------------------------------------
// Captures and router decisions
// ---------------------------------------------------------------------------

export type CaptureKind = 'text' | 'voice' | 'image' | 'file'
export type CaptureStatus = 'pending' | 'filed' | 'needs_review' | 'unsorted' | 'moved' | 'failed' | 'dismissed'
export type RouterAction = 'append' | 'new_strand' | 'link'
export type RouterIntent = 'note' | 'ask'
export type DecisionState = 'proposed' | 'applied' | 'confirmed' | 'undone' | 'superseded'

export interface Capture {
  id: string
  text: string
  kind: CaptureKind
  source: string
  agentId: string | null
  strandId: string | null
  messageId: number | null
  status: CaptureStatus
  createdAt: string
  filedAt: string | null
  attachments: UploadDescriptor[]
  clientMessageId: string | null
}

export interface DecisionAlternative {
  action: RouterAction
  strandId: string | null
  title: string | null
  confidence: number
  reason: string
}

/**
 * A project the router proposes for an EXISTING strand that has none yet
 * (SPEC 4.2b). It is stored with the decision and delivered to the client,
 * never applied by the server. The project name is deliberately not stored:
 * the client resolves it from `/api/projects` so a rename can never show a
 * stale label.
 */
export interface ProjectSuggestion {
  projectId: string
  confidence: number
  reason: string
}

export interface Decision {
  id: string
  captureId: string
  action: RouterAction
  strandId: string | null
  secondaryStrandId: string | null
  createdStrandId: string | null
  intent: RouterIntent
  confidence: number
  tags: string[]
  rationale: string
  /** Proposed title and persona of a `new_strand` decision, null otherwise. */
  title: string | null
  personaId: string | null
  /** Project set on the strand a `new_strand` decision creates, null otherwise. */
  projectId: string | null
  /** Proposal for the target strand of an `append`/`link`, never applied. */
  projectSuggestion: ProjectSuggestion | null
  alternatives: DecisionAlternative[]
  /**
   * Topic part of the capture this decision belongs to (split-on-intake).
   * A capture that was not split has exactly one decision with `partIndex 0`
   * and `partCount 1`, and `partText` null: the part IS the capture text.
   */
  partIndex: number
  partCount: number
  /** Consolidated text of this part, null for a single part capture. */
  partText: string | null
  partTitle: string | null
  /** 1-based sentence numbers of the capture this part was built from. */
  sentenceIds: number[]
  state: DecisionState
  model: string | null
  latencyMs: number | null
  createdAt: string
  appliedAt: string | null
  resolvedAt: string | null
}

interface CaptureRow {
  id: string
  user_id: string
  agent_id: string | null
  client_message_id: string | null
  text: string
  kind: string
  source: string
  attachments: string | null
  status: string
  strand_id: string | null
  message_id: number | null
  created_at: string
  filed_at: string | null
}

interface DecisionRow {
  id: string
  capture_id: string
  action: string
  target_strand_id: string | null
  secondary_strand_id: string | null
  created_strand_id: string | null
  intent: string
  confidence: number
  alternatives: string | null
  tags: string | null
  rationale: string | null
  new_strand_title: string | null
  new_strand_persona: string | null
  new_strand_project: string | null
  project_suggestion: string | null
  model: string | null
  latency_ms: number | null
  state: string
  created_at: string
  applied_at: string | null
  resolved_at: string | null
  part_index: number
  part_count: number
  part_text: string | null
  part_title: string | null
  sentence_ids: string | null
}

const CAPTURE_COLUMNS = 'id, user_id, agent_id, client_message_id, text, kind, source, attachments, status, strand_id, message_id, created_at, filed_at'
const DECISION_COLUMNS = 'id, capture_id, action, target_strand_id, secondary_strand_id, created_strand_id, intent, confidence, alternatives, tags, rationale, new_strand_title, new_strand_persona, new_strand_project, project_suggestion, model, latency_ms, state, created_at, applied_at, resolved_at, part_index, part_count, part_text, part_title, sentence_ids'

/** A stored project suggestion; anything unreadable counts as absent. */
function parseProjectSuggestion(raw: string | null | undefined): ProjectSuggestion | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectSuggestion> | null
    if (!parsed || typeof parsed !== 'object' || typeof parsed.projectId !== 'string') return null
    return {
      projectId: parsed.projectId,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    }
  } catch {
    return null
  }
}

function toCapture(row: CaptureRow): Capture {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind as CaptureKind,
    source: row.source,
    agentId: row.agent_id ?? null,
    strandId: row.strand_id ?? null,
    messageId: row.message_id ?? null,
    status: row.status as CaptureStatus,
    createdAt: toIso(row.created_at) ?? row.created_at,
    filedAt: toIso(row.filed_at),
    attachments: parseJsonArray<UploadDescriptor>(row.attachments),
    clientMessageId: row.client_message_id ?? null,
  }
}

function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    captureId: row.capture_id,
    action: row.action as RouterAction,
    strandId: row.target_strand_id ?? null,
    secondaryStrandId: row.secondary_strand_id ?? null,
    createdStrandId: row.created_strand_id ?? null,
    intent: row.intent as RouterIntent,
    confidence: row.confidence,
    tags: parseJsonArray<string>(row.tags),
    rationale: row.rationale ?? '',
    title: row.new_strand_title ?? null,
    personaId: row.new_strand_persona ?? null,
    projectId: row.new_strand_project ?? null,
    projectSuggestion: parseProjectSuggestion(row.project_suggestion),
    alternatives: parseJsonArray<DecisionAlternative>(row.alternatives),
    partIndex: row.part_index ?? 0,
    partCount: row.part_count ?? 1,
    partText: row.part_text ?? null,
    partTitle: row.part_title ?? null,
    sentenceIds: parseJsonArray<number>(row.sentence_ids),
    state: row.state as DecisionState,
    model: row.model ?? null,
    latencyMs: row.latency_ms ?? null,
    createdAt: toIso(row.created_at) ?? row.created_at,
    appliedAt: toIso(row.applied_at),
    resolvedAt: toIso(row.resolved_at),
  }
}

export interface InsertCaptureInput {
  userId: string
  agentId: string | null
  clientMessageId: string | null
  text: string
  kind: CaptureKind
  source: string
  attachments: UploadDescriptor[]
  /** Explicit target; when set the capture is stored as filed without routing. */
  strandId?: string | null
}

export function insertCapture(db: Database, input: InsertCaptureInput): Capture {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO captures (id, user_id, agent_id, client_message_id, text, kind, source, attachments, status, strand_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    input.userId,
    input.agentId,
    input.clientMessageId,
    input.text,
    input.kind,
    input.source,
    input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
    input.strandId ?? null,
  )
  return getCapture(db, input.userId, id)!
}

export function getCapture(db: Database, userId: string, id: string): Capture | null {
  const row = db.prepare(`SELECT ${CAPTURE_COLUMNS} FROM captures WHERE user_id = ? AND id = ?`)
    .get(userId, id) as CaptureRow | undefined
  return row ? toCapture(row) : null
}

export function getCaptureByClientKey(db: Database, userId: string, clientMessageId: string): Capture | null {
  const row = db.prepare(`SELECT ${CAPTURE_COLUMNS} FROM captures WHERE user_id = ? AND client_message_id = ?`)
    .get(userId, clientMessageId) as CaptureRow | undefined
  return row ? toCapture(row) : null
}

export interface ListCapturesOptions {
  status?: CaptureStatus | 'all'
  limit?: number
  offset?: number
}

export function listCaptures(db: Database, userId: string, options: ListCapturesOptions = {}): Capture[] {
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)))
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const where = ['user_id = ?']
  const params: unknown[] = [userId]
  if (options.status && options.status !== 'all') {
    where.push('status = ?')
    params.push(options.status)
  } else {
    // `all` means "everything that still counts". A dismissed capture is out
    // of every list by definition — it is only reachable by asking for it by
    // name (`status=dismissed`), which is what keeps "nothing is lost" true
    // without putting the discarded card back in front of the user. A client
    // that filters the tray itself (the app reads `all` and keeps what is
    // `inTray`) is covered by this too, including older builds that do not
    // know the status yet.
    where.push("status != 'dismissed'")
  }
  const rows = db.prepare(
    `SELECT ${CAPTURE_COLUMNS} FROM captures WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as CaptureRow[]
  return rows.map(toCapture)
}

export function updateCapture(
  db: Database,
  id: string,
  patch: { status?: CaptureStatus; strandId?: string | null; messageId?: number | null; filedAt?: 'now' | null },
): void {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
  if (patch.strandId !== undefined) { sets.push('strand_id = ?'); params.push(patch.strandId) }
  if (patch.messageId !== undefined) { sets.push('message_id = ?'); params.push(patch.messageId) }
  if (patch.filedAt === 'now') sets.push("filed_at = datetime('now')")
  else if (patch.filedAt === null) sets.push('filed_at = NULL')
  if (sets.length === 0) return
  db.prepare(`UPDATE captures SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
}

export interface InsertDecisionInput {
  captureId: string
  action: RouterAction
  strandId: string | null
  secondaryStrandId: string | null
  createdStrandId?: string | null
  intent: RouterIntent
  confidence: number
  tags: string[]
  rationale: string
  title?: string | null
  personaId?: string | null
  projectId?: string | null
  projectSuggestion?: ProjectSuggestion | null
  alternatives: DecisionAlternative[]
  model: string | null
  latencyMs: number | null
  state: DecisionState
  /** Split-on-intake: omitted means the single part every capture had before. */
  partIndex?: number
  partCount?: number
  partText?: string | null
  partTitle?: string | null
  sentenceIds?: number[]
}

export function insertDecision(db: Database, input: InsertDecisionInput): Decision {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO router_decisions
       (id, capture_id, action, target_strand_id, secondary_strand_id, created_strand_id, intent, confidence,
        alternatives, tags, rationale, new_strand_title, new_strand_persona, new_strand_project, project_suggestion,
        model, latency_ms, state, applied_at, part_index, part_count, part_text, part_title, sentence_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.captureId,
    input.action,
    input.strandId,
    input.secondaryStrandId,
    input.createdStrandId ?? null,
    input.intent,
    input.confidence,
    JSON.stringify(input.alternatives),
    JSON.stringify(input.tags),
    input.rationale,
    input.title ?? null,
    input.personaId ?? null,
    input.projectId ?? null,
    input.projectSuggestion ? JSON.stringify(input.projectSuggestion) : null,
    input.model,
    input.latencyMs,
    input.state,
    input.state === 'applied' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
    input.partIndex ?? 0,
    input.partCount ?? 1,
    input.partText ?? null,
    input.partTitle ?? null,
    input.sentenceIds && input.sentenceIds.length > 0 ? JSON.stringify(input.sentenceIds) : null,
  )
  return getDecision(db, id)!
}

export function getDecision(db: Database, id: string): Decision | null {
  const row = db.prepare(`SELECT ${DECISION_COLUMNS} FROM router_decisions WHERE id = ?`).get(id) as DecisionRow | undefined
  return row ? toDecision(row) : null
}

/**
 * The current decision of a capture: the newest row of its FIRST part (undone
 * rows are superseded by the row written on undo).
 *
 * Scoped to part 0 since split-on-intake: a capture split into parts has one
 * decision per part, and every caller that asks for "the" decision means the
 * one the clients show at the top level. The other parts are read through
 * {@link getCurrentDecisionForPart} or {@link listCurrentDecisions}. For a
 * capture that was never split this is the same row as before, because all of
 * its decisions carry `part_index 0`.
 */
export function getCurrentDecision(db: Database, captureId: string): Decision | null {
  return getCurrentDecisionForPart(db, captureId, 0)
}

/** The newest decision row of one part of a capture. */
export function getCurrentDecisionForPart(db: Database, captureId: string, partIndex: number): Decision | null {
  const row = db.prepare(
    `SELECT ${DECISION_COLUMNS} FROM router_decisions WHERE capture_id = ? AND part_index = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(captureId, partIndex) as DecisionRow | undefined
  return row ? toDecision(row) : null
}

/** The newest decision row per part of one capture, by part index. */
export function listCurrentDecisions(db: Database, captureId: string): Decision[] {
  const rows = db.prepare(
    `SELECT ${DECISION_COLUMNS} FROM router_decisions WHERE capture_id = ?
     ORDER BY part_index ASC, created_at DESC, rowid DESC`,
  ).all(captureId) as DecisionRow[]
  const seen = new Set<number>()
  const out: Decision[] = []
  for (const row of rows) {
    const index = row.part_index ?? 0
    if (seen.has(index)) continue
    seen.add(index)
    out.push(toDecision(row))
  }
  return out
}

/** How many parts a capture currently has, from its part 0 decision. */
export function capturePartCount(db: Database, captureId: string): number {
  const row = db.prepare(
    `SELECT part_count FROM router_decisions WHERE capture_id = ? AND part_index = 0
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(captureId) as { part_count: number } | undefined
  return row?.part_count ?? 1
}

export function listDecisionsForCaptures(db: Database, captureIds: string[]): Decision[] {
  if (captureIds.length === 0) return []
  const placeholders = captureIds.map(() => '?').join(', ')
  const rows = db.prepare(
    `SELECT ${DECISION_COLUMNS} FROM router_decisions WHERE capture_id IN (${placeholders}) AND part_index = 0
     ORDER BY capture_id, created_at DESC, rowid DESC`,
  ).all(...captureIds) as DecisionRow[]
  const seen = new Set<string>()
  const out: Decision[] = []
  for (const row of rows) {
    if (seen.has(row.capture_id)) continue
    seen.add(row.capture_id)
    out.push(toDecision(row))
  }
  return out
}

/** The newest decision row per part for several captures, part order kept. */
export function listAllCurrentDecisions(db: Database, captureIds: string[]): Decision[] {
  if (captureIds.length === 0) return []
  const placeholders = captureIds.map(() => '?').join(', ')
  const rows = db.prepare(
    `SELECT ${DECISION_COLUMNS} FROM router_decisions WHERE capture_id IN (${placeholders})
     ORDER BY capture_id, part_index ASC, created_at DESC, rowid DESC`,
  ).all(...captureIds) as DecisionRow[]
  const seen = new Set<string>()
  const out: Decision[] = []
  for (const row of rows) {
    const key = `${row.capture_id}\u0000${row.part_index ?? 0}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(toDecision(row))
  }
  return out
}

export function updateDecision(
  db: Database,
  id: string,
  patch: { state?: DecisionState; createdStrandId?: string | null; strandId?: string | null; appliedAt?: 'now'; resolvedAt?: 'now' | null },
): void {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.state !== undefined) { sets.push('state = ?'); params.push(patch.state) }
  if (patch.createdStrandId !== undefined) { sets.push('created_strand_id = ?'); params.push(patch.createdStrandId) }
  if (patch.strandId !== undefined) { sets.push('target_strand_id = ?'); params.push(patch.strandId) }
  if (patch.appliedAt === 'now') sets.push("applied_at = datetime('now')")
  if (patch.resolvedAt === 'now') sets.push("resolved_at = datetime('now')")
  // Restoring a discarded capture puts its proposal back on the table, and a
  // proposal that carries a resolution timestamp is a contradiction.
  else if (patch.resolvedAt === null) sets.push('resolved_at = NULL')
  if (sets.length === 0) return
  db.prepare(`UPDATE router_decisions SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
}

// ---------------------------------------------------------------------------
// Resurface snoozes
// ---------------------------------------------------------------------------

export function snoozeStrand(db: Database, userId: string, strandId: string, days: number): void {
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  db.prepare(
    `INSERT INTO resurface_snoozes (user_id, strand_id, snoozed_until) VALUES (?, ?, ?)
     ON CONFLICT(user_id, strand_id) DO UPDATE SET snoozed_until = excluded.snoozed_until`,
  ).run(userId, strandId, until)
}

export function snoozedStrandIds(db: Database, userId: string): Set<string> {
  const rows = db.prepare(
    "SELECT strand_id FROM resurface_snoozes WHERE user_id = ? AND snoozed_until > datetime('now')",
  ).all(userId) as { strand_id: string }[]
  return new Set(rows.map(r => r.strand_id))
}
