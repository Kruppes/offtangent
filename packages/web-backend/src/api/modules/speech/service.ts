/**
 * The "summarize aloud" service.
 *
 *   POST /api/speech/summary { messageId } | { text }
 *     -> 200 { text, language, sourceChars, summaryChars }
 *        400 { error: 'empty' }      nothing speakable left after cleaning
 *        404 { error: 'not_found' }  no such message, or not this user's
 *        502 { error: 'upstream' }   the summary model failed or timed out
 *
 *   POST /api/speech/audio   { messageId } | { text } (+ optional `format`)
 *     -> 200 audio bytes of exactly that summary. Spoken by the configured
 *        cloud TTS when `settings.tts.enabled` (Content-Type as the provider
 *        produces it, Ogg/Opus for Gemini), otherwise by the LOCAL TTS
 *        service (settings.json `voiceTelegram.ttsUrl`, always `audio/ogg`,
 *        `format` ignored)
 *        400/404 as above, plus 400 { error: 'unsupported_format' } when the
 *        cloud provider cannot deliver the requested container
 *        502 { error: 'upstream' }          summary model OR TTS failed
 *        503 { error: 'tts_unconfigured' }  neither cloud nor local TTS configured
 *
 * Ownership follows the same rule the chat history uses: a message belongs to
 * the caller when its `user_id` is the caller, or when the strand it lives in
 * is the caller's (assistant rows written by the agent path carry no
 * `user_id`). A foreign message answers exactly like a missing one, so the
 * endpoint is no existence oracle.
 */
import type { Readable } from 'node:stream'
import {
  createVoiceNote as createVoiceNoteFile,
  formatFromAccept,
  getVoiceRepliesEnabled,
  setVoiceRepliesEnabled,
  SpeechSummaryEmptyError,
  SpeechSummaryUpstreamError,
  summarizeForSpeech,
  TtsFormatError,
  TTS_STREAMABLE_FORMATS,
  VoiceNoteUnconfiguredError,
  VoiceNoteUpstreamError,
  type Database,
  type SpeechSummaryResult,
  type SummarizeForSpeechOptions,
  type VoiceNote,
} from '@axiom/core'
import type { TtsResponseFormat } from '@axiom/core/contracts'
import type { SpeechSummaryBody } from './schema.js'
import {
  ensureVoiceNote,
  type VoiceNoteFrame,
  type VoiceNoteGenerator,
} from './voice-note-runner.js'
import {
  LocalTtsError,
  loadCloudTtsConfig,
  loadLocalTtsConfig,
  synthesizeCloudSpeech,
  synthesizeCloudSpeechStream,
  synthesizeSpeech,
  type CloudSpeechResult,
  type CloudSpeechStreamResult,
  type CloudTtsConfig,
  type LocalTtsConfig,
  type SynthesizeSpeechInput,
} from './tts.js'

/**
 * Container the app path uses when the caller names none.
 *
 * Deliberately NOT `settings.tts.responseFormat`: this endpoint is the
 * companion app's read-aloud contract, which is Ogg Opus, and the global
 * format setting exists for the other clients (a puck asking for WAV, a
 * browser preview asking for mp3). A client that wants something else says so
 * with `format` or `Accept`.
 */
export const SPEECH_DEFAULT_FORMAT: TtsResponseFormat = 'opus'

export class SpeechServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'SpeechServiceError'
  }
}

export interface SpeechServiceOptions {
  db: Database
  /** Test seam: the summarizer, so no test ever needs a provider. */
  summarize?: (raw: string, options?: SummarizeForSpeechOptions) => Promise<SpeechSummaryResult>
  /** Test seam: the local TTS call, so no test ever hits the network. */
  synthesize?: (input: SynthesizeSpeechInput) => Promise<Buffer>
  /** Test seam: where the local TTS URL and timeout come from. */
  loadTtsConfig?: () => LocalTtsConfig
  /** Test seam: the cloud TTS call, so no test ever hits a provider. */
  synthesizeCloud?: (text: string, format: TtsResponseFormat | null) => Promise<CloudSpeechResult>
  /** Test seam: the streamed cloud TTS call. */
  synthesizeCloudStream?: (
    text: string,
    format: TtsResponseFormat | null,
  ) => Promise<CloudSpeechStreamResult | null>
  /** Test seam: whether the cloud voice is switched on. */
  loadCloudTtsConfig?: () => CloudTtsConfig
  /** Test seam: the whole voice-note pipeline (rewrite + Gemini + upload). */
  createVoiceNote?: VoiceNoteGenerator
  /** Announce a freshly created voice note (WS frame). Optional. */
  onVoiceNote?: (frame: VoiceNoteFrame) => void
}

export interface SpeechSummaryResponse {
  text: string
  language: 'de' | 'en'
  sourceChars: number
  summaryChars: number
}

export interface SpeechAudioResponse {
  /** Set on the buffered path; exactly one of `audio`/`stream` is present. */
  audio?: Buffer
  /** Set when the voice streams: the controller pipes it into the response. */
  stream?: Readable
  /** MIME type of the audio. */
  contentType: string
  language: 'de' | 'en'
  summaryChars: number
  /** Which endpoint spoke, for the response header and the log. */
  source?: 'primary' | 'fallback'
}

