/**
 * Deepgram voice integration — Speech-to-Text (pre-recorded audio) and
 * Text-to-Speech.
 *
 * STT API:  POST https://api.deepgram.com/v1/listen
 *   - Auth: `Authorization: Token <key>`
 *   - Body: raw audio bytes
 *   - Query: `model`, `language`, `punctuate`, `smart_format`
 *
 * TTS API:  POST https://api.deepgram.com/v1/speak
 *   - Auth: `Authorization: Token <key>`
 *   - Content-Type: application/json
 *   - Query: `model`, `encoding`
 *   - Body: { "text": "..." }
 *   - Response: raw audio bytes
 */

import { encrypt, decrypt, isEncrypted } from './encryption.js'
import type { DeepgramModelContract, DeepgramModelsListContract } from './contracts/deepgram.js'

// ── Constants ─────────────────────────────────────────────────────────

export const DEEPGRAM_DEFAULT_BASE_URL = 'https://api.deepgram.com'

/** Default STT model. `nova-3` is Deepgram's current production transcription model. */
export const DEEPGRAM_DEFAULT_STT_MODEL = 'nova-3'

/** Default TTS model. `aura-2-thalia-en` is a clear English voice. */
export const DEEPGRAM_DEFAULT_TTS_MODEL = 'aura-2-thalia-en'

/** Curated list of common Deepgram TTS voices surfaced in the UI. */
export const DEEPGRAM_TTS_PRESET_MODELS = [
  'aura-2-thalia-en',
  'aura-2-andromeda-en',
  'aura-2-helena-en',
  'aura-asteria-en',
  'aura-luna-en',
  'aura-stella-en',
  'aura-zeus-en',
  'aura-2-ophelia-de',
] as const

export type DeepgramTtsPresetModel = (typeof DEEPGRAM_TTS_PRESET_MODELS)[number]

/** Audio container Deepgram should encode the synthesized speech in. */
export const DEEPGRAM_TTS_ENCODINGS = ['mp3', 'linear16', 'opus', 'flac'] as const
export type DeepgramTtsEncoding = (typeof DEEPGRAM_TTS_ENCODINGS)[number]

// ── Types ─────────────────────────────────────────────────────────────

export interface DeepgramTranscribeOptions {
  /** Override base URL (mainly for tests / proxies). */
  baseUrl?: string
  /** Model name, e.g. `nova-3`, `nova-2-general`, `enhanced`. */
  model?: string
  /** ISO-639-1 language code (`en`, `de`, ...) or `multi`. Omit for auto-detect. */
  language?: string
  /** Hint used to set Content-Type when the format is not auto-detected. */
  mimeType?: string
}

export interface DeepgramSynthesizeOptions {
  /** Override base URL (mainly for tests / proxies). */
  baseUrl?: string
  /** Voice / model name, e.g. `aura-2-thalia-en`. */
  model?: string
  /** Audio container Deepgram should produce. Defaults to `mp3`. */
  encoding?: DeepgramTtsEncoding
}

/**
 * Runtime alias for the wire-format `DeepgramModelContract`. Kept under the
 * shorter name in the runtime layer so call sites read naturally; the
 * contract type is the source of truth that the frontend can import.
 */
export type DeepgramModel = DeepgramModelContract

/** Response shape of `GET /v1/models`. */
export type DeepgramModelsList = DeepgramModelsListContract

export interface DeepgramListModelsOptions {
  /** Override base URL (mainly for tests / proxies). */
  baseUrl?: string
  /** When `true`, include outdated/deprecated models. Defaults to `false`. */
  includeOutdated?: boolean
}

// ── Encryption helpers ────────────────────────────────────────────────

/**
 * Encrypt a Deepgram API key for storage in `settings.json`.
 *
 * Idempotent: an already-encrypted ciphertext is returned unchanged so
 * accidental double-PATCHes do not corrupt the stored value.
 */
export function encryptDeepgramApiKey(apiKey: string): string {
  if (!apiKey) return ''
  return isEncrypted(apiKey) ? apiKey : encrypt(apiKey)
}

