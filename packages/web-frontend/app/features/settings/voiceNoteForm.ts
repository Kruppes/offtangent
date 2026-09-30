/**
 * Draft state for the optional voice-note route (`tts.voiceNote`).
 *
 * The block is sparse: a field it does not contain is inherited from the
 * read-aloud configuration, and the backend resolves that inheritance. The
 * form therefore must never write an inherited value back — the empty string
 * (`null` for `style`/`rewrite`) means "inherit", and `buildVoiceNotePayload`
 * emits only the keys the user actually set. Resetting a field removes its
 * key; resetting all of them drops the block, which is what
 * `PUT /api/settings` with `tts.voiceNote: null` does.
 */
import type { TtsProvider, VoiceNoteSettingsContract } from '@axiom/core/contracts'
import { VOICE_NOTE_MAX_CHARS_RANGE } from '@axiom/core/contracts'
import type { TtsCatalogAccount, VoiceNoteCatalogView, VoiceNoteDraftField } from '~/api/tts'

export type { TtsCatalogAccount, VoiceNoteCatalogView, VoiceNoteDraftField }

/**
 * One editable override. `''`/`null` is "inherit"; `style` distinguishes
 * "inherit" (`null`) from an explicit "no delivery hint" (`''`).
 */
export interface VoiceNoteDraft {
  provider: string
  providerId: string
  model: string
  voice: string
  style: string | null
  /** Raw input value, so a half-typed number does not vanish. */
  maxChars: string
  rewrite: boolean | null
}

/** Draft with every field inherited. */
export function emptyVoiceNoteDraft(): VoiceNoteDraft {
  return { provider: '', providerId: '', model: '', voice: '', style: null, maxChars: '', rewrite: null }
}

/**
 * Rebuild the draft from the catalog view: `inherited` lists exactly the
 * fields the saved block does NOT set, so everything else is an override and
 * its effective value is the saved one.
 */
export function voiceNoteDraftFromCatalog(view: VoiceNoteCatalogView | null | undefined): VoiceNoteDraft {
  const draft = emptyVoiceNoteDraft()
  if (!view) return draft
  const set = (field: VoiceNoteDraftField) => !view.inherited.includes(field)
  if (set('provider')) draft.provider = view.provider
  if (set('providerId')) draft.providerId = view.providerId
  if (set('model')) draft.model = view.model
  if (set('voice')) draft.voice = view.voice
  if (set('style')) draft.style = view.style
  if (set('maxChars')) draft.maxChars = String(view.maxChars)
  if (set('rewrite')) draft.rewrite = view.rewrite
  return draft
}

/** Whether the field is currently inherited (no key in the saved block). */
export function voiceNoteInheritsField(draft: VoiceNoteDraft, field: VoiceNoteDraftField): boolean {
  switch (field) {
    case 'style': return draft.style === null
    case 'rewrite': return draft.rewrite === null
    case 'maxChars': return draft.maxChars.trim() === ''
    default: return draft[field].trim() === ''
  }
}

/** A copy of the draft with this one field back to "inherit". */
export function resetVoiceNoteField(draft: VoiceNoteDraft, field: VoiceNoteDraftField): VoiceNoteDraft {
  const next: VoiceNoteDraft = { ...draft }
  if (field === 'style') next.style = null
  else if (field === 'rewrite') next.rewrite = null
  else if (field === 'maxChars') next.maxChars = ''
  else next[field] = ''
  return next
}

/** `'range'` when the typed cap is not an integer inside the contract range. */
export function voiceNoteMaxCharsError(draft: VoiceNoteDraft): 'range' | null {
  const raw = draft.maxChars.trim()
  if (raw === '') return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) return 'range'
  if (parsed < VOICE_NOTE_MAX_CHARS_RANGE.min || parsed > VOICE_NOTE_MAX_CHARS_RANGE.max) return 'range'
  return null
}

/**
 * The block to send with `PUT /api/settings`, or `null` for "no block"
 * (= inherit everything). Only fields the user set appear; an out-of-range
 * `maxChars` is left out so the rest can still be saved while the form shows
 * the range error.
 */
export function buildVoiceNotePayload(
  draft: VoiceNoteDraft,
  accounts: readonly TtsCatalogAccount[] = [],
): VoiceNoteSettingsContract | null {
  const payload: VoiceNoteSettingsContract = {}
  const provider = draft.provider.trim()
  if (provider) payload.provider = provider as TtsProvider
  const providerId = draft.providerId.trim()
  if (providerId) {
    // Never send an account that cannot serve the chosen provider: the
    // backend rejects the pair, and inheriting is the honest fallback.
    const account = accounts.find(entry => entry.id === providerId)
    const mismatch = provider && account && account.ttsProvider !== provider
    if (!mismatch) payload.providerId = providerId
  }
  const model = draft.model.trim()
  if (model) payload.model = model
  const voice = draft.voice.trim()
  if (voice) payload.voice = voice
  if (draft.style !== null) payload.style = draft.style
  if (voiceNoteMaxCharsError(draft) === null && draft.maxChars.trim() !== '') {
    payload.maxChars = Number(draft.maxChars.trim())
  }
  if (draft.rewrite !== null) payload.rewrite = draft.rewrite

  return Object.keys(payload).length === 0 ? null : payload
}
