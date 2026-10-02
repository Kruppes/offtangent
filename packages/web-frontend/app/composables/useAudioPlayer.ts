/**
 * useAudioPlayer — the ONE audio element of the web client (W4b).
 *
 * Read-aloud clips, voice notes, dictation recordings and audio attachments
 * all play through this element, so two of them can never sound at once.
 * A native <video> (or any other media element in the page) that starts
 * playing pauses it, and it pauses every page media element when it starts.
 *
 * Hard rules: no autoplay (play() is only ever called from `toggle`, which
 * only runs on a user action) and no MediaSession API — `navigator.mediaSession`
 * is never touched, so the OS shows no lock screen controls for the app.
 */
import { shallowRef } from 'vue'
import { classifyMediaError, initialPlayerState, reducePlayer, type PlayerEvent, type PlayerState } from '~/utils/audioPlayer'

const state = shallowRef<PlayerState>(initialPlayerState())
let element: HTMLAudioElement | null = null
let documentListener = false
/** Bumped by every new load; an older async source resolution bails. */
let generation = 0

function dispatch(event: PlayerEvent) {
  state.value = reducePlayer(state.value, event)
}

function pausePageMedia(except?: EventTarget | null) {
  if (typeof document === 'undefined') return
  document.querySelectorAll('audio, video').forEach((media) => {
    if (media !== except && !(media as HTMLMediaElement).paused) (media as HTMLMediaElement).pause()
  })
}

function ensureElement(): HTMLAudioElement {
  if (element) return element
  const audio = new Audio()
  audio.preload = 'metadata'
  audio.autoplay = false
  audio.addEventListener('playing', () => { pausePageMedia(audio); dispatch({ type: 'playing' }) })
  audio.addEventListener('pause', () => { if (!audio.ended) dispatch({ type: 'pause' }) })
  audio.addEventListener('timeupdate', () => dispatch({ type: 'time', position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : undefined }))
  audio.addEventListener('loadedmetadata', () => dispatch({ type: 'time', position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : undefined }))
  audio.addEventListener('durationchange', () => dispatch({ type: 'time', position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : undefined }))
  audio.addEventListener('ended', () => dispatch({ type: 'ended' }))
  audio.addEventListener('error', () => { if (audio.getAttribute('src')) dispatch({ type: 'error', error: classifyMediaError(audio.error) }) })
  element = audio
  if (!documentListener && typeof document !== 'undefined') {
    // Any page media element that starts (a native <video controls>) stops
    // the shared clip: one sound at a time across the whole page.
    document.addEventListener('play', (event) => {
      if (event.target !== audio && !audio.paused) audio.pause()
      pausePageMedia(event.target)
    }, true)
    documentListener = true
  }
  return audio
}

export type SourceResolver = () => string | Promise<string>

export function useAudioPlayer() {
  /**
   * Play / pause one clip. Must be called from a user action. A clip that
   * does not own the player takes it over (the previous one is paused and
   * forgotten); `resolve` may fetch the source first.
   */
  async function toggle(id: string, resolve: SourceResolver, durationHint?: number): Promise<void> {
    const audio = ensureElement()
    const current = state.value
    if (current.id === id && current.status === 'playing') { audio.pause(); return }
    if (current.id === id && (current.status === 'paused' || current.status === 'ended') && audio.getAttribute('src')) {
      if (current.status === 'ended') audio.currentTime = 0
      try { await audio.play() } catch (error) { dispatch({ type: 'error', error: classifyMediaError(error) }) }
      return
    }
    const mine = ++generation
    audio.pause()
    dispatch({ type: 'load', id, duration: durationHint })
    let src: string
    try {
      src = await resolve()
    } catch {
      if (mine === generation) dispatch({ type: 'error', error: 'network' })
      return
    }
    if (mine !== generation) return
    audio.src = src
    audio.playbackRate = state.value.rate
    try {
      await audio.play()
    } catch (error) {
      if (mine !== generation) return
      const kind = classifyMediaError(error)
      // A refused start (lost user activation) is not an error: the clip is
      // ready and waits for the next tap.
      if (kind === 'blocked' || kind === 'aborted') dispatch({ type: 'pause' })
      else dispatch({ type: 'error', error: kind })
    }
  }

  function seek(id: string, seconds: number) {
    if (state.value.id !== id || !element) return
    element.currentTime = seconds
    dispatch({ type: 'time', position: seconds })
  }

  function setRate(rate: number) {
    dispatch({ type: 'rate', rate })
    if (element) element.playbackRate = state.value.rate
  }

  /** Stop and release the owner (e.g. when its clip disappears). */
  function stop(id?: string) {
    if (id && state.value.id !== id) return
    generation++
    if (element) {
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
    dispatch({ type: 'stop' })
  }

  return { state, toggle, seek, setRate, stop }
}

/** Test seam: put the shared player into a state (render specs). */
export function setPlayerStateForTest(next: PlayerState): void {
  state.value = next
}
