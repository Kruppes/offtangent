/**
 * strand-fork.ts: branching a strand instead of cutting it.
 *
 * A strand is a thought that lives over time. Sometimes it stops being ONE
 * thought: the Gmail integration strand grows a privacy discussion that has
 * its own questions, its own decisions and its own lifetime. Until now the
 * only answer was a capture through the user API — the agent itself had no way
 * to say "this belongs somewhere else", so the side path stayed in the strand
 * and every following turn paid for its history in tokens.
 *
 * A fork is that answer, and it is deliberately NOT a copy:
 *
 * - the new strand starts with ONE message, the `seed` the agent writes itself
 *   (a condensed handoff). That is the whole point: the token and context win
 *   comes from NOT carrying the parent transcript over,
 * - the lineage is persisted on the new strand (`parent_strand_id`,
 *   `forked_at`, `forked_from_message_id`), so a client can draw the way back,
 * - the parent keeps a visible row (`role = 'system'`, metadata
 *   `strand_forked`) naming the child, so the jump works in both directions
 *   even in a plain text export,
 * - a `strand_links` row (`kind = 'reference'`) is written too, so the fork
 *   shows up in the `links` count the strand list already carries.
 *
 * The tree is a tree by construction: a fork always creates a FRESH session
 * id, so no `parent_strand_id` edge can ever point at an ancestor. The chain
 * walk in {@link forkDepthOf} still carries a visited set and a hard step
 * limit, because "cannot happen" is exactly the assumption that rots — a
 * restored backup, a manual UPDATE or a future feature that re-parents a
 * strand would otherwise hang a request in an endless loop.
 *
 * Depth is capped ({@link MAX_FORK_DEPTH}) so a runaway model cannot build an
 * infinitely deep chain, and the auto-run cascade is capped by
 * {@link isForkStartedRun}: a turn that was itself started by a fork may fork
 * again, but its forks are created dormant.
 */
import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import { captureLanguage, type CaptureLanguage } from './capture-router.js'
import { getLatestSessionSummary } from './session-summary-store.js'
import { createStrandLink } from './strand-store.js'
import type { SessionSummary } from './session-summary-schema.js'

/** Longest lineage chain a fork may create (root strand = depth 0). */
export const MAX_FORK_DEPTH = 5
/** Forks one turn (or one background task run) may create. */
export const MAX_FORKS_PER_TURN = 3
/** Hard step limit of the lineage walk, see the file header. */
const LINEAGE_WALK_LIMIT = 64
/** Seed length ceiling: a handoff, not a transcript copy. */
export const FORK_SEED_MAX = 8000
export const FORK_TITLE_MAX = 80

/** Metadata `type` of the seed row in the new strand. */
export const FORK_SEED_METADATA_TYPE = 'strand_fork_seed'
/** Metadata `type` of the pointer row left in the parent strand. */
export const FORK_NOTICE_METADATA_TYPE = 'strand_forked'

export type ForkStrandErrorCode =
  | 'parent_not_found'
  | 'parent_archived'
  | 'invalid_title'
  | 'invalid_seed'
  | 'fork_depth_exceeded'
  | 'fork_lineage_cycle'

export class ForkStrandError extends Error {
  constructor(readonly code: ForkStrandErrorCode, message: string) {
    super(message)
    this.name = 'ForkStrandError'
  }
}

/** The slice of `SessionManager` a fork needs; keeps this module testable. */
export interface ForkSessionManagerLike {
  createThread(userId: string, agentId?: string, title?: string | null, projectId?: string | null): { id: string }
  getThread(userId: string, strandId: string): {
    id: string
    agentId: string
    title: string | null
    archived: boolean
    projectId: string | null
  } | null
}

export interface ForkStrandInput {
  db: Database
  sessions: ForkSessionManagerLike
  /** Numeric user id of the owner of the parent strand (`users.id`). */
  userId: number | string
  /** The strand the fork branches off. */
  parentStrandId: string
  title: string
  seed: string
  /** Append the parent's latest structured summary to the seed (default false). */
  includeParentSummary?: boolean
  /** Keep the parent's project (default true). */
  inheritProject?: boolean
  /** Whether a turn is going to run in the new strand (only recorded here). */
  autoRun?: boolean
}

export interface StrandFork {
  strandId: string
  title: string
  agentId: string
  parentStrandId: string
  parentTitle: string | null
  forkedAt: string
  forkedFromMessageId: number | null
  /** Depth of the NEW strand (a fork of a root strand has depth 1). */
  depth: number
  projectId: string | null
  /** The seed row in the new strand, or null when the turn writes it. */
  seedMessageId: number | null
  /** The pointer row in the parent strand. */
  noticeMessageId: number
  /** The `strand_links` row connecting parent and child. */
  linkId: string
  /** The seed text as it was stored / as it is handed to the turn. */
  seedText: string
  autoRun: boolean
}

