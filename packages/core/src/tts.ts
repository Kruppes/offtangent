/**
 * Multi-provider Text-to-Speech dispatcher.
 *
 * Mirrors `stt.ts` in shape: a single `synthesizeTts(text, options?)` entry
 * point that reads the saved settings, looks up the configured provider, and
 * returns the synthesized audio as a `Buffer`.
 *
 * Lives in core (not in the web-backend route) so non-HTTP callers \u2014
 * primarily the Telegram bot, which uploads the audio as a voice message \u2014
 * can synthesize without going through the web layer.
 *
 * Provider support:
 *   - `openai`   \u2014 OpenAI-compatible `/v1/audio/speech` endpoint
 *   - `mistral`  \u2014 Mistral Voxtral, same path with `voice_id` body
 *   - `deepgram` \u2014 dedicated `/v1/speak`, key under `tts.deepgramApiKey`
 *   - `gemini`   \u2014 Google Interactions API, key from a `google` provider;
 *                  returns PCM only, so we mux Ogg/Opus or WAV ourselves
 */

import { ensureConfigTemplates, loadConfig } from './config.js'
import { loadProvidersDecrypted, getApiKeyForProvider } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import { synthesizeDeepgram, decryptDeepgramApiKey, DEEPGRAM_DEFAULT_TTS_MODEL } from './deepgram.js'
import type { DeepgramTtsEncoding } from './deepgram.js'
import { synthesizeGeminiPcm } from './gemini-tts.js'
import { encodeOggOpus, normalizePcm, wrapPcmInWav } from './ogg-opus.js'
import type { PcmAudio } from './ogg-opus.js'
import { isSupportedSampleRate, resamplePcm } from './pcm-resample.js'
import { Readable } from 'node:stream'
import type { TtsProvider, TtsResponseFormat } from './contracts/settings.js'
import {
  DEFAULT_TTS_GEMINI_MODEL,
  DEFAULT_TTS_GEMINI_VOICE,
  SETTINGS_TTS_FORMATS_BY_PROVIDER,
  SETTINGS_TTS_OPENAI_VOICES,
  SETTINGS_TTS_STREAMABLE_FORMATS,
} from './contracts/settings.js'

/**
 * Map the unified user-facing `responseFormat` to Deepgram's `encoding`
 * parameter. Deepgram doesn't speak `wav` directly \u2014 it ships raw
 * 16-bit PCM at 24 kHz under `linear16`. We wrap that into a proper WAV
 * container after synthesis so the user gets a playable file.
 */
const DEEPGRAM_FORMAT_MAP: Record<TtsResponseFormat, DeepgramTtsEncoding> = {
  mp3: 'mp3',
  opus: 'opus',
  flac: 'flac',
  wav: 'linear16',
  // Deepgram does not advertise a headerless format in our catalog
  // (`SETTINGS_TTS_FORMATS_BY_PROVIDER.deepgram`), so `resolveTtsFormat`
  // rejects `pcm` before this entry is ever read. It only exists so the map
  // stays total over the format union.
  pcm: 'linear16',
}

/** Deepgram's `linear16` always uses these PCM parameters. */
const DEEPGRAM_LINEAR16_SAMPLE_RATE = 24000
const DEEPGRAM_LINEAR16_CHANNELS = 1
const DEEPGRAM_LINEAR16_BITS_PER_SAMPLE = 16

/**
 * Deepgram's `/v1/speak` rejects payloads >2000 chars. We split longer
 * texts into chunks and synthesize each separately so the user-facing
 * “Read message aloud” button works for long assistant replies. Kept a
 * touch under the hard limit to leave headroom for whitespace tweaks.
 */
const DEEPGRAM_TTS_CHUNK_LIMIT = 1900

/** Deepgram's documented hard cap on `/v1/speak` input length. */
const DEEPGRAM_TTS_HARD_LIMIT = 2000

/**
 * Split `text` into chunks of at most `maxLen` characters, preferring
 * paragraph → sentence → word boundaries before falling back to a hard
 * slice. The goal is to keep prosody intact across chunks: cutting at
 * `. ` / `! ` / `? ` / `\n\n` produces audibly smoother joins than
 * mid-sentence splits. Shared by the Deepgram and Gemini paths.
 */
