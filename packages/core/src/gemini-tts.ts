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
 *              content: [{ type: 'audio', data: <base64 PCM16 LE>,
 *                          mime_type: 'audio/l16; rate=24000; channels=1',
 *                          sample_rate?, channels? }] }] }
 *
 * `store: false` is not optional for us: the Interactions API keeps stored
 * interactions for up to 55 days by default, and what we read aloud is the
 * user's private chat content.
 *
 * Gemini only ever returns raw PCM; the container step (Ogg/Opus, WAV) lives
 * in `ogg-opus.ts` and the dispatcher in `tts.ts`.
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

  const blocks = (payload.steps ?? [])
    .flatMap(step => step.content ?? [])
    .filter(content => content.type === 'audio' && typeof content.data === 'string' && content.data.length > 0)
  if (blocks.length === 0) {
    throw new Error('Gemini TTS returned no audio block.')
  }

  const format = parseGeminiAudioFormat(blocks[0]!)
  if (format.channels !== 1 && format.channels !== 2) {
    throw new Error(`Gemini TTS returned ${format.channels} channels; expected mono or stereo.`)
  }

  const raw = Buffer.concat(blocks.map(block => Buffer.from(block.data!, 'base64')))
  // PCM16 LE: two bytes per sample. Drop a dangling byte rather than mis-align.
  const usable = raw.length - (raw.length % 2)
  const samples = new Int16Array(usable / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = raw.readInt16LE(i * 2)

  return { samples, sampleRate: format.sampleRate, channels: format.channels }
}
