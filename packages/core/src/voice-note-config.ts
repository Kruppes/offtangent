/**
 * voice-note-config.ts: which voice speaks a voice note.
 *
 * A voice note is NOT pinned to one provider. The optional settings block
 * `tts.voiceNote` selects the route; every field it does not set is inherited
 * from the read-aloud configuration `settings.tts`. A fresh install with no
 * block therefore speaks voice notes with exactly the read-aloud voice, and an
 * instance that wants a cheaper or calmer voice for notes sets only the fields
 * it cares about.
 *
 * Credentials never live here: the effective `providerId` is handed to the
 * read-aloud synthesizer (`tts.ts`), which resolves the key from the provider
 * registry. There is no own key path and no env var special-casing.
 *
 * Adding a provider (e.g. a new hosted voice) is one entry in
 * {@link VOICE_NOTE_PROVIDER_ROUTES} plus the adapter and catalog entries the
 * read-aloud path needs anyway — no voice-note code changes.
 */

import {
  SETTINGS_TTS_FORMATS_BY_PROVIDER,
  SETTINGS_TTS_GEMINI_MODELS,
  SETTINGS_TTS_GEMINI_VOICES,
  SETTINGS_TTS_OPENAI_MODELS,
  SETTINGS_TTS_OPENAI_VOICES,
  SETTINGS_TTS_PROVIDERS,
  VOICE_NOTE_MAX_CHARS_RANGE,
  type TtsProvider,
  type TtsResponseFormat,
  type VoiceNoteSettingsContract,
} from './contracts/settings.js'
import type { TtsSettings } from './tts.js'

/**
 * Upper bound for the spoken text when the block sets none. ~1300 characters
 * are 80 to 90 seconds of speech — long enough for a real answer, short enough
 * that an automatic voice note on every turn stays affordable.
 */
export const VOICE_NOTE_DEFAULT_MAX_CHARS = 1300

/** Smallest / largest cap a configuration may ask for (shared with the UI). */
export const VOICE_NOTE_MIN_MAX_CHARS = VOICE_NOTE_MAX_CHARS_RANGE.min
export const VOICE_NOTE_MAX_MAX_CHARS = VOICE_NOTE_MAX_CHARS_RANGE.max

/**
 * Whether the automatic mode and the long-press endpoint rewrite the answer
 * for the ear before speaking it. `true` keeps the behavior voice notes
 * shipped with; `false` is the deterministic path with zero model calls.
 */
export const VOICE_NOTE_DEFAULT_REWRITE = true

/** Which read-aloud fields a provider takes its model, voice and style from. */
export interface VoiceNoteProviderRoute {
  /** Model id as the read-aloud settings hold it for this provider. */
  model: (settings: TtsSettings) => string
  /** Voice id as the read-aloud settings hold it for this provider. */
  voice: (settings: TtsSettings) => string
  /** Delivery hint / instructions, empty when the provider has none. */
  style: (settings: TtsSettings) => string
  /** Write the effective route back into a settings object for the synthesizer. */
  apply: (settings: TtsSettings, effective: EffectiveVoiceNoteRoute) => TtsSettings
  /** Known model ids, or null when the provider takes free-form ids. */
  models: readonly string[] | null
  /** Known voice ids, or null when the provider takes free-form ids. */
  voices: readonly string[] | null
}

/** The three values a route contributes on top of provider/providerId. */
export interface EffectiveVoiceNoteRoute {
  model: string
  voice: string
  style: string
}

/**
 * One entry per provider of {@link SETTINGS_TTS_PROVIDERS}. The read-aloud
 * settings keep one field set per provider, so the mapping has to be explicit.
 */
export const VOICE_NOTE_PROVIDER_ROUTES: Record<TtsProvider, VoiceNoteProviderRoute> = {
  openai: {
    model: s => s.openaiModel,
    voice: s => s.openaiVoice,
    style: s => s.openaiInstructions,
    apply: (s, e) => ({ ...s, openaiModel: e.model, openaiVoice: e.voice, openaiInstructions: e.style }),
    models: SETTINGS_TTS_OPENAI_MODELS,
    voices: SETTINGS_TTS_OPENAI_VOICES.map(v => v.name),
  },
  mistral: {
    // Mistral pins the model in the adapter (`voxtral-mini-tts`), the voice is
    // a free-form voice id.
    model: () => '',
    voice: s => s.mistralVoice,
    style: () => '',
    apply: (s, e) => ({ ...s, mistralVoice: e.voice }),
    models: null,
    voices: null,
  },
  deepgram: {
    // Deepgram's "model" IS the voice (`aura-2-thalia-en`), so both fields
    // point at the same setting and the UI can show either.
    model: s => s.deepgramModel,
    voice: s => s.deepgramModel,
    style: () => '',
    apply: (s, e) => ({ ...s, deepgramModel: e.voice || e.model }),
    models: null,
    voices: null,
  },
  gemini: {
    model: s => s.geminiModel,
    voice: s => s.geminiVoice,
    style: s => s.geminiStyle,
    apply: (s, e) => ({ ...s, geminiModel: e.model, geminiVoice: e.voice, geminiStyle: e.style }),
    models: SETTINGS_TTS_GEMINI_MODELS,
    voices: SETTINGS_TTS_GEMINI_VOICES.map(v => v.name),
  },
}

