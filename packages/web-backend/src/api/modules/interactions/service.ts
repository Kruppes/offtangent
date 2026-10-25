/**
 * Answering an interactive block (SPEC 7.4c).
 *
 *   POST /api/interactions { messageId, blockId, value, clientMessageId }
 *     -> 200 { applied: true, resumed }
 *        409 { code: 'already_answered', value }   (the card shows the old answer)
 *        410 { code: 'stale' }                     (the turn/strand is gone)
 *
 * Three things happen on a successful answer, in this order:
 *
 *  1. The answer is recorded in the `chat_messages.metadata` of the message
 *     that CARRIES the block. No schema change: the column exists, and the
 *     card rebuilds its collapsed chip from it after a reload.
 *  2. The chosen label is filed as an ordinary user message in the same
 *     strand — exactly what typing the answer would have produced, so the
 *     transcript reads the same in every channel. `client_message_id` carries
 *     the caller's idempotency key, so the partial unique index makes a retry
 *     a no-op at the database level too.
 *  3. If a turn runner is available, the turn is resumed with that text
 *     (`resumed: true`). Without one the answer is filed and nothing runs,
 *     which is the same degradation the captures path takes.
 */
import {
  createInteraction,
  findAnswerableInteractionBlock,
  findInteractionByBlock,
  getInteraction,
  InteractionTransitionError,
  readInteractionAnswers,
  listStrandInteractions,
  saveInteractionDraft,
  runInteractionTransaction,
  supersedeOpenOnUserMessage,
  markInteractionResumed,
  interactionValueHash,
  interactionAnswersHash,
  isAskUserPayload,
  validateAskUserAnswer,
  formatAskUserAnswerBlock,
  type AskUserAnswerInput,
  type AskUserAnswerItem,
  type AskUserPayload,
  findInteractionRequest,
  bindInteractionRequest,
  sealText,
  transitionInteraction,
  type InteractionBlock,
  type InteractionRecord,
  type InteractionStatus,
  type InteractionSurface,
  validateInteractionAnswer,
  withInteractionAnswer,
  type Database,
  type InteractionAnswerRecord,
} from '@axiom/core'
import type { AnswerInteractionBody } from './schema.js'
import { sealedInteraction, sealInteractionValue } from '../../../interaction-seal.js'

export class InteractionServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'InteractionServiceError'
  }
}

/** Minimal turn starter, mirroring the captures module so no wiring changes. */
export interface InteractionTurnStarter {
  startTurn: (input: {
    userId: number
    sessionId: string
    text: string
    source: string
    agentId: string
    explicitSessionId: string
    /** Recorded on the strand turn (statistics). */
    inputMode?: 'typed' | 'voice' | 'answer' | null
    /** S1-B: the ask_user interaction this turn answers. */
    replyToInteractionId?: string | null
  }) => unknown
  /**
   * S1-D: hand an already formatted block to the RUNNING turn of the strand
   * as an interjection (steer). Optional: without it a non-blocking answer
   * waits for the next turn as a context note.
   */
  offerSteerToLiveTurn?: (input: {
    agentUserId: string
    agentId?: string
    sessionId: string
    text: string
    source?: string
    preformatted?: boolean
  }) => { accepted: true; turnId: string; settled: Promise<boolean> } | { accepted: false; reason: string }
}

/**
 * A block the captures module owns (the "filed as a note — or should I answer
 * it?" card). Its two options are not ordinary chat answers: keeping the note
 * must run NO turn at all, and answering it must run the turn on the capture
 * text, not on the label the user tapped. So the captures service resolves
 * them itself and this module only stays the one door for every card.
 */
export interface CaptureBlockConfirmer {
  confirmNoteFiling: (
    userId: number,
    input: { captureId: string; blockId: string; choice: string },
  ) => { handled: boolean; resumed: boolean }
}

export interface InteractionsServiceOptions {
  db: Database
  getTurnRunner?: () => InteractionTurnStarter | null
  /** Captures service, for blocks that hang off a capture. Optional: without it every block takes the generic path. */
  getCaptureConfirmer?: () => CaptureBlockConfirmer | null
  /** Tell other clients of this user that the card was answered. */
  broadcast?: (input: {
    userId: number
    sessionId: string
    agentId: string
    messageId: number
    blockId: string
    label: string
  }) => void
}

export interface AnswerInteractionResult {
  applied: true
  resumed: boolean
  /** True when this exact `clientMessageId` had already been applied. */
  idempotent: boolean
  value: string | string[]
  label: string
  /** S1-A: the row of the `interactions` table, after the answer (payload sealed). */
  interaction?: InteractionStateView
  /** S1-D: a non-blocking answer was handed to the running turn as an interjection. */
  steered?: { turnId: string }
}

