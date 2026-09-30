/**
 * The configurable voice-note route: what an unset `tts.voiceNote` inherits
 * from the read-aloud settings, what a partial block overrides, and which
 * values the settings validator refuses.
 *
 * All fixtures are synthetic.
 */
import { describe, it, expect } from 'vitest'
import {
  VOICE_NOTE_DEFAULT_MAX_CHARS,
  VOICE_NOTE_DEFAULT_REWRITE,
  resolveVoiceNoteConfig,
  ttsSettingsForVoiceNote,
  validateVoiceNoteSettings,
  voiceNoteFormatFor,
} from './voice-note-config.js'
import type { TtsSettings } from './tts.js'

function readAloud(overrides: Partial<TtsSettings> = {}): TtsSettings {
  return {
    enabled: true,
    provider: 'gemini',
    providerId: 'provider-google',
    openaiModel: 'gpt-4o-mini-tts',
    openaiVoice: 'nova',
    openaiInstructions: 'Speak calmly.',
    mistralVoice: 'alto',
    responseFormat: 'mp3',
    deepgramModel: 'aura-2-thalia-en',
    geminiModel: 'gemini-3.1-flash-tts-preview',
    geminiVoice: 'Puck',
    geminiStyle: 'Read slowly.',
    ...overrides,
  }
}

describe('resolveVoiceNoteConfig', () => {
  it('inherits the whole read-aloud route when no block is configured', () => {
    const config = resolveVoiceNoteConfig(readAloud())
    expect(config.provider).toBe('gemini')
    expect(config.providerId).toBe('provider-google')
    expect(config.model).toBe('gemini-3.1-flash-tts-preview')
    expect(config.voice).toBe('Puck')
    expect(config.style).toBe('Read slowly.')
    expect(config.maxChars).toBe(VOICE_NOTE_DEFAULT_MAX_CHARS)
    expect(config.rewrite).toBe(VOICE_NOTE_DEFAULT_REWRITE)
    expect(config.inherited).toEqual(
      expect.arrayContaining(['provider', 'providerId', 'model', 'voice', 'style']),
    )
  })

  it('inherits the read-aloud route of an openai-compatible install', () => {
    const config = resolveVoiceNoteConfig(readAloud({ provider: 'openai', providerId: 'provider-openai' }))
    expect(config.provider).toBe('openai')
    expect(config.model).toBe('gpt-4o-mini-tts')
    expect(config.voice).toBe('nova')
    expect(config.style).toBe('Speak calmly.')
  })

  it('takes the deepgram voice from its model field', () => {
    const config = resolveVoiceNoteConfig(readAloud({ provider: 'deepgram', providerId: '' }))
    expect(config.model).toBe('aura-2-thalia-en')
    expect(config.voice).toBe('aura-2-thalia-en')
  })

  it('overrides only the fields the block sets', () => {
    const config = resolveVoiceNoteConfig(readAloud(), {
      model: 'gemini-3.8-flash-lite-tts',
      voice: 'Charon',
      maxChars: 500,
      rewrite: false,
    })
    expect(config.provider).toBe('gemini')
    expect(config.providerId).toBe('provider-google')
    expect(config.model).toBe('gemini-3.8-flash-lite-tts')
    expect(config.voice).toBe('Charon')
    expect(config.maxChars).toBe(500)
    expect(config.rewrite).toBe(false)
    expect(config.inherited).toContain('provider')
    expect(config.inherited).not.toContain('model')
  })

  it('switches the provider and then inherits that provider read-aloud fields', () => {
    const config = resolveVoiceNoteConfig(readAloud(), { provider: 'openai', providerId: 'provider-openai' })
    expect(config.provider).toBe('openai')
    expect(config.providerId).toBe('provider-openai')
    expect(config.model).toBe('gpt-4o-mini-tts')
    expect(config.voice).toBe('nova')
  })

  it('ignores empty strings in the block instead of speaking with no voice', () => {
    const config = resolveVoiceNoteConfig(readAloud(), { model: '  ', voice: '' })
    expect(config.model).toBe('gemini-3.1-flash-tts-preview')
    expect(config.voice).toBe('Puck')
  })
})