/** Per-request wishes that do not travel in the JSON body. */
export interface SpeechAudioOptions {
  /** Raw `Accept` header; decides the container when the body names none. */
  accept?: string | null
}

export interface SpeechService {
  summary: (userId: number, body: SpeechSummaryBody) => Promise<SpeechSummaryResponse>
  /** The spoken version of one finished answer, stored on the message. */
  voiceNote: (userId: number, messageId: number) => Promise<{ voiceNote: VoiceNote }>
  /** Per-user switch: speak every finished answer automatically. */
  getVoiceReplies: (userId: number) => { enabled: boolean }
  setVoiceReplies: (userId: number, enabled: boolean) => { enabled: boolean }
  audio: (
    userId: number,
    body: SpeechSummaryBody,
    options?: SpeechAudioOptions,
  ) => Promise<SpeechAudioResponse>
}

interface MessageRow {
  id: number
  content: string
  role: string
  session_id: string
  metadata: string | null
  user_id: number | null
  session_user_id: number | null
  session_user: string | null
}

/**
 * Small result cache. Not required by the contract, but the app re-reads the
 * same message whenever the user taps play twice, and a summary of a stored
 * message never changes. Keyed by the exact source text, so the `text` form
 * profits too. FIFO, bounded — this is a convenience, not a store.
 */
const CACHE_LIMIT = 50
const cache = new Map<string, SpeechSummaryResponse>()

function cacheKey(raw: string): string {
  // The content itself is the key; length prefix keeps collisions of the
  // first/last window impossible for different lengths.
  return `${raw.length}:${raw.slice(0, 200)}:${raw.slice(-200)}`
}

/** Test hook: forget every cached summary. */
export function clearSpeechSummaryCache(): void {
  cache.clear()
}

/**
 * Map the pipeline's failures onto the endpoint contract. Never masked: a
 * missing voice (503) has to be distinguishable from a voice that failed
 * (502) and from an answer with nothing speakable in it (400).
 */
export function toVoiceNoteServiceError(err: unknown): unknown {
  if (err instanceof SpeechServiceError) return err
  if (err instanceof SpeechSummaryEmptyError) {
    return new SpeechServiceError(400, 'empty', 'Nothing to speak')
  }
  if (err instanceof VoiceNoteUnconfiguredError) {
    console.warn(`[voice-note] not configured: ${err.message}`)
    return new SpeechServiceError(503, 'tts_unconfigured', 'No Gemini voice configured')
  }
  if (err instanceof SpeechSummaryUpstreamError || err instanceof VoiceNoteUpstreamError) {
    console.warn(`[voice-note] upstream failure: ${err.message}`)
    return new SpeechServiceError(502, 'upstream', 'The voice is not available')
  }
  return err
}

