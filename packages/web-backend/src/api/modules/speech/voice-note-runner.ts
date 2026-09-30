/**
 * One generation per message, no matter how many callers ask.
 *
 * Both entry points end up here: the explicit `POST /api/speech/voice-note`
 * of the app, and the automatic voice reply after a finished turn. The app
 * typically does both at once (the switch is on AND the user taps play before
 * the automatic note has landed), so without a shared in-flight map the same
 * answer would be spoken — and paid for — twice.
 *
 * The map is module state on purpose: it is keyed by `chat_messages.id`, which
 * is unique per process and per database, and both callers must see the same
 * entry. It never grows: an entry is removed when its generation settles.
 */
import {
  estimateVoiceNoteUsage,
  voiceNoteCostUsd,
  logTokenUsage,
  readVoiceNoteMetadata,
  storeVoiceNote,
  voiceNoteScriptRecord,
  type CreatedVoiceNote,
  type CreateVoiceNoteOptions,
  type Database,
  type VoiceNote,
} from '@axiom/core'

/** What a finished voice note is announced with (WS frame payload). */
export interface VoiceNoteFrame {
  userId: number
  sessionId: string
  messageId: number
  voiceNote: VoiceNote
}

/** The message a voice note is made for. */
export interface VoiceNoteTarget {
  messageId: number
  userId: number
  sessionId: string
  /** Written answer text. */
  content: string
  /** Current metadata document of the row, so an existing note is found. */
  metadata: string | null
}

export type VoiceNoteGenerator = (
  raw: string,
  options?: CreateVoiceNoteOptions,
) => Promise<CreatedVoiceNote>

export interface EnsureVoiceNoteResult {
  voiceNote: VoiceNote
  /** False when the note already existed or another caller made it. */
  created: boolean
}

const inFlight = new Map<number, Promise<VoiceNote>>()

/** Test hook: forget every running generation. */
export function clearVoiceNoteInFlight(): void {
  inFlight.clear()
}

/**
 * Return the message's voice note, generating it once if needed.
 *
 * `onCreated` runs exactly once per actually generated note, inside the
 * generation, so concurrent callers produce one broadcast and not three.
 * Errors are NOT cached: a failed generation leaves the map empty and the
 * next call tries again.
 */
export async function ensureVoiceNote(
  db: Database,
  target: VoiceNoteTarget,
  generate: VoiceNoteGenerator,
  onCreated?: (frame: VoiceNoteFrame) => void,
): Promise<EnsureVoiceNoteResult> {
  const existing = readVoiceNoteMetadata(target.metadata)
  if (existing) return { voiceNote: existing, created: false }

  const running = inFlight.get(target.messageId)
  if (running) return { voiceNote: await running, created: false }

  const promise = (async (): Promise<VoiceNote> => {
    const started = Date.now()
    const created = await generate(target.content, {
      userId: target.userId,
      sessionId: target.sessionId,
      fileNameHint: String(target.messageId),
    })
    storeVoiceNote(db, target.messageId, created.voiceNote, voiceNoteScriptRecord(created.script))
    // Same accounting every other model call gets: the provider's own token
    // counts when the reply carried them, otherwise an estimate from the
    // spoken characters and the measured duration.
    try {
      const reported = created.usage
      const usage = reported
        ? {
          promptTokens: reported.promptTokens,
          completionTokens: reported.completionTokens,
          estimatedCost: voiceNoteCostUsd(reported.promptTokens, reported.completionTokens),
        }
        : estimateVoiceNoteUsage({
          spokenChars: created.voiceNote.spokenChars,
          seconds: created.voiceNote.seconds,
        })
      logTokenUsage(db, {
        provider: 'gemini',
        model: created.voiceNote.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cacheRead: 0,
        cacheWrite: 0,
        estimatedCost: usage.estimatedCost,
        sessionId: target.sessionId,
        // Not a conversation request: the strand context report must never
        // mistake this estimate for the last model request of the strand.
        kind: 'voice_note',
      })
    } catch (err) {
      console.warn('[voice-note] Failed to record the usage row:', err)
    }
    console.log(
      `[voice-note] message ${target.messageId}: ${created.voiceNote.sourceChars} -> `
      + `${created.voiceNote.spokenChars} chars, ${created.voiceNote.seconds}s audio, `
      + `${created.chunks} chunk(s), script ${created.script.model} `
      + `(${created.script.rounds ?? (created.script.passthrough ? 0 : 1)} round(s)`
      + `${created.script.trimmed ? ', CUT' : ''}), ${Date.now() - started}ms`,
    )
    try {
      onCreated?.({
        userId: target.userId,
        sessionId: target.sessionId,
        messageId: target.messageId,
        voiceNote: created.voiceNote,
      })
    } catch (err) {
      // A broken broadcast must not lose the note that is already stored.
      console.error('[voice-note] Failed to announce the voice note:', err)
    }
    return created.voiceNote
  })()

  inFlight.set(target.messageId, promise)
  try {
    return { voiceNote: await promise, created: true }
  } finally {
    inFlight.delete(target.messageId)
  }
}