describe('ttsSettingsForVoiceNote', () => {
  it('feeds the effective gemini route back into the read-aloud synthesizer', () => {
    const config = resolveVoiceNoteConfig(readAloud(), { model: 'gemini-3.8-flash-lite-tts', voice: 'Charon' })
    const settings = ttsSettingsForVoiceNote(readAloud({ enabled: false }), config)
    expect(settings.enabled).toBe(true)
    expect(settings.provider).toBe('gemini')
    expect(settings.geminiModel).toBe('gemini-3.8-flash-lite-tts')
    expect(settings.geminiVoice).toBe('Charon')
    expect(settings.responseFormat).toBe('wav')
  })

  it('feeds the effective openai route into the openai fields', () => {
    const base = readAloud({ provider: 'openai', providerId: 'provider-openai' })
    const config = resolveVoiceNoteConfig(base, { model: 'tts-1-hd', voice: 'shimmer' })
    const settings = ttsSettingsForVoiceNote(base, config)
    expect(settings.provider).toBe('openai')
    expect(settings.openaiModel).toBe('tts-1-hd')
    expect(settings.openaiVoice).toBe('shimmer')
    expect(settings.responseFormat).toBe('wav')
  })
})

describe('voiceNoteFormatFor', () => {
  it('asks every catalog provider for wav, because the encoder needs samples', () => {
    for (const provider of ['openai', 'mistral', 'deepgram', 'gemini'] as const) {
      expect(voiceNoteFormatFor(provider)).toBe('wav')
    }
  })
})

describe('validateVoiceNoteSettings', () => {
  it('accepts an empty block', () => {
    expect(validateVoiceNoteSettings({})).toEqual({ value: {} })
  })

  it('accepts a full block against the catalogs', () => {
    const result = validateVoiceNoteSettings({
      provider: 'gemini',
      providerId: 'provider-google',
      model: 'gemini-3.8-flash-lite-tts',
      voice: 'Charon',
      style: '',
      maxChars: 900,
      rewrite: false,
    })
    expect(result).toEqual({
      value: {
        provider: 'gemini',
        providerId: 'provider-google',
        model: 'gemini-3.8-flash-lite-tts',
        voice: 'Charon',
        style: '',
        maxChars: 900,
        rewrite: false,
      },
    })
  })

  it('rejects an unknown provider', () => {
    const result = validateVoiceNoteSettings({ provider: 'elevenlabs' })
    expect('error' in result && result.error).toMatch(/provider/)
  })

  it('rejects a model the selected provider catalog does not know', () => {
    const result = validateVoiceNoteSettings({ provider: 'gemini', model: 'gemini-9-ultra-tts' })
    expect('error' in result && result.error).toMatch(/model/)
  })

  it('rejects a voice the selected provider catalog does not know', () => {
    const result = validateVoiceNoteSettings({ provider: 'gemini', voice: 'Nobody' })
    expect('error' in result && result.error).toMatch(/voice/)
  })

  it('validates a voice against the provider of the block, not the default', () => {
    expect(validateVoiceNoteSettings({ provider: 'openai', voice: 'shimmer' })).toEqual({
      value: { provider: 'openai', voice: 'shimmer' },
    })
    const result = validateVoiceNoteSettings({ provider: 'openai', voice: 'Charon' })
    expect('error' in result && result.error).toMatch(/voice/)
  })

  it('rejects a maxChars outside the supported range', () => {
    expect('error' in validateVoiceNoteSettings({ maxChars: 10 })).toBe(true)
    expect('error' in validateVoiceNoteSettings({ maxChars: 99_000 })).toBe(true)
    expect('error' in validateVoiceNoteSettings({ maxChars: 1.5 })).toBe(true)
  })

  it('rejects a non-boolean rewrite flag', () => {
    const result = validateVoiceNoteSettings({ rewrite: 'yes' })
    expect('error' in result && result.error).toMatch(/rewrite/)
  })
})