export function chunkTextForTts(text: string, maxLen: number): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= maxLen) return [trimmed]

  // Split on sentence-ish boundaries while keeping the delimiter attached
  // to the preceding piece, so the synthesized audio still ends on the
  // punctuation.
  const pieces = trimmed.split(/(?<=[.!?\n])\s+/)

  const chunks: string[] = []
  let current = ''
  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }

  for (const piece of pieces) {
    if (piece.length > maxLen) {
      // A single “sentence” still longer than `maxLen` — fall back to a
      // word-boundary slice so we don't chop a word in half.
      flush()
      let remaining = piece
      while (remaining.length > maxLen) {
        const slice = remaining.slice(0, maxLen)
        const lastSpace = slice.lastIndexOf(' ')
        const cut = lastSpace > maxLen * 0.5 ? lastSpace : maxLen
        chunks.push(slice.slice(0, cut).trim())
        remaining = remaining.slice(cut).trim()
      }
      if (remaining) current = remaining
      continue
    }
    if (current.length + piece.length + 1 > maxLen) {
      flush()
    }
    current = current ? `${current} ${piece}` : piece
  }
  flush()
  return chunks
}

// ── Types ─────────────────────────────────────────────────────────────

export interface TtsSettings {
  enabled: boolean
  provider: TtsProvider
  /** Provider-config id (used to look up the API key for openai/mistral). */
  providerId: string
  openaiModel: string
  openaiVoice: string
  openaiInstructions: string
  mistralVoice: string
  /**
   * Single user-facing audio format used across providers. The dispatcher
   * maps it to provider-specific knobs (e.g. Deepgram `wav` \u2192 `linear16`
   * + WAV header wrap).
   */
  responseFormat: TtsResponseFormat
  deepgramModel: string
  geminiModel: string
  geminiVoice: string
  /** Natural-language delivery hint prepended to the text; empty = none. */
  geminiStyle: string
}

export interface SynthesizeOptions {
  /** Override the configured voice for this call (e.g. preview override). */
  voice?: string
  /**
   * Override the configured `responseFormat` for this call. Set by clients
   * that can only play one container (an ESP32 puck plays WAV, the phone app
   * prefers Opus) so one global setting still serves both.
   */
  format?: TtsResponseFormat
  /**
   * Target sample rate in Hz for WAV output from a PCM provider (Gemini,
   * Deepgram `linear16`). Ignored for every other provider/format pair,
   * because only there do we hold raw samples we may resample.
   */
  sampleRate?: number
  /**
   * Unsaved settings laid over the stored ones for this single call. The
   * settings preview sends the form as it stands so the user hears the voice
   * they are ABOUT to save, not the one on disk. Never persisted.
   */
  settings?: Partial<TtsSettings>
}

export interface SynthesizeResult {
  audio: Buffer
  /**
   * Which endpoint produced the audio: the configured primary or the hosted
   * OpenAI fallback. Only set by the OpenAI-compatible path, which is the
   * only one with a fallback.
   */
  source?: 'primary' | 'fallback'
  /** MIME type matching the encoded audio (e.g. `audio/mpeg`, `audio/ogg`). */
  contentType: string
  /** File extension hint without leading dot (e.g. `mp3`, `ogg`). */
  extension: string
  /**
   * Sample rate of the returned audio, set ONLY when the server resampled it
   * on request. Absent means "provider native rate", which we do not inspect.
   */
  sampleRate?: number
}

/**
 * A synthesis that is handed on while it is still being produced. `stream`
 * emits the raw audio bytes of `contentType` in the order the endpoint sent
 * them, so an HTTP route can pipe it straight into its response.
 */
export interface TtsStreamResult {
  stream: Readable
  contentType: string
  extension: string
  /** Set only when the endpoint was asked for, and honors, a sample rate. */
  sampleRate?: number
  source: 'primary' | 'fallback'
}

/**
 * The requested format cannot be produced by the configured provider.
 *
 * A separate type because it is a caller error, not a server fault: HTTP
 * routes map it to 400, never to 500, and never silently fall back to another
 * format (a client that asked for WAV cannot play the Opus it would get).
 */
export class TtsFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TtsFormatError'
  }
}

/**
 * Which of the four user-facing formats each provider can actually deliver.
 * Gemini returns raw PCM that we package ourselves, so it is limited to the
 * two containers we can build without ffmpeg.
 */
export const TTS_PROVIDER_FORMATS: Record<TtsProvider, ReadonlySet<TtsResponseFormat>> = {
  openai: new Set(SETTINGS_TTS_FORMATS_BY_PROVIDER.openai),
  mistral: new Set(SETTINGS_TTS_FORMATS_BY_PROVIDER.mistral),
  deepgram: new Set(SETTINGS_TTS_FORMATS_BY_PROVIDER.deepgram),
  gemini: new Set(SETTINGS_TTS_FORMATS_BY_PROVIDER.gemini),
}

