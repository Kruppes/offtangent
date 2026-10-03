import { ref, type Ref } from 'vue'
import { useApi } from '~/composables/useApi'

/** `GET|DELETE /api/speech/cache` (W7, admin only). */
export interface SpeechCacheStats {
  enabled: boolean
  entries: number
  bytes: number
  maxBytes: number
  hits: number
  misses: number
}
export interface SpeechCacheCleared extends SpeechCacheStats {
  removedEntries: number
  removedBytes: number
}

export interface SpeechCacheApi {
  get: () => Promise<SpeechCacheStats>
  clear: () => Promise<SpeechCacheCleared>
}

export function useSpeechCacheApi(): SpeechCacheApi {
  const { apiFetch } = useApi()
  return {
    get: () => apiFetch<SpeechCacheStats>('/api/speech/cache'),
    clear: () => apiFetch<SpeechCacheCleared>('/api/speech/cache', { method: 'DELETE' }),
  }
}

export interface SpeechCacheController {
  stats: Ref<SpeechCacheStats | null>
  state: Ref<'loading' | 'ready' | 'error'>
  clearing: Ref<boolean>
  feedback: Ref<{ kind: 'cleared'; entries: number; bytes: number } | { kind: 'failed' } | null>
  load: () => Promise<void>
  clear: () => Promise<boolean>
}

/**
 * Figures of the read-aloud cache plus "empty it". Load has its own
 * loading/error state; clearing keeps the figures visible and reports
 * success (with what was removed) or failure next to the button.
 */
export function createSpeechCache(api: SpeechCacheApi): SpeechCacheController {
  const stats = ref<SpeechCacheStats | null>(null)
  const state = ref<'loading' | 'ready' | 'error'>('loading')
  const clearing = ref(false)
  const feedback = ref<SpeechCacheController['feedback']['value']>(null)

  async function load(): Promise<void> {
    state.value = 'loading'
    try {
      stats.value = await api.get()
      state.value = 'ready'
    } catch {
      state.value = 'error'
    }
  }

  async function clear(): Promise<boolean> {
    if (clearing.value) return false
    clearing.value = true
    feedback.value = null
    try {
      const res = await api.clear()
      const { removedEntries, removedBytes, ...rest } = res
      stats.value = rest
      feedback.value = { kind: 'cleared', entries: removedEntries, bytes: removedBytes }
      return true
    } catch {
      feedback.value = { kind: 'failed' }
      return false
    } finally {
      clearing.value = false
    }
  }

  return { stats, state, clearing, feedback, load, clear }
}

/** 1536 -> "1.5 KB" style, locale-aware number, binary units. */
export function formatCacheBytes(bytes: number, locale?: string): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const digits = unit === 0 || value >= 10 ? 0 : 1
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`
}