/** Fields that can be inherited from the read-aloud configuration. */
export type VoiceNoteInheritedField = 'provider' | 'providerId' | 'model' | 'voice' | 'style' | 'maxChars' | 'rewrite'

/** The route one voice note actually uses. Nothing here is optional. */
export interface EffectiveVoiceNoteConfig extends EffectiveVoiceNoteRoute {
  provider: TtsProvider
  providerId: string
  maxChars: number
  rewrite: boolean
  /** Container asked from the provider; `wav` wherever the provider can. */
  format: TtsResponseFormat
  /** Which fields came from `settings.tts` rather than from `tts.voiceNote`. */
  inherited: VoiceNoteInheritedField[]
}

/**
 * The container a voice note asks the provider for. `wav` everywhere it is
 * supported: the encoder needs samples to join chunks, fade the edges and
 * produce one Ogg/Opus file. A provider that cannot deliver WAV keeps its own
 * container, and the note carries that `mimeType`.
 */
export function voiceNoteFormatFor(provider: TtsProvider): TtsResponseFormat {
  const supported = SETTINGS_TTS_FORMATS_BY_PROVIDER[provider] ?? []
  if (supported.includes('wav')) return 'wav'
  return supported[0] ?? 'mp3'
}

function text(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Merge the optional `tts.voiceNote` block over the read-aloud configuration.
 *
 * An unset (or blank) field is inherited, so switching the read-aloud voice
 * moves the voice notes with it unless the block says otherwise. `style` is
 * the one field that may legitimately be an empty string in the block ("no
 * delivery hint"), so it is only inherited when the key is absent.
 */
export function resolveVoiceNoteConfig(
  readAloud: TtsSettings,
  block: VoiceNoteSettingsContract | undefined | null = readAloud.voiceNote,
): EffectiveVoiceNoteConfig {
  const inherited: VoiceNoteInheritedField[] = []
  const blockProvider = text(block?.provider) as TtsProvider | null
  const provider = blockProvider && (SETTINGS_TTS_PROVIDERS as readonly string[]).includes(blockProvider)
    ? blockProvider
    : (() => { inherited.push('provider'); return readAloud.provider })()

  // The provider id is only inherited when the provider itself is: a note that
  // speaks through another provider must not carry the read-aloud provider's
  // account id. Empty means "let the registry pick by type", exactly as
  // read-aloud does.
  const blockProviderId = text(block?.providerId)
  let providerId: string
  if (blockProviderId) {
    providerId = blockProviderId
  } else if (blockProvider && blockProvider !== readAloud.provider) {
    providerId = ''
  } else {
    inherited.push('providerId')
    providerId = readAloud.providerId
  }

  const route = VOICE_NOTE_PROVIDER_ROUTES[provider]
  const blockModel = text(block?.model)
  const model = blockModel ?? (() => { inherited.push('model'); return route.model(readAloud) })()
  const blockVoice = text(block?.voice)
  const voice = blockVoice ?? (() => { inherited.push('voice'); return route.voice(readAloud) })()
  const style = typeof block?.style === 'string'
    ? block.style
    : (() => { inherited.push('style'); return route.style(readAloud) })()

  const maxChars = typeof block?.maxChars === 'number' && Number.isFinite(block.maxChars)
    ? Math.min(VOICE_NOTE_MAX_MAX_CHARS, Math.max(VOICE_NOTE_MIN_MAX_CHARS, Math.round(block.maxChars)))
    : (() => { inherited.push('maxChars'); return VOICE_NOTE_DEFAULT_MAX_CHARS })()
  const rewrite = typeof block?.rewrite === 'boolean'
    ? block.rewrite
    : (() => { inherited.push('rewrite'); return VOICE_NOTE_DEFAULT_REWRITE })()

  return { provider, providerId, model, voice, style, maxChars, rewrite, format: voiceNoteFormatFor(provider), inherited }
}

/**
 * The read-aloud settings object that speaks ONE voice note: same provider
 * adapters, same key lookup, only the effective route and container laid over
 * it. `enabled` is forced on — a voice note is an explicit request, and the
 * read-aloud switch does not govern it.
 */
export function ttsSettingsForVoiceNote(
  readAloud: TtsSettings,
  config: EffectiveVoiceNoteConfig,
): TtsSettings {
  const base: TtsSettings = {
    ...readAloud,
    enabled: true,
    provider: config.provider,
    providerId: config.providerId,
    responseFormat: config.format,
  }
  return VOICE_NOTE_PROVIDER_ROUTES[config.provider].apply(base, config)
}

export type VoiceNoteSettingsValidation =
  | { value: VoiceNoteSettingsContract }
  | { error: string }

/**
 * Validate a `tts.voiceNote` block against the same catalogs the read-aloud
 * settings use. An unknown model or voice is rejected with the list of known
 * ids — a silently ignored typo would leave the user with a voice they did not
 * choose and no way to see why.
 */
export function validateVoiceNoteSettings(raw: unknown): VoiceNoteSettingsValidation {
  if (raw === null || raw === undefined) return { value: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'tts.voiceNote must be an object' }
  }
  const input = raw as Record<string, unknown>
  const value: VoiceNoteSettingsContract = {}

  let provider: TtsProvider | null = null
  if (input.provider !== undefined) {
    if (typeof input.provider !== 'string'
      || !(SETTINGS_TTS_PROVIDERS as readonly string[]).includes(input.provider)) {
      return { error: `tts.voiceNote.provider must be one of: ${SETTINGS_TTS_PROVIDERS.join(', ')}` }
    }
    provider = input.provider as TtsProvider
    value.provider = provider
  }
  if (input.providerId !== undefined) {
    if (typeof input.providerId !== 'string') return { error: 'tts.voiceNote.providerId must be a string' }
    value.providerId = input.providerId.trim()
  }

  // Without an explicit provider the block inherits it, and we cannot know it
  // here. Validating against the union of all catalogs would accept a Gemini
  // voice for an OpenAI route, so a model/voice is only checked when the block
  // names its provider — the synthesizer rejects a wrong id at call time.
  const route = provider ? VOICE_NOTE_PROVIDER_ROUTES[provider] : null

  if (input.model !== undefined) {
    if (typeof input.model !== 'string') return { error: 'tts.voiceNote.model must be a string' }
    const model = input.model.trim()
    if (model && route?.models && !route.models.includes(model)) {
      return { error: `tts.voiceNote.model "${model}" is not a known ${provider} model: ${route.models.join(', ')}` }
    }
    value.model = model
  }
  if (input.voice !== undefined) {
    if (typeof input.voice !== 'string') return { error: 'tts.voiceNote.voice must be a string' }
    const voice = input.voice.trim()
    if (voice && route?.voices && !route.voices.includes(voice)) {
      return { error: `tts.voiceNote.voice "${voice}" is not a known ${provider} voice: ${route.voices.join(', ')}` }
    }
    value.voice = voice
  }
  if (input.style !== undefined) {
    if (typeof input.style !== 'string') return { error: 'tts.voiceNote.style must be a string' }
    value.style = input.style
  }
  if (input.maxChars !== undefined) {
    if (typeof input.maxChars !== 'number' || !Number.isInteger(input.maxChars)
      || input.maxChars < VOICE_NOTE_MIN_MAX_CHARS || input.maxChars > VOICE_NOTE_MAX_MAX_CHARS) {
      return {
        error: `tts.voiceNote.maxChars must be an integer between ${VOICE_NOTE_MIN_MAX_CHARS} `
          + `and ${VOICE_NOTE_MAX_MAX_CHARS}`,
      }
    }
    value.maxChars = input.maxChars
  }
  if (input.rewrite !== undefined) {
    if (typeof input.rewrite !== 'boolean') return { error: 'tts.voiceNote.rewrite must be a boolean' }
    value.rewrite = input.rewrite
  }

  return { value }
}

/** Catalog view of the effective route, for `GET /api/tts/catalog` and the UI. */
export interface VoiceNoteConfigView extends EffectiveVoiceNoteConfig {
  /** Known model ids of the effective provider; empty = free-form. */
  models: readonly string[]
  /** Known voice ids of the effective provider; empty = free-form. */
  voices: readonly string[]
}

/** {@link VoiceNoteConfigView} for one effective configuration. */
export function describeVoiceNoteConfig(config: EffectiveVoiceNoteConfig): VoiceNoteConfigView {
  const route = VOICE_NOTE_PROVIDER_ROUTES[config.provider]
  return { ...config, models: route.models ?? [], voices: route.voices ?? [] }
}
