/**
 * useMessageSpeech — read-aloud, audio summary and voice notes of one answer
 * (W4b, parity with the companion app's StrandSpeech / VoiceNotes).
 *
 *  - Read aloud:     POST /api/speech/audio { messageId } → clip in the shared player
 *  - Audio summary:  POST /api/speech/summary { messageId } → text, then
 *                    POST /api/speech/audio { text } → that text spoken by the
 *                    server's configured voice (the web has no device engine,
 *                    and the voice stays a server setting)
 *  - Voice note:     POST /api/speech/voice-note { messageId } → stored on the
 *                    message (`metadata.voiceNote`). A note that already exists
 *                    — also one the app created — is shown, never re-created.
 *
 * Generated clips are kept as blob URLs per message for the session, so a
 * second tap plays again without paying for the synthesis twice.
 */
import { shallowRef } from 'vue'
import {
  SPEECH_AUDIO_PATH, SPEECH_SUMMARY_PATH, SPEECH_VOICE_NOTE_PATH,
  readVoiceNote, speechErrorKind, speechRequestBody,
  type SpeechErrorKind, type SpeechSummaryResponse, type VoiceNoteRef,
} from '~/api/speech'
import { useAudioPlayer } from '~/composables/useAudioPlayer'

export type SpeechMode = 'read' | 'summary'

export interface SpeechEntry {
  mode: SpeechMode
  status: 'loading' | 'ready' | 'error'
  src?: string
  summary?: string
  error?: SpeechErrorKind
}

export interface VoiceNoteJob {
  status: 'creating' | 'error'
  error?: SpeechErrorKind
}

/** Per message: the last read/summary entry. Keyed by `messageKey`. */
const entries = shallowRef(new Map<string, SpeechEntry>())
/** Voice notes created in this tab before the history row reflects them. */
const createdNotes = shallowRef(new Map<number, VoiceNoteRef>())
const noteJobs = shallowRef(new Map<number, VoiceNoteJob>())

function setEntry(key: string, entry: SpeechEntry | null) {
  const next = new Map(entries.value)
  if (entry) next.set(key, entry)
  else next.delete(key)
  entries.value = next
}

function setJob(id: number, job: VoiceNoteJob | null) {
  const next = new Map(noteJobs.value)
  if (job) next.set(id, job)
  else next.delete(id)
  noteJobs.value = next
}

/** Stable key of a message: its id, or the text for a bubble never stored. */
export function messageKey(messageId: number | undefined, text: string): string {
  if (typeof messageId === 'number') return `m:${messageId}`
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return `t:${text.length}:${hash}`
}

export function speechClipId(key: string, mode: SpeechMode): string {
  return `${mode}:${key}`
}

class SpeechRequestError extends Error {
  constructor(readonly kind: SpeechErrorKind) { super(kind) }
}

export function useMessageSpeech() {
  const config = useRuntimeConfig()
  const { getAccessToken, refreshAccessToken } = useAuth()
  const player = useAudioPlayer()

  async function post(path: string, body: unknown): Promise<Response> {
    const send = (token: string | null) => fetch(`${config.public.apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    let res: Response
    try {
      res = await send(getAccessToken())
      if (res.status === 401 && await refreshAccessToken()) res = await send(getAccessToken())
    } catch {
      throw new SpeechRequestError('network')
    }
    if (!res.ok) {
      const payload = await res.json().catch(() => ({})) as { error?: unknown }
      throw new SpeechRequestError(speechErrorKind(res.status, payload.error))
    }
    return res
  }

  async function fetchClip(body: { messageId: number } | { text: string }): Promise<string> {
    const res = await post(SPEECH_AUDIO_PATH, body)
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  }

  /**
   * Read aloud / audio summary. A ready clip toggles play/pause; otherwise the
   * clip is generated and then played (the tap is the user action).
   */
  async function speak(mode: SpeechMode, messageId: number | undefined, text: string): Promise<void> {
    const key = messageKey(messageId, text)
    const clipId = speechClipId(key, mode)
    const existing = entries.value.get(key)
    if (existing?.mode === mode && existing.status === 'ready' && existing.src) {
      const src = existing.src
      await player.toggle(clipId, () => src)
      return
    }
    if (existing?.mode === mode && existing.status === 'loading') return
    if (existing?.src && existing.mode !== mode) player.stop(speechClipId(key, existing.mode))
    setEntry(key, { mode, status: 'loading' })
    try {
      let summary: string | undefined
      let src: string
      if (mode === 'summary') {
        const res = await post(SPEECH_SUMMARY_PATH, speechRequestBody(messageId, text))
        const data = await res.json() as SpeechSummaryResponse
        summary = typeof data.text === 'string' ? data.text : ''
        if (!summary.trim()) throw new SpeechRequestError('empty')
        src = await fetchClip({ text: summary })
      } else {
        src = await fetchClip(speechRequestBody(messageId, text))
      }
      if (entries.value.get(key)?.mode !== mode) { URL.revokeObjectURL(src); return }
      if (existing?.src) URL.revokeObjectURL(existing.src)
      setEntry(key, { mode, status: 'ready', src, summary })
      await player.toggle(clipId, () => src)
    } catch (error) {
      if (entries.value.get(key)?.mode !== mode) return
      setEntry(key, { mode, status: 'error', error: error instanceof SpeechRequestError ? error.kind : 'generic' })
    }
  }

  function dismiss(messageId: number | undefined, text: string) {
    const key = messageKey(messageId, text)
    const entry = entries.value.get(key)
    if (!entry) return
    player.stop(speechClipId(key, entry.mode))
    if (entry.src) URL.revokeObjectURL(entry.src)
    setEntry(key, null)
  }

  /** Ask the server for the voice note; an existing one comes back unchanged. */
  async function createVoiceNote(messageId: number): Promise<void> {
    if (noteJobs.value.get(messageId)?.status === 'creating') return
    setJob(messageId, { status: 'creating' })
    try {
      const res = await post(SPEECH_VOICE_NOTE_PATH, { messageId })
      const data = await res.json() as { voiceNote?: unknown }
      const note = readVoiceNote(data.voiceNote)
      if (!note) throw new SpeechRequestError('generic')
      rememberVoiceNote(messageId, note)
      setJob(messageId, null)
    } catch (error) {
      setJob(messageId, { status: 'error', error: error instanceof SpeechRequestError ? error.kind : 'generic' })
    }
  }

  return {
    entries,
    noteJobs,
    speak,
    dismiss,
    createVoiceNote,
    entryFor: (messageId: number | undefined, text: string) => entries.value.get(messageKey(messageId, text)) ?? null,
    voiceNoteFor: (messageId: number | undefined): VoiceNoteRef | null => (typeof messageId === 'number' ? createdNotes.value.get(messageId) ?? null : null),
    jobFor: (messageId: number | undefined): VoiceNoteJob | null => (typeof messageId === 'number' ? noteJobs.value.get(messageId) ?? null : null),
  }
}

/** Also fed by the `voice_note` socket frame. */
export function rememberVoiceNote(messageId: number, note: VoiceNoteRef) {
  const next = new Map(createdNotes.value)
  next.set(messageId, note)
  createdNotes.value = next
}

/** Test seam: preset entries / voice-note jobs (render specs). */
export function setSpeechStateForTest(next: { entries?: Array<[string, SpeechEntry]>; jobs?: Array<[number, VoiceNoteJob]> }): void {
  entries.value = new Map(next.entries ?? [])
  noteJobs.value = new Map(next.jobs ?? [])
  createdNotes.value = new Map()
}
