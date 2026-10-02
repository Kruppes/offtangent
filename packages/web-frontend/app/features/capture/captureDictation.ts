import { insertAtCursor } from '~/utils/dictation'

/**
 * Dictation in the capture box on Home (W5d), the pure part.
 *
 * Product rule: a capture keeps ONLY the text. The recording goes to the
 * transcription endpoint once (without `keepAudio`) and is never stored, never
 * attached. What survives of the dictation is a mark on the capture.
 *
 * The mark is the capture's existing `kind` field: the server has always
 * accepted `kind: 'voice'` (whitelist `text | voice | image | file`, unknown
 * values answer 400 `invalid_kind`), stores it in `captures.kind` and returns it
 * in every capture, and the Android tray already draws a microphone for it. A
 * typed capture sends no `kind` at all, so its body stays exactly as before
 * (the server default is `text`).
 */

/** The value of `kind` that marks a dictated capture. */
export const DICTATED_CAPTURE_KIND = 'voice' as const

/**
 * The transcript goes in at the END of what is already in the box, never
 * replacing it, with one space (or nothing) as separator. Blank transcripts
 * leave the text untouched.
 */
export function appendTranscript(value: string, transcript: string): string {
  return insertAtCursor(value, transcript, value.length, value.length).value
}

/** The mark after a transcript arrived: set when real text went in. */
export function markAfterTranscript(dictated: boolean, transcript: string): boolean {
  return dictated || transcript.trim().length > 0
}

/**
 * The mark after the box changed: a box that was emptied completely starts
 * over as typed; any edit of dictated text keeps the mark (the words were
 * still spoken).
 */
export function markAfterEdit(dictated: boolean, value: string): boolean {
  return dictated && value.trim().length > 0
}

/** The extra body fields of `POST /api/captures` for the mark. */
export function dictationFields(dictated: boolean): { kind?: typeof DICTATED_CAPTURE_KIND } {
  return dictated ? { kind: DICTATED_CAPTURE_KIND } : {}
}

/** Whether a listed capture carries the dictation mark. */
export function isDictatedCapture(capture: { kind?: string | null }): boolean {
  return capture.kind === DICTATED_CAPTURE_KIND
}
