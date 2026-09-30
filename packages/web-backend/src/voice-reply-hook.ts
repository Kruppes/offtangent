/**
 * voice-reply-hook.ts: the automatic voice note after a finished answer.
 *
 * When a user switched `voiceReplies` on, every answer this user gets is also
 * spoken. The work happens AFTER the answer was persisted and always detached:
 * a turn is never delayed by the voice, and a voice that fails never turns a
 * good answer into an error. Failures are logged with the real message — a
 * silent voice with no trace in the log is worse than no voice.
 *
 * The hook is deliberately thin. It decides "does this answer get a voice",
 * and hands the actual work to the same runner the explicit endpoint uses, so
 * both paths share one in-flight guard and one persistence path.
 */
import {
  getVoiceRepliesEnabled,
  type Database,
  type PersistedAssistantMessage,
} from '@axiom/core'
import {
  ensureVoiceNote,
  type VoiceNoteFrame,
  type VoiceNoteGenerator,
} from './api/modules/speech/voice-note-runner.js'
import type { ChatEventBus } from './chat-event-bus.js'

export interface VoiceReplyHookOptions {
  db: Database
  /** Broadcasts the `voice_note` frame to every socket of the user. */
  chatEventBus?: ChatEventBus | null
  /** Test seam: the whole pipeline (rewrite + Gemini + upload). */
  generate?: VoiceNoteGenerator
  /** Test seam: whether the user wants automatic voice notes. */
  isEnabled?: (userId: number) => boolean
  logger?: { warn: (msg: string) => void; error: (msg: string) => void }
}

export interface VoiceReplyHook {
  /** Fire and forget. Returns the detached promise for tests. */
  handle: (message: PersistedAssistantMessage) => Promise<void>
}

export function createVoiceReplyHook(options: VoiceReplyHookOptions): VoiceReplyHook {
  const { db } = options
  const isEnabled = options.isEnabled ?? ((userId: number) => getVoiceRepliesEnabled(db, userId))
  const logger = options.logger ?? {
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  }

  async function run(message: PersistedAssistantMessage): Promise<void> {
    // The turn already spoke: `send_voice_message` produced the note and the
    // transcript wrote it onto the row. Announce it (the tool cannot, it has
    // no message id yet) and stop — one answer, one voice.
    if (message.voiceNote) {
      options.chatEventBus?.broadcast({
        type: 'voice_note',
        userId: message.userId,
        source: 'web',
        sessionId: message.sessionId,
        agentId: message.agentId,
        messageId: message.messageId,
        voiceNote: message.voiceNote,
      })
      return
    }
    // Nothing to speak: a turn that only produced a file still writes a row.
    if (!message.content.trim()) return
    if (!isEnabled(message.userId)) return

    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?')
      .get(message.messageId) as { metadata: string | null } | undefined

    const generate = options.generate
      // Imported lazily so a test never drags the Gemini path (and the
      // provider config it reads) into the module graph.
      ?? (await import('@axiom/core')).createVoiceNote

    await ensureVoiceNote(
      db,
      {
        messageId: message.messageId,
        userId: message.userId,
        sessionId: message.sessionId,
        content: message.content,
        metadata: row?.metadata ?? null,
      },
      generate,
      (frame: VoiceNoteFrame) => {
        options.chatEventBus?.broadcast({
          type: 'voice_note',
          userId: frame.userId,
          source: 'web',
          sessionId: frame.sessionId,
          agentId: message.agentId,
          messageId: frame.messageId,
          voiceNote: frame.voiceNote,
        })
      },
    )
  }

  return {
    handle(message) {
      const promise = run(message).catch((err: unknown) => {
        logger.error(
          `[voice-reply] Voice note for message ${message.messageId} failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        )
      })
      return promise
    },
  }
}
