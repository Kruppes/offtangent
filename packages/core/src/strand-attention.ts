/**
 * strand-attention.ts: the "awaiting you" state of a strand (plan
 * 2026-09-26).
 *
 * `unread` (strand-read-state.ts) answers "did something happen here". It
 * disappears the moment the strand is opened. That is not enough for the one
 * case that actually costs the user something: a strand that is BLOCKED on an
 * answer. Those are two different states and they need two different signals,
 * so this module derives the second one:
 *
 *   attention = the still-open question of the strand that is still LIVE, or
 *               null
 *
 * Exactly two sources count, both of them exact signals — no prose heuristic,
 * a question inside a sentence is deliberately NOT attention:
 *
 *   - `kind: 'interaction'`   — an interactive block (SPEC 7.4c) that
 *     `POST /api/interactions` would still accept an answer for.
 *   - `kind: 'task_question'` — a background task of this strand that is
 *     `status = 'paused'` with `result_status = 'question'`, i.e. exactly the
 *     state `POST /api/tasks/:id/reply` resumes (`task-reply.ts`).
 *
 * Answerability vs. attention (this replaces the older "one question, one
 * implementation" rule, which said the two were the same question):
 *
 *   attention = answerable AND not stale
 *
 * The answerable half is NOT decided here. It is `resolveInteractionBlockState`
 * in `contracts/interaction-blocks.ts`, the same function
 * `POST /api/interactions` uses for its 409/410 — a badge over a card the
 * endpoint refuses is still the failure mode this module must avoid, and
 * nothing in here changes what the endpoint accepts. The staleness half is
 * attention-only and lives here: a card that lost its badge stays fully
 * answerable in the chat. That asymmetry is deliberate and it only goes one
 * way. A clickable card without a badge costs nothing; a badge on a question
 * from last week is the bug this module was measured on (live data
 * 2026-09-26: 6 of 6 "awaiting" cards of the main user were 0.4–8.3 days old,
 * 5 of them already followed by 1–21 later user messages).
 *
 * The three staleness rules for `kind: 'interaction'`, all attention-only:
 *
 *   1. Superseded by the user: a later genuine user turn in the same strand
 *      (`role = 'user'`, same `user_id`, higher `chat_messages.id`) clears the
 *      card. The user answered in prose or moved on, and id order is used
 *      because the timestamps are second-resolution.
 *   2. Superseded by a newer card: only the NEWEST open card of a strand can
 *      be attention — the newest open question represents the strand, older
 *      open cards below it are history.
 *   3. Age limit: a card older than the configured age (`settings.json` ›
 *      `offtangent.attentionMaxAgeHours`, default 48 h) is not
 *      attention any more.
 *
 * `kind: 'task_question'` gets rule 3 only. Rule 1 does not apply: a paused
 * task is really blocked until somebody replies to it, no amount of chatting
 * in the strand unblocks it. Rule 2 does not apply either (there is no
 * "newer" question superseding it).
 *
 * What counts as a "genuine user turn" for rule 1 (read from the write paths,
 * not assumed): only web chat (`routes/chat.ts`, `ws-chat.ts`), Telegram
 * inbound text/attachments (`telegram/bot.ts`), a filed capture
 * (`captures/service.ts`) and an answered interaction card
 * (`interactions/service.ts`, metadata `type: 'interaction_answer'`) write
 * `role = 'user'` rows. Everything the system injects is stored under a
 * different role: task results and task questions as `role = 'system'`
 * (`task-notification.ts`), task injection answers, task transcripts and file
 * deliveries as `'assistant'`/`'tool'`, model changes, session dividers, turn
 * errors and stall warnings as `'system'` — and a reminder cronjob writes no
 * `chat_messages` row at all (it logs a `tool_calls` row and broadcasts).
 * So the `role = 'user'` filter alone is what "the user acted" means; no
 * metadata exception is needed.
 *
 * Cost: the whole list is answered in a bounded number of queries (three per
 * chunk of 400 strand ids), never one per strand — same rule as
 * `getStrandReadStates`.
 */
