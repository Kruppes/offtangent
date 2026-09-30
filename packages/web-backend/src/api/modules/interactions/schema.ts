/**
 * Request parsing for `POST /api/interactions` (SPEC 7.4c).
 *
 * Hand-rolled like every other module here, so a malformed body produces a
 * 400 with a code instead of a stack trace.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string }

const ID_MAX = 64
const VALUE_MAX = 64
const MULTI_MAX = 8

export interface AnswerInteractionBody {
  messageId: number
  blockId: string
  value: string | string[]
  clientMessageId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAnswerInteractionBody(body: unknown): ParseResult<AnswerInteractionBody> {
  if (!isRecord(body)) {
    return { ok: false, error: 'A JSON body is required', code: 'invalid_body' }
  }

  const rawMessageId = body.messageId
  const messageId = typeof rawMessageId === 'string' ? Number(rawMessageId) : rawMessageId
  if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId <= 0) {
    return { ok: false, error: 'messageId must be the id of a chat message', code: 'invalid_message_id' }
  }

  const blockId = body.blockId
  if (typeof blockId !== 'string' || !blockId.trim() || blockId.length > ID_MAX) {
    return { ok: false, error: 'blockId must be a block id', code: 'invalid_block_id' }
  }

  const clientMessageId = body.clientMessageId
  if (typeof clientMessageId !== 'string' || !clientMessageId.trim() || clientMessageId.length > ID_MAX) {
    return { ok: false, error: 'clientMessageId is required for idempotency', code: 'invalid_client_message_id' }
  }

  const rawValue = body.value
  let value: string | string[]
  if (typeof rawValue === 'string') {
    if (!rawValue.trim() || rawValue.length > VALUE_MAX) {
      return { ok: false, error: 'value must be an option id', code: 'invalid_value' }
    }
    value = rawValue
  } else if (Array.isArray(rawValue)) {
    if (rawValue.length === 0 || rawValue.length > MULTI_MAX) {
      return { ok: false, error: 'value must hold between one and eight option ids', code: 'invalid_value' }
    }
    if (rawValue.some(entry => typeof entry !== 'string' || !entry.trim() || entry.length > VALUE_MAX)) {
      return { ok: false, error: 'value must hold option ids', code: 'invalid_value' }
    }
    value = rawValue as string[]
  } else {
    return { ok: false, error: 'value must be an option id or a list of option ids', code: 'invalid_value' }
  }

  return {
    ok: true,
    value: { messageId, blockId: blockId.trim(), value, clientMessageId: clientMessageId.trim() },
  }
}
