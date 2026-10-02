import { ref, type Ref } from 'vue'
import type { VoiceRepliesState } from './voiceRepliesApi'

export interface VoiceRepliesApi {
  get: () => Promise<VoiceRepliesState>
  set: (enabled: boolean) => Promise<VoiceRepliesState>
}

export interface VoiceRepliesController {
  enabled: Ref<boolean>
  state: Ref<'loading' | 'ready' | 'error'>
  saving: Ref<boolean>
  feedback: Ref<'saved' | 'failed' | null>
  load: () => Promise<void>
  toggle: (next: boolean) => Promise<void>
  dispose: () => void
}

/**
 * State of the per-user voice-replies switch. It saves on change: the switch
 * flips at once, a failed PUT flips it back and reports the failure; a success
 * message clears itself after `feedbackMs`.
 */
export function createVoiceReplies(api: VoiceRepliesApi, feedbackMs = 3000): VoiceRepliesController {
  const enabled = ref(false)
  const state = ref<'loading' | 'ready' | 'error'>('loading')
  const saving = ref(false)
  const feedback = ref<'saved' | 'failed' | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  async function load() {
    state.value = 'loading'
    try {
      enabled.value = (await api.get()).enabled === true
      state.value = 'ready'
    } catch {
      state.value = 'error'
    }
  }

  async function toggle(next: boolean) {
    if (saving.value) return
    const previous = enabled.value
    enabled.value = next
    saving.value = true
    feedback.value = null
    clearTimer()
    try {
      enabled.value = (await api.set(next)).enabled === true
      feedback.value = 'saved'
      timer = setTimeout(() => { feedback.value = null }, feedbackMs)
    } catch {
      enabled.value = previous
      feedback.value = 'failed'
    } finally {
      saving.value = false
    }
  }

  return { enabled, state, saving, feedback, load, toggle, dispose: clearTimer }
}