/**
 * Write responses (answer, dismiss, draft, 409 bodies) and the list carry the
 * row with its payload sealed (privacy V3): the payload is assistant text
 * that never passed the boundary, so an option label with a credential would
 * otherwise leak back out of the very answer that sealed it. See
 * `interaction-seal.ts`.
 */
export type InteractionStateView = InteractionRecord

export function interactionStateView(record: InteractionRecord): InteractionStateView {
  return sealedInteraction(record)
}

/**
 * Who calls (review 1, finding 1). A card or strand without owner
 * (`user_id IS NULL`) is visible only to an admin; for everyone else it is
 * the same 404 as a missing one. A bare number is a non-admin user.
 */
export type InteractionActor = number | { userId: number; admin?: boolean }

function actorOf(actor: InteractionActor): { userId: number; admin: boolean } {
  return typeof actor === 'number' ? { userId: actor, admin: false } : { userId: actor.userId, admin: actor.admin === true }
}

export function canSeeOwner(actor: InteractionActor, ownerId: number | null | undefined): boolean {
  const a = actorOf(actor)
  if (ownerId === null || ownerId === undefined) return a.admin
  return ownerId === a.userId
}

/** Body of `POST /api/interactions/:id/answer` (S1-A). */
export interface AnswerByIdInput {
  /** Fence card: an option id or a list of them. */
  value?: string | string[]
  /** ask_user card (S1-B): one entry per question id. */
  answers?: Record<string, AskUserAnswerInput>
  clientRequestId: string
  surface: InteractionSurface
  /**
   * S1-C: run the answer turn on this starter instead of the server's runner.
   * Telegram passes its own, so the reply lands in the chat the card was
   * answered in. Same state machine and idempotency either way.
   */
  startTurn?: InteractionTurnStarter['startTurn']
}

interface BlockMessageRow {
  id: number
  session_id: string
  user_id: number | null
  content: string
  metadata: string | null
  agent_id: string | null
  capture_id: string | null
  session_exists: number | null
}

export interface InteractionsService {
  /** Legacy door `POST /api/interactions` (message id + block id). Writes into the table. */
  answer: (actor: InteractionActor, body: AnswerInteractionBody, surface?: InteractionSurface) => AnswerInteractionResult
  /** `POST /api/interactions/:id/answer` (S1-A). */
  answerById: (actor: InteractionActor, id: string, input: AnswerByIdInput) => AnswerInteractionResult
  /** `POST /api/interactions/:id/dismiss` (S1-A): state only, never a turn. */
  dismiss: (actor: InteractionActor, id: string, surface: InteractionSurface) => { interaction: InteractionStateView; idempotent: boolean }
  /** `PUT /api/interactions/:id/draft` (S1-A). */
  saveDraft: (actor: InteractionActor, id: string, draft: unknown) => InteractionStateView
  /** `GET /api/strands/:id/interactions` (S1-A). */
  listForStrand: (actor: InteractionActor, strandId: string, status?: InteractionStatus) => InteractionRecord[]
}

