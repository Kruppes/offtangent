/**
 * Dictation in the chat composer, the pure part.
 *
 * The state machine (`dictationReducer`), the text insertion at the caret and
 * the small formatting helpers live here without any browser API, so they are
 * unit tested on their own. `useStt` drives the microphone and the upload and
 * feeds events into the reducer; `DictationBar.vue` renders the state.
 *
 *   idle ──start──▶ starting ──started──▶ recording ──stop──▶ transcribing ──done──▶ idle
 *                      │                     │                     │
 *                      └─start_failed──▶ error ◀──too_short────────┤
 *                                          ▲                       └─failed──▶ error (retry keeps the audio; `offline` when the browser had no network)
 *   recording / starting ──cancel──▶ idle  (the audio is dropped, nothing is sent)
 *   error ──retry──▶ transcribing          error ──dismiss──▶ idle
 */

export type DictationErrorCode =
  /** The browser or the user refused the microphone. */
  | 'permission_denied'
  /** No microphone, no MediaRecorder, or the device failed to start. */
  | 'mic_error'
  /** Released before there was anything to transcribe. */
  | 'too_short'
  /** Upload or transcription failed; the recording is kept for a retry. */
  | 'transcribe_error'
  /** The upload failed while the browser reported no network; kept for a retry too. */
  | 'offline'
  /** The server understood nothing. */
  | 'no_speech'

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'error'

export interface DictationState {
  phase: DictationPhase
  /** `Date.now()` when the recorder really started (recording only). */
  startedAt: number | null
  error: DictationErrorCode | null
  /** True when a failed transcription can be sent again (the blob is kept). */
  canRetry: boolean
}

export type DictationEvent =
  | { type: 'start' }
  | { type: 'started'; at: number }
  | { type: 'start_failed'; error: 'permission_denied' | 'mic_error' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'too_short' }
  | { type: 'transcribed' }
  | { type: 'no_speech' }
  /** `offline`: the browser reported no network when the upload failed. */
  | { type: 'failed'; offline?: boolean }
  | { type: 'retry' }
  | { type: 'dismiss' }

export const INITIAL_DICTATION_STATE: DictationState = Object.freeze({
  phase: 'idle',
  startedAt: null,
  error: null,
  canRetry: false,
}) as DictationState

const IDLE: DictationState = INITIAL_DICTATION_STATE

/**
 * Next state for an event. An event that does not fit the current phase is
 * ignored (the same state object comes back), so a double click or a late
 * recorder callback can never jump the machine into a wrong phase.
 */
export function dictationReducer(state: DictationState, event: DictationEvent): DictationState {
  switch (event.type) {
    case 'start':
      // A new recording also clears a pending error (the user moved on).
      return state.phase === 'idle' || state.phase === 'error'
        ? { phase: 'starting', startedAt: null, error: null, canRetry: false }
        : state
    case 'started':
      return state.phase === 'starting' ? { phase: 'recording', startedAt: event.at, error: null, canRetry: false } : state
    case 'start_failed':
      return state.phase === 'starting' ? { phase: 'error', startedAt: null, error: event.error, canRetry: false } : state
    case 'stop':
      return state.phase === 'recording' ? { phase: 'transcribing', startedAt: null, error: null, canRetry: false } : state
    case 'cancel':
      return state.phase === 'recording' || state.phase === 'starting' ? IDLE : state
    case 'too_short':
      return state.phase === 'transcribing' || state.phase === 'recording'
        ? { phase: 'error', startedAt: null, error: 'too_short', canRetry: false }
        : state
    case 'transcribed':
      return state.phase === 'transcribing' ? IDLE : state
    case 'no_speech':
      return state.phase === 'transcribing' ? { phase: 'error', startedAt: null, error: 'no_speech', canRetry: false } : state
    case 'failed':
      return state.phase === 'transcribing'
        ? { phase: 'error', startedAt: null, error: event.offline ? 'offline' : 'transcribe_error', canRetry: true }
        : state
    case 'retry':
      return state.phase === 'error' && state.canRetry ? { phase: 'transcribing', startedAt: null, error: null, canRetry: false } : state
    case 'dismiss':
      return state.phase === 'error' ? IDLE : state
  }
}

/** `mm:ss` of a running recording; minutes keep counting past 59. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * The text the composer gets, as in the app: the rewritten sentence when the
 * server sends a non-blank one, the raw transcript otherwise.
 */
export function pickTranscriptText(response: { transcript?: string | null; rewritten?: string | null }): string {
  const rewritten = response.rewritten?.trim()
  if (rewritten) return rewritten
  return (response.transcript ?? '').trim()
}

/**
 * Insert `insert` into `value` at the selection, never replacing what was
 * typed: a selection is kept and the text goes in at its END. A single space
 * separates the dictation from a neighbouring non-space character on either
 * side. Returns the new value and the caret right after the inserted text.
 */
export function insertAtCursor(
  value: string,
  insert: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined = selectionStart,
): { value: string; caret: number } {
  const text = insert.trim()
  const end = clamp(selectionEnd ?? selectionStart ?? value.length, value.length)
  const position = Math.max(clamp(selectionStart ?? end, value.length), end)
  if (!text) return { value, caret: position }
  const before = value.slice(0, position)
  const after = value.slice(position)
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  const inserted = `${lead}${text}${trail}`
  return { value: before + inserted + after, caret: before.length + lead.length + text.length }
}

function clamp(n: number, max: number): number {
  if (!Number.isFinite(n)) return max
  return Math.min(Math.max(0, Math.trunc(n)), max)
}

/**
 * Loudness 0..1 of one analyser frame (`getByteTimeDomainData`, 128 = silence).
 * Root mean square, scaled so normal speech fills most of the bar.
 */
export function levelFromTimeDomain(frame: ArrayLike<number>): number {
  if (!frame.length) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = ((frame[i] ?? 128) - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / frame.length)
  return Math.min(1, rms * 3)
}

/**
 * Calm level history: the newest value enters smoothed against the previous
 * one, and the row keeps a fixed number of bars (oldest first).
 */
export function pushLevel(history: readonly number[], level: number, bars: number, smoothing = 0.5): number[] {
  const previous = history.length ? history[history.length - 1]! : 0
  const next = previous + (Math.min(1, Math.max(0, level)) - previous) * (1 - smoothing)
  const row = [...history, Math.round(next * 1000) / 1000]
  return row.length > bars ? row.slice(row.length - bars) : row
}

/**
 * Whether a keydown is the dictation shortcut: Ctrl+M everywhere. Cmd+M is
 * NOT used, macOS (and with it every browser there) minimises the window.
 */
export function isDictationShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'm'
}
