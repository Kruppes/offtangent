/**
 * interaction-store.ts — the `interactions` table (Stufe 1, S1-A).
 *
 * ONE source of truth for the state of a question card ("Fragekarte"). Before
 * S1-A the state was spread over three heuristics (the answer map in
 * `chat_messages.metadata`, the stale rule in web/app, the LIKE scan in
 * `strand-attention.ts`); now every reader asks this table and every writer
 * goes through the transition functions below. This module is the only place
 * that writes `interactions` — with one documented exception that is defined
 * here as well: none. A genuine user message passes over the open cards of
 * its strand through {@link supersedeOpenOnUserMessage}, which every user
 * write path calls at its persist point (review 1, finding 6: the former SQL
 * trigger changed rows without an `interaction.updated` event).
 *
 * States and transitions (report.md 3.4/3.6, HANDOVER-S1):
 *
 *   open       -> answered   (answer)
 *   open       -> dismissed  (dismiss)                 no turn, state only
 *   open       -> superseded (user_continued | newer_question | backfill)
 *   open       -> expired    (timeout)
 *   answered, dismissed, superseded, expired: terminal (review 1, finding 4:
 *   strict contract — a passed-over card is no longer answerable). Anything
 *   else throws
 *   {@link InteractionTransitionError}.
 *
 * The payload is the block of the Core contract, validated with
 * `parseInteractionBlockPayload` on write AND on read — this module invents no
 * second schema.
 */
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Database } from './database.js'
import { isAskUserPayload, type AskUserAnswerItem, type AskUserPayload } from './contracts/ask-user.js'
import {
  extractAnswerableInteractionBlocks,
  interactionSkipReason,
  parseInteractionBlockPayload,
  readInteractionAnswers,
  type InteractionBlock,
} from './contracts/interaction-blocks.js'

export const INTERACTION_STATUSES = ['open', 'answered', 'dismissed', 'superseded', 'expired'] as const
export type InteractionStatus = typeof INTERACTION_STATUSES[number]

export const INTERACTION_CLOSE_SOURCES = ['answer', 'dismiss', 'user_continued', 'timeout', 'newer_question', 'backfill'] as const
export type InteractionCloseSource = typeof INTERACTION_CLOSE_SOURCES[number]

export const INTERACTION_SURFACES = ['web', 'android', 'telegram', 'api', 'system'] as const
export type InteractionSurface = typeof INTERACTION_SURFACES[number]

/** The stored answer. `clientRequestId` is the idempotency key of the request that produced it. */
export interface InteractionAnswer {
  value: string | string[]
  label: string
  answeredAt: string
  clientRequestId: string | null
  /** True when the answer started a turn. */
  resumed: boolean
  /** ask_user (S1-B): one entry per question with the chosen options and the comment. */
  items?: AskUserAnswerItem[]
}

export interface InteractionRecord {
  id: string
  strandId: string
  userId: number | null
  messageId: number
  toolCallId: string | null
  blockId: string | null
  agent: string
  /** A fence block (S1-A) or a normalized ask_user payload (S1-B, `kind: 'ask_user'`). */
  payload: InteractionBlock | AskUserPayload
  blocking: boolean
  status: InteractionStatus
  answer: InteractionAnswer | null
  draft: unknown
  createdAt: string
  expiresAt: string | null
  closedAt: string | null
  closedSurface: InteractionSurface | null
  closeSource: InteractionCloseSource | null
}

/** Every allowed edge, keyed `from>to`, with the close sources it accepts. */
const TRANSITIONS: Record<string, readonly InteractionCloseSource[]> = {
  'open>answered': ['answer'],
  'open>dismissed': ['dismiss'],
  'open>superseded': ['user_continued', 'newer_question', 'backfill'],
  'open>expired': ['timeout', 'backfill'],
}

export function isAllowedInteractionTransition(
  from: InteractionStatus,
  to: InteractionStatus,
  closeSource: InteractionCloseSource,
): boolean {
  return TRANSITIONS[`${from}>${to}`]?.includes(closeSource) ?? false
}

export class InteractionTransitionError extends Error {
  constructor(
    readonly interactionId: string,
    readonly from: InteractionStatus,
    readonly to: InteractionStatus,
    readonly closeSource: InteractionCloseSource,
  ) {
    super(`Interaction ${interactionId}: transition ${from} -> ${to} (${closeSource}) is not allowed`)
    this.name = 'InteractionTransitionError'
  }
}

