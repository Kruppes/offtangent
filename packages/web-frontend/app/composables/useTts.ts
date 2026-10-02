import type { TtsSettings } from './useSettings'

export interface MistralVoice {
  id: string
  name: string
  languages: string[]
  isPreset: boolean
}

/**
 * TTS settings and the voice catalogue. Playback of a message is the server
 * speech flow (`/api/speech/audio`, `useMessageSpeech` + the shared player);
 * the old client-side `play()` of this composable is gone since W6b.
 */
export function useTts() {
  const { apiFetch } = useApi()

  /** TTS settings (cached) */
  const ttsSettings = useState<TtsSettings | null>('tts_settings', () => null)
  /** Whether TTS is enabled */
  const ttsEnabled = computed(() => ttsSettings.value?.enabled ?? false)
  /** Mistral voices (fetched from API) */
  const mistralVoices = useState<MistralVoice[]>('tts_mistral_voices', () => [])
  /** Whether voices are loading */
  const voicesLoading = useState<boolean>('tts_voices_loading', () => false)
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

  return {
    ttsEnabled,
    ttsSettings,
    mistralVoices,
    voicesLoading,
    fetchTtsSettings,
    fetchMistralVoices,
  }
}
