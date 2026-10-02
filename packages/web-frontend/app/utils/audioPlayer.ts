/**
 * Pure state of the one shared audio player (W4b).
 *
 * Exactly one clip owns the player at a time (`id`). Every other player on the
 * page renders as idle at position 0, so "only one audio plays" holds by
 * construction: there is one state, not one per clip. The DOM side lives in
 * `useAudioPlayer`; everything here is plain data so it can be unit tested.
 *
 * Hard rules this module encodes: nothing ever starts by itself. The only
 * transition into `playing` is the media element reporting that it plays,
 * and the composable only calls `play()` from a user action.
 */

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export interface PlayerState {
  /** Clip that owns the player, null when nothing was ever started. */
  id: string | null
  status: PlayerStatus
  /** Seconds. */
  position: number
  /** Seconds, 0 while unknown. */
  duration: number
  rate: number
  /** Error kind of the owning clip (see `classifyMediaError`). */
  error: string | null
}

export type PlayerEvent =
  | { type: 'load'; id: string; duration?: number }
  | { type: 'playing' }
  | { type: 'pause' }
  | { type: 'time'; position: number; duration?: number }
  | { type: 'ended' }
  | { type: 'error'; error: string }
  | { type: 'stop' }
  | { type: 'rate'; rate: number }

export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const

export function initialPlayerState(): PlayerState {
  return { id: null, status: 'idle', position: 0, duration: 0, rate: 1, error: null }
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export function reducePlayer(state: PlayerState, event: PlayerEvent): PlayerState {
  switch (event.type) {
    case 'load':
      // A new owner always starts from zero; the previous clip is paused by
      // the composable before this event is dispatched.
      return { ...state, id: event.id, status: 'loading', position: 0, duration: finite(event.duration, 0), error: null }
    case 'playing':
      if (!state.id) return state
      return { ...state, status: 'playing', error: null }
    case 'pause':
      if (state.status !== 'playing' && state.status !== 'loading') return state
      return { ...state, status: 'paused' }
    case 'time': {
      if (!state.id) return state
      const duration = finite(event.duration, state.duration)
      const position = Math.min(finite(event.position, state.position), duration || Number.POSITIVE_INFINITY)
      return { ...state, position, duration }
    }
    case 'ended':
      if (!state.id) return state
      return { ...state, status: 'ended', position: state.duration || state.position }
    case 'error':
      if (!state.id) return state
      return { ...state, status: 'error', error: event.error }
    case 'stop':
      return { ...initialPlayerState(), rate: state.rate }
    case 'rate':
      return { ...state, rate: (PLAYBACK_RATES as readonly number[]).includes(event.rate) ? event.rate : 1 }
  }
}

/** What one clip's player shows: its own state if it owns the player, else idle. */
export function viewForClip(state: PlayerState, id: string, durationHint = 0): Omit<PlayerState, 'id'> {
  if (state.id === id) {
    return { status: state.status, position: state.position, duration: state.duration || finite(durationHint, 0), rate: state.rate, error: state.error }
  }
  return { status: 'idle', position: 0, duration: finite(durationHint, 0), rate: state.rate, error: null }
}

/** `m:ss`, or `h:mm:ss` from one hour. Unknown or negative values read 0:00. */
export function formatClock(seconds: number): string {
  const total = Math.floor(finite(seconds, 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * Keyboard of the scrubber (ARIA slider pattern): arrows step 5 s, PageUp /
 * PageDown 30 s, Home / End jump to the ends. Returns the new position or
 * null when the key is not a scrubber key (the event then stays untouched).
 */
export function seekForKey(key: string, position: number, duration: number, step = 5): number | null {
  if (!(duration > 0)) return null
  const clamp = (value: number) => Math.min(duration, Math.max(0, value))
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown': return clamp(position - step)
    case 'ArrowRight':
    case 'ArrowUp': return clamp(position + step)
    case 'PageDown': return clamp(position - 30)
    case 'PageUp': return clamp(position + 30)
    case 'Home': return 0
    case 'End': return duration
    default: return null
  }
}

/** Position for a pointer at `x` on a track from `left` with `width` pixels. */
export function seekForPointer(x: number, left: number, width: number, duration: number): number | null {
  if (!(width > 0) || !(duration > 0)) return null
  const fraction = Math.min(1, Math.max(0, (x - left) / width))
  return fraction * duration
}

export function nextRate(rate: number): number {
  const index = (PLAYBACK_RATES as readonly number[]).indexOf(rate)
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1
}

/** Map a rejected `play()` or a media `error` event onto a stable kind. */
export function classifyMediaError(error: unknown): 'blocked' | 'unsupported' | 'network' | 'aborted' | 'unknown' {
  const name = (error as { name?: string } | null)?.name
  if (name === 'NotAllowedError') return 'blocked'
  if (name === 'NotSupportedError') return 'unsupported'
  if (name === 'AbortError') return 'aborted'
  const code = (error as { code?: number } | null)?.code
  if (code === 2) return 'network'
  if (code === 3 || code === 4) return 'unsupported'
  if (code === 1) return 'aborted'
  return 'unknown'
}

/** Percent along the track for the slider fill, 0..100. */
export function progressPercent(position: number, duration: number): number {
  if (!(duration > 0)) return 0
  return Math.min(100, Math.max(0, (position / duration) * 100))
}