export class InteractionPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InteractionPayloadError'
  }
}

/* ------------------------------------------------------------------ *
 * Events — the in-process bridge to the websocket frames
 * (`interaction.open`, `interaction.updated`, `interaction.draft`).
 * ------------------------------------------------------------------ */

export type InteractionEventType = 'open' | 'updated' | 'draft'
export interface InteractionEvent {
  type: InteractionEventType
  interaction: InteractionRecord
}

class InteractionEvents {
  private readonly emitter = new EventEmitter()
  constructor() {
    this.emitter.setMaxListeners(50)
  }
  on(listener: (event: InteractionEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => { this.emitter.off('event', listener) }
  }
  emit(event: InteractionEvent): void {
    // A broken listener must never undo a state change that is already committed.
    for (const listener of this.emitter.listeners('event') as Array<(e: InteractionEvent) => void>) {
      try { listener(event) } catch (error) {
        console.warn('[interactions] event listener failed:', error instanceof Error ? error.message : String(error))
      }
    }
  }
}

export const interactionEvents = new InteractionEvents()

/*
 * Outbox (review 1, finding 7; review 2, finding C): inside
 * {@link runInteractionTransaction} the events of every transition are
 * collected per transaction and emitted only after the COMMIT. A rollback
 * discards them, so no websocket frame ever shows a state that was not
 * persisted. The outbox stack hangs off the `db` object: a nested
 * `runInteractionTransaction` hands its events to the outer one, and only the
 * outermost one (the owner of the real transaction) emits.
 *
 * A transaction the outbox does not own (a caller's raw `db.transaction`)
 * cannot be observed to commit. Events produced inside it — through the
 * wrapper (a savepoint) or a bare transition — are therefore DROPPED with a
 * one-time warning, never sent before the commit. Callers that need the
 * events run their transaction through `runInteractionTransaction`.
 *
 * Delivery is best effort: the outbox lives in process memory, so a crash
 * between the commit and the emission loses those websocket events. The
 * table stays the truth; clients re-sync through the list endpoints.
 * Outside any transaction an event is emitted right after its own
 * (autocommitted) write.
 */
const outboxes = new WeakMap<Database, InteractionEvent[][]>()
let warnedForeignTransaction = false

function dropForeignTransactionEvents(events: InteractionEvent[]): void {
  if (events.length === 0 || warnedForeignTransaction) return
  warnedForeignTransaction = true
  console.warn(
    '[interactions] Interaction events inside a database transaction not owned by runInteractionTransaction were dropped '
    + '(never emitted before commit); wrap the outer transaction in runInteractionTransaction to keep them.',
  )
}

function emitInteractionEvent(db: Database, event: InteractionEvent): void {
  const stack = outboxes.get(db)
  if (stack && stack.length > 0) stack[stack.length - 1]!.push(event)
  else if (db.inTransaction) dropForeignTransactionEvents([event])
  else interactionEvents.emit(event)
}

/**
 * Run `fn` in one database transaction and emit the interaction events it
 * produced after the commit. Nested calls hand their events to the outer
 * transaction; a throw anywhere drops them together with the rollback. Inside
 * a foreign transaction (already `db.inTransaction`, no outer owner) the
 * events are dropped, never emitted before the foreign commit (review 2, C).
 */
export function runInteractionTransaction<T>(db: Database, fn: () => T): T {
  let stack = outboxes.get(db)
  if (!stack) { stack = []; outboxes.set(db, stack) }
  const foreign = stack.length === 0 && db.inTransaction
  const box: InteractionEvent[] = []
  stack.push(box)
  let result: T
  try {
    result = db.transaction(fn)()
  } finally {
    stack.pop()
  }
  if (stack.length > 0) stack[stack.length - 1]!.push(...box)
  else if (foreign) dropForeignTransactionEvents(box)
  else for (const event of box) interactionEvents.emit(event)
  return result
}

/** Test hook: re-arm the one-time warning for foreign transactions. */
export function resetInteractionOutboxWarning(): void {
  warnedForeignTransaction = false
}

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

/**
 * Additive migration. Columns follow report.md 3.4; `user_id` is added on top
 * so ownership checks and the attention query need no join (the strand row may
 * be gone, the card row must still say whose it was).
 */
export function ensureInteractionsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS interactions (
      id               TEXT PRIMARY KEY,
      strand_id        TEXT NOT NULL,
      user_id          INTEGER,
      message_id       INTEGER NOT NULL,
      tool_call_id     TEXT,
      block_id         TEXT,
      agent            TEXT NOT NULL,
      payload          TEXT NOT NULL,
      blocking         INTEGER NOT NULL DEFAULT 1,
      status           TEXT NOT NULL CHECK (status IN ('open','answered','dismissed','superseded','expired')),
      answer           TEXT,
      draft            TEXT,
      created_at       TEXT NOT NULL,
      expires_at       TEXT,
      closed_at        TEXT,
      closed_surface   TEXT CHECK (closed_surface IN ('web','android','telegram','api','system')),
      close_source     TEXT CHECK (close_source IN ('answer','dismiss','user_continued','timeout','newer_question','backfill'))
    );
    CREATE INDEX IF NOT EXISTS interactions_open ON interactions(strand_id) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS interactions_message ON interactions(message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS interactions_message_block
      ON interactions(message_id, block_id) WHERE block_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS interactions_tool_call
      ON interactions(tool_call_id) WHERE tool_call_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS interaction_migrations (
      version      TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL,
      stats        TEXT
    );
  `)
  // Review 1, finding 6: the former `interactions_user_continued` trigger
  // changed rows without an event. Stale rule 1 now runs through
  // `supersedeOpenOnUserMessage` at every user persist point; databases that
  // already carry the trigger lose it here.
  db.exec('DROP TRIGGER IF EXISTS interactions_user_continued')
  // Review 1, finding 3: an idempotency key (user, clientRequestId) is bound
  // to ONE card and ONE value. Reusing it for another card or value is a 409.
  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_requests (
      user_id           INTEGER NOT NULL,
      client_request_id TEXT NOT NULL,
      interaction_id    TEXT NOT NULL,
      value_hash        TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (user_id, client_request_id)
    );
  `)
}

