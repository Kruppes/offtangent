/**
 * Answering a card from a device (LED clock knob, dashboard touch).
 *
 * One rule for every device: only what {@link isDeviceAnswerableBlock} allows
 * (single choice or yes/no with at least two options, never `destructive`,
 * never a `danger` option, never multi/text) of a message of the token's own
 * user. Everything else is refused BEFORE the shared interactions service
 * sees it, so a stolen device token can never confirm a destructive card.
 * The answer itself goes through the same InteractionsService as a tap in
 * the app; `client_id` makes retries idempotent.
 */
import crypto from 'node:crypto'
import {
  ASK_USER_OTHER_OPTION_ID,
  errorClass,
  extractAnswerableInteractionBlocks,
  getInteraction,
  isAskUserPayload,
  type AskUserOption,
  type AskUserPayload,
  type AskUserQuestion,
  type Database,
  type InteractionBlock,
} from '@axiom/core'
import { InteractionServiceError, type InteractionsService } from '../interactions/service.js'

const ID_MAX = 64

/**
 * May this card be answered on a device? Only single-choice and yes/no, and
 * never anything the model marked as destructive — those stay on the phone,
 * where the full context is visible.
 */
export function isDeviceAnswerableBlock(block: InteractionBlock): boolean {
  if (block.kind !== 'choice' && block.kind !== 'confirm') return false
  if (block.destructive) return false
  if (block.options.some(option => option.style === 'danger')) return false
  return block.options.length >= 2
}

/** Opaque positional id of the privacy mode: `~<1-based index>`. */
/**
 * The device rule for an `ask_user` interaction (fix/status-ask-user): a
 * device may answer it only when the set holds exactly ONE question of type
 * `choice` or `confirm` with at least one real option. A `multi` question or
 * a set of several questions is answered as one atomic form on the phone; a
 * single tap cannot fill it. ask_user has no destructive flag (its contract
 * has none), so the destructive half of the fence rule cannot apply here.
 * Returns the question, or null when the card is phone-only.
 */
export function deviceAnswerableAskUserQuestion(payload: AskUserPayload): AskUserQuestion | null {
  if (payload.questions.length !== 1) return null
  const question = payload.questions[0]!
  if (question.type !== 'choice' && question.type !== 'confirm') return null
  return deviceAskUserOptions(question).length >= 1 ? question : null
}

/**
 * The options a device shows and may send: every option except the automatic
 * free-text row ("Other"), which needs a typed comment a device cannot give.
 */
export function deviceAskUserOptions(question: AskUserQuestion): AskUserOption[] {
  return question.options.filter(option => !option.other && option.id !== ASK_USER_OTHER_OPTION_ID)
}

/** Interaction ids (`ia_` + ULID) are opaque; an ask_user card uses one as its device `block_id`. */
const INTERACTION_ID = /^ia_[0-9A-HJKMNP-TV-Z]{26}$/

export function isInteractionBlockId(value: string): boolean {
  return INTERACTION_ID.test(value)
}

const OPAQUE_ID = /^~([1-9]\d{0,3})$/

function opaqueIndex(id: string): number | null {
  const match = OPAQUE_ID.exec(id)
  return match ? Number(match[1]) - 1 : null
}

/**
 * The block a device answer addresses. A real id and an opaque one (`~n` =
 * n-th answerable block of the message) are both accepted, so toggling the
 * privacy mode between the device's poll and its answer never breaks it; the
 * form the device's current mode emits wins if both would match.
 */
export function resolveDeviceBlock(
  blocks: InteractionBlock[],
  blockId: string,
  privacy: boolean,
): InteractionBlock | undefined {
  const exact = blocks.find(candidate => candidate.id === blockId)
  const index = opaqueIndex(blockId)
  const positional = index === null ? undefined : blocks[index]
  return privacy ? (positional ?? exact) : (exact ?? positional)
}

/** The real option id behind a device answer value (same rule as above). */
export function resolveDeviceOptionValue(block: InteractionBlock, value: string, privacy: boolean): string {
  const exact = block.options.find(option => option.id === value)?.id
  const index = opaqueIndex(value)
  const positional = index === null ? undefined : block.options[index]?.id
  return (privacy ? (positional ?? exact) : (exact ?? positional)) ?? value
}

export interface DeviceAnswerBody {
  messageId: number
  blockId: string
  value: string
  clientId: string
}

function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= ID_MAX ? trimmed : null
}

export function parseDeviceAnswerBody(body: unknown): DeviceAnswerBody | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const rawId = typeof record.message_id === 'string' ? Number(record.message_id) : record.message_id
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) return null
  const blockId = readId(record.block_id)
  const value = readId(record.value)
  const clientId = readId(record.client_id)
  if (!blockId || !value || !clientId) return null
  return { messageId: rawId, blockId, value, clientId }
}

/**
 * Idempotency key of a device answer: `<namespace>:` plus a hash of the FULL
 * `<namespace>:<device id>:<client_id>`. Hashed, not cut: a cut to 64 chars
 * left only the first ~20 chars of the client id, so two different answers
 * whose ids shared that prefix collided. Stays within {@link ID_MAX} chars.
 */
