/**
 * voice-note-tool.ts: the `send_voice_message` agent tool.
 *
 * The deterministic counterpart to the automatic voice reply. The model writes
 * the spoken text itself and hands it over; the tool speaks EXACTLY that text.
 * No rewrite, no summary, no second model call — whatever
 * `tts.voiceNote.rewrite` says, that setting governs the automatic mode and
 * the long-press endpoint, never this tool.
 *
 * Delivery follows `send_file_to_user`: the tool stays passive and puts the
 * finished note into `details.voiceNote`, the running turn's transcript picks
 * it up from the `tool_call_end` chunk and writes it onto the assistant row
 * (`metadata.voiceNote`), and the voice-reply hook broadcasts the `voice_note`
 * frame once that row has an id. A context where no turn persists the answer
 * gets a clear error instead of a note nobody will ever see.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import {
  VoiceNoteTooLongError,
  loadVoiceNoteConfig,
  speakVoiceNote,
  type CreateVoiceNoteOptions,
  type CreatedVoiceNote,
  type VoiceNote,
} from './voice-note.js'
import {
  VOICE_NOTE_PROVIDER_ROUTES,
  type EffectiveVoiceNoteConfig,
} from './voice-note-config.js'

/** The one name the skill, the registry and the hint text agree on. */
export const VOICE_MESSAGE_TOOL_NAME = 'send_voice_message'

/** What a channel or transcript finds on a `send_voice_message` result. */
export interface VoiceNoteToolDetails {
  voiceNote?: VoiceNote
  error?: boolean
}

export interface VoiceMessageToolOptions {
  /** Resolve the current user id (matches `users.id`). */
  getCurrentToolUserId: () => number | undefined
  /** Resolve the active interactive strand, if any. */
  getCurrentInteractiveSessionId?: () => string | null
  /**
   * True when a live turn persists this strand and will therefore write the
   * note onto its assistant row. False means nobody picks the note up — the
   * tool refuses rather than producing audio that is never delivered.
   */
  isCarriedByCurrentTurn?: () => boolean
  /** Test seam / policy override: the effective voice-note route. */
  loadConfig?: () => EffectiveVoiceNoteConfig
  /** Test seam: the deterministic pipeline. */
  speak?: (text: string, options: CreateVoiceNoteOptions) => Promise<CreatedVoiceNote>
  /** Log sink, defaults to `console.log`. */
  logger?: { log: (message: string) => void }
}

function fail(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: { error: true } satisfies VoiceNoteToolDetails,
  }
}

/**
 * Build the tool. Registered for the interactive agent; a background task gets
 * it too, where it reports the missing turn instead of guessing a strand
 * (see FOLLOWUPS).
 */
export function createVoiceMessageTool(options: VoiceMessageToolOptions): AgentTool {
  const speak = options.speak ?? speakVoiceNote
  const loadConfig = options.loadConfig ?? (() => loadVoiceNoteConfig())
  const log = options.logger?.log ?? ((message: string) => console.log(message))

  return {
    name: VOICE_MESSAGE_TOOL_NAME,
    label: 'Send Voice Message',
    description:
      'Speak a short text to the user as a voice message. The text is spoken exactly as given — '
      + 'no summary, no rewriting — so write it for the ear: short sentences, no markdown, no code, '
      + 'no tables, no urls or file paths, numbers written the way they are said. '
      + 'The voice message appears as an audio bubble on your answer; keep a short written line '
      + 'next to it. Use it when the user asks for audio or cannot read right now. Call it once per answer.',
    parameters: Type.Object({
      text: Type.String({
        description:
          'The exact text to speak. Plain prose, no markdown. Must fit the configured character '
          + 'limit of a voice message; a longer text is rejected, not cut.',
      }),
      voice: Type.Optional(Type.String({
        description:
          'Optional voice id, only if the user asked for a specific voice. Must be one of the '
          + 'voices the configured provider offers; otherwise the configured voice is used.',
      })),
    }),
    execute: async (_toolCallId, params) => {
      const { text, voice } = params as { text: string; voice?: string }

      const userId = options.getCurrentToolUserId()
      if (userId === undefined || userId === null) {
        return fail(`Error: ${VOICE_MESSAGE_TOOL_NAME} needs an active user; there is none in this context.`)
      }
      const sessionId = options.getCurrentInteractiveSessionId?.() ?? null
      if (options.isCarriedByCurrentTurn && !options.isCarriedByCurrentTurn()) {
        return fail(
          `Error: ${VOICE_MESSAGE_TOOL_NAME} can only be used in a live chat turn — no turn is currently `
          + 'writing an answer in this strand, so the voice message would never reach the user. '
          + 'Answer in text instead.',
        )
      }

      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (!trimmed) return fail('Error: text is empty; nothing to speak.')

      let config: EffectiveVoiceNoteConfig
      try {
        config = loadConfig()
      } catch (err) {
        return fail(`Error: the voice-message configuration could not be read: ${(err as Error).message}`)
      }

      if (trimmed.length > config.maxChars) {
        return fail(
          `Error: the text is ${trimmed.length} characters long, the limit for a voice message is `
          + `${config.maxChars}. Shorten it and call the tool again.`,
        )
      }

      if (voice !== undefined && voice !== null && String(voice).trim() !== '') {
        const wanted = String(voice).trim()
        const known = VOICE_NOTE_PROVIDER_ROUTES[config.provider]?.voices
        if (known && !known.includes(wanted)) {
          return fail(
            `Error: "${wanted}" is not a known voice for the configured provider. `
            + `Available voices: ${known.join(', ')}.`,
          )
        }
        config = { ...config, voice: wanted }
      }

      const started = Date.now()
      let created: CreatedVoiceNote
      try {
        created = await speak(trimmed, { config, userId, sessionId })
      } catch (err) {
        if (err instanceof VoiceNoteTooLongError) return fail(`Error: ${err.message}`)
        // The real upstream message, never a generic "empty response".
        const message = err instanceof Error && err.message ? err.message : String(err)
        return fail(`Error: the voice message could not be created: ${message}`)
      }

      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      // Route and size only — never the spoken text, never a key.
      log(`[voice-message] provider=${config.provider} model=${config.model || '-'} voice=${config.voice} `
        + `chars=${trimmed.length} chunks=${created.chunks} audio=${created.voiceNote.seconds}s took=${seconds}s`)

      return {
        content: [{
          type: 'text' as const,
          text: `Voice message sent (${created.voiceNote.seconds}s, ${trimmed.length} characters). `
            + 'It is attached to your answer — do not repeat the full text, one short written line is enough.',
        }],
        details: { voiceNote: created.voiceNote } satisfies VoiceNoteToolDetails,
      }
    },
  }
}

/**
 * Pull a voice note off a tool result, whatever tool produced it. Mirrors
 * `extractUploadsFromToolResult`: the transcript does not sniff for tool
 * names, it looks for the payload.
 */
export function extractVoiceNoteFromToolResult(toolResult: unknown): VoiceNote | null {
  if (!toolResult || typeof toolResult !== 'object') return null
  const details = (toolResult as { details?: unknown }).details
  if (!details || typeof details !== 'object') return null
  const note = (details as { voiceNote?: unknown }).voiceNote
  if (!note || typeof note !== 'object') return null
  const candidate = note as Partial<VoiceNote>
  if (typeof candidate.url !== 'string' || typeof candidate.mimeType !== 'string') return null
  return candidate as VoiceNote
}