/* ------------------------------------------------------------------ *
 * Idempotency keys (review 1, finding 3)
 * ------------------------------------------------------------------ */

/** Stable hash of an answer value: a multi-select is compared as given (order matters, as in `sameValue`). */
export function interactionValueHash(value: string | string[]): string {
  return createHash('sha256').update(JSON.stringify(typeof value === 'string' ? { s: value } : { a: value })).digest('hex')
}

/** Canonical JSON: object keys sorted at every level, arrays kept in order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * Value hash of an ask_user answer (S1-B): canonical JSON of the `answers`
 * object, keys sorted, so the key order of a retry does not matter. Same
 * idempotency rules as {@link interactionValueHash}.
 */
export function interactionAnswersHash(answers: unknown): string {
  return createHash('sha256').update(`ask_user:${canonicalJson(answers)}`).digest('hex')
}

export interface InteractionRequestBinding {
  interactionId: string
  valueHash: string
}

export function findInteractionRequest(db: Database, userId: number, clientRequestId: string): InteractionRequestBinding | null {
  const row = db.prepare(
    'SELECT interaction_id, value_hash FROM interaction_requests WHERE user_id = ? AND client_request_id = ?',
  ).get(userId, clientRequestId) as { interaction_id: string; value_hash: string } | undefined
  return row ? { interactionId: row.interaction_id, valueHash: row.value_hash } : null
}

/** Bind a key; returns the binding that holds afterwards (the existing one if the key was taken). */
export function bindInteractionRequest(
  db: Database,
  input: { userId: number; clientRequestId: string; interactionId: string; valueHash: string; now?: number },
): { bound: boolean; binding: InteractionRequestBinding } {
  const result = db.prepare(
    `INSERT INTO interaction_requests (user_id, client_request_id, interaction_id, value_hash, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, client_request_id) DO NOTHING`,
  ).run(input.userId, input.clientRequestId, input.interactionId, input.valueHash, new Date(input.now ?? Date.now()).toISOString())
  if (result.changes === 1) return { bound: true, binding: { interactionId: input.interactionId, valueHash: input.valueHash } }
  return { bound: false, binding: findInteractionRequest(db, input.userId, input.clientRequestId)! }
}

/* ------------------------------------------------------------------ *
 * Ids
 * ------------------------------------------------------------------ */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** `ia_<ulid>`: 48 bit time + 80 bit randomness, Crockford base32, sortable. */