/**
 * Decrypt a Deepgram API key from `settings.json`.
 *
 * Plaintext keys (e.g. for a freshly-edited config file) pass through
 * unchanged so callers don't need to special-case them.
 *
 * Tolerant fallback: Deepgram's 40-char hex API keys coincidentally satisfy
 * the strict-base64 + length-divisible-by-4 + decodes-to-30-bytes shape
 * that `isEncrypted()` checks for, so a plaintext key sitting in storage
 * can be misclassified as ciphertext. When `decrypt()` then fails the
 * AES-GCM auth tag check ("Unsupported state or unable to authenticate
 * data"), we treat the value as plaintext rather than crashing the caller.
 * The next save through `mergeStt`/`mergeTts` re-encrypts properly, so the
 * config heals itself on first round-trip.
 */
export function decryptDeepgramApiKey(encryptedKey: string): string {
  if (!encryptedKey) return ''
  if (!isEncrypted(encryptedKey)) return encryptedKey
  try {
    return decrypt(encryptedKey)
  } catch (err) {
    console.warn(
      `[deepgram] decrypt failed (${(err as Error).message}); treating stored value as plaintext. `
      + 'Re-save the key in Settings to re-encrypt it.',
    )
    return encryptedKey
  }
}

// ── Error mapping ─────────────────────────────────────────────────────

/**
 * Map a Deepgram non-OK response to a human-readable error message that
 * makes the failure mode (auth / rate limit / server) easy to spot in
 * logs and Telegram error replies.
 */
async function describeDeepgramError(label: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => '')
  const trimmed = body.trim().slice(0, 500)
  if (response.status === 401 || response.status === 403) {
    return new Error(`${label} authentication failed (HTTP ${response.status}): invalid or missing Deepgram API key.`)
  }
  if (response.status === 429) {
    return new Error(`${label} rate-limited by Deepgram (HTTP 429). ${trimmed}`.trim())
  }
  if (response.status >= 500) {
    return new Error(`${label} upstream error (HTTP ${response.status}). ${trimmed}`.trim())
  }
  return new Error(`${label} returned HTTP ${response.status}. ${trimmed}`.trim())
}

// ── Models listing ─────────────────────────────────────────────────────

/**
 * Fetch the list of available Deepgram models via `GET /v1/models`.
 *
 * Returns a `{ stt, tts }` object that mirrors Deepgram's response shape.
 * Empty arrays (rather than `null`) are returned when one of the categories
 * is missing in the API response, so the UI can iterate without null checks.
 */
