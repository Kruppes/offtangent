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

/* ------------------------------------------------------------------ *
 * S1-A: id-based endpoints
 * ------------------------------------------------------------------ */

const INTERACTION_ID = /^ia_[0-9A-HJKMNP-TV-Z]{26}$/
const DRAFT_MAX_BYTES = 16_384

export function isInteractionId(value: unknown): value is string {
  return typeof value === 'string' && INTERACTION_ID.test(value)
}

function parseValue(rawValue: unknown): ParseResult<string | string[]> {
  if (typeof rawValue === 'string') {
    if (!rawValue.trim() || rawValue.length > VALUE_MAX) {
      return { ok: false, error: 'value must be an option id', code: 'invalid_value' }
    }
    return { ok: true, value: rawValue }
  }
  if (Array.isArray(rawValue)) {
    if (rawValue.length === 0 || rawValue.length > MULTI_MAX) {
      return { ok: false, error: 'value must hold between one and eight option ids', code: 'invalid_value' }
    }
    if (rawValue.some(entry => typeof entry !== 'string' || !entry.trim() || entry.length > VALUE_MAX)) {
      return { ok: false, error: 'value must hold option ids', code: 'invalid_value' }
    }
    return { ok: true, value: rawValue as string[] }
  }
  return { ok: false, error: 'value must be an option id or a list of option ids', code: 'invalid_value' }
}

export interface AskUserAnswerBody {
  selected: string[]
  comment?: string
}

/** Exactly one of `value` (fence card) and `answers` (ask_user card, S1-B). */
export interface AnswerByIdBody {
  value?: string | string[]
  answers?: Record<string, AskUserAnswerBody>
  clientRequestId: string
}

const ASK_USER_QUESTIONS_MAX = 4
const ASK_USER_SELECTED_MAX = 9
const ASK_USER_COMMENT_MAX = 2000
const ASK_USER_KEY = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Shape check of `answers` (S1-B). The rules against the card itself (known
 * option ids, comment allowed) are `validateAskUserAnswer` in the service.
 * Error texts never echo a value of the request.
 */
function parseAnswers(raw: unknown): ParseResult<Record<string, AskUserAnswerBody>> {
  const bad = (error: string): ParseResult<Record<string, AskUserAnswerBody>> => ({ ok: false, error, code: 'invalid_value' })
  if (!isRecord(raw)) return bad('answers must be an object keyed by question id')
  const keys = Object.keys(raw)
  if (keys.length === 0 || keys.length > ASK_USER_QUESTIONS_MAX) return bad('answers must hold between one and four questions')
  const out: Record<string, AskUserAnswerBody> = {}
  for (const key of keys) {
    if (!ASK_USER_KEY.test(key)) return bad('answers must be keyed by question ids')
    const entry = raw[key]
    if (!isRecord(entry)) return bad('every answer must be an object with selected')
    const selected = entry.selected
    if (!Array.isArray(selected) || selected.length === 0 || selected.length > ASK_USER_SELECTED_MAX
      || !selected.every(id => typeof id === 'string' && ASK_USER_KEY.test(id))) {
      return bad('selected must hold between one and nine option ids')
    }
    const item: AskUserAnswerBody = { selected: selected as string[] }
    if (entry.comment !== undefined && entry.comment !== null) {
      if (typeof entry.comment !== 'string') return bad('comment must be a string')
      if (entry.comment.length > ASK_USER_COMMENT_MAX) return { ok: false, error: 'The comment is too long', code: 'comment_too_long' }
      item.comment = entry.comment
    }
    out[key] = item
  }
  return { ok: true, value: out }
}

/** `POST /api/interactions/:id/answer` `{ value | answers, clientRequestId }`. */
export function parseAnswerByIdBody(body: unknown): ParseResult<AnswerByIdBody> {
  if (!isRecord(body)) return { ok: false, error: 'A JSON body is required', code: 'invalid_body' }
  const clientRequestId = body.clientRequestId
  if (typeof clientRequestId !== 'string' || !clientRequestId.trim() || clientRequestId.length > ID_MAX) {
    return { ok: false, error: 'clientRequestId is required for idempotency', code: 'invalid_client_request_id' }
  }
  const hasValue = body.value !== undefined
  const hasAnswers = body.answers !== undefined
  if (hasValue === hasAnswers) {
    return { ok: false, error: 'Send either value or answers', code: 'invalid_value' }
  }
  if (hasAnswers) {
    const answers = parseAnswers(body.answers)
    if (!answers.ok) return answers
    return { ok: true, value: { answers: answers.value, clientRequestId: clientRequestId.trim() } }
  }
  const value = parseValue(body.value)
  if (!value.ok) return value
  return { ok: true, value: { value: value.value, clientRequestId: clientRequestId.trim() } }
}

/** `PUT /api/interactions/:id/draft` `{ answers }` — partial answers, opaque to the server, size capped. */
export function parseDraftBody(body: unknown): ParseResult<{ answers: unknown }> {
  if (!isRecord(body) || !('answers' in body)) {
    return { ok: false, error: 'answers is required', code: 'invalid_draft' }
  }
  const serialized = JSON.stringify(body.answers ?? null)
  if (Buffer.byteLength(serialized, 'utf8') > DRAFT_MAX_BYTES) {
    return { ok: false, error: 'draft is too large', code: 'draft_too_large' }
  }
  return { ok: true, value: { answers: body.answers ?? null } }
}

export const INTERACTION_STATUS_FILTERS = ['open', 'answered', 'dismissed', 'superseded', 'expired'] as const