/**
 * Effective format for one call: the per-request override wins over the saved
 * setting. Throws {@link TtsFormatError} when the provider cannot deliver it.
 */
export function resolveTtsFormat(
  provider: TtsProvider,
  settings: TtsSettings,
  options: SynthesizeOptions = {},
): TtsResponseFormat {
  const format = options.format ?? settings.responseFormat
  const supported = TTS_PROVIDER_FORMATS[provider]
  if (supported && !supported.has(format)) {
    const list = [...supported].join(', ')
    throw new TtsFormatError(
      `TTS provider \`${provider}\` cannot produce \`${format}\` audio. Supported formats: ${list}.`,
    )
  }
  return format
}

/**
 * Target rate for a PCM source, or `null` when nothing should be resampled:
 * no rate asked for, the format is not WAV, the rate is out of range, or it
 * already matches the native rate. Out-of-range values are ignored rather
 * than rejected here; the HTTP layer validates the body before we get here.
 */
function resolveTargetRate(
  format: TtsResponseFormat,
  options: SynthesizeOptions,
  nativeRate: number,
): number | null {
  if (format !== 'wav') return null
  const wanted = options.sampleRate
  if (wanted === undefined || !isSupportedSampleRate(wanted)) return null
  return wanted === nativeRate ? null : wanted
}

// ── Settings loader ───────────────────────────────────────────────────

export function loadTtsSettings(): TtsSettings {
  ensureConfigTemplates()
  const settings = loadConfig<Record<string, unknown>>('settings.json')
  const tts = (settings.tts ?? {}) as Partial<TtsSettings>
  return {
    enabled: tts.enabled ?? false,
    provider: tts.provider ?? 'openai',
    providerId: tts.providerId ?? '',
    openaiModel: tts.openaiModel ?? 'gpt-4o-mini-tts',
    openaiVoice: tts.openaiVoice ?? 'nova',
    openaiInstructions: tts.openaiInstructions ?? '',
    mistralVoice: tts.mistralVoice ?? '',
    responseFormat: tts.responseFormat ?? 'mp3',
    deepgramModel: tts.deepgramModel ?? DEEPGRAM_DEFAULT_TTS_MODEL,
    geminiModel: tts.geminiModel || DEFAULT_TTS_GEMINI_MODEL,
    geminiVoice: tts.geminiVoice || DEFAULT_TTS_GEMINI_VOICE,
    geminiStyle: tts.geminiStyle ?? '',
  }
}

/**
 * Read the (possibly encrypted) TTS Deepgram API key from
 * `settings.tts.deepgramApiKey`. Plaintext-fallback handled by
 * `decryptDeepgramApiKey()`.
 */
export function loadTtsDeepgramApiKey(): string {
  ensureConfigTemplates()
  const settings = loadConfig<{ tts?: { deepgramApiKey?: string } }>('settings.json')
  const raw = settings.tts?.deepgramApiKey ?? ''
  return raw ? decryptDeepgramApiKey(raw) : ''
}

// ── Provider lookup ───────────────────────────────────────────────────

/**
 * Find the provider config for an OpenAI-compatible or Mistral TTS call.
 * Prefers a specific `providerId` when set; falls back to the first provider
 * matching the type so default installs without an explicit selection still
 * work.
 */
function findTtsProvider(settings: TtsSettings): ProviderConfig | null {
  const file = loadProvidersDecrypted()

  if (settings.providerId) {
    return file.providers.find(p => p.id === settings.providerId) ?? null
  }

  const providerType = settings.provider
  const byType = file.providers.find(p => p.providerType === providerType || p.provider === providerType)
  if (byType) return byType

  if (providerType === 'openai') {
    return file.providers.find(p => p.baseUrl?.includes('api.openai.com')) ?? null
  }
  if (providerType === 'mistral') {
    return file.providers.find(p => p.baseUrl?.includes('api.mistral.ai')) ?? null
  }
  if (providerType === 'gemini') {
    return file.providers.find(p => p.providerType === 'google' || p.provider === 'google')
      ?? file.providers.find(p => p.baseUrl?.includes('generativelanguage.googleapis.com'))
      ?? null
  }
  return null
}

