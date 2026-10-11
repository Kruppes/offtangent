import { saveWithModelConsent } from './settingsConsent'
import type { SettingsContract, SettingsUpdateContract, TtsSettingsContract } from '@axiom/core/contracts'

interface ConsolidationRunResult {
  updated: boolean
  reason?: string
}

interface ConsolidationStatus {
  lastRun: string | null
  lastResult: ConsolidationRunResult | null
}

interface TtsPreviewPayload {
  text: string
  /** Container this browser can decode; omitted = the saved/overridden format. */
  format?: TtsSettingsContract['responseFormat']
  settings: Pick<
    TtsSettingsContract,
    'provider' | 'providerId' | 'openaiModel' | 'openaiVoice' | 'openaiInstructions' | 'mistralVoice' | 'responseFormat'
    | 'geminiModel' | 'geminiVoice' | 'geminiStyle'
  >
}

export function useSettingsApi() {
  const { apiFetch, getAuthHeaders } = useApi()
  const config = useRuntimeConfig()
  const { t } = useI18n()
  const consentDialog = useModelConsentDialog()

  const getSettings = () => apiFetch<Partial<SettingsContract>>('/api/settings')

  const updateSettings = (updates: Partial<SettingsUpdateContract>) => saveWithModelConsent(
    body => apiFetch<Partial<SettingsContract> & { message: string }>('/api/settings', {
      method: 'PUT', body: JSON.stringify(body),
    }),
    updates,
    warnings => {
      if (warnings.some(w => !w.explicitlySelected)) throw new Error(t('settings.modelConsent.selectProvider'))
      const scopes = warnings.map(w => t('settings.modelConsent.scope', {
        provider: w.providerName, destination: w.destination, model: w.modelId, role: w.role, voice: w.variant,
        region: w.policy.region, training: w.policy.training,
      })).join('\n\n')
      return consentDialog.request(scopes)
    },
  )

  const getConsolidationStatus = () => apiFetch<ConsolidationStatus>('/api/memory/consolidation/status')

  const runConsolidation = () => apiFetch<ConsolidationRunResult>('/api/memory/consolidation/run', {
    method: 'POST',
  })

  async function previewTts(payload: TtsPreviewPayload): Promise<Blob> {
    const response = await fetch(`${config.public.apiBase}/api/tts/preview`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
      throw new Error(error.error ?? `HTTP ${response.status}`)
    }

    return response.blob()
  }

  return {
    getSettings,
    updateSettings,
    getConsolidationStatus,
    runConsolidation,
    previewTts,
  }
}
