import type { TtsSettings } from './useSettings'
import { browserCanPlayType, classifyPlaybackError, pickPlayableFormat } from '~/utils/ttsPlayback'

export interface MistralVoice {
  id: string
  name: string
  languages: string[]
  isPreset: boolean
}

let audioElement: HTMLAudioElement | null = null
let currentBlobUrl: string | null = null
/**
 * Message whose audio is fetched and decodable but which the browser refused
 * to start without a fresh gesture. The next click on the same message plays
 * it synchronously instead of fetching again.
 */
let blockedIndex: number | null = null
/** Bumped by every play()/stop(); async continuations of an older call bail. */
let playGeneration = 0

export function useTts() {
  const { apiFetch } = useApi()
  const { getAccessToken } = useAuth()
  const config = useRuntimeConfig()
  const { t } = useI18n()

  /** Index of the message currently being played */
  const playingIndex = useState<number | null>('tts_playing_index', () => null)
  /** Whether audio is currently loading (fetching from server) */
  const loading = useState<boolean>('tts_loading', () => false)
  /** TTS settings (cached) */
  const ttsSettings = useState<TtsSettings | null>('tts_settings', () => null)
  /** Whether TTS is enabled */
  const ttsEnabled = computed(() => ttsSettings.value?.enabled ?? false)
  /** Mistral voices (fetched from API) */
  const mistralVoices = useState<MistralVoice[]>('tts_mistral_voices', () => [])
  /** Whether voices are loading */
  const voicesLoading = useState<boolean>('tts_voices_loading', () => false)
  /**
   * Last playback error (server message or network failure). Cleared on
   * each new `play()` call. Surfaced inline in the chat so a failed
   * “Read aloud” click doesn't look like a dead button — the most common
   * Deepgram failure mode (text >2000 chars) used to disappear into the
   * console.
   */
  const error = useState<string | null>('tts_error', () => null)

  /** Fetch TTS settings from the server */
  async function fetchTtsSettings(): Promise<void> {
    try {
      ttsSettings.value = await apiFetch<TtsSettings>('/api/tts/settings')
    } catch {
      ttsSettings.value = null
    }
  }

  /** Fetch available Mistral voices */
  async function fetchMistralVoices(): Promise<void> {
    voicesLoading.value = true
    try {
      const data = await apiFetch<{ voices: MistralVoice[] }>('/api/tts/voices')
      mistralVoices.value = data.voices
    } catch {
      mistralVoices.value = []
    } finally {
      voicesLoading.value = false
    }
  }

  /** Stop any currently playing audio */
  function stop() {
    playGeneration++
    if (audioElement) {
      // Detach the handlers first: `pause()` rejects a pending play() with
      // AbortError and `load()` on an empty src fires `error`, and neither is
      // something the user should read about after a deliberate stop.
      audioElement.onended = null
      audioElement.onerror = null
      audioElement.pause()
      audioElement.removeAttribute('src')
      audioElement.load()
      audioElement = null
    }
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl)
      currentBlobUrl = null
    }
    blockedIndex = null
    playingIndex.value = null
    loading.value = false
  }

  /**
   * Report a failed `play()`/media error in words the user can act on. A
   * blocked autoplay keeps the decoded audio around for a second click.
   */
  function reportPlaybackError(err: unknown, messageIndex: number): void {
    const failure = classifyPlaybackError(err)
    if (failure.kind === 'aborted') return
    if (failure.kind === 'blocked') {
      blockedIndex = messageIndex
      playingIndex.value = null
      loading.value = false
      error.value = t('chat.ttsBlocked')
      return
    }
    error.value = failure.kind === 'unsupported' ? t('chat.ttsUnsupported') : failure.message
    stop()
  }

  /** Clear the last error banner (e.g. when the user dismisses it). */
  function clearError() {
    error.value = null
  }

  /**
   * Play TTS for the given text.
   * If the same index is already playing, stop it (toggle behavior).
   */
  async function play(text: string, messageIndex: number) {
    // Toggle behavior: clicking the speaker on an already-playing message stops it.
    if (playingIndex.value === messageIndex) {
      stop()
      return
    }

    // Second click after an autoplay block: the audio is already here, and
    // this call happens inside the click handler, so `play()` is allowed now.
    // Must run before `stop()`, which would discard that audio.
    if (blockedIndex === messageIndex && audioElement) {
      const element = audioElement
      const generation = ++playGeneration
      blockedIndex = null
      error.value = null
      playingIndex.value = messageIndex
      element.play().catch((err) => {
        if (generation === playGeneration) reportPlaybackError(err, messageIndex)
      })
      return
    }

    stop()
    error.value = null

    if (!text.trim()) return

    // Everything after an `await` checks this: a stop or a click on another
    // message in the meantime must not start a ghost playback.
    const generation = ++playGeneration
    loading.value = true
    playingIndex.value = messageIndex

    try {
      const token = getAccessToken()
      const apiBase = config.public.apiBase as string

      // Ask for a container this browser can decode. Safari before 18.4 has
      // no Ogg/Opus, and a saved `opus` would otherwise play as silence.
      const format = pickPlayableFormat(
        ttsSettings.value?.responseFormat ?? 'mp3',
        ttsSettings.value?.provider,
        browserCanPlayType(),
      )

      const response = await fetch(`${apiBase}/api/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(format ? { text, format } : { text }),
      })
      if (generation !== playGeneration) return

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
        throw new Error(errorData.error ?? `HTTP ${response.status}`)
      }

      const blob = await response.blob()
      if (generation !== playGeneration) return
      currentBlobUrl = URL.createObjectURL(blob)

      const element = new Audio(currentBlobUrl)
      audioElement = element
      element.onended = () => {
        if (generation === playGeneration) stop()
      }
      element.onerror = () => {
        // A decode failure used to vanish here; now it is a visible error.
        // A stale element (already stopped) reports nothing.
        if (generation === playGeneration) {
          reportPlaybackError(element.error ?? new Error('media error'), messageIndex)
        }
      }

      try {
        await element.play()
      } catch (err) {
        if (generation === playGeneration) reportPlaybackError(err, messageIndex)
        return
      }
      if (generation === playGeneration) loading.value = false
    } catch (err) {
      if (generation !== playGeneration) return
      const message = err instanceof Error ? err.message : String(err)
      console.error('TTS playback failed:', err)
      error.value = message
      stop()
    }
  }

  return {
    playingIndex,
    loading,
    ttsEnabled,
    ttsSettings,
    mistralVoices,
    voicesLoading,
    error,
    fetchTtsSettings,
    fetchMistralVoices,
    play,
    stop,
    clearError,
  }
}