import type { Database } from './database.js'
import { loadConfig, warnConfigReadFailed } from './config.js'
import { parseAttentionMaxAgeHours } from './contracts/settings.js'
import {
  extractAnswerableInteractionBlocks,
  resolveInteractionBlockState,
  type InteractionBlock,
} from './contracts/interaction-blocks.js'
import { timestampSortKey, toIsoUtcOrNull } from './timestamps.js'

export type StrandAttentionKind = 'interaction' | 'task_question'

export interface StrandAttention {
  kind: StrandAttentionKind
  /** When the question appeared, ISO-8601 UTC. */
  since: string
  /** The question, single line, whitespace collapsed, at most 120 characters. */
  prompt: string
  /** Message carrying the block, for `kind: 'interaction'`, else null. */
  messageId: number | null
  /** Paused task, for `kind: 'task_question'`, else null. */
  taskId: string | null
}

/** See {@link getStrandReadStates}: SQLite's parameter limit with a margin. */
const ID_CHUNK = 400

/** Contract: `prompt` is a single line a list row can render without measuring. */
export const ATTENTION_PROMPT_MAX = 120

/**
 * How long an open question can stay "waiting on you" when nothing else says
 * otherwise. Two days covers a weekend; beyond that the question is stale by
 * definition — either the user decided without the card or the context is gone.
 *
 * The limit is configurable, in this precedence:
 *
 *   1. `options.maxAgeMs` — per call (tests, `Number.POSITIVE_INFINITY` = off)
 *   2. `settings.json` › `offtangent.attentionMaxAgeHours` — the user setting,
 *      integer 1–720 h, edited on the settings page or by hand
 *   3. `AXIOM_ATTENTION_MAX_AGE_MS` (ms) — deployment fallback, same env
 *      pattern as `AXIOM_TURN_INACTIVITY_MS` in `agent-runtime.ts`
 *   4. this constant
 */
export const ATTENTION_MAX_AGE_MS = 48 * 60 * 60 * 1000

const MS_PER_HOUR = 60 * 60 * 1000

/** The `offtangent` block as this module reads it — nothing else is needed. */
export interface AttentionMaxAgeSettings {
  offtangent?: { attentionMaxAgeHours?: unknown }
}

/**
 * `offtangent.attentionMaxAgeHours` as milliseconds, or `null` when the file
 * has no usable value. Forgiving on read, exactly like `resolveNowSetMax`:
 * missing, malformed or out-of-range falls through to the next source instead
 * of failing a request (`PUT /api/settings` is what rejects a bad value, so
 * only a hand edit can put one in the file).
 */
export function loadAttentionMaxAgeMs(settings?: AttentionMaxAgeSettings): number | null {
  let source = settings
  if (!source) {
    try {
      source = loadConfig<AttentionMaxAgeSettings>('settings.json')
    } catch (err) {
      warnConfigReadFailed('settings.json', err)
      return null
    }
  }
  const hours = parseAttentionMaxAgeHours(source.offtangent?.attentionMaxAgeHours)
  return hours === null ? null : hours * MS_PER_HOUR
}

/**
 * The age limit in force, see {@link ATTENTION_MAX_AGE_MS} for the precedence.
 * Settings and env are read per call, not at import: a change in `settings.json`
 * applies to the next request without a restart, and tests need no module reset.
 */
