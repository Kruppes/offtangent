import { useApi } from '~/composables/useApi'

/** Per-user switch for the automatic voice note after every answer. */
export interface VoiceRepliesState { enabled: boolean }

export function useVoiceRepliesApi() {
  const { apiFetch } = useApi()
  return {
    get: () => apiFetch<VoiceRepliesState>('/api/speech/voice-replies'),
    set: (enabled: boolean) => apiFetch<VoiceRepliesState>('/api/speech/voice-replies', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  }
}