/** Strip trailing slash and `/v1` suffix so we can always append `/v1/...`. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/opus',
  flac: 'audio/flac',
  pcm: 'audio/pcm',
  linear16: 'audio/wav',
}

const EXTENSION_MAP: Record<string, string> = {
  // Most encodings already match their extension; the table normalizes the
  // few that don't so callers get a sensible filename suffix. `pcm` keeps its
  // own suffix: the bytes carry no WAV header, so calling the file `.wav`
  // would lie to whatever opens it.
  linear16: 'wav',
  opus: 'ogg',
}

function describeAudio(encoding: string): { contentType: string; extension: string } {
  return {
    contentType: CONTENT_TYPE_MAP[encoding] ?? 'audio/mpeg',
    extension: EXTENSION_MAP[encoding] ?? encoding,
  }
}

// ── OpenAI synthesis ──────────────────────────────────────────────────

/**
 * Time the primary endpoint has to answer with response HEADERS. It is not a
 * budget for the whole synthesis: a streaming endpoint sends headers early and
 * then speaks for half a minute. Exceeding it means "this box is not there",
 * which is exactly the case the fallback exists for.
 */
export const TTS_FIRST_BYTE_TIMEOUT_MS = 3000

/**
 * Header budget for a container the endpoint cannot stream (mp3, opus, flac).
 * Those are muxed after the last sample, so the headers arrive only when the
 * whole text is spoken; a 3 s budget would cut off every longer reply. A dead
 * box is still noticed at once, because a refused connection does not wait for
 * a timer.
 */
export const TTS_BLOCK_TIMEOUT_MS = 120_000

/** Header budget for `format`: early for a stream, generous for a block. */
export function ttsHeaderTimeoutMs(format: TtsResponseFormat): number {
  return TTS_STREAMABLE_FORMATS.has(format) ? TTS_FIRST_BYTE_TIMEOUT_MS : TTS_BLOCK_TIMEOUT_MS
}

/** Model used when the primary OpenAI-compatible endpoint is unreachable. */
export const TTS_FALLBACK_MODEL = 'gpt-4o-mini-tts'

/** Voice used for the fallback when the configured one is not an OpenAI voice. */
export const TTS_FALLBACK_VOICE = 'nova'

/** Formats the dispatcher hands through chunk by chunk. */
export const TTS_STREAMABLE_FORMATS: ReadonlySet<TtsResponseFormat>
  = new Set(SETTINGS_TTS_STREAMABLE_FORMATS)

/**
 * An upstream speech endpoint answered with a non-2xx status. Carries the
 * status so the caller can tell a configuration problem (401, 400) from an
 * outage (5xx) that deserves a fallback.
 */
export class TtsUpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'TtsUpstreamError'
  }
}

/** True for the hosted OpenAI API, false for any self-hosted clone. */
export function isOfficialOpenAiBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return true // empty baseUrl means the OpenAI default
  return /(^|\/\/|\.)api\.openai\.com(\/|$|:)/.test(baseUrl)
}

interface OpenAiSpeechTarget {
  provider: ProviderConfig
  model: string
  voice: string
  instructions?: string
  /** Only sent to non-OpenAI endpoints, which is where the knob exists. */
  sampleRate?: number
}

/**
 * One POST to an OpenAI-compatible `/v1/audio/speech`.
 *
 * The abort timer covers the wait for the response headers only and is
 * cleared as soon as they arrive, so a long chunked body is never cut off
 * mid-sentence by the connect timeout.
 */
