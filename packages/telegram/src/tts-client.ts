/**
 * TTS Client — calls an external TTS service to generate OGG Opus audio.
 *
 * Usage:
 *   const client = new TtsClient('http://<tts-host>:7400')
 *   const ogg = await client.synthesize('Hallo Welt')
 *   // ogg is a Buffer containing OGG Opus audio
 */

export interface TtsClientOptions {
  /** Base URL of the TTS service */
  baseUrl: string
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number
  /** Voice name (default: Ethan) */
  voice?: string
  /** Language (default: German) */
  lang?: string
}

export interface TtsSynthResult {
  /** OGG Opus audio buffer */
  audio: Buffer
  /** Generation time in seconds (from X-TTS-Generation-Time header) */
  generationTime?: number
  /** Total time in seconds (from X-TTS-Total-Time header) */
  totalTime?: number
  /** Audio duration in seconds (from X-TTS-Audio-Duration header) */
  audioDuration?: number
}

export class TtsClient {
  private baseUrl: string
  private timeoutMs: number
  private voice: string
  private lang: string

  constructor(options: TtsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 30000
    this.voice = options.voice ?? 'Ethan'
    this.lang = options.lang ?? 'German'
  }

  /**
   * Check if the TTS service is reachable and model is loaded.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) return false
      const data = (await response.json()) as { status?: string; model_loaded?: boolean }
      return data.status === 'ok' && data.model_loaded === true
    } catch {
      return false
    }
  }

  /**
   * Synthesize text to OGG Opus audio.
   *
   * @throws Error if TTS service is unreachable, returns an error, or times out
   */
  async synthesize(text: string, voice?: string): Promise<TtsSynthResult> {
    const body = JSON.stringify({
      text,
      voice: voice ?? this.voice,
      lang: this.lang,
    })

    const response = await fetch(`${this.baseUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      let errorDetail: string
      try {
        const errData = (await response.json()) as { detail?: string }
        errorDetail = errData.detail ?? `HTTP ${response.status}`
      } catch {
        errorDetail = `HTTP ${response.status}`
      }
      throw new Error(`TTS service error: ${errorDetail}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const audio = Buffer.from(arrayBuffer)

    return {
      audio,
      generationTime: parseFloat(response.headers.get('X-TTS-Generation-Time') ?? '') || undefined,
      totalTime: parseFloat(response.headers.get('X-TTS-Total-Time') ?? '') || undefined,
      audioDuration: parseFloat(response.headers.get('X-TTS-Audio-Duration') ?? '') || undefined,
    }
  }
}
