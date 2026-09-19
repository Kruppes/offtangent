/**
 * Request parsing for `POST /api/speech/summary`.
 *
 * Hand rolled like every other module here, so a malformed body produces a
 * 400 with a code instead of a stack trace.
 *
 * The body carries exactly one of the two forms:
 *
 *   { "messageId": 12345 }                 a persisted message of this user
 *   { "text": "raw markdown of a bubble" } a bubble that was never stored
 *
 * A body that carries both is not rejected: `messageId` wins, because the
 * stored message is the authoritative text and an app that sends both is
 * sending the same content twice.
 */

import { SETTINGS_TTS_RESPONSE_FORMATS } from '@axiom/core/contracts'
import type { TtsResponseFormat } from '@axiom/core/contracts'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Upper bound for an inline body. Far above any real chat bubble. */
export const SPEECH_TEXT_MAX_CHARS = 200_000

/**
 * Body limit of the json parser in front of the speech routes.
 *
 * The app mounts everything else behind the default `express.json()` (100 kB).
 * A body at {@link SPEECH_TEXT_MAX_CHARS} is bigger than that, so without an
 * own limit express would answer 413 and the contract's
 * `400 { error: 'text_too_large' }` would be unreachable for a real client.
 * 2 MB leaves room for the JSON escaping and multi-byte characters of a
 * 200.000 character text while still capping an absurd body.
 */
export const SPEECH_BODY_LIMIT = '2mb'

export interface SpeechSummaryBody {
  messageId: number | null
  text: string | null
  /**
   * Optional audio container for `POST /api/speech/audio`, handed to the
   * cloud TTS. `null` means "whatever Settings → Text-to-Speech says". The
   * local `voiceTelegram.ttsUrl` path ignores it and always answers
   * `audio/ogg`. `POST /api/speech/summary` accepts the field (one parser for
   * both endpoints) and has no use for it.
   */
  format: TtsResponseFormat | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFormat(raw: unknown): ParseResult<TtsResponseFormat | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'string' || !(SETTINGS_TTS_RESPONSE_FORMATS as readonly string[]).includes(raw)) {
    return { ok: false, error: 'invalid_format' }
  }
  return { ok: true, value: raw as TtsResponseFormat }
}

export function parseSpeechSummaryBody(body: unknown): ParseResult<SpeechSummaryBody> {
  if (!isRecord(body)) return { ok: false, error: 'invalid_body' }

  const format = parseFormat(body.format)
  if (!format.ok) return { ok: false, error: format.error }

  const rawId = body.messageId
  if (rawId !== undefined && rawId !== null) {
    const messageId = typeof rawId === 'string' ? Number(rawId) : rawId
    if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId <= 0) {
      return { ok: false, error: 'invalid_message_id' }
    }
    return { ok: true, value: { messageId, text: null, format: format.value } }
  }

  const rawText = body.text
  if (typeof rawText === 'string') {
    if (rawText.length > SPEECH_TEXT_MAX_CHARS) return { ok: false, error: 'text_too_large' }
    return { ok: true, value: { messageId: null, text: rawText, format: format.value } }
  }

  return { ok: false, error: 'invalid_body' }
}