async function requestOpenAiSpeech(
  target: OpenAiSpeechTarget,
  text: string,
  format: TtsResponseFormat,
  timeoutMs: number,
): Promise<Response> {
  const apiKey = await getApiKeyForProvider(target.provider)
  const baseUrl = target.provider.baseUrl || 'https://api.openai.com'
  const official = isOfficialOpenAiBaseUrl(target.provider.baseUrl)
  const url = `${normalizeBaseUrl(baseUrl)}/v1/audio/speech`

  const body: Record<string, unknown> = {
    model: target.model,
    voice: target.voice,
    input: text,
    response_format: format,
  }
  // `instructions` is only honored by gpt-4o-mini-tts; sending it to other
  // models is a 400 from OpenAI.
  if (target.instructions && target.model === 'gpt-4o-mini-tts') {
    body.instructions = target.instructions
  }
  // `sample_rate` is an extension of self-hosted endpoints. OpenAI answers 400
  // for unknown body fields, so it never leaves the house towards api.openai.com.
  if (!official && target.sampleRate) body.sample_rate = target.sampleRate

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    throw new Error(`OpenAI TTS request failed: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new TtsUpstreamError(
      `OpenAI TTS returned HTTP ${response.status}: ${errText.slice(0, 500)}`,
      response.status,
    )
  }
  return response
}

/**
 * Whether a failed primary call should be retried on the hosted OpenAI API.
 * Transport failures, aborts and 5xx say "the box is gone"; a 4xx says "the
 * request was wrong", and repeating a wrong request elsewhere only hides it.
 */
function deservesTtsFallback(err: unknown): boolean {
  if (err instanceof TtsFormatError) return false
  if (err instanceof TtsUpstreamError) return err.status >= 500
  return true
}

/**
 * A configured provider that really is the hosted OpenAI API and carries a
 * key. `excludeId` keeps the primary out of its own fallback.
 */
function findOpenAiFallbackProvider(excludeId?: string): ProviderConfig | null {
  const file = loadProvidersDecrypted()
  return file.providers.find(p =>
    p.id !== excludeId
    && (p.providerType === 'openai' || p.provider === 'openai')
    && isOfficialOpenAiBaseUrl(p.baseUrl)
    && !!p.apiKey,
  ) ?? null
}

/** The configured voice if OpenAI knows it, otherwise the neutral default. */
function openAiFallbackVoice(voice: string): string {
  return SETTINGS_TTS_OPENAI_VOICES.some(v => v.name === voice) ? voice : TTS_FALLBACK_VOICE
}

interface OpenAiSpeechCall {
  response: Response
  format: TtsResponseFormat
  /** `primary` = the configured endpoint, `fallback` = hosted OpenAI. */
  source: 'primary' | 'fallback'
}

/**
 * Ask the configured OpenAI-compatible endpoint and, if it does not answer,
 * the hosted OpenAI API with {@link TTS_FALLBACK_MODEL}. The switch is logged
 * with the reason; the caller only sees audio.
 */
async function callOpenAiSpeech(
  text: string,
  settings: TtsSettings,
  options: SynthesizeOptions,
): Promise<OpenAiSpeechCall> {
  const provider = findTtsProvider(settings)
  if (!provider) {
    throw new Error(
      'OpenAI TTS provider is not configured. Add or select an OpenAI-compatible provider in Settings \u2192 Text-to-Speech.',
    )
  }
  const format = resolveTtsFormat('openai', settings, options)
  const voice = options.voice ?? settings.openaiVoice

  try {
    const response = await requestOpenAiSpeech(
      {
        provider,
        model: settings.openaiModel,
        voice,
        instructions: settings.openaiInstructions,
        sampleRate: options.sampleRate,
      },
      text,
      format,
      ttsHeaderTimeoutMs(format),
    )
    return { response, format, source: 'primary' }
  } catch (err) {
    if (!deservesTtsFallback(err)) throw err

    const fallback = findOpenAiFallbackProvider(provider.id)
    if (!fallback) {
      console.warn(
        `[tts] primary voice "${provider.name}" failed and no hosted OpenAI provider with a key is configured`,
      )
      throw err
    }
    console.warn(
      `[tts] primary voice "${provider.name}" failed (${(err as Error).message.slice(0, 200)}); `
      + `falling back to OpenAI ${TTS_FALLBACK_MODEL} via "${fallback.name}"`,
    )
    const response = await requestOpenAiSpeech(
      {
        provider: fallback,
        model: TTS_FALLBACK_MODEL,
        voice: openAiFallbackVoice(voice),
        instructions: settings.openaiInstructions,
      },
      text,
      format,
      ttsHeaderTimeoutMs(format),
    )
    return { response, format, source: 'fallback' }
  }
}

export async function synthesizeOpenAi(
  text: string,
  settings: TtsSettings,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const call = await callOpenAiSpeech(text, settings, options)
  const audio = Buffer.from(await call.response.arrayBuffer())
  return { audio, ...describeAudio(call.format), source: call.source }
}

/**
 * Same call as {@link synthesizeOpenAi}, but the body is handed on as it
 * arrives. Used for `pcm`/`wav`, where every chunk is already playable and
 * waiting for the last byte would waste the whole head start the endpoint
 * gives us.
 */
export async function synthesizeOpenAiStream(
  text: string,
  settings: TtsSettings,
  options: SynthesizeOptions = {},
): Promise<TtsStreamResult> {
  const call = await callOpenAiSpeech(text, settings, options)
  if (!call.response.body) {
    throw new Error('OpenAI TTS returned no response body to stream')
  }
  const described = describeAudio(call.format)
  const result: TtsStreamResult = {
    stream: Readable.fromWeb(call.response.body as Parameters<typeof Readable.fromWeb>[0]),
    contentType: described.contentType,
    extension: described.extension,
    source: call.source,
  }
  // Only the self-hosted endpoint honors `sample_rate`; the hosted fallback
  // answers in its own rate, so we must not claim the requested one there.
  if (options.sampleRate && call.source === 'primary') result.sampleRate = options.sampleRate
  return result
}

// ── Mistral synthesis ─────────────────────────────────────────────────

export async function synthesizeMistral(
  text: string,
  settings: TtsSettings,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const provider = findTtsProvider(settings)
  if (!provider) {
    throw new Error(
      'Mistral TTS provider is not configured. Add or select a Mistral provider in Settings \u2192 Text-to-Speech.',
    )
  }
  const format = resolveTtsFormat('mistral', settings, options)
  const apiKey = await getApiKeyForProvider(provider)
  const baseUrl = provider.baseUrl || 'https://api.mistral.ai'
  const url = `${normalizeBaseUrl(baseUrl)}/v1/audio/speech`
  const voiceId = options.voice ?? settings.mistralVoice

  const body: Record<string, unknown> = {
    model: 'voxtral-mini-tts-2603',
    input: text,
    response_format: format,
    stream: false,
  }
  if (voiceId) body.voice_id = voiceId

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`Mistral TTS request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`Mistral TTS returned HTTP ${response.status}: ${errText.slice(0, 500)}`)
  }

  // Mistral returns either binary audio or a JSON envelope `{ audio_data: base64 }`
  // depending on version. Detect via Content-Type.
  const contentType = response.headers.get('content-type') ?? ''
  let audio: Buffer
  if (contentType.includes('application/json')) {
    const data = await response.json() as { audio_data?: string }
    if (!data.audio_data) {
      throw new Error('Mistral TTS returned no audio data.')
    }
    audio = Buffer.from(data.audio_data, 'base64')
  } else {
    audio = Buffer.from(await response.arrayBuffer())
  }

  return { audio, ...describeAudio(format) }
}

