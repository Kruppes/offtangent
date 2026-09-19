import type {
  DeepgramModelContract,
  DeepgramModelsListContract,
} from '@axiom/core/contracts'

/**
 * Re-export the core contract types under shorter local names so consumers
 * don't need to import from `@axiom/core/contracts` directly.
 */
export type DeepgramModel = DeepgramModelContract
export type DeepgramModelsList = DeepgramModelsListContract

/**
 * Backend response shape for `GET /api/deepgram/models`. Same as the upstream
 * Deepgram payload; `error` is only set when the backend rejects the request.
 */
interface DeepgramModelsApiResponse extends DeepgramModelsListContract {
  error?: string
}

/**
 * Fetch and cache the list of Deepgram STT/TTS models. The list is shared
 * across the Settings panes (one fetch hydrates both the STT and TTS Deepgram
 * dropdowns) and cached via Nuxt's `useState` so navigating away and back
 * doesn't re-trigger the request.
 */
export function useDeepgram() {
  const { apiFetch } = useApi()

  /** STT models returned by `GET /api/deepgram/models`. */
  const sttModels = useState<DeepgramModelContract[]>('deepgram_stt_models', () => [])
  /** TTS models returned by `GET /api/deepgram/models`. */
  const ttsModels = useState<DeepgramModelContract[]>('deepgram_tts_models', () => [])
  /** True while a fetch is in flight. */
  const loading = useState<boolean>('deepgram_models_loading', () => false)
  /** Last error message, or `null` when the most recent fetch succeeded. */
  const error = useState<string | null>('deepgram_models_error', () => null)
  /** True once at least one fetch has completed (successful or not). */
  const loaded = useState<boolean>('deepgram_models_loaded', () => false)

  /**
   * Fetch the model list from the backend.
   *
   * `scope` selects which saved key the backend falls back to when `apiKey`
   * is omitted or still the masked sentinel — STT and TTS each have their
   * own Deepgram key. `apiKey` lets the caller test a freshly-typed (not yet
   * saved) key without a save round-trip.
   *
   * Sets `error` on failure and clears the cached arrays so the UI shows the
   * empty-state dropdowns with whatever the form currently has selected.
   */
  async function fetchModels(options: {
    scope: 'stt' | 'tts'
    apiKey?: string
    includeOutdated?: boolean
  }): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const body: Record<string, unknown> = { scope: options.scope }
      if (options.apiKey) body.apiKey = options.apiKey
      if (options.includeOutdated) body.includeOutdated = true
      const data = await apiFetch<DeepgramModelsApiResponse>('/api/deepgram/models', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      sttModels.value = Array.isArray(data.stt) ? data.stt : []
      ttsModels.value = Array.isArray(data.tts) ? data.tts : []
    } catch (err) {
      error.value = (err as Error).message
      sttModels.value = []
      ttsModels.value = []
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  /** Drop the cache so the next `fetchModels()` call refetches. */
  function clear() {
    sttModels.value = []
    ttsModels.value = []
    error.value = null
    loaded.value = false
  }

  return {
    sttModels,
    ttsModels,
    loading,
    error,
    loaded,
    fetchModels,
    clear,
  }
}