export function resolveAttentionMaxAgeMs(
  override?: number,
  settings?: AttentionMaxAgeSettings,
): number {
  if (override !== undefined && override > 0) return override
  const fromSettings = loadAttentionMaxAgeMs(settings)
  if (fromSettings !== null) return fromSettings
  const raw = Number(process.env.AXIOM_ATTENTION_MAX_AGE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : ATTENTION_MAX_AGE_MS
}

interface BlockMessageRow {
  id: number
  session_id: string
  content: string
  metadata: string | null
  timestamp: string | null
}

interface PausedTaskRow {
  id: string
  session_id: string
  parent_session_id: string | null
  name: string
  result_summary: string | null
  started_at: string | null
  created_at: string | null
}

export interface StrandAttentionOptions {
  /**
   * The user the strands belong to. Required, not optional: the interaction
   * endpoint answers 404 for a message whose `user_id` is somebody else's, so
   * a block row of a foreign user must not produce attention either, however
   * the strand id was obtained.
   */
  userId: number
  /** Test seam for `expiresAt` and the age limit; defaults to now. */
  now?: number
  /**
   * Age limit for an open question, in milliseconds. Defaults to
   * `offtangent.attentionMaxAgeHours`, then `AXIOM_ATTENTION_MAX_AGE_MS`, then
   * {@link ATTENTION_MAX_AGE_MS}. Values <= 0 are ignored (they would silently
   * switch attention off); `Number.POSITIVE_INFINITY` disables the limit.
   */
  maxAgeMs?: number
  /**
   * Settings already in hand, to skip the `settings.json` read. Callers that
   * have no settings object pass nothing: this module then reads the file ONCE
   * per call, never once per strand.
   */
  settings?: AttentionMaxAgeSettings
}

/**
 * One line, collapsed whitespace, at most {@link ATTENTION_PROMPT_MAX}
 * characters with an ellipsis. The clients render this into a single row, so
 * the truncation happens once here instead of once per client.
 */
export function formatAttentionPrompt(raw: string | null | undefined): string {
  const collapsed = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= ATTENTION_PROMPT_MAX) return collapsed
  return `${collapsed.slice(0, ATTENTION_PROMPT_MAX - 1).trimEnd()}…`
}

/**
 * Attention state for many strands at once. Ids without an open question are
 * simply absent from the map — the API renders `attention: null` for them.
 *
 * Three queries per chunk of ids: the messages that carry an interactive
 * fence, the newest genuine user turn per strand (rule 1 of the staleness
 * rules in the module header), and the paused tasks of those strands. All
 * three are filtered in SQL, parsed in memory, and the winner per strand is
 * the oldest `since` of the surviving candidates.
 */