export function newInteractionId(now: number = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const bytes = randomBytes(16)
  let rand = ''
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32]
  return `ia_${time}${rand}`
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

interface InteractionRow {
  id: string
  strand_id: string
  user_id: number | null
  message_id: number
  tool_call_id: string | null
  block_id: string | null
  agent: string
  payload: string
  blocking: number
  status: InteractionStatus
  answer: string | null
  draft: string | null
  created_at: string
  expires_at: string | null
  closed_at: string | null
  closed_surface: InteractionSurface | null
  close_source: InteractionCloseSource | null
}

function parseJson(text: string | null): unknown {
  if (text === null) return null
  try { return JSON.parse(text) } catch { return null }
}

function validatePayload(payload: unknown): InteractionBlock | AskUserPayload {
  // ask_user payloads are normalized by `parseAskUserArgs` before they are
  // written (S1-B); the stored shape is trusted, the fence contract does not apply.
  if (isAskUserPayload(payload)) return payload
  const block = parseInteractionBlockPayload(payload)
  if (!block) throw new InteractionPayloadError('Interaction payload does not satisfy the interaction block contract')
  if (block.kind === 'draft') throw new InteractionPayloadError('A draft block is not a question')
  return block
}

function toRecord(row: InteractionRow): InteractionRecord {
  return {
    id: row.id,
    strandId: row.strand_id,
    userId: row.user_id,
    messageId: row.message_id,
    toolCallId: row.tool_call_id,
    blockId: row.block_id,
    agent: row.agent,
    payload: validatePayload(parseJson(row.payload)),
    blocking: row.blocking === 1,
    status: row.status,
    answer: parseJson(row.answer) as InteractionAnswer | null,
    draft: parseJson(row.draft),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    closedAt: row.closed_at,
    closedSurface: row.closed_surface,
    closeSource: row.close_source,
  }
}

const SELECT = 'SELECT * FROM interactions'

export function getInteraction(db: Database, id: string): InteractionRecord | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as InteractionRow | undefined
  return row ? toRecord(row) : null
}

export function findInteractionByBlock(db: Database, messageId: number, blockId: string): InteractionRecord | null {
  const row = db.prepare(`${SELECT} WHERE message_id = ? AND block_id = ?`).get(messageId, blockId) as InteractionRow | undefined
  return row ? toRecord(row) : null
}

export function listInteractionsForMessage(db: Database, messageId: number): InteractionRecord[] {
  return (db.prepare(`${SELECT} WHERE message_id = ? ORDER BY created_at ASC, id ASC`).all(messageId) as InteractionRow[]).map(toRecord)
}

export function listStrandInteractions(
  db: Database,
  strandId: string,
  options: { status?: InteractionStatus; now?: number } = {},
): InteractionRecord[] {
  expireDueInteractions(
    db,
    db.prepare(`${SELECT} WHERE strand_id = ? AND status = 'open' AND expires_at IS NOT NULL`).all(strandId) as InteractionRow[],
    options.now ?? Date.now(),
  )
  const rows = options.status
    ? db.prepare(`${SELECT} WHERE strand_id = ? AND status = ? ORDER BY message_id ASC, id ASC`).all(strandId, options.status)
    : db.prepare(`${SELECT} WHERE strand_id = ? ORDER BY message_id ASC, id ASC`).all(strandId)
  return (rows as InteractionRow[]).map(toRecord)
}

/**
 * Open cards of many strands of one user (attention). Rows whose `expiresAt`
 * has passed are closed as `expired / timeout` first (lazy expiry, see
 * `expireDueInteractions`), so they are not returned.
 */
export function listOpenInteractionsForStrands(
  db: Database,
  strandIds: string[],
  userId: number,
  now: number = Date.now(),
): InteractionRecord[] {
  if (strandIds.length === 0) return []
  const placeholders = strandIds.map(() => '?').join(',')
  expireDueInteractions(
    db,
    db.prepare(
      `${SELECT} WHERE strand_id IN (${placeholders}) AND user_id = ? AND status = 'open' AND expires_at IS NOT NULL`,
    ).all(...strandIds, userId) as InteractionRow[],
    now,
  )
  const rows = db.prepare(
    `${SELECT} WHERE strand_id IN (${placeholders}) AND user_id = ? AND status = 'open'
       ORDER BY message_id ASC, id ASC`,
  ).all(...strandIds, userId) as InteractionRow[]
  // Belt and braces: a row a concurrent writer kept open is still not shown.
  return rows.map(toRecord).filter(record => !record.expiresAt || Date.parse(record.expiresAt) > now)
}

