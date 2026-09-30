/**
 * Google Gemini text-to-speech over the Interactions API.
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   Headers: x-goog-api-key, Api-Revision (the speech_config array shape
 *            only exists from revision 2026-05-20 on; without the header the
 *            server answers 400 "invalid argument")
 *   Body:    { model, input, response_format: { type: 'audio' },
 *              generation_config: { speech_config: [{ voice }] }, store: false }
 *   Reply:   { status, steps: [{ type: 'model_output',
 *              content: [{ type: 'audio', data: <base64 audio>,
 *                          mime_type: 'audio/l16; rate=24000; channels=1',
 *                          sample_rate?, channels? }] }] }
 *
 * `store: false` is not optional for us: the Interactions API keeps stored
 * interactions for up to 55 days by default, and what we read aloud is the
 * user's private chat content.
 *
 * The audio block comes in one of two shapes, depending on the model:
 *   - raw PCM16 LE (`audio/l16; rate=24000; channels=1`), e.g. 3.1 and 2.5,
 *   - a complete RIFF/WAVE file (`audio/wav`, no rate parameter), e.g. the
 *     3.8 family. Those files carry a trailing `C2PA` chunk (~6 KB of content
 *     credentials) after `data`; reading the whole thing as PCM gives a click
 *     at the start (44-byte header) and ~125 ms of full-scale noise at the
 *     end. So the container is parsed and only the `data` chunk is used.
 * The re-container step (Ogg/Opus, WAV) lives in `ogg-opus.ts`, the dispatcher
 * in `tts.ts`.
 */

import type { PcmAudio } from './ogg-opus.js'

export const GEMINI_TTS_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
/** Pinned so a future breaking revision cannot change the wire format under us. */
export const GEMINI_TTS_API_REVISION = '2026-05-20'
export const GEMINI_TTS_DEFAULT_TIMEOUT_MS = 90_000

export interface GeminiTtsRequest {
  text: string
  model: string
  voice: string
  apiKey: string
  /** Defaults to the public Generative Language endpoint. */
  baseUrl?: string
  timeoutMs?: number
  /** Test seam. */
  fetchImpl?: typeof fetch
  /**
   * Called with the provider's own token counts when the reply carries them.
   * Additive: the read-aloud path ignores it, the voice note uses it for its
   * `token_usage` row instead of estimating.
   */
  onUsage?: (usage: GeminiTtsUsage) => void
}

/** Token counts as Gemini reports them for one synthesis. */
export interface GeminiTtsUsage {
  promptTokens: number
  /** Audio tokens produced. */
  completionTokens: number
}

interface GeminiAudioContent {
  type?: string
  data?: string
  mime_type?: string
  sample_rate?: number
  channels?: number
}