// ── Deepgram synthesis ────────────────────────────────────────────────

async function synthesizeDeepgramWrapped(
  text: string,
  settings: TtsSettings,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const apiKey = loadTtsDeepgramApiKey()
  if (!apiKey) {
    throw new Error('Deepgram TTS: API key is not configured. Set it in Settings \u2192 Text-to-Speech.')
  }

  const format = resolveTtsFormat('deepgram', settings, options)
  const deepgramEncoding = DEEPGRAM_FORMAT_MAP[format]
  const model = options.voice || settings.deepgramModel

  // Deepgram caps `/v1/speak` at 2000 chars per call. For longer texts we
  // split the input and concatenate the audio. Safe for `mp3` (frame-
  // aligned) and `linear16` (raw PCM — just bytes); `opus`/`flac` use
  // page/frame containers that don't survive naive concatenation, so we
  // refuse only when the input actually exceeds the per-call limit and
  // would therefore require multiple Deepgram calls. Inputs at or below
  // 2000 chars stay valid for every format even if our internal chunker
  // (which works under the limit for prosody headroom) would split them.
  const inputLength = text.length
  if (inputLength > DEEPGRAM_TTS_HARD_LIMIT && (deepgramEncoding === 'opus' || deepgramEncoding === 'flac')) {
    throw new Error(
      `Deepgram TTS: text is ${inputLength} chars (>${DEEPGRAM_TTS_HARD_LIMIT}). Long-text chunking is only supported for `
      + `\`mp3\` and \`wav\` — switch “Response format” in Settings → Text-to-Speech.`,
    )
  }

  // `opus` and `flac` use container/page/frame structures that don't
  // survive naive `Buffer.concat()`. For those encodings, only chunk
  // when the response format is concatenation-safe — otherwise send the
  // whole (≤2000-char) text in a single Deepgram call.
  const supportsChunkConcatenation = deepgramEncoding === 'mp3' || deepgramEncoding === 'linear16'
  const chunks = supportsChunkConcatenation
    ? chunkTextForTts(text, DEEPGRAM_TTS_CHUNK_LIMIT)
    : [text.trim()]

  const parts: Buffer[] = []
  for (const chunk of chunks) {
    parts.push(
      await synthesizeDeepgram(chunk, apiKey, { model, encoding: deepgramEncoding }),
    )
  }
  const raw = parts.length === 1 ? parts[0]! : Buffer.concat(parts)

  if (format === 'wav') {
    const targetRate = resolveTargetRate(format, options, DEEPGRAM_LINEAR16_SAMPLE_RATE)
    if (targetRate === null) {
      const wav = wrapPcmInWav(
        raw,
        DEEPGRAM_LINEAR16_SAMPLE_RATE,
        DEEPGRAM_LINEAR16_CHANNELS,
        DEEPGRAM_LINEAR16_BITS_PER_SAMPLE,
      )
      return { audio: wav, contentType: 'audio/wav', extension: 'wav' }
    }
    const resampled = resamplePcm(
      bufferToInt16(raw),
      DEEPGRAM_LINEAR16_SAMPLE_RATE,
      targetRate,
      DEEPGRAM_LINEAR16_CHANNELS,
    )
    const wav = wrapPcmInWav(
      int16ToBuffer(resampled),
      targetRate,
      DEEPGRAM_LINEAR16_CHANNELS,
      DEEPGRAM_LINEAR16_BITS_PER_SAMPLE,
    )
    return { audio: wav, contentType: 'audio/wav', extension: 'wav', sampleRate: targetRate }
  }
  return { audio: raw, ...describeAudio(deepgramEncoding) }
}