export function createSpeechService(options: SpeechServiceOptions): SpeechService {
  const { db } = options
  const summarize = options.summarize ?? summarizeForSpeech
  const synthesize = options.synthesize ?? synthesizeSpeech
  const loadTtsConfig = options.loadTtsConfig ?? loadLocalTtsConfig
  const synthesizeCloud = options.synthesizeCloud ?? synthesizeCloudSpeech
  const synthesizeCloudStream = options.synthesizeCloudStream ?? synthesizeCloudSpeechStream
  const loadCloudConfig = options.loadCloudTtsConfig ?? loadCloudTtsConfig
  const createVoiceNote = options.createVoiceNote ?? createVoiceNoteFile

  /**
   * One ownership rule for every read here: a message belongs to the caller
   * when its `user_id` is the caller, or when the strand it lives in is the
   * caller's. A foreign row answers exactly like a missing one.
   */
  function loadMessageRow(userId: number, messageId: number): MessageRow {
    const row = db.prepare(
      `SELECT m.id, m.content, m.role, m.session_id, m.metadata, m.user_id,
              s.user_id AS session_user_id, s.session_user AS session_user
         FROM chat_messages m
         LEFT JOIN sessions s ON s.id = m.session_id
        WHERE m.id = ?`,
    ).get(messageId) as MessageRow | undefined

    const owned = !!row && (
      row.user_id === userId
      || (row.user_id == null && (
        row.session_user_id === userId || row.session_user === String(userId)
      ))
    )
    if (!owned) {
      throw new SpeechServiceError(404, 'not_found', 'No such message')
    }
    return row
  }

  function loadMessage(userId: number, messageId: number): string {
    return loadMessageRow(userId, messageId).content ?? ''
  }

  async function summary(userId: number, body: SpeechSummaryBody): Promise<SpeechSummaryResponse> {
    const raw = body.messageId !== null ? loadMessage(userId, body.messageId) : (body.text ?? '')

    const key = cacheKey(raw)
    const hit = cache.get(key)
    if (hit) return hit

    let result: SpeechSummaryResult
    try {
      result = await summarize(raw)
    } catch (err) {
      if (err instanceof SpeechSummaryEmptyError) {
        throw new SpeechServiceError(400, 'empty', 'Nothing to speak')
      }
      if (err instanceof SpeechSummaryUpstreamError) {
        // Never masked as an empty summary: the app has to be able to tell
        // "nothing to say" from "the model did not answer".
        console.warn(`[speech-summary] upstream failure: ${err.message}`)
        throw new SpeechServiceError(502, 'upstream', 'The summary model is not available')
      }
      throw err
    }

    console.log(
      `[speech-summary] ${result.passthrough ? 'passthrough' : result.model} `
      + `${result.sourceChars} -> ${result.summaryChars} chars, ${result.language}`,
    )

    const response: SpeechSummaryResponse = {
      text: result.text,
      language: result.language,
      sourceChars: result.sourceChars,
      summaryChars: result.summaryChars,
    }
    cache.set(key, response)
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    return response
  }

  return {
    summary,

    /**
     * Idempotent: an answer that already carries a note returns it without
     * asking the voice again, and concurrent callers share one generation
     * (see `voice-note-runner.ts`).
     *
     * Only assistant rows qualify. A user row is refused with the same 404 a
     * foreign row gets — the endpoint stays free of any "this id exists"
     * signal.
     */
    async voiceNote(userId, messageId) {
      const row = loadMessageRow(userId, messageId)
      if (row.role !== 'assistant') {
        throw new SpeechServiceError(404, 'not_found', 'No such message')
      }
      try {
        const result = await ensureVoiceNote(
          db,
          {
            messageId: row.id,
            userId,
            sessionId: row.session_id,
            content: row.content ?? '',
            metadata: row.metadata,
          },
          createVoiceNote,
          options.onVoiceNote,
        )
        return { voiceNote: result.voiceNote }
      } catch (err) {
        throw toVoiceNoteServiceError(err)
      }
    },

    getVoiceReplies(userId) {
      return { enabled: getVoiceRepliesEnabled(db, userId) }
    },

    setVoiceReplies(userId, enabled) {
      setVoiceRepliesEnabled(db, userId, enabled)
      return { enabled }
    },

    async audio(userId, body, audioOptions = {}) {
      // Exactly the same summary pipeline — ownership, cleaning, passthrough,
      // cache and the 400/404/502 codes come from one place, not from a copy.
      const spoken = await summary(userId, body)

      const startedAt = Date.now()
      let audio: Buffer
      let contentType: string
      let engine: 'cloud' | 'local'

      if (loadCloudConfig().enabled) {
        // The cloud voice is an explicit choice, so it wins over a configured
        // local box; no silent fallback to the other engine on failure.
        engine = 'cloud'
        const format = body.format
          ?? formatFromAccept(audioOptions.accept)
          ?? SPEECH_DEFAULT_FORMAT
        try {
          if (TTS_STREAMABLE_FORMATS.has(format)) {
            const streamed = await synthesizeCloudStream(spoken.text, format)
            if (streamed) {
              console.log(
                `[speech-audio] cloud stream ${spoken.summaryChars} chars, ${spoken.language} -> `
                + `${streamed.contentType} (${streamed.source}), headers in ${Date.now() - startedAt}ms`,
              )
              return {
                stream: streamed.stream,
                contentType: streamed.contentType,
                language: spoken.language,
                summaryChars: spoken.summaryChars,
                source: streamed.source,
              }
            }
          }
          const result = await synthesizeCloud(spoken.text, format)
          audio = result.audio
          contentType = result.contentType
        } catch (err) {
          if (err instanceof TtsFormatError) {
            // The caller asked for a container this provider cannot build.
            // That is a bad request, not an upstream outage, and never a
            // silent fallback to a format the caller may not be able to play.
            throw new SpeechServiceError(400, 'unsupported_format', err.message)
          }
          console.warn(`[speech-audio] cloud TTS failure: ${err instanceof Error ? err.message : String(err)}`)
          throw new SpeechServiceError(502, 'upstream', 'The speech service is not available')
        }
      } else {
        const config = loadTtsConfig()
        if (!config.baseUrl) {
          // Not an error of this request: the instance has no TTS at all. The
          // app falls back to on-device speech on exactly this code.
          throw new SpeechServiceError(503, 'tts_unconfigured', 'No TTS service configured')
        }
        engine = 'local'
        contentType = 'audio/ogg'
        try {
          audio = await synthesize({
            text: spoken.text,
            language: spoken.language,
            baseUrl: config.baseUrl,
            timeoutMs: config.timeoutMs,
          })
        } catch (err) {
          const detail = err instanceof LocalTtsError || err instanceof Error ? err.message : String(err)
          console.warn(`[speech-audio] TTS failure: ${detail}`)
          throw new SpeechServiceError(502, 'upstream', 'The speech service is not available')
        }
      }

      console.log(
        `[speech-audio] ${engine} ${spoken.summaryChars} chars, ${spoken.language} -> `
        + `${audio.length} bytes ${contentType} in ${Date.now() - startedAt}ms`,
      )
      return { audio, contentType, language: spoken.language, summaryChars: spoken.summaryChars }
    },
  }
}