/**
 * Lazy expiry (S1-A): there is no sweeper job. Whenever open cards are read
 * (attention, `GET /api/strands/:id/interactions`), every `open` row whose
 * `expiresAt` lies at or before `now` is moved to `expired` with close source
 * `timeout` through `transitionInteraction` — the one door, so it emits
 * `interaction.updated` like every other state change. `closed_at` is the
 * expiry moment itself, the same value the backfill writes. A row another
 * writer closed in between is skipped. Returns the expired rows.
 */
export function expireDueInteractions(
  db: Database,
  rows: ReadonlyArray<{ id: string; status: InteractionStatus; expires_at: string | null }>,
  now: number = Date.now(),
): InteractionRecord[] {
  const expired: InteractionRecord[] = []
  for (const row of rows) {
    if (row.status !== 'open' || !row.expires_at) continue
    const at = Date.parse(row.expires_at)
    if (!Number.isFinite(at) || at > now) continue
    try {
      expired.push(transitionInteraction(db, row.id, 'expired', { closeSource: 'timeout', closedSurface: 'system', now: at }))
    } catch (err) {
      if (!(err instanceof InteractionTransitionError)) throw err
    }
  }
  return expired
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Expiry before supersede (review 2, finding B): every open card of the
 * strand whose `expiresAt` lies at or before `now` becomes `expired /
 * timeout` first, so the live stale paths only supersede cards that were
 * still answerable. Runs in the caller's transaction.
 */
function expireDueInStrand(db: Database, strandId: string, now: number): InteractionRecord[] {
  return expireDueInteractions(
    db,
    db.prepare(`${SELECT} WHERE strand_id = ? AND status = 'open' AND expires_at IS NOT NULL`).all(strandId) as InteractionRow[],
    now,
  )
}

export interface CreateInteractionInput {
  strandId: string
  userId: number | null
  messageId: number
  agent: string
  /** Raw block payload; validated with `parseInteractionBlockPayload`. */
  payload: unknown
  toolCallId?: string | null
  blockId?: string | null
  blocking?: boolean
  createdAt?: string
  now?: number
}

/**
 * Create an open card. Idempotent per (message, block) and per tool call: a
 * second call returns the existing row unchanged. Stale rule 2 is applied in
 * the same transaction: older open cards of the strand become
 * `superseded (newer_question)`.
 */
export function createInteraction(db: Database, input: CreateInteractionInput): { record: InteractionRecord; created: boolean } {
  const block = validatePayload(input.payload)
  const blockId = input.blockId === undefined ? block.id : input.blockId
  const now = input.now ?? Date.now()
  const nowIso = new Date(now).toISOString()
  const id = newInteractionId(now)

  return runInteractionTransaction(db, (): { record: InteractionRecord; created: boolean } => {
    const existing = blockId !== null
      ? db.prepare(`${SELECT} WHERE message_id = ? AND block_id = ?`).get(input.messageId, blockId) as InteractionRow | undefined
      : input.toolCallId
        ? db.prepare(`${SELECT} WHERE tool_call_id = ?`).get(input.toolCallId) as InteractionRow | undefined
        : undefined
    if (existing) return { record: toRecord(existing), created: false }

    // Expired before superseded (review 2, finding B).
    expireDueInStrand(db, input.strandId, now)
    const older = db.prepare(
      // Strictly older messages only: several cards of ONE message stay open
      // side by side, as in the shared stale rule (per message id, S0-B/B4).
      `SELECT id FROM interactions WHERE strand_id = ? AND status = 'open' AND message_id < ?`,
    ).all(input.strandId, input.messageId) as Array<{ id: string }>
    for (const row of older) {
      const updated = applyTransition(db, row.id, 'superseded', { closeSource: 'newer_question', closedSurface: 'system', now })
      emitInteractionEvent(db, { type: 'updated', interaction: updated })
    }

    db.prepare(
      `INSERT INTO interactions (id, strand_id, user_id, message_id, tool_call_id, block_id, agent, payload, blocking,
                                 status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      id, input.strandId, input.userId, input.messageId, input.toolCallId ?? null, blockId, input.agent,
      JSON.stringify(block), input.blocking === false ? 0 : 1, input.createdAt ?? nowIso, block.expiresAt ?? null,
    )
    const record = getInteraction(db, id)!
    emitInteractionEvent(db, { type: 'open', interaction: record })
    return { record, created: true }
  })
}

interface TransitionOptions {
  closeSource: InteractionCloseSource
  closedSurface?: InteractionSurface | null
  answer?: InteractionAnswer
  now?: number
}

/** The edge itself, without emitting. Optimistic: a concurrent writer makes it throw. */
function applyTransition(db: Database, id: string, to: InteractionStatus, options: TransitionOptions): InteractionRecord {
  const current = db.prepare('SELECT status FROM interactions WHERE id = ?').get(id) as { status: InteractionStatus } | undefined
  if (!current) throw new Error(`Interaction ${id} does not exist`)
  if (!isAllowedInteractionTransition(current.status, to, options.closeSource)) {
    throw new InteractionTransitionError(id, current.status, to, options.closeSource)
  }
  if (to === 'answered' && !options.answer) throw new Error('An answered interaction needs an answer')
  const closedAt = new Date(options.now ?? Date.now()).toISOString()
  const result = db.prepare(
    `UPDATE interactions
        SET status = ?, close_source = ?, closed_surface = ?, closed_at = ?,
            answer = COALESCE(?, answer), draft = CASE WHEN ? = 'answered' THEN NULL ELSE draft END
      WHERE id = ? AND status = ?`,
  ).run(
    to, options.closeSource, options.closedSurface ?? null, closedAt,
    options.answer ? JSON.stringify(options.answer) : null, to, id, current.status,
  )
  if (result.changes !== 1) {
    const now = db.prepare('SELECT status FROM interactions WHERE id = ?').get(id) as { status: InteractionStatus }
    throw new InteractionTransitionError(id, now.status, to, options.closeSource)
  }
  return getInteraction(db, id)!
}

/** The one door for every state change of a card. Emits `interaction.updated`. */
export function transitionInteraction(
  db: Database,
  id: string,
  to: InteractionStatus,
  options: TransitionOptions,
): InteractionRecord {
  const record = applyTransition(db, id, to, options)
  emitInteractionEvent(db, { type: 'updated', interaction: record })
  return record
}

/**
 * Stale rule 1 (S0-B/B4) at the persist point of a genuine user message
 * (review 1, finding 6): every open card of the strand above the new message
 * becomes `superseded (user_continued)` through {@link transitionInteraction},
 * so each change emits `interaction.updated`. Same strand, cards of the same
 * user or without owner, across agents (the strand-wide stale rule). Without
 * `beforeMessageId` every open card of the strand qualifies.
 */
export function supersedeOpenOnUserMessage(
  db: Database,
  strandId: string,
  userId: number | null,
  beforeMessageId?: number | null,
  now: number = Date.now(),
): InteractionRecord[] {
  return runInteractionTransaction(db, () => {
    // Expired before superseded (review 2, finding B), in the same transaction.
    expireDueInStrand(db, strandId, now)
    const rows = db.prepare(
      `SELECT id FROM interactions
        WHERE strand_id = ? AND status = 'open' AND (? IS NULL OR message_id < ?)
          AND (user_id IS NULL OR user_id = ?)
        ORDER BY message_id ASC, id ASC`,
    ).all(strandId, beforeMessageId ?? null, beforeMessageId ?? null, userId) as Array<{ id: string }>
    const superseded: InteractionRecord[] = []
    for (const row of rows) {
      try {
        superseded.push(transitionInteraction(db, row.id, 'superseded', { closeSource: 'user_continued', closedSurface: 'system', now }))
      } catch (err) {
        if (!(err instanceof InteractionTransitionError)) throw err
      }
    }
    return superseded
  })
}

/** Record whether the answer of a card started its turn (review 1, finding 9). */
export function markInteractionResumed(db: Database, id: string, resumed: boolean): InteractionRecord {
  const current = getInteraction(db, id)
  if (!current?.answer) throw new Error(`Interaction ${id} has no answer`)
  db.prepare('UPDATE interactions SET answer = ? WHERE id = ?').run(JSON.stringify({ ...current.answer, resumed }), id)
  const record = getInteraction(db, id)!
  emitInteractionEvent(db, { type: 'updated', interaction: record })
  return record
}

/** Partial answers, readable from every device. Only while the card can still be answered. */
export function saveInteractionDraft(db: Database, id: string, draft: unknown): InteractionRecord {
  const current = getInteraction(db, id)
  if (!current) throw new Error(`Interaction ${id} does not exist`)
  if (current.status !== 'open') {
    throw new InteractionTransitionError(id, current.status, current.status, 'answer')
  }
  db.prepare('UPDATE interactions SET draft = ? WHERE id = ? AND status = ?')
    .run(draft === null || draft === undefined ? null : JSON.stringify(draft), id, current.status)
  const record = getInteraction(db, id)!
  emitInteractionEvent(db, { type: 'draft', interaction: record })
  return record
}

/* ------------------------------------------------------------------ *
 * Live path: an assistant row that carries fence cards
 * ------------------------------------------------------------------ */

export interface IngestMessageInput {
  messageId: number
  strandId: string
  userId: number | null
  agent: string
  content: string
  now?: number
  /** Creation time of the row, ISO; defaults to `now` (the message was just written). */
  createdAt?: string
}

/**
 * Create a row for every answerable fence card of a freshly persisted
 * assistant message. Idempotent. Returns the records (new or existing).
 */
export function ingestInteractionMessage(db: Database, input: IngestMessageInput): InteractionRecord[] {
  if (!input.content || !input.content.includes('offtangent')) return []
  const records: InteractionRecord[] = []
  for (const block of extractAnswerableInteractionBlocks(input.content)) {
    if (block.kind === 'draft') continue
    records.push(createInteraction(db, {
      strandId: input.strandId,
      userId: input.userId,
      messageId: input.messageId,
      agent: input.agent,
      payload: block,
      blockId: block.id,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    }).record)
  }
  return records
}

/* ------------------------------------------------------------------ *
 * Backfill of the legacy markdown cards (report.md 3.9 step 1)
 * ------------------------------------------------------------------ */
// The owner of a card is the message owner, else the strand owner
// (sessions.user_id); review 1, finding 1. Imported answer labels are stored
// raw: the table is the raw source, the response/frame is the boundary that
// seals them (review 1, finding 2).

export const INTERACTION_BACKFILL_VERSION = 's1a-backfill-v1'

export interface InteractionBackfillStats {
  scannedMessages: number
  inserted: number
  answered: number
  superseded: number
  expired: number
  open: number
  skippedExisting: number
}

interface LegacyMessageRow {
  id: number
  session_id: string
  user_id: number | null
  agent_id: string | null
  content: string
  metadata: string | null
  timestamp: string | null
  session_exists: number | null
}

function toIso(timestamp: string | null, fallback: string): string {
  if (!timestamp) return fallback
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(timestamp) ? timestamp : `${timestamp.replace(' ', 'T')}Z`
  const at = Date.parse(normalized)
  return Number.isFinite(at) ? new Date(at).toISOString() : fallback
}

/**
 * One-time import of every legacy card in `chat_messages`. Guarded by a
 * marker row in `interaction_migrations`; a second run is a no-op (and even
 * without the marker the unique (message_id, block_id) index keeps it
 * idempotent). The status follows the shared stale rule of S0-B/B4:
 *
 *   answered in metadata          -> answered   (close_source answer)
 *   expiresAt in the past         -> expired    (timeout)
 *     (expired BEFORE superseded on purpose: the merged S0-B client — fixture
 *     and Kotlin — ranks `expired` above `skipped`, and the web/app contract
 *     wins over report.md 3.x, which asked answered > superseded > expired;
 *     review 1, finding 5)
 *   strand row gone               -> superseded (backfill)
 *   later genuine user turn       -> superseded (user_continued)
 *   newer open card in the strand -> superseded (newer_question)
 *   otherwise                     -> open
 */
export function backfillInteractions(
  db: Database,
  options: { now?: number; force?: boolean } = {},
): { ran: boolean; stats: InteractionBackfillStats } {
  const stats: InteractionBackfillStats = { scannedMessages: 0, inserted: 0, answered: 0, superseded: 0, expired: 0, open: 0, skippedExisting: 0 }
  const marker = db.prepare('SELECT version FROM interaction_migrations WHERE version = ?').get(INTERACTION_BACKFILL_VERSION)
  if (marker && !options.force) return { ran: false, stats }
  const now = options.now ?? Date.now()
  const nowIso = new Date(now).toISOString()

  const run = db.transaction(() => {
    const rows = db.prepare(
      `SELECT m.id, m.session_id,
              COALESCE(m.user_id, (SELECT s.user_id FROM sessions s WHERE s.id = m.session_id)) AS user_id, m.agent_id, m.content, m.metadata, m.timestamp,
              (SELECT 1 FROM sessions s WHERE s.id = m.session_id) AS session_exists
         FROM chat_messages m
        WHERE m.role = 'assistant' AND m.content LIKE '%offtangent%'
        ORDER BY m.session_id ASC, m.id ASC`,
    ).all() as LegacyMessageRow[]

    const lastUserTurn = new Map<string, number>()
    for (const row of db.prepare(
      `SELECT session_id, MAX(id) AS last_id FROM chat_messages WHERE role = 'user' GROUP BY session_id`,
    ).all() as Array<{ session_id: string; last_id: number }>) lastUserTurn.set(row.session_id, row.last_id)

    type Candidate = { row: LegacyMessageRow; block: InteractionBlock; answered: ReturnType<typeof readInteractionAnswers>[string] | null }
    const candidates: Candidate[] = []
    const newestOpenAt = new Map<string, number>()
    for (const row of rows) {
      stats.scannedMessages += 1
      const answers = readInteractionAnswers(row.metadata)
      for (const block of extractAnswerableInteractionBlocks(row.content)) {
        if (block.kind === 'draft') continue
        const answered = answers[block.id] ?? null
        candidates.push({ row, block, answered })
        const expired = !!block.expiresAt && Date.parse(block.expiresAt) <= now
        if (!answered && !expired) {
          newestOpenAt.set(row.session_id, Math.max(newestOpenAt.get(row.session_id) ?? row.id, row.id))
        }
      }
    }

    const insert = db.prepare(
      `INSERT INTO interactions (id, strand_id, user_id, message_id, tool_call_id, block_id, agent, payload, blocking,
                                 status, answer, created_at, expires_at, closed_at, closed_surface, close_source)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, block_id) WHERE block_id IS NOT NULL DO NOTHING`,
    )
    for (const { row, block, answered } of candidates) {
      const createdAt = toIso(row.timestamp, nowIso)
      let status: InteractionStatus = 'open'
      let closeSource: InteractionCloseSource | null = null
      let closedAt: string | null = null
      let answer: InteractionAnswer | null = null
      if (answered) {
        status = 'answered'
        closeSource = 'answer'
        closedAt = toIso(answered.answeredAt, createdAt)
        answer = {
          value: answered.value,
          label: answered.label,
          answeredAt: answered.answeredAt,
          clientRequestId: answered.clientMessageId || null,
          resumed: answered.resumed,
        }
      } else if (block.expiresAt && Date.parse(block.expiresAt) <= now) {
        status = 'expired'
        closeSource = 'timeout'
        closedAt = toIso(block.expiresAt, nowIso)
      } else if (!row.session_exists) {
        status = 'superseded'
        closeSource = 'backfill'
        closedAt = nowIso
      } else {
        const skip = interactionSkipReason({
          at: row.id,
          lastUserTurnAt: lastUserTurn.get(row.session_id) ?? null,
          newestCardAt: newestOpenAt.get(row.session_id) ?? null,
        })
        if (skip) {
          status = 'superseded'
          closeSource = skip === 'later_user_turn' ? 'user_continued' : 'newer_question'
          closedAt = nowIso
        }
      }
      const result = insert.run(
        newInteractionId(Date.parse(createdAt) || now), row.session_id, row.user_id, row.id, block.id, row.agent_id ?? 'main',
        JSON.stringify(block), status, answer ? JSON.stringify(answer) : null, createdAt, block.expiresAt ?? null,
        closedAt, closeSource === null ? null : 'system', closeSource,
      )
      if (result.changes !== 1) { stats.skippedExisting += 1; continue }
      stats.inserted += 1
      stats[status as 'open' | 'answered' | 'superseded' | 'expired'] += 1
    }
    db.prepare(
      `INSERT INTO interaction_migrations (version, completed_at, stats) VALUES (?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET completed_at = excluded.completed_at, stats = excluded.stats`,
    ).run(INTERACTION_BACKFILL_VERSION, nowIso, JSON.stringify(stats))
  })
  run()
  return { ran: true, stats }
}