export async function listDeepgramModels(
  apiKey: string,
  options: DeepgramListModelsOptions = {},
): Promise<DeepgramModelsList> {
  if (!apiKey) {
    throw new Error('Deepgram models: API key is not configured.')
  }

  const base = (options.baseUrl ?? DEEPGRAM_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const params = new URLSearchParams()
  // Only add the query param when explicitly opting in — Deepgram defaults to
  // `include_outdated=false`, which is what we want for the picker UI.
  if (options.includeOutdated) {
    params.set('include_outdated', 'true')
  }
  const qs = params.toString()
  const url = `${base}/v1/models${qs ? `?${qs}` : ''}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    throw new Error(`Deepgram models request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    throw await describeDeepgramError('Deepgram models', response)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch (err) {
    throw new Error(`Deepgram models: invalid JSON response: ${(err as Error).message}`)
  }

  // Be lenient with the payload shape: pull `stt`/`tts` if they're arrays,
  // default to empty otherwise. Real upstream errors come through the
  // non-OK branch above; a body that parses but lacks the expected keys
  // shouldn't crash the picker UI.
  const stt = data && typeof data === 'object' && Array.isArray((data as { stt?: unknown }).stt)
    ? (data as { stt: DeepgramModel[] }).stt
    : []
  const tts = data && typeof data === 'object' && Array.isArray((data as { tts?: unknown }).tts)
    ? (data as { tts: DeepgramModel[] }).tts
    : []
  return { stt, tts }
}

// ── STT ────────────────────────────────────────────────────────────

/**
 * Transcribe pre-recorded audio via Deepgram's `/v1/listen` endpoint.
 *
 * The Telegram voice handler hands us OGG Opus bytes; Deepgram detects the
 * container automatically. We still set `Content-Type: audio/ogg` (or the
 * caller-provided hint) so misconfigured proxies don't strip the body.
 */
export async function transcribeDeepgram(
  buffer: Buffer,
  apiKey: string,
  options: DeepgramTranscribeOptions = {},
): Promise<string> {
  if (!apiKey) {
    throw new Error('Deepgram STT: API key is not configured. Set it in Settings → Skills → Voice.')
  }
  if (!buffer || buffer.length === 0) {
    throw new Error('Deepgram STT: audio buffer is empty.')
  }

  const base = (options.baseUrl ?? DEEPGRAM_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const params = new URLSearchParams()
  params.set('model', options.model || DEEPGRAM_DEFAULT_STT_MODEL)
  params.set('punctuate', 'true')
  params.set('smart_format', 'true')
  if (options.language) {
    params.set('language', options.language)
  }
  const url = `${base}/v1/listen?${params.toString()}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': options.mimeType || 'audio/ogg',
      },
      // Buffer is a Uint8Array subclass and is accepted by Node's undici-based
      // fetch as a body. Cast through `unknown` so we don't depend on DOM lib's
      // `BodyInit` (not part of the core build's @types).
      body: buffer as unknown as ReadableStream<Uint8Array>,
    })
  } catch (err) {
    throw new Error(`Deepgram STT request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    throw await describeDeepgramError('Deepgram STT', response)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch (err) {
    throw new Error(`Deepgram STT: invalid JSON response: ${(err as Error).message}`)
  }

  const transcript = extractDeepgramTranscript(data)
  if (transcript === null) {
    throw new Error('Deepgram STT: response did not contain a transcript.')
  }
  return transcript.trim()
}

/**
 * Pull the first alternative's transcript out of Deepgram's nested response
 * shape: `{ results: { channels: [ { alternatives: [ { transcript } ] } ] } }`.
 * Returns `null` (not the empty string) when the structure is missing so
 * callers can distinguish "API responded with empty transcript" from "API
 * returned an unexpected shape" — only the latter is an error.
 */
export function extractDeepgramTranscript(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const results = (payload as { results?: unknown }).results
  if (!results || typeof results !== 'object') return null
  const channels = (results as { channels?: unknown }).channels
  if (!Array.isArray(channels) || channels.length === 0) return null
  const first = channels[0]
  if (!first || typeof first !== 'object') return null
  const alternatives = (first as { alternatives?: unknown }).alternatives
  if (!Array.isArray(alternatives) || alternatives.length === 0) return null
  const alt = alternatives[0]
  if (!alt || typeof alt !== 'object') return null
  const transcript = (alt as { transcript?: unknown }).transcript
  return typeof transcript === 'string' ? transcript : null
}

// ── TTS ───────────────────────────────────────────────────────────────

/**
 * Synthesize speech via Deepgram's `/v1/speak` endpoint.
 *
 * Returns the raw audio bytes (e.g. an MP3) the caller can stream to a
 * client or upload to Telegram as a voice message.
 */
export async function synthesizeDeepgram(
  text: string,
  apiKey: string,
  options: DeepgramSynthesizeOptions = {},
): Promise<Buffer> {
  if (!apiKey) {
    throw new Error('Deepgram TTS: API key is not configured. Set it in Settings → Skills → Voice.')
  }
  const trimmed = text?.trim() ?? ''
  if (!trimmed) {
    throw new Error('Deepgram TTS: input text is empty.')
  }
  // Deepgram's /v1/speak rejects payloads larger than 2000 chars per request.
  // We surface a clean error rather than letting the API 400 on us.
  if (trimmed.length > 2000) {
    throw new Error(`Deepgram TTS: input text is ${trimmed.length} chars, max is 2000. Split before synthesizing.`)
  }

  const base = (options.baseUrl ?? DEEPGRAM_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const params = new URLSearchParams()
  params.set('model', options.model || DEEPGRAM_DEFAULT_TTS_MODEL)
  params.set('encoding', options.encoding || 'mp3')
  const url = `${base}/v1/speak?${params.toString()}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: trimmed }),
    })
  } catch (err) {
    throw new Error(`Deepgram TTS request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    throw await describeDeepgramError('Deepgram TTS', response)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