// ── Gemini synthesis ──────────────────────────────────────────────────

/**
 * Gemini accepts far more than this per request, but long inputs drift in
 * pacing and a single call for a whole article takes minutes. Paragraph-sized
 * chunks keep latency and quality predictable; PCM concatenates gaplessly, so
 * the joins are inaudible after one encode pass.
 */
export const GEMINI_TTS_CHUNK_LIMIT = 1500

/** Formats we can build from Gemini's raw PCM without ffmpeg. */
const GEMINI_SUPPORTED_FORMATS: ReadonlySet<TtsResponseFormat> = TTS_PROVIDER_FORMATS.gemini

/** Copy a byte buffer into Int16 samples; a trailing odd byte is dropped. */
function bufferToInt16(pcm: Buffer): Int16Array {
  const frames = Math.floor(pcm.length / 2)
  const out = new Int16Array(frames)
  for (let i = 0; i < frames; i++) out[i] = pcm.readInt16LE(i * 2)
  return out
}

/** View Int16 samples as little-endian bytes (Node only runs little-endian). */
function int16ToBuffer(samples: Int16Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
}

/**
 * The style hint is a natural-language instruction Gemini reads as stage
 * direction ("Sprich ruhig und deutlich:"). It goes in front of the text
 * with a blank line so the model does not glue it to the first sentence.
 */
export function composeGeminiPrompt(style: string, text: string): string {
  const hint = style.trim()
  return hint ? `${hint}\n\n${text}` : text
}

export async function synthesizeGemini(
  text: string,
  settings: TtsSettings,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const format = options.format ?? settings.responseFormat
  if (!GEMINI_SUPPORTED_FORMATS.has(format)) {
    throw new TtsFormatError(
      `Gemini TTS delivers raw PCM, which we package as \`opus\` or \`wav\` only — `
      + `ask for one of those or switch “Response format” in Settings → Text-to-Speech `
      + `(requested \`${format}\`).`,
    )
  }

  const provider = findTtsProvider(settings)
  if (!provider) {
    throw new Error(
      'Gemini TTS provider is not configured. Add a Google provider with a Gemini API key in Settings → Providers '
      + 'and select it under Settings → Text-to-Speech.',
    )
  }
  const apiKey = await getApiKeyForProvider(provider)
  if (!apiKey) {
    throw new Error(`Gemini TTS: provider "${provider.name}" has no API key.`)
  }

  const voice = options.voice || settings.geminiVoice
  const chunks = chunkTextForTts(text, GEMINI_TTS_CHUNK_LIMIT)
  const parts: PcmAudio[] = []
  for (const chunk of chunks) {
    parts.push(await synthesizeGeminiPcm({
      text: composeGeminiPrompt(settings.geminiStyle, chunk),
      model: settings.geminiModel,
      voice,
      apiKey,
      baseUrl: provider.baseUrl?.includes('generativelanguage.googleapis.com') ? provider.baseUrl : undefined,
    }))
  }

  const first = parts[0]!
  for (const part of parts) {
    if (part.sampleRate !== first.sampleRate || part.channels !== first.channels) {
      throw new Error('Gemini TTS returned chunks with differing audio formats; cannot join them.')
    }
  }
  const total = parts.reduce((n, p) => n + p.samples.length, 0)
  const joined = new Int16Array(total)
  let cursor = 0
  for (const part of parts) {
    joined.set(part.samples, cursor)
    cursor += part.samples.length
  }

  const pcm: PcmAudio = {
    samples: normalizePcm(joined),
    sampleRate: first.sampleRate,
    channels: first.channels,
  }

  if (format === 'wav') {
    // Int16Array shares the host byte order; Node only runs little-endian
    // hosts, which is what WAV wants.
    const targetRate = resolveTargetRate(format, options, pcm.sampleRate)
    const samples = targetRate === null
      ? pcm.samples
      : resamplePcm(pcm.samples, pcm.sampleRate, targetRate, pcm.channels)
    const rate = targetRate ?? pcm.sampleRate
    const wav = wrapPcmInWav(int16ToBuffer(samples), rate, pcm.channels, 16)
    return targetRate === null
      ? { audio: wav, contentType: 'audio/wav', extension: 'wav' }
      : { audio: wav, contentType: 'audio/wav', extension: 'wav', sampleRate: targetRate }
  }
  const ogg = await encodeOggOpus(pcm)
  return { audio: ogg, contentType: 'audio/ogg', extension: 'ogg' }
}