export interface StrandForkLineage {
  parentStrandId: string | null
  forkedAt: string | null
  forkedFromMessageId: number | null
}

const EMPTY_LINEAGE: StrandForkLineage = { parentStrandId: null, forkedAt: null, forkedFromMessageId: null }

interface LineageRow {
  parent_strand_id: string | null
  forked_at: string | null
  forked_from_message_id: number | null
}

/** Lineage of one strand, `null` fields for a strand nobody forked. */
export function getStrandForkLineage(db: Database, strandId: string): StrandForkLineage {
  const row = db.prepare(
    'SELECT parent_strand_id, forked_at, forked_from_message_id FROM sessions WHERE id = ?',
  ).get(strandId) as LineageRow | undefined
  if (!row) return EMPTY_LINEAGE
  return {
    parentStrandId: row.parent_strand_id ?? null,
    forkedAt: row.forked_at ?? null,
    forkedFromMessageId: row.forked_from_message_id ?? null,
  }
}

/**
 * Direct children of a strand, oldest fork first. Only interactive sessions
 * are children — a fork never creates anything else.
 *
 * Two forks of the same strand can share one `forked_at` (same millisecond,
 * and `started_at` only has second resolution), so the tie is broken by
 * `rowid` — the insertion order, which IS the fork order. Breaking it by `id`
 * would order siblings by random UUID.
 */
export function listChildStrandIds(db: Database, strandId: string): string[] {
  const rows = db.prepare(
    `SELECT id FROM sessions
     WHERE parent_strand_id = ? AND type = 'interactive'
     ORDER BY COALESCE(forked_at, started_at) ASC, rowid ASC`,
  ).all(strandId) as { id: string }[]
  return rows.map(row => row.id)
}

/**
 * Lineage depth of a strand: 0 for a strand that was never forked, 1 for a
 * fork of such a strand, and so on. A broken chain (missing parent) ends the
 * walk; a cycle throws instead of looping forever.
 */
export function forkDepthOf(db: Database, strandId: string): number {
  const seen = new Set<string>([strandId])
  let depth = 0
  let current = getStrandForkLineage(db, strandId).parentStrandId
  while (current) {
    if (seen.has(current)) {
      throw new ForkStrandError('fork_lineage_cycle', `Strand lineage of ${strandId} contains a cycle at ${current}`)
    }
    seen.add(current)
    depth += 1
    if (depth > LINEAGE_WALK_LIMIT) {
      throw new ForkStrandError('fork_lineage_cycle', `Strand lineage of ${strandId} is deeper than ${LINEAGE_WALK_LIMIT}`)
    }
    current = getStrandForkLineage(db, current).parentStrandId
  }
  return depth
}

/**
 * True while the current turn of `strandId` is the run a fork started
 * (`run_agent: true`): the strand is itself a fork and the seed is still the
 * only user message in it.
 *
 * This is the whole cascade brake. A fork-started run may create further
 * forks — a side path can genuinely branch again — but it may not start their
 * agent runs, so a chain of automatic runs stops after exactly one hop. The
 * user's next message in the forked strand lifts the brake, because from then
 * on the strand is a normal conversation again.
 */
export function isForkStartedRun(db: Database, strandId: string): boolean {
  if (!getStrandForkLineage(db, strandId).parentStrandId) return false
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ? AND role = 'user'",
  ).get(strandId) as { c: number }
  return row.c <= 1
}

/** Last message id of a strand, the anchor a fork points back at. */
function lastMessageIdOf(db: Database, strandId: string): number | null {
  const row = db.prepare('SELECT MAX(id) AS id FROM chat_messages WHERE session_id = ?')
    .get(strandId) as { id: number | null } | undefined
  return row?.id ?? null
}

function renderSummary(summary: SessionSummary): string | null {
  const lines: string[] = []
  if (summary.goal) lines.push(`Goal: ${summary.goal}`)
  if (summary.decisions.length) lines.push('Decisions:', ...summary.decisions.map(d => `- ${d}`))
  if (summary.open.length) lines.push('Open:', ...summary.open.map(o => `- ${o}`))
  if (summary.artifacts.length) lines.push(`Artifacts: ${summary.artifacts.join(', ')}`)
  if (summary.next.length) lines.push(`Next: ${summary.next.join('; ')}`)
  return lines.length > 0 ? lines.join('\n') : null
}

