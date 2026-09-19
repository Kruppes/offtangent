/**
 * Silence guard: recognise a transcript that is not speech (SPEC 4.3).
 *
 * Whisper never returns an empty string for silence. It returns its training
 * data instead: `* Musik *` for a dead microphone, `Thank you.` for a short
 * gap, the subtitle credits of the corpus it learned from. Seven of the ten
 * captures waiting in the product owner's tray were `* Musik *` from a button
 * that recorded nothing — routed by a model, filed as a proposal, impossible
 * to get rid of.
 *
 * Two rules, both deliberately narrow, because a false positive silently eats
 * a real thought:
 *
 *  1. The WHOLE text is a non-speech annotation: `* Musik *`, `[Applaus]`,
 *     `(Music)`, `♪♪`. Whisper wraps every non-speech event like this and a
 *     person dictating never speaks the brackets. Capped in length so a
 *     parenthesis around a real sentence stays a real capture.
 *  2. The whole text equals one of a handful of known artefacts that arrive
 *     unbracketed — the subtitle credits and the "thank you" of a silent clip.
 *
 * Everything else passes. `Musik aufnehmen für den Film` is speech: the marker
 * has to BE the text, not appear in it.
 *
 * The guard runs on every capture, not only on `kind: 'voice'`. That is a
 * measurement, not a preference: in the live database all 51 captures from the
 * Android client are `kind: 'text'` — the app transcribes on the device and
 * posts the result as text — and two of the twelve `* Musik *` cards came in
 * that way. Gating on `voice` would have missed exactly the cards the product
 * owner complained about. A typed `* Musik *` is collateral, and it is cheap
 * collateral: the capture is stored, the response says it was discarded, and
 * one undo brings it back.
 */

/** Longest annotation body still treated as non-speech, in characters. */
const MAX_ANNOTATION_LENGTH = 40

/** Exact texts, normalised, that Whisper emits for silence without brackets. */
const BARE_ARTEFACTS = new Set([
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'thank you very much',
  'untertitel der amara.org-community',
  'untertitel im auftrag des zdf',
  'untertitelung des zdf',
  'untertitelung des zdf fur funk',
  'subtitles by the amara.org community',
  'subtitling by the amara.org community',
  'amara.org',
  // German silence, straight from the live tray ('Vielen Dank.' sat there as a
  // needs_review card next to the `* Musik *` ones).
  'vielen dank',
  'danke',
  'danke schon',
  'tschuss',
  'bis zum nachsten mal',
  'wir sehen uns',
])

/**
 * Subtitle credits. Whisper emits them unbracketed and in many spellings, so
 * they need a pattern — but one anchored on an actual broadcaster, because
 * `Copyright für die Reliefkarten klären` is a real thought about copyright.
 */
const CREDITS = /^(untertitel|untertitelung|copyright|subtitles?|subtitling)\b.{0,60}\b(zdf|wdr|ard|ndr|srf|orf|amara\.org|funk)\b.{0,20}$/

/** Bracket pairs Whisper uses around a non-speech event. */
const WRAPPERS: Array<[string, string]> = [
  ['*', '*'],
  ['[', ']'],
  ['(', ')'],
  ['{', '}'],
  ['<', '>'],
  ['♪', '♪'],
  ['#', '#'],
]

/** Lowercase, collapse whitespace, drop trailing punctuation and umlauts. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    // Strip combining marks so `für` and `fur` compare equal; the artefact
    // list is data, not language, and Whisper is inconsistent about umlauts.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:\s]+$/g, '')
    .trim()
}

/**
 * True when the text is a non-speech annotation or a known silent-clip
 * artefact, i.e. the recording contained nothing worth keeping.
 */
export function isSilenceTranscript(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true

  // Rule 1: fully wrapped annotation. Music notes may also stand alone (`♪♪`).
  if (/^[♪\s]+$/.test(trimmed)) return true
  for (const [open, close] of WRAPPERS) {
    if (!trimmed.startsWith(open) || !trimmed.endsWith(close) || trimmed.length < open.length + close.length) continue
    const inner = trimmed.slice(open.length, trimmed.length - close.length).trim()
    // A wrapper that closes in the middle means the text merely CONTAINS an
    // annotation ("[Musik] und dann der Plan") — that is speech.
    if (inner.includes(open) || inner.includes(close)) continue
    if (inner.length === 0) return true
    if (inner.length <= MAX_ANNOTATION_LENGTH) return true
  }

  // Rule 2: bare artefact or subtitle credits.
  const normalised = normalise(trimmed)
  return BARE_ARTEFACTS.has(normalised) || CREDITS.test(normalised)
}

/** Why a capture was dismissed without routing; stored on its decision. */
export const SILENCE_GUARD_MARKER = 'silence guard: the recording contained no speech'