interface GeminiInteractionResponse {
  status?: string
  steps?: Array<{ type?: string; content?: GeminiAudioContent[] }>
  error?: { message?: string; code?: string | number }
  /** Interactions API (`total_input_tokens` / `total_output_tokens`). */
  usage?: {
    total_input_tokens?: number
    total_output_tokens?: number
    total_tokens?: number
  }
  /** generateContent-style reply, kept as a fallback. */
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

/**
 * Token counts of a reply, or null when the provider sent none.
 *
 * The Interactions endpoint answers with `usage.total_input_tokens` /
 * `usage.total_output_tokens` (audio tokens on the output side); the older
 * generateContent shape with `usageMetadata` is still accepted.
 */
export function readGeminiTtsUsage(payload: unknown): GeminiTtsUsage | null {
  const body = payload as GeminiInteractionResponse | null
  const interaction = body?.usage
  if (interaction) {
    const promptTokens = interaction.total_input_tokens ?? 0
    const completionTokens = interaction.total_output_tokens ?? 0
    if (promptTokens !== 0 || completionTokens !== 0) return { promptTokens, completionTokens }
  }
  const legacy = body?.usageMetadata
  if (!legacy) return null
  const promptTokens = legacy.promptTokenCount ?? 0
  const completionTokens = legacy.candidatesTokenCount ?? 0
  if (promptTokens === 0 && completionTokens === 0) return null
  return { promptTokens, completionTokens }
}

/** Strip trailing slash so we can always append `/interactions`. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Read sample rate and channel count from the audio block. Newer models put
 * them into dedicated fields, older ones only into the MIME parameters
 * (`audio/L16;codec=pcm;rate=24000` vs `audio/l16; rate=24000; channels=1`).
 */
export function parseGeminiAudioFormat(content: GeminiAudioContent): { sampleRate: number; channels: number } {
  const mime = content.mime_type ?? ''
  const rateMatch = /rate\s*=\s*(\d+)/i.exec(mime)
  const channelsMatch = /channels\s*=\s*(\d+)/i.exec(mime)
  const sampleRate = content.sample_rate ?? (rateMatch ? Number(rateMatch[1]) : 24_000)
  const channels = content.channels ?? (channelsMatch ? Number(channelsMatch[1]) : 1)
  return { sampleRate, channels }
}

/** What one audio block carried; `channels` is validated against PcmAudio later. */
export interface GeminiDecodedAudio {
  samples: Int16Array
  sampleRate: number
  channels: number
}

/** PCM16 LE bytes → samples. A dangling odd byte is dropped rather than mis-aligned. */
function pcm16(raw: Buffer): Int16Array {
  const usable = raw.length - (raw.length % 2)
  const samples = new Int16Array(usable / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = raw.readInt16LE(i * 2)
  return samples
}

function looksLikeRiffWave(raw: Buffer): boolean {
  return raw.length >= 12 && raw.toString('ascii', 0, 4) === 'RIFF' && raw.toString('ascii', 8, 12) === 'WAVE'
}

/**
 * Walk the RIFF chunks and return only what `data` holds. Unknown chunks
 * (`LIST`, `C2PA`, …) are skipped, including the pad byte that word-aligns an
 * odd-sized chunk.
 */
function parseWav(raw: Buffer): GeminiDecodedAudio {
  if (!looksLikeRiffWave(raw)) throw new Error('Gemini TTS returned a broken WAV container (no RIFF/WAVE header).')

  let pos = 12
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined
  let data: Buffer | undefined
  while (pos + 8 <= raw.length) {
    const id = raw.toString('ascii', pos, pos + 4)
    const size = raw.readUInt32LE(pos + 4)
    const body = raw.subarray(pos + 8, Math.min(pos + 8 + size, raw.length))
    if (id === 'fmt ' && body.length >= 16) {
      fmt = {
        audioFormat: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      }
    } else if (id === 'data') {
      data = body
    }
    pos += 8 + size + (size % 2) // RIFF chunks are word aligned
  }

  if (!fmt || !data) throw new Error('Gemini TTS returned a WAV without a fmt or data chunk.')
  // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (still PCM for our 16-bit case).
  if ((fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe) || fmt.bitsPerSample !== 16) {
    throw new Error(`Gemini TTS returned an unsupported WAV encoding (format ${fmt.audioFormat}, ${fmt.bitsPerSample} bit); expected 16-bit PCM.`)
  }
  return { samples: pcm16(data), sampleRate: fmt.sampleRate, channels: fmt.channels }
}

/** Decode one audio block: RIFF/WAVE container or raw PCM16, as the model sent it. */
export function decodeGeminiAudioBlock(content: GeminiAudioContent): GeminiDecodedAudio {
  const raw = Buffer.from(content.data ?? '', 'base64')
  const mime = (content.mime_type ?? '').toLowerCase()
  if (mime.includes('wav') || looksLikeRiffWave(raw)) return parseWav(raw)
  const format = parseGeminiAudioFormat(content)
  return { samples: pcm16(raw), sampleRate: format.sampleRate, channels: format.channels }
}

/**
 * Synthesize one text with Gemini and return the PCM it produced. Throws on
 * transport errors, non-2xx answers, and replies without an audio block;
 * the message carries what Google said so the user can act on it (wrong
 * key, unknown model, quota).
 */
export async function synthesizeGeminiPcm(request: GeminiTtsRequest): Promise<PcmAudio> {
  const fetchImpl = request.fetchImpl ?? fetch
  const url = `${normalizeBaseUrl(request.baseUrl ?? GEMINI_TTS_DEFAULT_BASE_URL)}/interactions`

  const body = {
    model: request.model,
    input: request.text,
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: request.voice }] },
    store: false,
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': request.apiKey,
        'Content-Type': 'application/json',
        'Api-Revision': GEMINI_TTS_API_REVISION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(request.timeoutMs ?? GEMINI_TTS_DEFAULT_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(`Gemini TTS request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    let detail = errText.slice(0, 500)
    try {
      const parsed = JSON.parse(errText) as GeminiInteractionResponse
      if (parsed.error?.message) detail = parsed.error.message
    } catch {
      // not JSON, keep the raw excerpt
    }
    throw new Error(`Gemini TTS returned HTTP ${response.status}: ${detail}`)
  }

  let payload: GeminiInteractionResponse
  try {
    payload = await response.json() as GeminiInteractionResponse
  } catch (err) {
    throw new Error(`Gemini TTS returned an unreadable body: ${(err as Error).message}`)
  }

  if (payload.status && payload.status !== 'completed') {
    throw new Error(`Gemini TTS interaction ended with status "${payload.status}"`)
  }

  const usage = readGeminiTtsUsage(payload)
  if (usage) request.onUsage?.(usage)

  const blocks = (payload.steps ?? [])
    .flatMap(step => step.content ?? [])
    .filter(content => content.type === 'audio' && typeof content.data === 'string' && content.data.length > 0)
  if (blocks.length === 0) {
    throw new Error('Gemini TTS returned no audio block.')
  }

  const decoded = blocks.map(block => decodeGeminiAudioBlock(block))
  const first = decoded[0]!
  if (first.channels !== 1 && first.channels !== 2) {
    throw new Error(`Gemini TTS returned ${first.channels} channels; expected mono or stereo.`)
  }
  const mismatch = decoded.find(part => part.sampleRate !== first.sampleRate || part.channels !== first.channels)
  if (mismatch) {
    throw new Error(`Gemini TTS mixed audio formats in one reply (${first.sampleRate} Hz/${first.channels}ch vs ${mismatch.sampleRate} Hz/${mismatch.channels}ch).`)
  }

  const total = decoded.reduce((sum, part) => sum + part.samples.length, 0)
  const samples = new Int16Array(total)
  let offset = 0
  for (const part of decoded) {
    samples.set(part.samples, offset)
    offset += part.samples.length
  }

  return { samples, sampleRate: first.sampleRate, channels: first.channels as 1 | 2 }
}
