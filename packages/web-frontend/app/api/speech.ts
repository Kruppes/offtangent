/**
 * Contract of the spoken-output routes the companion app already uses
 * (backend `packages/web-backend/src/api/modules/speech/route.ts`):
 *
 *   POST /api/speech/audio      { messageId } | { text } -> audio bytes
 *   POST /api/speech/summary    { messageId } | { text } -> { text, language, sourceChars, summaryChars }
 *   POST /api/speech/voice-note { messageId }            -> { voiceNote }
 *
 * Errors are `{ error: <code> }`: 400 empty | invalid_body | invalid_message_id
 * | text_too_large, 404 not_found, 502 upstream, 503 tts_unconfigured.
 * Voice and engine stay a server setting; the client never names one.
 */

export const SPEECH_AUDIO_PATH = '/api/speech/audio'
export const SPEECH_SUMMARY_PATH = '/api/speech/summary'
export const SPEECH_VOICE_NOTE_PATH = '/api/speech/voice-note'

/** `metadata.voiceNote` of an assistant message (core `VoiceNote`). */
export interface VoiceNoteRef {
  url: string
  mimeType: string
  seconds: number
  spokenChars?: number
  sourceChars?: number
  createdAt?: string
  variant?: 'full' | 'summary'
}

export interface SpeechSummaryResponse {
  text: string
  language: string
  sourceChars: number
  summaryChars: number
}

/**
 * Request body: a persisted message goes by id (the server reads the stored,
 * authoritative text and caches its summary), a bubble that was never stored
 * by its text. Never both.
 */
export function speechRequestBody(messageId: number | undefined, text: string): { messageId: number } | { text: string } {
  if (typeof messageId === 'number' && Number.isInteger(messageId) && messageId > 0) return { messageId }
  return { text }
}

export type SpeechErrorKind = 'unconfigured' | 'upstream' | 'empty' | 'tooLarge' | 'notFound' | 'network' | 'generic'

/** Map a status + `error` code onto the message the UI shows. */
export function speechErrorKind(status: number | null, code?: unknown): SpeechErrorKind {
  if (status === null) return 'network'
  if (status === 503 || code === 'tts_unconfigured') return 'unconfigured'
  if (status === 502 || code === 'upstream') return 'upstream'
  if (code === 'empty') return 'empty'
  if (code === 'text_too_large') return 'tooLarge'
  if (status === 404) return 'notFound'
  return 'generic'
}

/** Only files of our own upload store are ever played (no foreign URLs). */
export function isOwnUploadPath(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('/api/uploads/') && !url.includes('..') && !url.includes('//', 1)
}

/** Validate `metadata.voiceNote` (or a `voice_note` frame payload). */
export function readVoiceNote(value: unknown): VoiceNoteRef | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (!isOwnUploadPath(raw.url)) return null
  const seconds = typeof raw.seconds === 'number' && Number.isFinite(raw.seconds) && raw.seconds >= 0 ? raw.seconds : 0
  return {
    url: raw.url,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : 'audio/wav',
    seconds,
    ...(typeof raw.spokenChars === 'number' ? { spokenChars: raw.spokenChars } : {}),
    ...(typeof raw.sourceChars === 'number' ? { sourceChars: raw.sourceChars } : {}),
    ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {}),
    ...(raw.variant === 'full' || raw.variant === 'summary' ? { variant: raw.variant } : {}),
  }
}

/**
 * URL of a stored upload for an element that cannot send a header (`<audio>`,
 * `<video>`, `<img>`): the token travels as a query parameter, exactly like
 * the existing attachment links.
 */
export function uploadSrc(apiBase: string, urlPath: string, token: string | null, download = false): string {
  const params = new URLSearchParams()
  if (download) params.set('download', '1')
  if (token) params.set('token', token)
  const query = params.toString()
  return `${apiBase}${urlPath}${query ? `?${query}` : ''}`
}
