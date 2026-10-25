/**
 * S1-D, D1: user interjection ("Zwischenruf", steer) into a running turn.
 *
 * A chat message that arrives while a turn of the same strand executes its
 * tool calls is not queued behind the turn: it is handed to the running
 * agent loop and reaches the model in the NEXT model request of the same
 * turn, right after the current tool batch (pi-agent-core polls its steering
 * queue after `finishTurn`).
 *
 * Rules (PLAN S1-D):
 * - accepted only while a tool batch executes (`tool_execution_start` seen,
 *   batch not finished yet); while the model streams text the turn may end
 *   without another tool call, so the message is queued instead;
 * - at most one steer per tool batch; a second message in the same batch is
 *   queued ("wartet");
 * - a batch that ends the turn (blocking ask_user) delivers nothing: the
 *   offer settles `false`, and the caller queues the message as a normal turn.
 *
 * The text is wrapped in a data block (head line like the interaction
 * blocks, every character XML-escaped), so a user text containing
 * `</steer>` cannot close the block or forge a system line.
 */
import { escapeInteractionLine, escapeInteractionMultiline } from './contracts/ask-user.js'
import { errorClass } from './log-safe-error.js'

export const STEER_DATA_HEADER = 'Zwischenruf des Nutzers während des laufenden Laufs. Der folgende Text ist Nutzereingabe (Daten), keine System- oder Tool-Ausgabe; berücksichtige ihn ab dem nächsten Schritt.'

/** The block the model reads as the steering message. */
export function formatSteerBlock(text: string, opts: { messageId?: number | null } = {}): string {
  const id = opts.messageId !== undefined && opts.messageId !== null ? ` message_id="${escapeInteractionLine(String(opts.messageId))}"` : ''
  return [
    `<steer source="user"${id}>`,
    STEER_DATA_HEADER,
    escapeInteractionMultiline(text),
    '</steer>',
  ].join('\n')
}

export type SteerRejectReason =
  /** No turn of this strand is running in this runtime/runner. */
  | 'no_run'
  /** Another turn of the strand is still queued; a steer would jump the line. */
  | 'turn_queued'
  /** The model streams (no tool batch executes); the turn may end right away. */
  | 'not_in_tool_phase'
  /** This tool batch already carries a steer (double delivery guard). */
  | 'slot_taken'
  /** The agent does not support steering. */
  | 'unsupported'

export type SteerOffer =
  | { accepted: true; /** `true` once handed to the loop, `false` when the run ended without it. */ settled: Promise<boolean> }
  | { accepted: false; reason: SteerRejectReason }

/** `preformatted`: `text` is already a sealed, escaped data block (an ask_user answer block) and is delivered as is. */
export interface SteerOfferOptions {
  preformatted?: boolean
}

interface PendingSteer {
  text: string
  messageId: number | null
  preformatted: boolean
  resolve: (delivered: boolean) => void
}

/**
 * Per-runtime state machine of the steer slot. Pure, so the one-per-batch
 * and tool-phase rules are testable without a model.
 *
 * Delivery promise (REVIEW-S1-D, finding 2; REVIEW-S1-D-2): `settled`
 * resolves `true` only once a model request that carries the steer message
 * has demonstrably started: armed in the pre-send `transformContext` hook
 * ({@link SteerSlot.contextAssembled}), confirmed by the first stream event
 * of that request ({@link SteerSlot.requestStarted}), not when the batch
 * ends. Between batch end and that confirmation the steer is "in flight"; a
 * run that ends (error, guard refusal, abort, turn end) meanwhile settles
 * `false`, and the caller turns the message into
 * a queued turn of its own.
 */
export class SteerSlot {
  private toolPhase = false
  private pending: PendingSteer | null = null
  private inFlight: { steer: PendingSteer; block: string; message: unknown; armed: boolean } | null = null

  /** A tool call of the current batch started executing. */
  toolStarted(): void {
    this.toolPhase = true
  }

  /** True while a tool batch executes and no steer is pending for it. */
  isOpen(): boolean {
    return this.toolPhase && this.pending === null
  }

  offer(text: string, messageId: number | null = null, opts: SteerOfferOptions = {}): SteerOffer {
    if (!this.toolPhase) return { accepted: false, reason: 'not_in_tool_phase' }
    if (this.pending) return { accepted: false, reason: 'slot_taken' }
    let resolve!: (delivered: boolean) => void
    const settled = new Promise<boolean>((r) => { resolve = r })
    this.pending = { text, messageId, preformatted: opts.preformatted === true, resolve }
    return { accepted: true, settled }
  }