export function createInteractionsService(options: InteractionsServiceOptions): InteractionsService {
  const { db } = options
  // S1-C: the turn starter of the answer currently being applied (set only
  // for the synchronous duration of one answerById call).
  let callStarter: InteractionTurnStarter | null = null
  const turnRunnerOf = (): InteractionTurnStarter | null => callStarter ?? options.getTurnRunner?.() ?? null

  function loadMessage(actor: InteractionActor, messageId: number, ownerCheck = true): BlockMessageRow {
    const row = db.prepare(
      `SELECT m.id, m.session_id, m.user_id, m.content, m.metadata, m.agent_id, m.capture_id,
              (SELECT 1 FROM sessions s WHERE s.id = m.session_id) AS session_exists
         FROM chat_messages m
        WHERE m.id = ?`,
    ).get(messageId) as BlockMessageRow | undefined

    // A foreign message is answered with the same 404 as a missing one: the
    // API must not confirm that someone else's message id exists.
    if (!row || (ownerCheck && !canSeeOwner(actor, row.user_id))) {
      throw new InteractionServiceError(404, 'unknown_message', 'No such message')
    }
    // The strand was deleted underneath the card (SPEC 7.5b delete). The card
    // goes quiet with a reason instead of failing loudly.
    if (!row.session_exists) {
      throw new InteractionServiceError(410, 'stale', 'The strand this question belonged to is gone')
    }
    return row
  }

  function fileAnswerMessage(
    row: BlockMessageRow,
    userId: number,
    label: string,
    clientMessageId: string,
    replyToInteractionId?: string,
  ): boolean {
    const agentId = row.agent_id ?? 'main'
    const metadata = replyToInteractionId
      ? { type: 'interaction_answer', interactionId: replyToInteractionId, replyToInteractionId }
      : { type: 'interaction_answer', messageId: row.id }
    const result = db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, client_message_id)
       VALUES (?, ?, 'user', ?, ?, ?, ?)
       ON CONFLICT(user_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING`,
    ).run(
      row.session_id,
      row.user_id ?? userId,
      label,
      JSON.stringify(metadata),
      agentId,
      clientMessageId,
    )
    return result.changes === 1
  }

  /**
   * The answer state of the card, in the metadata of the message that carries
   * it. Both paths write it, and it is what makes a second tap a `409` and the
   * collapsed chip survive a reload.
   */
  function recordAnswer(
    row: BlockMessageRow,
    blockId: string,
    value: string | string[],
    label: string,
    clientMessageId: string,
    resumed: boolean,
  ): void {
    const record: InteractionAnswerRecord = {
      blockId,
      value,
      label,
      answeredAt: new Date().toISOString(),
      clientMessageId,
      resumed,
    }
    db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run(
      JSON.stringify(withInteractionAnswer(row.metadata, record)),
      row.id,
    )
  }

  /**
   * The row of the table behind a legacy (message, block) pair. Cards written
   * before the backfill ran, or by a path without the live hook, get their
   * row lazily here, so the table stays the one truth for the answer.
   */
  function rowForBlock(row: BlockMessageRow, block: InteractionBlock): InteractionRecord {
    const existing = findInteractionByBlock(db, row.id, block.id)
    if (existing) return existing
    const record = createInteraction(db, {
      strandId: row.session_id,
      userId: row.user_id,
      messageId: row.id,
      agent: row.agent_id ?? 'main',
      payload: block,
    }).record
    // A card answered before the table existed carries its answer only in
    // the message metadata: carry it over, so a second tap stays a 409.
    const legacy = readInteractionAnswers(row.metadata)[block.id]
    if (legacy && record.status === 'open') {
      return transitionInteraction(db, record.id, 'answered', {
        closeSource: 'answer',
        closedSurface: 'system',
        answer: {
          value: legacy.value,
          label: legacy.label,
          answeredAt: legacy.answeredAt,
          clientRequestId: legacy.clientMessageId || null,
          resumed: legacy.resumed,
        },
      })
    }
    return record
  }

  function loadOwnInteraction(actor: InteractionActor, id: string): InteractionRecord {
    const record = getInteraction(db, id)
    // Same 404 for a foreign and a missing card (no existence oracle); a card
    // without owner only for an admin (review 1, finding 1).
    if (!record || !canSeeOwner(actor, record.userId)) {
      throw new InteractionServiceError(404, 'unknown_interaction', 'No such interaction')
    }
    return record
  }

  function conflict(record: InteractionRecord): InteractionServiceError {
    // The body is a boundary too: value and label come from the sealed view,
    // so a backfilled raw label never leaves unsealed (review 1, finding 2).
    const view = interactionStateView(record)
    if (record.status === 'answered' && view.answer) {
      return new InteractionServiceError(409, 'already_answered', 'This block was already answered', {
        status: record.status,
        value: view.answer.value,
        label: view.answer.label,
        answeredAt: view.answer.answeredAt,
        interaction: view,
      })
    }
    return new InteractionServiceError(409, 'closed', `This question is ${record.status}`, {
      status: record.status,
      interaction: view,
    })
  }

  /** The key was bound to another card or another value: 409 with the status of the bound card, no transition. */
  function keyConflict(userId: number, boundId: string): InteractionServiceError {
    const bound = getInteraction(db, boundId)
    const view = bound && canSeeOwner(userId, bound.userId) ? interactionStateView(bound) : null
    return new InteractionServiceError(409, 'idempotency_conflict', 'This clientRequestId was already used for another answer', {
      status: bound?.status ?? null,
      ...(view ? { interaction: view } : {}),
    })
  }

  function startAnswerTurn(
    userId: number,
    row: BlockMessageRow,
    label: string,
    surface: InteractionSurface,
    replyToInteractionId?: string,
  ): void {
    const runner = turnRunnerOf()
    if (!runner) throw new Error('No turn runner available')
    runner.startTurn({
      userId,
      sessionId: row.session_id,
      text: label,
      source: surface === 'android' || surface === 'telegram' ? surface : 'web',
      agentId: row.agent_id ?? 'main',
      explicitSessionId: row.session_id,
      inputMode: 'answer',
      ...(replyToInteractionId ? { replyToInteractionId } : {}),
    })
  }

  /* ---------------------------------------------------------------- *
   * ask_user answers (S1-B)
   * ---------------------------------------------------------------- */

  /**
   * The strand side of an ask_user card. Its anchor message is only where
   * the card hangs (the message that triggered the asking turn, or none in an
   * empty strand); strand, owner and persona come from the row itself.
   */
  function askUserRow(record: InteractionRecord): BlockMessageRow {
    const strand = db.prepare('SELECT 1 AS ok FROM sessions WHERE id = ?').get(record.strandId) as { ok: number } | undefined
    if (!strand) throw new InteractionServiceError(410, 'stale', 'The strand this question belonged to is gone')
    return {
      id: record.messageId,
      session_id: record.strandId,
      user_id: record.userId,
      content: '',
      metadata: null,
      agent_id: record.agent,
      capture_id: null,
      session_exists: 1,
    }
  }

  /** Turn text of an answered ask_user card: the structured block, from the sealed view. */
  function askUserTurnText(record: InteractionRecord): string {
    const items = (interactionStateView(record).answer?.items ?? []) as AskUserAnswerItem[]
    return formatAskUserAnswerBlock(record.id, items)
  }

  function resumeAskUser(
    userId: number,
    row: BlockMessageRow,
    answered: InteractionRecord,
    surface: InteractionSurface,
    idempotent: boolean,
  ): AnswerInteractionResult {
    try {
      startAnswerTurn(userId, row, askUserTurnText(answered), surface, answered.id)
    } catch (err) {
      console.warn(`[interactions] Turn for the answer to ${answered.id} did not start:`, (err as Error).message)
      throw new InteractionServiceError(502, 'turn_failed', 'The answer was saved, but the turn did not start', {
        retryable: true,
        status: answered.status,
        interaction: interactionStateView(answered),
      })
    }
    const view = interactionStateView(markInteractionResumed(db, answered.id, true))
    return { applied: true, resumed: true, idempotent, value: view.answer!.value, label: view.answer!.label, interaction: view }
  }

  /**
   * The ask_user answer path. Same idempotency and state machine as the
   * fence path (S1-A): key check first, only an `open` card is answered, one
   * transaction for key, transition and user row, the turn after the commit.
   * The value hash is taken over the canonical JSON of `answers`.
   */
  function applyAskUserAnswer(
    actor: InteractionActor,
    payload: AskUserPayload,
    record: InteractionRecord,
    rawAnswers: Record<string, AskUserAnswerInput> | undefined,
    clientRequestId: string,
    surface: InteractionSurface,
  ): AnswerInteractionResult {
    const { userId } = actorOf(actor)
    const row = askUserRow(record)
    // Resume retry (review 2 S1-C, B1): the value in the body is ignored.
    if (isResumeRetry(row, record, userId, clientRequestId)) return resumeAskUser(userId, row, record, surface, true)
    if (!rawAnswers) throw new InteractionServiceError(400, 'invalid_value', 'answers is required for this question')
    const answers = rawAnswers
    const valueHash = interactionAnswersHash(answers)
    const binding = findInteractionRequest(db, userId, clientRequestId)
    if (binding && (binding.interactionId !== record.id || binding.valueHash !== valueHash)) {
      throw keyConflict(userId, binding.interactionId)
    }
    if (record.status === 'answered' && record.answer) {
      if (binding !== null) {
        if (turnRunnerOf() && owesTurn(row, record, userId, clientRequestId)) {
          return resumeAskUser(userId, row, record, surface, true)
        }
        const view = interactionStateView(record)
        return { applied: true, resumed: record.answer.resumed, idempotent: true, value: view.answer!.value, label: view.answer!.label, interaction: view }
      }
      throw conflict(record)
    }
    const expired = record.status === 'expired'
      || (record.status === 'open' && record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now())
    if (expired) {
      if (record.status === 'open') transitionInteraction(db, record.id, 'expired', { closeSource: 'timeout', closedSurface: 'system' })
      throw new InteractionServiceError(410, 'stale', 'This question has expired', { status: 'expired' })
    }
    if (record.status !== 'open') throw conflict(record)

    // The error names the rule only, never a value from the request.
    const checked = validateAskUserAnswer(payload, answers)
    if (!checked.ok) throw new InteractionServiceError(400, checked.code, checked.error)
    // Privacy: every string of the items (question, option labels, typed
    // comment) passes the same boundary as a chat message before it becomes a
    // stored answer, a user row and turn text. The question and labels are
    // model text that was never sealed (privacy V3); ids stay byte-identical.
    const seal = (text: string) => sealText(text, { tier: 'user', source: 'interaction' }).text
    const items: AskUserAnswerItem[] = sealInteractionValue(checked.items)
    const label = seal(checked.label)
    const turnText = formatAskUserAnswerBlock(record.id, items)

    let answered: InteractionRecord
    let inserted: boolean
    try {
      ;({ answered, inserted } = runInteractionTransaction(db, () => {
        const bind = bindInteractionRequest(db, { userId, clientRequestId, interactionId: record.id, valueHash })
        if (!bind.bound && (bind.binding.interactionId !== record.id || bind.binding.valueHash !== valueHash)) {
          throw keyConflict(userId, bind.binding.interactionId)
        }
        const closed = transitionInteraction(db, record.id, 'answered', {
          closeSource: 'answer',
          closedSurface: surface,
          answer: { value: checked.value, label, answeredAt: new Date().toISOString(), clientRequestId, resumed: false, items },
        })
        // Non-blocking: no user row, no turn; the answer reaches the model at
        // the start of the next turn (claimInteractionContextNotes).
        if (!record.blocking) return { answered: closed, inserted: true }
        const filed = fileAnswerMessage(row, userId, turnText, clientRequestId, record.id)
        if (filed) supersedeOpenOnUserMessage(db, row.session_id, row.user_id ?? userId)
        return { answered: closed, inserted: filed }
      }))
    } catch (err) {
      if (err instanceof InteractionTransitionError) throw conflict(getInteraction(db, record.id) ?? record)
      throw err
    }

    options.broadcast?.({
      userId,
      sessionId: row.session_id,
      agentId: row.agent_id ?? 'main',
      messageId: row.id,
      blockId: record.id,
      label,
    })
    const result = (resumed: boolean, idempotent: boolean): AnswerInteractionResult =>
      ({ applied: true, resumed, idempotent, value: checked.value, label, interaction: interactionStateView(answered) })
    if (!record.blocking) {
      const steered = steerNonBlockingAnswer(userId, row, answered, turnText, surface)
      return steered ? { ...result(false, false), steered } : result(false, false)
    }
    if (!inserted) return result(false, true)
    if (!turnRunnerOf()) {
      console.warn(`[interactions] No turn runner available; answer to ${record.id} was filed without a turn`)
      return result(false, false)
    }
    return resumeAskUser(userId, row, answered, surface, false)
  }

  /**
   * S1-D (report.md ~357): the answer to a NON-blocking ask_user card that
   * arrives while a turn of its strand runs a tool batch goes into that turn
   * as a steer, instead of waiting for the next turn as a context note. Only
   * a delivered steer marks the answer resumed (then the note path skips it);
   * a steer the run did not take stays a note for the next turn. Never throws:
   * the note path is the fallback.
   */
  function steerNonBlockingAnswer(
    userId: number,
    row: BlockMessageRow,
    answered: InteractionRecord,
    turnText: string,
    surface: InteractionSurface,
  ): { turnId: string } | null {
    // The call's own starter (Telegram) may not steer; the shared runner can.
    const runner = [callStarter, options.getTurnRunner?.()].find(r => r?.offerSteerToLiveTurn)
    if (!runner?.offerSteerToLiveTurn) return null
    try {
      const offer = runner.offerSteerToLiveTurn({
        agentUserId: String(row.user_id ?? userId),
        agentId: row.agent_id ?? 'main',
        sessionId: row.session_id,
        text: turnText,
        source: surface,
        preformatted: true,
      })
      if (!offer.accepted) return null
      void offer.settled.then((delivered) => {
        if (delivered) markInteractionResumed(db, answered.id, true)
      }).catch(() => undefined)
      return { turnId: offer.turnId }
    } catch (err) {
      console.warn(`[interactions] Steer of the answer to ${answered.id} failed:`, (err as Error).message)
      return null
    }
  }

  /**
   * Start the turn of a filed answer. A failure leaves `answer.resumed=false`
   * and answers 502 retryable (review 1, finding 9); a retry with the same
   * key and value comes back here without filing a second user row.
   */
  function resumeAfterAnswer(
    userId: number,
    row: BlockMessageRow,
    block: InteractionBlock,
    answered: InteractionRecord,
    surface: InteractionSurface,
    idempotent: boolean,
  ): AnswerInteractionResult {
    // Review 2, finding A: a backfilled answer can carry a raw label, so the
    // turn text, the metadata mirror and the response all use the sealed one.
    const answer = sealInteractionValue(answered.answer!)
    try {
      startAnswerTurn(userId, row, answer.label, surface)
    } catch (err) {
      console.warn(`[interactions] Turn for the answer to block ${block.id} did not start:`, (err as Error).message)
      recordAnswer(row, block.id, answer.value, answer.label, answer.clientRequestId ?? '', false)
      throw new InteractionServiceError(502, 'turn_failed', 'The answer was saved, but the turn did not start', {
        retryable: true,
        status: answered.status,
        interaction: interactionStateView(answered),
      })
    }
    const resumed = markInteractionResumed(db, answered.id, true)
    recordAnswer(row, block.id, answer.value, answer.label, answer.clientRequestId ?? '', true)
    return { applied: true, resumed: true, idempotent, value: answer.value, label: answer.label, interaction: interactionStateView(resumed) }
  }

  /**
   * Resume retry (review 2 S1-C, B1): the key is bound to exactly this card,
   * the card is answered with `resumed=false` and still owes its turn. Then
   * the request only starts the turn again; the value of the body is not
   * hashed or compared, because the client can only rebuild it from the
   * sealed answer. Every other combination keeps the hash check (409).
   */
  function isResumeRetry(row: BlockMessageRow, record: InteractionRecord, userId: number, clientRequestId: string): boolean {
    if (record.status !== 'answered' || !record.answer || record.answer.resumed !== false) return false
    // The runner of this call counts too: Telegram passes its own starter (S1-C telegram review 2).
    if (!turnRunnerOf()) return false
    const binding = findInteractionRequest(db, userId, clientRequestId)
    if (!binding || binding.interactionId !== record.id) return false
    return owesTurn(row, record, userId, clientRequestId)
  }

  /** Whether a stored answer still owes its turn: generic path, blocking card, user row filed, turn not started. */
  function owesTurn(row: BlockMessageRow, record: InteractionRecord, userId: number, clientRequestId: string): boolean {
    if (!record.answer || record.answer.resumed || !record.blocking || row.capture_id) return false
    const filed = db.prepare(
      `SELECT 1 FROM chat_messages WHERE user_id = ? AND client_message_id = ? AND role = 'user'`,
    ).get(row.user_id ?? userId, clientRequestId)
    return Boolean(filed)
  }

  /**
   * The one answer path (review 1, findings 3, 4, 8, 9):
   *   1. idempotency key check BEFORE any transition — the key
   *      (user, clientRequestId) is bound to one card and one value hash;
   *   2. strict state: only an `open` card can be answered;
   *   3. one transaction: key binding, transition to `answered`
   *      (resumed=false), the user row — events leave after the commit;
   *   4. then the turn, only for a blocking card; a failed start is 502
   *      retryable, the retry only starts the turn again.
   */
  function applyAnswer(
    actor: InteractionActor,
    row: BlockMessageRow,
    block: InteractionBlock,
    record: InteractionRecord,
    rawValue: string | string[] | undefined,
    clientRequestId: string,
    surface: InteractionSurface,
  ): AnswerInteractionResult {
    const { userId } = actorOf(actor)
    // Resume retry (review 2 S1-C, B1): the value in the body is ignored.
    if (isResumeRetry(row, record, userId, clientRequestId)) return resumeAfterAnswer(userId, row, block, record, surface, true)
    if (rawValue === undefined) throw new InteractionServiceError(400, 'invalid_value', 'value is required for this question')
    const value = rawValue
    const valueHash = interactionValueHash(value)
    const binding = findInteractionRequest(db, userId, clientRequestId)
    if (binding && (binding.interactionId !== record.id || binding.valueHash !== valueHash)) {
      throw keyConflict(userId, binding.interactionId)
    }
    if (record.status === 'answered' && record.answer) {
      // Idempotent replay of the very same request (same key, same card,
      // same value): report the stored answer instead of a conflict, so a
      // retry after a dropped response does not look like a failure.
      const sameRequest = binding !== null
        || (record.answer.clientRequestId === clientRequestId && sameValue(record.answer.value, value))
      if (sameRequest) {
        if (turnRunnerOf() && owesTurn(row, record, userId, clientRequestId)) {
          return resumeAfterAnswer(userId, row, block, record, surface, true)
        }
        // Review 2, finding A: value and label come from the sealed view, like
        // the 409 body; an imported raw label never leaves unsealed.
        const view = interactionStateView(record)
        return {
          applied: true,
          resumed: record.answer.resumed,
          idempotent: true,
          value: view.answer!.value,
          label: view.answer!.label,
          interaction: view,
        }
      }
      throw conflict(record)
    }
    const expired = record.status === 'expired'
      || (record.status === 'open' && record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now())
    if (expired) {
      if (record.status === 'open') transitionInteraction(db, record.id, 'expired', { closeSource: 'timeout', closedSurface: 'system' })
      throw new InteractionServiceError(410, 'stale', 'This question has expired', { status: 'expired' })
    }
    // Strict contract (review 1, finding 4): dismissed and superseded cards
    // are closed; the answer is a 409 with the status.
    if (record.status !== 'open') throw conflict(record)

    const raw = validateInteractionAnswer(block, value)
    if (!raw.ok) {
      throw new InteractionServiceError(400, 'invalid_value', 'The value is not an option of this block')
    }
    // Privacy (plan 2026-09-26, step 1): the label is filed as a `user`
    // message and starts a turn, so it passes the same boundary as typed
    // text. The option ids (`raw.value`) are the model's own identifiers
    // and stay untouched — only the human-readable label is sealed, and
    // the SAME sealed label is used for the row, the turn and the recorded
    // answer so the idempotent replay still matches.
    const sealedLabel = sealText(raw.label, { tier: 'user', source: 'interaction' })
    const validated = { ...raw, label: sealedLabel.text }

    // A card that belongs to a capture is resolved by the captures service:
    // it knows what "keep" and "answer" have to do to the capture, and it
    // owns the idempotent answer path. Nothing is filed as a user message in
    // that case — the tapped label is not the question, the capture text is,
    // and a stray "Answer it" row would end up in the next LLM context as if
    // the user had typed it.
    const delegated = row.capture_id && typeof validated.value === 'string'
      ? options.getCaptureConfirmer?.()?.confirmNoteFiling(userId, {
        captureId: row.capture_id,
        blockId: block.id,
        choice: validated.value,
      }) ?? null
      : null
    if (delegated?.handled) {
      const answered = runInteractionTransaction(db, () => {
        bindInteractionRequest(db, { userId, clientRequestId, interactionId: record.id, valueHash })
        return closeAnswered(record, validated.value, validated.label, clientRequestId, delegated.resumed, surface)
      })
      recordAnswer(row, block.id, validated.value, validated.label, clientRequestId, delegated.resumed)
      return { applied: true, resumed: delegated.resumed, idempotent: false, value: validated.value, label: validated.label, interaction: interactionStateView(answered) }
    }

    let answered: InteractionRecord
    let inserted: boolean
    try {
      ;({ answered, inserted } = runInteractionTransaction(db, () => {
        const bind = bindInteractionRequest(db, { userId, clientRequestId, interactionId: record.id, valueHash })
        if (!bind.bound && (bind.binding.interactionId !== record.id || bind.binding.valueHash !== valueHash)) {
          throw keyConflict(userId, bind.binding.interactionId)
        }
        // resumed=false until the turn really started (review 1, finding 9).
        const closed = closeAnswered(record, validated.value, validated.label, clientRequestId, false, surface)
        // A non-blocking card (blocking=0) files no user row: its answer is
        // stored and emitted only; feeding it into the next turn is S1-B
        // (review 1, finding 8).
        if (!record.blocking) return { answered: closed, inserted: true }
        const filed = fileAnswerMessage(row, userId, validated.label, clientRequestId)
        // Stale rule 1 for the other open cards of the strand: the answer row
        // is a genuine user turn (review 1, finding 6).
        if (filed) supersedeOpenOnUserMessage(db, row.session_id, row.user_id ?? userId)
        return { answered: closed, inserted: filed }
      }))
    } catch (err) {
      // Lost a race against a parallel answer/dismiss: report the winner.
      if (err instanceof InteractionTransitionError) throw conflict(getInteraction(db, record.id) ?? record)
      throw err
    }

    // Mirror for clients that still read the answer from the message
    // metadata (the released app, until S1-C). The table stays the truth.
    recordAnswer(row, block.id, validated.value, validated.label, clientRequestId, false)
    options.broadcast?.({
      userId,
      sessionId: row.session_id,
      agentId: row.agent_id ?? 'main',
      messageId: row.id,
      blockId: block.id,
      label: validated.label,
    })

    // A non-blocking card (blocking=0) stores and emits its answer, but starts
    // NO turn (review 1, finding 8); feeding it into the next turn's context
    // is S1-B.
    const runner = turnRunnerOf()
    if (!record.blocking) {
      return { applied: true, resumed: false, idempotent: false, value: validated.value, label: validated.label, interaction: interactionStateView(answered) }
    }
    if (!inserted) {
      return { applied: true, resumed: false, idempotent: true, value: validated.value, label: validated.label, interaction: interactionStateView(answered) }
    }
    if (!runner) {
      console.warn(`[interactions] No turn runner available; answer to block ${block.id} was filed without a turn`)
      return { applied: true, resumed: false, idempotent: false, value: validated.value, label: validated.label, interaction: interactionStateView(answered) }
    }
    return resumeAfterAnswer(userId, row, block, answered, surface, false)
  }

  function closeAnswered(
    record: InteractionRecord,
    value: string | string[],
    label: string,
    clientRequestId: string,
    resumed: boolean,
    surface: InteractionSurface,
  ): InteractionRecord {
    return transitionInteraction(db, record.id, 'answered', {
      closeSource: 'answer',
      closedSurface: surface,
      answer: { value, label, answeredAt: new Date().toISOString(), clientRequestId, resumed },
    })
  }

  const service: InteractionsService = {
    answer(actor, body, surface = 'web'): AnswerInteractionResult {
      const row = loadMessage(actor, body.messageId)
      // Every kind the contract declares is answerable (`multi`, `handover`
      // too); the value is still checked against the block's own options.
      const block = findAnswerableInteractionBlock(row.content, body.blockId)
      if (!block) {
        throw new InteractionServiceError(404, 'unknown_block', 'No such block in this message')
      }
      const record = rowForBlock(row, block)
      if (!canSeeOwner(actor, record.userId)) throw new InteractionServiceError(404, 'unknown_message', 'No such message')
      return applyAnswer(actor, row, block, record, body.value, body.clientMessageId, surface)
    },

    answerById(actor, id, input): AnswerInteractionResult {
      if (input.startTurn) {
        const previous = callStarter
        callStarter = { startTurn: input.startTurn }
        try {
          return service.answerById(actor, id, { ...input, startTurn: undefined })
        } finally {
          callStarter = previous
        }
      }
      const record = loadOwnInteraction(actor, id)
      // The card's owner was checked above; the message row may carry no
      // user id (agent rows), so it is not checked a second time.
      if (isAskUserPayload(record.payload)) {
        return applyAskUserAnswer(actor, record.payload, record, input.answers, input.clientRequestId, input.surface)
      }
      const row = loadMessage(actor, record.messageId, false)
      return applyAnswer(actor, row, record.payload, record, input.value, input.clientRequestId, input.surface)
    },

    dismiss(actor, id, surface) {
      const record = loadOwnInteraction(actor, id)
      // Repeating a dismiss is harmless and reports the state it left.
      if (record.status === 'dismissed') return { interaction: interactionStateView(record), idempotent: true }
      // Strict contract (review 1, finding 4): only an open card is dismissed.
      if (record.status !== 'open') throw conflict(record)
      try {
        // Deliberately no turn and no user row: dismissing is a state change
        // of the card, not something the model gets to read.
        return { interaction: interactionStateView(transitionInteraction(db, id, 'dismissed', { closeSource: 'dismiss', closedSurface: surface })), idempotent: false }
      } catch (err) {
        if (err instanceof InteractionTransitionError) throw conflict(getInteraction(db, id) ?? record)
        throw err
      }
    },

    saveDraft(actor, id, draft) {
      const record = loadOwnInteraction(actor, id)
      if (record.status !== 'open') throw conflict(record)
      try {
        return interactionStateView(saveInteractionDraft(db, id, draft))
      } catch (err) {
        if (err instanceof InteractionTransitionError) throw conflict(getInteraction(db, id) ?? record)
        throw err
      }
    },

    listForStrand(actor, strandId, status) {
      const owner = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(strandId) as { user_id: number | null } | undefined
      // A strand without owner only for an admin (review 1, finding 1).
      if (!owner || !canSeeOwner(actor, owner.user_id)) {
        throw new InteractionServiceError(404, 'unknown_strand', 'No such strand')
      }
      return listStrandInteractions(db, strandId, status ? { status } : {})
        .filter(record => canSeeOwner(actor, record.userId))
        .map(sealedInteraction)
    },
  }
  return service
}

function sameValue(a: string | string[], b: string | string[]): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}