const SEED_HEADER: Record<CaptureLanguage, (title: string | null) => string> = {
  de: title => `Abgezweigt aus dem Strand ${title ? `"${title}"` : '(ohne Titel)'}:`,
  en: title => `Forked from the strand ${title ? `"${title}"` : '(untitled)'}:`,
}

const SUMMARY_HEADER: Record<CaptureLanguage, string> = {
  de: 'Zusammenfassung des Ursprungs-Strands:',
  en: 'Summary of the original strand:',
}

const NOTICE_TEXT: Record<CaptureLanguage, (title: string, strandId: string) => string> = {
  de: (title, strandId) => `↳ Abgezweigt nach: "${title}" (Strand ${strandId})`,
  en: (title, strandId) => `↳ Forked into: "${title}" (strand ${strandId})`,
}

/**
 * The text the new strand starts with: the agent's own handoff, prefixed with
 * one line naming the origin (so the model knows why it is here even when the
 * client shows no lineage chip yet) and optionally the parent's summary.
 *
 * The language follows the seed, exactly as the capture cards follow the
 * capture — a German handoff with an English header reads like a bug.
 */
export function buildForkSeedText(input: {
  seed: string
  parentTitle: string | null
  parentSummary?: string | null
}): string {
  const language = captureLanguage(input.seed)
  const parts = [SEED_HEADER[language](input.parentTitle), '', input.seed.trim()]
  if (input.parentSummary) {
    parts.push('', '---', SUMMARY_HEADER[language], input.parentSummary)
  }
  return parts.join('\n')
}

/** The pointer line left in the parent strand. */
export function buildForkNoticeText(input: { title: string; strandId: string; seed: string }): string {
  return NOTICE_TEXT[captureLanguage(input.seed)](input.title, input.strandId)
}

function normalizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new ForkStrandError('invalid_title', 'title must be a string')
  const title = raw.replace(/\s+/g, ' ').trim()
  if (title.length === 0) throw new ForkStrandError('invalid_title', 'title must not be empty')
  if (title.length > FORK_TITLE_MAX) {
    throw new ForkStrandError('invalid_title', `title must be at most ${FORK_TITLE_MAX} characters`)
  }
  return title
}

function normalizeSeed(raw: unknown): string {
  if (typeof raw !== 'string') throw new ForkStrandError('invalid_seed', 'seed must be a string')
  const seed = raw.trim()
  if (seed.length === 0) throw new ForkStrandError('invalid_seed', 'seed must not be empty')
  if (seed.length > FORK_SEED_MAX) {
    throw new ForkStrandError(
      'invalid_seed',
      `seed must be at most ${FORK_SEED_MAX} characters (got ${seed.length}) — condense it instead of copying the strand`,
    )
  }
  return seed
}

/**
 * Create the fork. Ownership is NOT a parameter the caller can widen: the
 * parent is read through `getThread(userId, id)`, which returns null for a
 * foreign strand, and the new strand is created for the same `userId` and the
 * same persona. A tool argument for the owner would be a cross-user write
 * primitive.
 *
 * With `autoRun` the seed is NOT written here: the turn runner persists the
 * user message itself, and two rows with the same text would be worse than
 * none. The caller starts that turn with {@link StrandFork.seedText}.
 */