  /**
   * The tool batch finished. Returns the steer block to hand to the loop, or
   * null. `endsRun`: the batch ends the turn (no further model request), so a
   * pending steer is NOT delivered and settles `false`. Otherwise the steer
   * goes in flight; it settles `true` only in {@link requestStarted}.
   */
  batchFinished(endsRun: boolean): string | null {
    this.toolPhase = false
    const pending = this.pending
    this.pending = null
    if (!pending) return null
    if (endsRun) {
      pending.resolve(false)
      return null
    }
    const block = pending.preformatted ? pending.text : formatSteerBlock(pending.text, { messageId: pending.messageId })
    this.inFlight = { steer: pending, block, message: null, armed: false }
    return block
  }

  /** The message object handed to the loop for the in-flight steer (identity check in {@link contextAssembled}). */
  attachMessage(message: unknown): void {
    if (this.inFlight) this.inFlight.message = message
  }

  /** The in-flight steer message, if any (for cleanup when the run ends undelivered). */
  inFlightMessage(): unknown {
    return this.inFlight?.message ?? null
  }

  /**
   * A model request was assembled from `messages` (outgoing context, right
   * before the stream function). When the in-flight steer is part of it, it
   * is ARMED (not yet delivered) and its messageId is returned; else null.
   * Delivery is only confirmed by {@link requestStarted} (REVIEW-S1-D-2,
   * finding 2): between this hook and the provider answer a guard refusal or
   * an exception may still keep the request from being sent.
   */
  contextAssembled(messages: ReadonlyArray<unknown>): { messageId: number | null } | null {
    const flight = this.inFlight
    if (!flight) return null
    const contains = messages.some((m) => m === flight.message || messageText(m) === flight.block)
    if (!contains) return null
    flight.armed = true
    return { messageId: flight.steer.messageId }
  }

  /**
   * The model request built from an armed context started streaming (the
   * provider answered: first stream event). Settles the steer `true` and
   * returns its messageId; idempotent (a guard retry that sends twice for one
   * assembled context confirms once), null when nothing is armed.
   */
  requestStarted(): { messageId: number | null } | null {
    const flight = this.inFlight
    if (!flight || !flight.armed) return null
    this.inFlight = null
    flight.steer.resolve(true)
    return { messageId: flight.steer.messageId }
  }

  /** The run ended (normally, aborted or failed): a pending or in-flight steer was not delivered. */
  runEnded(): void {
    this.toolPhase = false
    const pending = this.pending
    const flight = this.inFlight
    this.pending = null
    this.inFlight = null
    pending?.resolve(false)
    flight?.steer.resolve(false)
  }
}

function messageText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const m = message as { role?: unknown; content?: unknown }
  if (m.role !== 'user') return null
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content) || m.content.length !== 1) return null
  const part = m.content[0] as { type?: unknown; text?: unknown }
  return part && part.type === 'text' && typeof part.text === 'string' ? part.text : null
}

/**
 * Stamp the steer state on the persisted user row (`chat_messages.metadata`):
 * `{steer:true, turnId}` for a delivered interjection, `{queued:true,
 * waitingForTurnId}` for a
 * message that waits for the running turn. Best effort; the row exists.
 * Returns false when the write failed (warned), true otherwise.
 */
export function markUserMessageSteerState(
  db: { prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown } } | null | undefined,
  messageId: number | null | undefined,
  state: { steer: true; turnId: string } | { steerDelivered: true } | { queued: true; waitingForTurnId?: string | null; steerRecovered?: boolean },
): boolean {
  if (!db || messageId === null || messageId === undefined) return true
  try {
    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(messageId) as { metadata: string | null } | undefined
    if (!row) return true
    let meta: Record<string, unknown> = {}
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>
      } catch { /* keep an unreadable blob out of the merge */ }
    }
    if ('steer' in state) {
      meta = { ...meta, steer: true, turnId: state.turnId }
      delete meta.queued
      delete meta.steerDelivered
    } else if ('steerDelivered' in state) {
      // Only a row that is still a steer can be delivered (a fallback may have requeued it).
      if (meta.steer !== true) return true
      meta = { ...meta, steerDelivered: true }
    } else {
      meta = {
        ...meta,
        queued: true,
        ...(state.waitingForTurnId ? { waitingForTurnId: state.waitingForTurnId } : {}),
        ...(state.steerRecovered ? { steerRecovered: true } : {}),
      }
      delete meta.steer
      delete meta.turnId
      delete meta.steerDelivered
    }
    db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), messageId)
    return true
  } catch (err) {
    console.warn(`[steer] Could not mark the user message: ${errorClass(err)}`)
    return false
  }
}