export function getStrandAttentions(
  db: Database,
  strandIds: string[],
  options: StrandAttentionOptions,
): Map<string, StrandAttention> {
  const attentions = new Map<string, StrandAttention>()
  if (strandIds.length === 0) return attentions
  const now = options.now ?? Date.now()
  const maxAgeMs = resolveAttentionMaxAgeMs(options.maxAgeMs, options.settings)
  const isFresh = (since: string): boolean => {
    const at = Date.parse(since)
    return Number.isFinite(at) ? now - at <= maxAgeMs : false
  }

  for (let offset = 0; offset < strandIds.length; offset += ID_CHUNK) {
    const chunk = strandIds.slice(offset, offset + ID_CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')

    // Only rows that can possibly carry a block reach the parser. The LIKE is
    // exactly the parser's own precondition (`content.includes('offtangent')`
    // in `extractAnswerableInteractionBlocks`) and SQLite's LIKE is
    // case-insensitive on ASCII, so it is strictly wider than the parser: it
    // cannot drop a block the parser would have accepted. A narrower pattern
    // with the backticks would miss a four-backtick fence, which the fence
    // regex (three-or-more backticks, optional spaces, offtangent) accepts.
    //
    // No `role` filter on purpose: `POST /api/interactions` does not look at
    // the role either (it refuses a message by OWNER, not by role), and the
    // rule of this module is to mirror that endpoint rather than to invent a
    // narrower one.
    const blockRows = db.prepare(
      `SELECT m.id AS id, m.session_id AS session_id, m.content AS content,
              m.metadata AS metadata, m.timestamp AS timestamp
         FROM chat_messages m
        WHERE m.session_id IN (${placeholders})
          AND m.user_id = ?
          AND m.content LIKE '%offtangent%'
        ORDER BY m.timestamp ASC, m.id ASC`,
    ).all(...chunk, options.userId) as BlockMessageRow[]

    // Rule 1 of the staleness rules: the newest genuine user turn per strand.
    // `role = 'user'` is the whole test — see the module header for the write
    // paths that produce such a row and for why nothing the system injects
    // ever does. `MAX(id)`, not `MAX(timestamp)`: the timestamps are
    // second-resolution, so a card and the answer typed in the same second are
    // only ordered by id.
    const lastUserTurnRows = db.prepare(
      `SELECT m.session_id AS session_id, MAX(m.id) AS last_user_message_id
         FROM chat_messages m
        WHERE m.session_id IN (${placeholders})
          AND m.user_id = ?
          AND m.role = 'user'
        GROUP BY m.session_id`,
    ).all(...chunk, options.userId) as Array<{ session_id: string; last_user_message_id: number }>
    const lastUserTurn = new Map<string, number>()
    for (const row of lastUserTurnRows) lastUserTurn.set(row.session_id, row.last_user_message_id)

    // Rule 2: only the newest open card of a strand can be attention. The rows
    // arrive oldest first, so the last open one per strand wins.
    const newestOpenCard = new Map<string, { row: BlockMessageRow; block: InteractionBlock }>()
    for (const row of blockRows) {
      const open = firstOpenBlock(row, options.now)
      if (!open) continue
      const held = newestOpenCard.get(row.session_id)
      if (!held || row.id > held.row.id) newestOpenCard.set(row.session_id, { row, block: open })
    }

    for (const [strandId, { row, block }] of newestOpenCard) {
      const since = toIsoUtcOrNull(row.timestamp)
      if (!since) continue
      // Rule 1. An older card of the same strand cannot survive this either:
      // its id is smaller, so the same user turn is newer than it as well.
      const lastUserMessageId = lastUserTurn.get(strandId)
      if (lastUserMessageId !== undefined && lastUserMessageId > row.id) continue
      // Rule 3.
      if (!isFresh(since)) continue
      consider(attentions, strandId, {
        kind: 'interaction',
        since,
        prompt: formatAttentionPrompt(block.question),
        messageId: row.id,
        taskId: null,
      })
    }

    // How a task hangs off a strand (read from `task-runner.ensureTaskSession`
    // and `task-tree.tasksBySessionLineage`, not guessed): a task gets its OWN
    // session, whose `parent_session_id` is the strand it was started from —
    // `tasks.session_id` is that task session, NOT the strand. Both shapes are
    // accepted here: the parent link (every task started from a strand) and a
    // direct `session_id = strand` (the shape `hasLiveTaskForStrand` checks).
    //
    // Deliberately only ONE hop. A sub-task of a task asks its parent AGENT,
    // not the human — its pause is answered by the task that spawned it, so
    // counting it as "awaiting you" would put a badge on a strand the user
    // cannot clear.
    //
    // `paused` + `question` is precisely the state `POST /api/tasks/:id/reply`
    // resumes; every other status either runs or is done.
    const chunkSet = new Set(chunk)
    const taskRows = db.prepare(
      `SELECT t.id AS id, t.session_id AS session_id, ts.parent_session_id AS parent_session_id,
              t.name AS name, t.result_summary AS result_summary,
              t.started_at AS started_at, t.created_at AS created_at
         FROM tasks t
         JOIN sessions ts ON ts.id = t.session_id
        WHERE (t.session_id IN (${placeholders}) OR ts.parent_session_id IN (${placeholders}))
          AND t.status = 'paused'
          AND t.result_status = 'question'`,
    ).all(...chunk, ...chunk) as PausedTaskRow[]

    for (const row of taskRows) {
      const strandId = chunkSet.has(row.session_id) ? row.session_id : row.parent_session_id
      if (!strandId || !chunkSet.has(strandId)) continue
      // There is no `paused_at` column and this feature adds none (no schema
      // change): the run started before it asked, so `started_at` is the
      // closest honest lower bound, with `created_at` as the fallback for a
      // row that never recorded a start. `completed_at` exists but the pause
      // path (`TaskRunner`, `status: 'paused'` + `resultStatus: 'question'`)
      // never writes it, so it is always NULL here and useless as a clock.
      const since = toIsoUtcOrNull(row.started_at) ?? toIsoUtcOrNull(row.created_at)
      if (!since) continue
      // Age limit (rule 3), the only staleness rule a task question gets: it
      // stays blocked until somebody replies, so no later user turn clears it
      // — but a question from last week is not "waiting on you" any more
      // either.
      if (!isFresh(since)) continue
      consider(attentions, strandId, {
        kind: 'task_question',
        since,
        // The question the task left is its result summary; a run that paused
        // without one still has a name, which beats an empty row.
        prompt: formatAttentionPrompt(row.result_summary ?? row.name),
        messageId: null,
        taskId: row.id,
      })
    }
  }

  return attentions
}

/** Attention of a single strand. Thin wrapper over {@link getStrandAttentions}. */
export function getStrandAttention(
  db: Database,
  strandId: string,
  options: StrandAttentionOptions,
): StrandAttention | null {
  return getStrandAttentions(db, [strandId], options).get(strandId) ?? null
}

/**
 * Every non-archived strand id of a user (or all of them with
 * `includeArchived`), for the counts that must not be cut off by the 100-per-
 * page cap of the list endpoint.
 *
 * The predicate mirrors `SessionManager.listThreads` exactly — interactive
 * type, either owner column, archived flag — because a strand the list shows
 * must be a strand the summary counts.
 */
export function listStrandIdsForAttention(
  db: Database,
  userId: number,
  options: { includeArchived?: boolean } = {},
): string[] {
  const where = ["type = 'interactive'", '(session_user = ? OR CAST(user_id AS TEXT) = ?)']
  if (!options.includeArchived) where.push('archived = 0')
  const rows = db.prepare(
    `SELECT id FROM sessions WHERE ${where.join(' AND ')}`,
  ).all(String(userId), String(userId)) as Array<{ id: string }>
  return rows.map(row => row.id)
}

export interface StrandAttentionSummary {
  /** Strands with an open question. */
  awaiting: number
  /** Strands with unread non-user activity. */
  unread: number
  /** The awaiting strand with the oldest `since`, or null. */
  firstAwaitingStrandId: string | null
}

/**
 * The oldest open question of a set of strands, by `since`. Ties (same second,
 * which second-resolution timestamps make common) are broken deterministically
 * by strand id so two calls never disagree about `firstAwaitingStrandId`.
 */
export function firstAwaitingStrandId(attentions: Map<string, StrandAttention>): string | null {
  let bestId: string | null = null
  let bestKey = Number.MAX_SAFE_INTEGER
  for (const [strandId, attention] of attentions) {
    const key = timestampSortKey(attention.since)
    if (key < bestKey || (key === bestKey && bestId !== null && strandId < bestId)) {
      bestKey = key
      bestId = strandId
    }
  }
  return bestId
}

/**
 * Keep the oldest open question per strand. Same tie-break idea as
 * {@link firstAwaitingStrandId}: on an equal timestamp the incoming candidate
 * does not displace the stored one, so the order of the two queries above
 * cannot change the answer.
 */
function consider(
  attentions: Map<string, StrandAttention>,
  strandId: string,
  candidate: StrandAttention,
): void {
  const existing = attentions.get(strandId)
  if (!existing) {
    attentions.set(strandId, candidate)
    return
  }
  if (timestampSortKey(candidate.since) < timestampSortKey(existing.since)) {
    attentions.set(strandId, candidate)
  }
}

/**
 * The first still-answerable block of a message, or null. Rendering keeps one
 * card per message, but answering accepts every well-formed block, so the
 * answering view is the one that decides here.
 */
function firstOpenBlock(row: BlockMessageRow, now?: number): InteractionBlock | null {
  if (!row.content) return null
  for (const block of extractAnswerableInteractionBlocks(row.content)) {
    const state = resolveInteractionBlockState(block, row.metadata, now === undefined ? {} : { now })
    if (state.closedReason === null) return block
  }
  return null
}