export function forkStrand(input: ForkStrandInput): StrandFork {
  const { db, sessions } = input
  const userId = String(input.userId)
  const title = normalizeTitle(input.title)
  const seed = normalizeSeed(input.seed)

  const parent = sessions.getThread(userId, input.parentStrandId)
  if (!parent) {
    throw new ForkStrandError('parent_not_found', `Strand ${input.parentStrandId} not found for this user`)
  }
  if (parent.archived) {
    throw new ForkStrandError('parent_archived', 'An archived strand cannot be forked')
  }

  const parentDepth = forkDepthOf(db, parent.id)
  if (parentDepth + 1 > MAX_FORK_DEPTH) {
    throw new ForkStrandError(
      'fork_depth_exceeded',
      `Fork lineage would be ${parentDepth + 1} levels deep, the limit is ${MAX_FORK_DEPTH}`,
    )
  }

  const inheritProject = input.inheritProject !== false
  const parentSummary = input.includeParentSummary
    ? renderSummary(getLatestSessionSummary(db, parent.id)?.summary ?? { goal: '', decisions: [], open: [], artifacts: [], next: [] })
    : null
  const seedText = buildForkSeedText({ seed, parentTitle: parent.title, parentSummary })
  const forkedFromMessageId = lastMessageIdOf(db, parent.id)
  const autoRun = input.autoRun === true

  // The project is validated by `createThread`; an unusable one must not cost
  // the fork, so it degrades to "no project" exactly like a capture does.
  let child: { id: string }
  try {
    child = sessions.createThread(userId, parent.agentId, title, inheritProject ? parent.projectId : null)
  } catch {
    child = sessions.createThread(userId, parent.agentId, title, null)
  }

  const forkedAt = new Date().toISOString()
  const numericUser = Number(userId)
  const messageUserId = Number.isFinite(numericUser) ? numericUser : null

  const write = db.transaction(() => {
    db.prepare(
      'UPDATE sessions SET parent_strand_id = ?, forked_at = ?, forked_from_message_id = ? WHERE id = ?',
    ).run(parent.id, forkedAt, forkedFromMessageId, child.id)

    // A pinned model is a decision the user made about this line of thought,
    // so the branch inherits it. Nothing is chosen automatically here, which
    // is why the data-policy gate has nothing to say about a fork.
    const pin = db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?')
      .get(parent.id) as { model_provider_id: string | null; model_id: string | null } | undefined
    if (pin?.model_provider_id && pin.model_id) {
      db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?')
        .run(pin.model_provider_id, pin.model_id, child.id)
    }

    let seedMessageId: number | null = null
    if (!autoRun) {
      const result = db.prepare(
        `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id)
         VALUES (?, ?, 'user', ?, ?, ?)`,
      ).run(
        child.id,
        messageUserId,
        seedText,
        JSON.stringify({
          type: FORK_SEED_METADATA_TYPE,
          parentStrandId: parent.id,
          parentTitle: parent.title,
          forkedFromMessageId,
        }),
        parent.agentId,
      )
      seedMessageId = Number(result.lastInsertRowid)
    }

    const notice = db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id)
       VALUES (?, ?, 'system', ?, ?, ?)`,
    ).run(
      parent.id,
      messageUserId,
      buildForkNoticeText({ title, strandId: child.id, seed }),
      JSON.stringify({
        type: FORK_NOTICE_METADATA_TYPE,
        childStrandId: child.id,
        childTitle: title,
        autoRun,
      }),
      parent.agentId,
    )

    const linkId = createStrandLink(db, { fromStrand: parent.id, toStrand: child.id, kind: 'reference' })
    return { seedMessageId, noticeMessageId: Number(notice.lastInsertRowid), linkId }
  })

  const written = write.immediate()

  return {
    strandId: child.id,
    title,
    agentId: parent.agentId,
    parentStrandId: parent.id,
    parentTitle: parent.title,
    forkedAt,
    forkedFromMessageId,
    depth: parentDepth + 1,
    projectId: inheritProject ? parent.projectId : null,
    seedMessageId: written.seedMessageId,
    noticeMessageId: written.noticeMessageId,
    linkId: written.linkId,
    seedText,
    autoRun,
  }
}

/**
 * Per-turn fork budget, held in memory and keyed by the scope the caller
 * names: the live turn for an interactive run, the task id for a background
 * run. Deliberately not a database counter — the limit protects against a
 * runaway loop inside ONE run, and a restart is not a loop.
 */
export class ForkBudget {
  private counts = new Map<string, number>()
  /** Insertion-ordered ring so a long-lived process cannot grow this map. */
  private readonly maxScopes = 200

  constructor(private readonly limit: number = MAX_FORKS_PER_TURN) {}

  /** Forks already created in this scope. */
  used(scope: string): number {
    return this.counts.get(scope) ?? 0
  }

  remaining(scope: string): number {
    return Math.max(0, this.limit - this.used(scope))
  }

  /**
   * Give a slot back. A call that failed VALIDATION (an empty seed, a title
   * that is too long) created nothing, so it must not cost the run a fork —
   * otherwise a model that fixes its arguments and retries runs out of budget
   * for work it never did.
   */
  refund(scope: string): void {
    const used = this.used(scope)
    if (used > 0) this.counts.set(scope, used - 1)
  }

  /** Take one slot; false when the scope is exhausted. */
  take(scope: string): boolean {
    const used = this.used(scope)
    if (used >= this.limit) return false
    this.counts.set(scope, used + 1)
    while (this.counts.size > this.maxScopes) {
      const oldest = this.counts.keys().next()
      if (oldest.done) break
      this.counts.delete(oldest.value)
    }
    return true
  }
}

/** A stable id for a fork scope that has no turn and no task (tests, CLI). */
export function anonymousForkScope(): string {
  return `anon:${randomUUID()}`
}
