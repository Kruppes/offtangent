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
  findAnswerableInteractionBlock,
  readInteractionAnswers,
  validateInteractionAnswer,
  withInteractionAnswer,
  type Database,
  type InteractionAnswerRecord,
} from '@axiom/core'
import type { AnswerInteractionBody } from './schema.js'

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
  }) => unknown
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
}

interface BlockMessageRow {
  id: number
  session_id: string
  user_id: number
  content: string
  metadata: string | null
  agent_id: string | null
  capture_id: string | null
  session_exists: number | null
}

export interface InteractionsService {
  answer: (userId: number, body: AnswerInteractionBody) => AnswerInteractionResult
}

export function createInteractionsService(options: InteractionsServiceOptions): InteractionsService {
  const { db } = options

  function loadMessage(userId: number, messageId: number): BlockMessageRow {
    const row = db.prepare(
      `SELECT m.id, m.session_id, m.user_id, m.content, m.metadata, m.agent_id, m.capture_id,
              (SELECT 1 FROM sessions s WHERE s.id = m.session_id) AS session_exists
         FROM chat_messages m
        WHERE m.id = ?`,
    ).get(messageId) as BlockMessageRow | undefined

    // A foreign message is answered with the same 404 as a missing one: the
    // API must not confirm that someone else's message id exists.
    if (!row || row.user_id !== userId) {
      throw new InteractionServiceError(404, 'unknown_message', 'No such message')
    }
    // The strand was deleted underneath the card (SPEC 7.5b delete). The card
    // goes quiet with a reason instead of failing loudly.
    if (!row.session_exists) {
      throw new InteractionServiceError(410, 'stale', 'The strand this question belonged to is gone')
    }
    return row
  }

  function fileAnswerMessage(row: BlockMessageRow, label: string, clientMessageId: string): boolean {
    const agentId = row.agent_id ?? 'main'
    const result = db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, client_message_id)
       VALUES (?, ?, 'user', ?, ?, ?, ?)
       ON CONFLICT(user_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING`,
    ).run(
      row.session_id,
      row.user_id,
      label,
      JSON.stringify({ type: 'interaction_answer', messageId: row.id }),
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

  return {
    answer(userId, body): AnswerInteractionResult {
      const row = loadMessage(userId, body.messageId)

      // Every kind the contract declares is answerable, not only the two a
      // client draws as a card today: `multi` and `handover` were rendered by
      // the app and answered `404 unknown_block` here (measured 2026-09-15),
      // which is a broken contract. The value is still checked against the
      // block's own options below, so a wrong option stays a 400.
      const block = findAnswerableInteractionBlock(row.content, body.blockId)
      if (!block) {
        throw new InteractionServiceError(404, 'unknown_block', 'No such block in this message')
      }
      if (block.expiresAt && Date.parse(block.expiresAt) <= Date.now()) {
        throw new InteractionServiceError(410, 'stale', 'This question has expired')
      }

      const existing = readInteractionAnswers(row.metadata)[block.id]
      if (existing) {
        // Idempotent replay of the very same request: report the stored
        // answer as applied instead of a conflict, so a retry after a dropped
        // response does not look like a failure to the client.
        if (existing.clientMessageId && existing.clientMessageId === body.clientMessageId) {
          return {
            applied: true,
            resumed: existing.resumed,
            idempotent: true,
            value: existing.value,
            label: existing.label,
          }
        }
        throw new InteractionServiceError(409, 'already_answered', 'This block was already answered', {
          value: existing.value,
          label: existing.label,
          answeredAt: existing.answeredAt,
        })
      }

      const validated = validateInteractionAnswer(block, body.value)
      if (!validated.ok) {
        throw new InteractionServiceError(400, 'invalid_value', 'The value is not an option of this block')
      }

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
        recordAnswer(row, block.id, validated.value, validated.label, body.clientMessageId, delegated.resumed)
        return {
          applied: true,
          resumed: delegated.resumed,
          idempotent: false,
          value: validated.value,
          label: validated.label,
        }
      }

      const inserted = fileAnswerMessage(row, validated.label, body.clientMessageId)

      const runner = inserted ? options.getTurnRunner?.() ?? null : null
      let resumed = false
      if (runner) {
        runner.startTurn({
          userId,
          sessionId: row.session_id,
          text: validated.label,
          source: 'web',
          agentId: row.agent_id ?? 'main',
          explicitSessionId: row.session_id,
        })
        resumed = true
      } else if (inserted) {
        console.warn(`[interactions] No turn runner available; answer to block ${block.id} was filed without a turn`)
      }

      recordAnswer(row, block.id, validated.value, validated.label, body.clientMessageId, resumed)

      options.broadcast?.({
        userId,
        sessionId: row.session_id,
        agentId: row.agent_id ?? 'main',
        messageId: row.id,
        blockId: block.id,
        label: validated.label,
      })

      return { applied: true, resumed, idempotent: !inserted, value: validated.value, label: validated.label }
    },
  }
}