export function deviceClientMessageId(namespace: string, deviceId: string, clientId: string): string {
  const digest = crypto.createHash('sha256').update(`${namespace}:${deviceId}:${clientId}`).digest('hex')
  return `${namespace}:${digest}`.slice(0, ID_MAX)
}

export interface DeviceAnswerOutcome {
  status: number
  body: Record<string, unknown>
}

/**
 * Applies a parsed device answer. `clientNamespace` keeps the idempotency
 * keys of devices apart from app taps (`clock:<id>:<client_id>` for the
 * clock, `device:<id>:<client_id>` for the status API).
 */
export function applyDeviceAnswer(input: {
  db: Database
  interactions: InteractionsService
  device: { id: string; userId: number; privacy: boolean }
  body: DeviceAnswerBody
  clientNamespace: string
  logTag: string
}): DeviceAnswerOutcome {
  const { db, device, body } = input
  // ask_user cards (S1-B) live only in the `interactions` table; their
  // device block_id is the interaction id. Fence cards keep the path below.
  if (isInteractionBlockId(body.blockId)) return applyDeviceAskUserAnswer(input)
  const row = db.prepare('SELECT content FROM chat_messages WHERE id = ? AND user_id = ?')
    .get(body.messageId, device.userId) as { content: string } | undefined
  if (!row) return { status: 404, body: { error: 'No such message', code: 'unknown_message' } }
  // Privacy mode sends opaque positional ids (`~n`); both forms resolve.
  const block = resolveDeviceBlock(extractAnswerableInteractionBlocks(row.content), body.blockId, device.privacy)
  if (!block) return { status: 404, body: { error: 'No such block in this message', code: 'unknown_block' } }
  if (!isDeviceAnswerableBlock(block)) {
    return { status: 403, body: { error: 'This question must be answered on the phone', code: 'not_allowed' } }
  }
  try {
    const result = input.interactions.answer(device.userId, {
      messageId: body.messageId,
      blockId: block.id,
      value: resolveDeviceOptionValue(block, body.value, device.privacy),
      // Namespaced, so a device retry can never collide with an app tap.
      clientMessageId: deviceClientMessageId(input.clientNamespace, device.id, body.clientId),
    })
    // No label in the reply: the device already shows the label it sent, and
    // the stored label may be private (privacy mode).
    return { status: 200, body: { applied: true, idempotent: result.idempotent } }
  } catch (err) {
    if (err instanceof InteractionServiceError) {
      // The 409 deliberately does NOT echo the stored label: the device only
      // needs "already answered", and the label may be private.
      return { status: err.status, body: { error: err.message, code: err.code } }
    }
    // Review K0-K2-4 #4 (clock-companion): log the class, never the text; an
    // error message may quote a private card or a dictation.
    console.error(`[${input.logTag}] Failed to apply the answer: ${errorClass(err)}`)
    return { status: 500, body: { error: 'Failed to apply the answer', code: 'internal' } }
  }
}

function deviceAnswerError(err: unknown, logTag: string): DeviceAnswerOutcome {
  if (err instanceof InteractionServiceError) {
    return { status: err.status, body: { error: err.message, code: err.code } }
  }
  console.error(`[${logTag}] Failed to apply the answer: ${errorClass(err)}`)
  return { status: 500, body: { error: 'Failed to apply the answer', code: 'internal' } }
}

/**
 * The ask_user half of {@link applyDeviceAnswer}. Ownership and the message
 * binding are checked here (a foreign or mismatched card is the same 404 as a
 * missing one), the device rule decides 403, and the answer itself goes
 * through `InteractionsService.answerById` with surface `api`: the same state
 * machine, error codes (already_answered, closed, stale, idempotency_conflict)
 * and answer turn as a tap in the app.
 */
function applyDeviceAskUserAnswer(input: {
  db: Database
  interactions: InteractionsService
  device: { id: string; userId: number; privacy: boolean }
  body: DeviceAnswerBody
  clientNamespace: string
  logTag: string
}): DeviceAnswerOutcome {
  const { db, device, body } = input
  const record = getInteraction(db, body.blockId)
  if (!record || record.userId !== device.userId || record.messageId !== body.messageId || !isAskUserPayload(record.payload)) {
    return { status: 404, body: { error: 'No such block in this message', code: 'unknown_block' } }
  }
  const question = deviceAnswerableAskUserQuestion(record.payload)
  if (!question) {
    return { status: 403, body: { error: 'This question must be answered on the phone', code: 'not_allowed' } }
  }
  const options = deviceAskUserOptions(question)
  const exact = options.find(option => option.id === body.value)
  const index = opaqueIndex(body.value)
  const positional = index === null ? undefined : options[index]
  const option = device.privacy ? (positional ?? exact) : (exact ?? positional)
  if (!option) return { status: 400, body: { error: 'value must be one of the shown options', code: 'invalid_value' } }
  try {
    const result = input.interactions.answerById(device.userId, record.id, {
      answers: { [question.id]: { selected: [option.id] } },
      clientRequestId: deviceClientMessageId(input.clientNamespace, device.id, body.clientId),
      surface: 'api',
    })
    return { status: 200, body: { applied: true, idempotent: result.idempotent } }
  } catch (err) {
    return deviceAnswerError(err, input.logTag)
  }
}
