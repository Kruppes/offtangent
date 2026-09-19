/**
 * Wire-format types for the Deepgram management API responses we proxy
 * through the backend (`/api/deepgram/models`). Mirrors Deepgram's documented
 * `GET /v1/models` shape so we can pass entries through to the UI without
 * remapping. Optional fields are kept loose because Deepgram occasionally
 * adds new metadata keys and we don't want a strict contract to drop them.
 */
export interface DeepgramModelContract {
  /** Human-readable display name, e.g. "Nova-3 General" or "Aura-2 \u2014 Thalia". */
  name: string
  /** API identifier passed to `?model=`, e.g. `nova-3-general`, `aura-2-thalia-en`. */
  canonical_name: string
  /** Model family, e.g. `nova-3`, `aura-2`. */
  architecture: string
  /** ISO-639-1 language codes the model supports (e.g. `["en"]`, `["multi"]`). */
  languages: string[]
  /** Version string Deepgram assigns (date or hash). */
  version: string
  /** Stable Deepgram-assigned identifier. */
  uuid: string
  /** STT-only: model supports batch transcription. */
  batch?: boolean
  /** STT-only: model supports streaming transcription. */
  streaming?: boolean
  /** STT-only: model supports formatted output (smart_format etc.). */
  formatted_output?: boolean
  /** Optional metadata bag (TTS exposes `accent`, both expose `tags`/`use_cases`). */
  metadata?: {
    accent?: string
    tags?: string[]
    use_cases?: string[]
    [key: string]: unknown
  }
}

/**
 * Response of `GET /api/deepgram/models` (and the upstream `GET /v1/models`).
 * Empty arrays are returned for missing categories so the UI can iterate
 * without null checks.
 */
export interface DeepgramModelsListContract {
  stt: DeepgramModelContract[]
  tts: DeepgramModelContract[]
}
