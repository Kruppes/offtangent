import type { TtsProvider, TtsResponseFormat } from '@axiom/core/contracts'

/** Field of the voice-note block a user can override, as the UI addresses it. */
export type VoiceNoteDraftField = 'provider' | 'providerId' | 'model' | 'voice' | 'style' | 'maxChars' | 'rewrite'

/** Provider account entry of `GET /api/tts/catalog` (never a key). */
export interface TtsCatalogAccount {
  id: string
  name: string
  providerType: string
  ttsProvider: TtsProvider
}

/** The effective route plus its catalogs, as `GET /api/tts/catalog` returns it. */
export interface VoiceNoteCatalogView {
  provider: TtsProvider
  providerId: string
  model: string
  voice: string
  style: string
  maxChars: number
  rewrite: boolean
  format: TtsResponseFormat
  /** Fields that came from the read-aloud settings rather than from the block. */
  inherited: readonly VoiceNoteDraftField[]
  /** Known model ids of the effective provider; empty = free-form. */
  models: readonly string[]
  /** Known voice ids of the effective provider; empty = free-form. */
  voices: readonly string[]
}

/**
 * `GET /api/tts/catalog` — everything the settings form needs without
 * hardcoding lists: providers, formats, the static model/voice catalogs, the
 * provider accounts that can back TTS (id/name/type, never a key) and the
 * effective voice-note route incl. which of its fields are inherited.
 */
export interface TtsCatalogResponse {
  providers: readonly TtsProvider[]
  formats: readonly TtsResponseFormat[]
  formatsByProvider: Record<string, readonly TtsResponseFormat[]>
  openai: { models: readonly string[]; voices: readonly { name: string }[] }
  gemini: { models: readonly string[]; voices: readonly { name: string; style: string }[]; defaultModel: string; defaultVoice: string }
  accounts: readonly TtsCatalogAccount[]
  voiceNote: VoiceNoteCatalogView
}

export function useTtsCatalogApi() {
  const { apiFetch } = useApi()

  const getTtsCatalog = () => apiFetch<TtsCatalogResponse>('/api/tts/catalog')

  return { getTtsCatalog }
}
