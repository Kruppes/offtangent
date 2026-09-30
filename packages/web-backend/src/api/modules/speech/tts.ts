/**
 * The two ways a spoken summary gets its voice.
 *
 * 1. The configured cloud TTS (`settings.tts`, core `synthesizeTts`) when it
 *    is enabled. That is the same voice the Telegram voice replies use, so
 *    one setting decides how the instance sounds everywhere.
 * 2. Otherwise the LOCAL TTS service (`voiceTelegram.ttsUrl`), a LAN box that
 *    speaks the small protocol below. Kept as the fallback for setups without
 *    a cloud voice.
 *
 * The local protocol is the one `packages/telegram/src/tts-client.ts` speaks:
 *
 *   POST <baseUrl>/tts  { text, voice, lang }  ->  OGG Opus bytes
 *   error case          ->  non-2xx with { detail }
 *
 * The Telegram client is NOT imported here on purpose — web-backend must not
 * depend on the telegram package. This file is the small piece of that
 * protocol the speech module needs (synthesize only, no health probe).
 */
import type { Readable } from 'node:stream'
import {
  loadConfig,
  loadTtsSettings,
  loadVoiceTelegramSettings,
  synthesizeTts,
  synthesizeTtsStream,
} from '@axiom/core'
import type { TtsResponseFormat } from '@axiom/core/contracts'

/** Same default voice the Telegram voice notes use. */
export const DEFAULT_TTS_VOICE = 'Ethan'

/** Language names the TTS service expects, keyed by the summary language. */
const TTS_LANG: Record<'de' | 'en', string> = {
  de: 'German',
  en: 'English',
}

export interface LocalTtsConfig {
  /** Base URL of the local TTS service, empty when it is not configured. */
  baseUrl: string
  /** Request timeout in ms. */
  timeoutMs: number
}

/**
 * Reads `voiceTelegram.ttsUrl` / `voiceTelegram.timeoutMs` from settings.json.
 * One setting for one service: the box that speaks for Telegram also speaks
 * for the app, so a second URL to keep in sync would only rot.
 */
export function loadLocalTtsConfig(): LocalTtsConfig {
  const settings = loadVoiceTelegramSettings(name => loadConfig<Record<string, unknown>>(name))
  return {
    baseUrl: (settings.ttsUrl ?? '').trim(),
    timeoutMs: settings.timeoutMs,
  }
}

export interface CloudTtsConfig {
  /** `settings.tts.enabled`: the cloud voice takes precedence when on. */
  enabled: boolean
}

/** Reads `tts.enabled` from settings.json. */
export function loadCloudTtsConfig(): CloudTtsConfig {
  return { enabled: loadTtsSettings().enabled }
}

export interface CloudSpeechResult {
  audio: Buffer
  /** As produced by the provider; Gemini → `audio/ogg`, others follow the format setting. */
  contentType: string
}

/**
 * Synthesize with the configured cloud provider. Errors propagate as-is —
 * the service maps a `TtsFormatError` to 400 and every other failure to 502.
 *
 * `format` is the caller's per-request container wish; `null` keeps the saved
 * setting.
 */
export async function synthesizeCloudSpeech(
  text: string,
  format: TtsResponseFormat | null = null,
): Promise<CloudSpeechResult> {
  const result = await synthesizeTts(text, format ? { format } : {})
  if (result.audio.length === 0) {
    throw new Error('Cloud TTS returned no audio')
  }
  return { audio: result.audio, contentType: result.contentType }
}

export interface CloudSpeechStreamResult {
  stream: Readable
  contentType: string
  /** `primary` = configured endpoint, `fallback` = hosted OpenAI. */
  source: 'primary' | 'fallback'
}

/**
 * Start a streamed synthesis, or return `null` when the configured provider
 * cannot stream this container. `null` is not an error: the caller then takes
 * the buffered path it always had.
 */
export async function synthesizeCloudSpeechStream(
  text: string,
  format: TtsResponseFormat | null = null,
): Promise<CloudSpeechStreamResult | null> {
  const result = await synthesizeTtsStream(text, format ? { format } : {})
  if (!result) return null
  return { stream: result.stream, contentType: result.contentType, source: result.source }
}

export interface SynthesizeSpeechInput {
  text: string
  language: 'de' | 'en'
  baseUrl: string
  timeoutMs: number
  voice?: string
}

/** The TTS service did not answer, timed out or answered with an error. */
export class LocalTtsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalTtsError'
  }
}

/**
 * Synthesize one spoken summary. Returns the raw OGG Opus bytes.
 *
 * @throws LocalTtsError on any transport, timeout or service level failure —
 *   the caller turns that into the 502 of the endpoint contract.
 */
export async function synthesizeSpeech(input: SynthesizeSpeechInput): Promise<Buffer> {
  const baseUrl = input.baseUrl.replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetch(`${baseUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: input.text,
        voice: input.voice ?? DEFAULT_TTS_VOICE,
        lang: TTS_LANG[input.language],
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    })
  } catch (err) {
    throw new LocalTtsError(`TTS service unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) {
    let detail: string
    try {
      const body = (await response.json()) as { detail?: string }
      detail = body.detail ?? `HTTP ${response.status}`
    } catch {
      detail = `HTTP ${response.status}`
    }
    throw new LocalTtsError(`TTS service error: ${detail}`)
  }

  let audio: Buffer
  try {
    audio = Buffer.from(await response.arrayBuffer())
  } catch (err) {
    throw new LocalTtsError(`TTS response unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (audio.length === 0) {
    throw new LocalTtsError('TTS service returned no audio')
  }
  return audio
}
