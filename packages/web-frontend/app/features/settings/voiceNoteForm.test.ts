/**
 * Draft <-> payload logic of the "Voice messages" settings section.
 *
 * The saved block `tts.voiceNote` is sparse on purpose: a field that is not in
 * it inherits from the read-aloud configuration. So the form may never write
 * the inherited value back — a reset has to REMOVE the key, and an override
 * has to send that key only. Those two rules are what this spec pins down,
 * plus the range of `maxChars` and the tri-state of the rewrite switch.
 */
import { describe, it, expect } from 'vitest'
import { VOICE_NOTE_MAX_CHARS_RANGE } from '@axiom/core/contracts'
import {
  buildVoiceNotePayload,
  resetVoiceNoteField,
  voiceNoteDraftFromCatalog,
  voiceNoteInheritsField,
  voiceNoteMaxCharsError,
  type VoiceNoteCatalogView,
  type VoiceNoteDraft,
} from './voiceNoteForm'

/** Catalog view as `GET /api/tts/catalog` returns it: everything inherited. */
const inheritedView: VoiceNoteCatalogView = {
  provider: 'openai',
  providerId: 'acct-one',
  model: 'gpt-4o-mini-tts',
  voice: 'nova',
  style: 'calm',
  maxChars: 1300,
  rewrite: true,
  format: 'wav',
  inherited: ['provider', 'providerId', 'model', 'voice', 'style', 'maxChars', 'rewrite'],
  models: ['gpt-4o-mini-tts', 'tts-1'],
  voices: ['nova', 'alloy'],
}