// ── Dispatcher ────────────────────────────────────────────────────────

/**
 * Synthesize `text` using the configured TTS provider. Returns the raw
 * audio Buffer plus a content-type / extension hint that callers can use to
 * set HTTP response headers or pick a filename for upload.
 *
 * Throws when TTS is disabled or no usable provider/key is configured \u2014
 * callers (Telegram bot, web TTS preview, etc.) decide how loud the
 * failure surfaces.
 */
export async function synthesizeTts(
  text: string,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const settings: TtsSettings = options.settings
    ? { ...loadTtsSettings(), ...options.settings }
    : loadTtsSettings()
  if (!settings.enabled) {
    throw new Error('TTS is not enabled. Enable it in Settings \u2192 Text-to-Speech.')
  }
  const trimmed = text?.trim() ?? ''
  if (!trimmed) {
    throw new Error('TTS: input text is empty.')
  }

  switch (settings.provider) {
    case 'openai':
      return synthesizeOpenAi(trimmed, settings, options)

    case 'mistral':
      return synthesizeMistral(trimmed, settings, options)
    case 'deepgram':
      return synthesizeDeepgramWrapped(trimmed, settings, options)
    case 'gemini':
      return synthesizeGemini(trimmed, settings, options)
    default:
      throw new Error(`Unknown TTS provider: ${settings.provider as string}`)
  }
}

/**
 * Whether a call can be streamed: only the OpenAI-compatible path speaks a
 * chunked protocol we can pass on, and only for formats where a later chunk
 * never rewrites an earlier byte. Cheap and synchronous on purpose, so a
 * route can decide before it opens a connection.
 */
export function shouldStreamTts(provider: TtsProvider, format: TtsResponseFormat | undefined): boolean {
  return provider === 'openai' && !!format && TTS_STREAMABLE_FORMATS.has(format)
}

/**
 * Synthesize `text` and hand the audio on while it is still being produced.
 * Returns `null` when the configured provider or the requested format cannot
 * stream; the caller then uses {@link synthesizeTts} and buffers as before.
 */
export async function synthesizeTtsStream(
  text: string,
  options: SynthesizeOptions = {},
): Promise<TtsStreamResult | null> {
  const settings: TtsSettings = options.settings
    ? { ...loadTtsSettings(), ...options.settings }
    : loadTtsSettings()
  if (!settings.enabled) {
    throw new Error('TTS is not enabled. Enable it in Settings \u2192 Text-to-Speech.')
  }
  const trimmed = text?.trim() ?? ''
  if (!trimmed) {
    throw new Error('TTS: input text is empty.')
  }
  const format = options.format ?? settings.responseFormat
  if (!shouldStreamTts(settings.provider, format)) return null
  return synthesizeOpenAiStream(trimmed, settings, { ...options, format })
}

/**
 * Media types a client may ask for when it cannot set a body field. The puck
 * firmware sends `Accept: audio/wav, audio/*;q=0.9`, so the header has to be
 * enough to pick a container; `audio/*` and `*\/*` stay unopinionated and
 * leave the saved setting in charge.
 */
const ACCEPT_FORMATS: Record<string, TtsResponseFormat> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/ogg': 'opus',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/pcm': 'pcm',
  'audio/l16': 'pcm',
}

/**
 * Pick an audio format from an `Accept` header, or `null` when the header
 * expresses no usable preference. The highest q value wins; the first listed
 * type wins a tie; `q=0` rejects a type instead of selecting it.
 */
export function formatFromAccept(header: string | undefined | null): TtsResponseFormat | null {
  if (!header) return null
  let best: { format: TtsResponseFormat; q: number } | null = null
  for (const part of header.split(',')) {
    const segments = part.split(';')
    const type = (segments[0] ?? '').trim().toLowerCase()
    const format = ACCEPT_FORMATS[type]
    if (!format) continue
    let q = 1
    for (const segment of segments.slice(1)) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(segment)
      if (match) q = Number(match[1])
    }
    if (!Number.isFinite(q) || q <= 0) continue
    if (!best || q > best.q) best = { format, q }
  }
  return best?.format ?? null
}
