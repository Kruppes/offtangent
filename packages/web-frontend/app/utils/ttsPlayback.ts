import { SETTINGS_TTS_FORMATS_BY_PROVIDER } from '@axiom/core/contracts'
import type { TtsProvider, TtsResponseFormat } from '@axiom/core/contracts'

/**
 * Format negotiation and error classification for `<audio>` playback of
 * server TTS. Pure functions so the browser matrix can be unit-tested; the
 * composable/component only wires them to a real `HTMLAudioElement`.
 *
 * Why this exists: the saved format is Ogg/Opus, which Chrome and Firefox
 * play but Safari only from 18.4 on. The old code created `new Audio(blob)`
 * and swallowed the decode error, so the user got a button that did nothing.
 */

/** MIME type per format as `canPlayType` wants it. */
export const TTS_FORMAT_MIME: Record<TtsResponseFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg; codecs="opus"',
  flac: 'audio/flac',
}

/** Fallback order when the preferred format cannot be decoded here. */
const FALLBACK_ORDER: readonly TtsResponseFormat[] = ['mp3', 'wav', 'opus', 'flac']

export type CanPlayType = (mime: string) => string

/**
 * Pick the format to request: the preferred one when the browser can decode
 * it, otherwise the first decodable fallback the provider can build. Returns
 * `null` when nothing matches (the caller then sends no override and lets the
 * server decide, which at least yields a readable error instead of silence).
 *
 * `canPlayType` answers '' | 'maybe' | 'probably'; both non-empty answers
 * count. WAV is treated as always playable because every engine decodes PCM
 * even where `canPlayType('audio/wav')` is conservative.
 */
export function pickPlayableFormat(
  preferred: TtsResponseFormat,
  provider: TtsProvider | string | undefined,
  canPlayType: CanPlayType,
): TtsResponseFormat | null {
  const supported = provider && provider in SETTINGS_TTS_FORMATS_BY_PROVIDER
    ? SETTINGS_TTS_FORMATS_BY_PROVIDER[provider as TtsProvider]
    : FALLBACK_ORDER
  const playable = (format: TtsResponseFormat) =>
    format === 'wav' || canPlayType(TTS_FORMAT_MIME[format]) !== ''

  if (supported.includes(preferred) && playable(preferred)) return preferred
  for (const format of FALLBACK_ORDER) {
    if (supported.includes(format) && playable(format)) return format
  }
  return null
}

/** Resolve `canPlayType` from the DOM, or a stub outside the browser. */
export function browserCanPlayType(): CanPlayType {
  if (typeof document === 'undefined') return () => ''
  const probe = document.createElement('audio')
  return mime => probe.canPlayType(mime)
}

export type PlaybackFailure =
  /** We interrupted it ourselves (pause/src swap); nothing to report. */
  | { kind: 'aborted' }
  /** The browser refused `play()` without a fresh user gesture. */
  | { kind: 'blocked' }
  /** The element could not decode the bytes it was given. */
  | { kind: 'unsupported' }
  /** Network, server or anything else; `message` is what we know. */
  | { kind: 'failed'; message: string }

/**
 * Classify a rejected `play()` promise or a media `error` event so the UI can
 * offer the right recovery: a second tap for a blocked autoplay, a format
 * hint for an undecodable stream, the raw message for the rest.
 */
export function classifyPlaybackError(err: unknown): PlaybackFailure {
  if (err instanceof Error || (typeof err === 'object' && err !== null && 'name' in err)) {
    const name = String((err as { name?: unknown }).name ?? '')
    if (name === 'AbortError') return { kind: 'aborted' }
    if (name === 'NotAllowedError') return { kind: 'blocked' }
    if (name === 'NotSupportedError') return { kind: 'unsupported' }
    const message = String((err as { message?: unknown }).message ?? name)
    return { kind: 'failed', message }
  }
  if (typeof err === 'object' && err !== null && 'code' in err) {
    // MediaError from the element's `error` property.
    const code = Number((err as { code?: unknown }).code)
    if (code === 1) return { kind: 'aborted' } // MEDIA_ERR_ABORTED
    if (code === 3 || code === 4) return { kind: 'unsupported' }
    return { kind: 'failed', message: `media error ${code}` }
  }
  return { kind: 'failed', message: String(err) }
}