describe('voice-note settings draft', () => {
  it('shows every field as inherited when the block is empty', () => {
    const draft = voiceNoteDraftFromCatalog(inheritedView)
    expect(draft).toEqual({
      provider: '',
      providerId: '',
      model: '',
      voice: '',
      style: null,
      maxChars: '',
      rewrite: null,
    })
    for (const field of ['provider', 'providerId', 'model', 'voice', 'style', 'maxChars', 'rewrite'] as const) {
      expect(voiceNoteInheritsField(draft, field)).toBe(true)
    }
    // Nothing set => no block at all, so the route keeps following read-aloud.
    expect(buildVoiceNotePayload(draft)).toBeNull()
  })

  it('takes the set fields out of the catalog and leaves the rest inherited', () => {
    const draft = voiceNoteDraftFromCatalog({
      ...inheritedView,
      provider: 'gemini',
      providerId: 'acct-google',
      model: 'gemini-2.5-flash-preview-tts',
      voice: 'Charon',
      maxChars: 900,
      rewrite: false,
      inherited: ['providerId', 'style'],
      models: ['gemini-2.5-flash-preview-tts'],
      voices: ['Charon', 'Kore'],
    })
    expect(draft).toEqual({
      provider: 'gemini',
      providerId: '',
      model: 'gemini-2.5-flash-preview-tts',
      voice: 'Charon',
      style: null,
      maxChars: '900',
      rewrite: false,
    })
    expect(voiceNoteInheritsField(draft, 'providerId')).toBe(true)
    expect(voiceNoteInheritsField(draft, 'voice')).toBe(false)
  })

  it('sends only the fields the user set', () => {
    const draft: VoiceNoteDraft = {
      provider: 'gemini',
      providerId: 'acct-google',
      model: '',
      voice: 'Charon',
      style: null,
      maxChars: '',
      rewrite: null,
    }
    expect(buildVoiceNotePayload(draft)).toEqual({
      provider: 'gemini',
      providerId: 'acct-google',
      voice: 'Charon',
    })
  })

  it('removes the key when a field is reset to inherit', () => {
    const draft: VoiceNoteDraft = {
      provider: 'gemini',
      providerId: 'acct-google',
      model: 'gemini-2.5-flash-preview-tts',
      voice: 'Charon',
      style: 'friendly',
      maxChars: '900',
      rewrite: false,
    }
    const withoutVoice = resetVoiceNoteField(draft, 'voice')
    const payload = buildVoiceNotePayload(withoutVoice)
    expect(payload).not.toBeNull()
    expect(Object.keys(payload!).sort()).toEqual(['maxChars', 'model', 'provider', 'providerId', 'rewrite', 'style'])
    expect('voice' in payload!).toBe(false)
    expect(withoutVoice.voice).toBe('')

    // Resetting every field drops the block itself instead of writing `{}`.
    let bare = draft
    for (const field of ['provider', 'providerId', 'model', 'voice', 'style', 'maxChars', 'rewrite'] as const) {
      bare = resetVoiceNoteField(bare, field)
    }
    expect(buildVoiceNotePayload(bare)).toBeNull()

    // The original draft is untouched (immutability keeps Vue state honest).
    expect(draft.voice).toBe('Charon')
  })

  it('carries the rewrite toggle as a boolean, both ways', () => {
    const base = voiceNoteDraftFromCatalog(inheritedView)
    expect(buildVoiceNotePayload({ ...base, rewrite: false })).toEqual({ rewrite: false })
    expect(buildVoiceNotePayload({ ...base, rewrite: true })).toEqual({ rewrite: true })
    expect(buildVoiceNotePayload({ ...base, rewrite: null })).toBeNull()
  })

  it('keeps an explicit empty style but inherits a null one', () => {
    const base = voiceNoteDraftFromCatalog(inheritedView)
    expect(buildVoiceNotePayload({ ...base, style: '' })).toEqual({ style: '' })
    expect(buildVoiceNotePayload({ ...base, style: 'whisper' })).toEqual({ style: 'whisper' })
    expect(buildVoiceNotePayload({ ...base, style: null })).toBeNull()
  })

  it('reports a maxChars outside the contract range and never sends it', () => {
    const base = voiceNoteDraftFromCatalog(inheritedView)
    expect(voiceNoteMaxCharsError({ ...base, maxChars: '' })).toBeNull()
    expect(voiceNoteMaxCharsError({ ...base, maxChars: String(VOICE_NOTE_MAX_CHARS_RANGE.min) })).toBeNull()
    expect(voiceNoteMaxCharsError({ ...base, maxChars: String(VOICE_NOTE_MAX_CHARS_RANGE.max) })).toBeNull()
    expect(voiceNoteMaxCharsError({ ...base, maxChars: String(VOICE_NOTE_MAX_CHARS_RANGE.min - 1) })).toBe('range')
    expect(voiceNoteMaxCharsError({ ...base, maxChars: String(VOICE_NOTE_MAX_CHARS_RANGE.max + 1) })).toBe('range')
    expect(voiceNoteMaxCharsError({ ...base, maxChars: '90.5' })).toBe('range')
    expect(voiceNoteMaxCharsError({ ...base, maxChars: 'abc' })).toBe('range')

    expect(buildVoiceNotePayload({ ...base, maxChars: '1200' })).toEqual({ maxChars: 1200 })
    expect(buildVoiceNotePayload({ ...base, maxChars: 'abc' })).toBeNull()
  })

  it('drops a provider account that does not belong to the chosen provider', () => {
    // Switching the provider must not keep the old account id: the backend
    // rejects the pair, and inheriting is the honest fallback.
    const draft: VoiceNoteDraft = {
      provider: 'gemini',
      providerId: 'acct-openai',
      model: '',
      voice: '',
      style: null,
      maxChars: '',
      rewrite: null,
    }
    const accounts = [
      { id: 'acct-openai', name: 'OpenAI Key', providerType: 'openai', ttsProvider: 'openai' as const },
      { id: 'acct-google', name: 'Google Key', providerType: 'google', ttsProvider: 'gemini' as const },
    ]
    expect(buildVoiceNotePayload(draft, accounts)).toEqual({ provider: 'gemini' })
    expect(buildVoiceNotePayload({ ...draft, providerId: 'acct-google' }, accounts))
      .toEqual({ provider: 'gemini', providerId: 'acct-google' })
  })
})
