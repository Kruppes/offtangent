import { Router } from 'express'
import { pipeline } from 'node:stream/promises'
import {
  formatFromAccept,
  getApiKeyForProvider,
  loadProviders,
  loadProvidersDecrypted,
  loadTtsSettings,
  shouldStreamTts,
  synthesizeTts,
  synthesizeTtsStream,
  TtsFormatError,
  TTS_PROVIDER_FORMATS,
  PCM_MIN_SAMPLE_RATE,
  PCM_MAX_SAMPLE_RATE,
} from '@axiom/core'
import {
  SETTINGS_TTS_RESPONSE_FORMATS,
  SETTINGS_TTS_PROVIDERS,
  SETTINGS_TTS_OPENAI_MODELS,
  SETTINGS_TTS_OPENAI_VOICES,
  SETTINGS_TTS_GEMINI_MODELS,
  SETTINGS_TTS_GEMINI_VOICES,
  DEFAULT_TTS_GEMINI_MODEL,
  DEFAULT_TTS_GEMINI_VOICE,
} from '@axiom/core/contracts'
import type { TtsResponseFormat, TtsProvider } from '@axiom/core/contracts'
import type { TtsSettings } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

interface TtsRequestBody {
  text: string
  voice?: string
  format?: unknown
  sampleRate?: unknown
}

// The `Accept` parsing lives in core next to the format table, so the puck
// route, the app route and the synthesizer cannot drift apart. Re-exported
// here because this module is where callers used to find it.
export { formatFromAccept }

type FormatParse =
  | { ok: true; format?: TtsResponseFormat; sampleRate?: number }
  | { ok: false; error: string }

/**
 * The settings fields a preview may lay over the stored ones. Whitelisted
 * on purpose: `deepgramApiKey` never travels from a client into a
 * synthesis call, and an unknown key is a typo the caller should learn about.
 */
const PREVIEW_STRING_FIELDS = [
  'providerId', 'openaiModel', 'openaiVoice', 'openaiInstructions', 'mistralVoice',
  'deepgramModel', 'geminiModel', 'geminiVoice', 'geminiStyle',
] as const satisfies ReadonlyArray<keyof TtsSettings>

type PreviewSettingsParse =
  | { ok: true; settings: Partial<TtsSettings> | undefined }
  | { ok: false; error: string }

/**
 * Validate the `settings` block of `POST /api/tts/preview`. Returns the
 * override to hand to the synthesizer, or a 400 message. `enabled` is always
 * forced on: a preview exists so the user can hear a voice BEFORE switching
 * the feature on, so the stored `enabled: false` must not block it.
 */
export function parsePreviewSettings(raw: unknown): PreviewSettingsParse {
  if (raw === undefined || raw === null) return { ok: true, settings: undefined }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'settings must be an object' }
  }
  const input = raw as Record<string, unknown>
  const settings: Partial<TtsSettings> = {}

  if (input.provider !== undefined) {
    if (typeof input.provider !== 'string'
      || !(SETTINGS_TTS_PROVIDERS as readonly string[]).includes(input.provider)) {
      return { ok: false, error: `settings.provider must be one of: ${SETTINGS_TTS_PROVIDERS.join(', ')}` }
    }
    settings.provider = input.provider as TtsProvider
  }
  if (input.responseFormat !== undefined) {
    if (typeof input.responseFormat !== 'string'
      || !(SETTINGS_TTS_RESPONSE_FORMATS as readonly string[]).includes(input.responseFormat)) {
      return { ok: false, error: `settings.responseFormat must be one of: ${SETTINGS_TTS_RESPONSE_FORMATS.join(', ')}` }
    }
    settings.responseFormat = input.responseFormat as TtsResponseFormat
  }
  for (const field of PREVIEW_STRING_FIELDS) {
    const value = input[field]
    if (value === undefined) continue
    if (typeof value !== 'string') return { ok: false, error: `settings.${field} must be a string` }
    settings[field] = value
  }
  // An empty block (a client that always sends `settings: {}`) is no override,
  // so a non-admin must not run into the 403 for it.
  if (Object.keys(settings).length === 0) return { ok: true, settings: undefined }
  return { ok: true, settings: { ...settings, enabled: true } }
}

/** Provider-config types that can back a TTS provider. */
const ACCOUNT_TYPE_TO_TTS: Record<string, TtsProvider> = {
  openai: 'openai',
  // A self-hosted endpoint that speaks the OpenAI speech API is a valid TTS
  // account, so it has to be selectable in the settings UI.
  'openai-compatible': 'openai',
  mistral: 'mistral',
  deepgram: 'deepgram',
  google: 'gemini',
}

/**
 * Validate the per-request audio options of `POST /api/tts`. The body wins
 * over `Accept`; an unparseable value is a 400, never a silent fallback — a
 * client that cannot play what it gets back is worse off than one that gets
 * an error it can read.
 */
export function parseTtsAudioOptions(body: TtsRequestBody, acceptHeader?: string | null): FormatParse {
  const parsed: { ok: true; format?: TtsResponseFormat; sampleRate?: number } = { ok: true }

  if (body.format !== undefined && body.format !== null) {
    if (typeof body.format !== 'string'
      || !(SETTINGS_TTS_RESPONSE_FORMATS as readonly string[]).includes(body.format)) {
      return { ok: false, error: `format must be one of: ${SETTINGS_TTS_RESPONSE_FORMATS.join(', ')}` }
    }
    parsed.format = body.format as TtsResponseFormat
  } else {
    const fromAccept = formatFromAccept(acceptHeader)
    if (fromAccept) parsed.format = fromAccept
  }

  if (body.sampleRate !== undefined && body.sampleRate !== null) {
    const rate = typeof body.sampleRate === 'string' ? Number(body.sampleRate) : body.sampleRate
    if (typeof rate !== 'number' || !Number.isInteger(rate)
      || rate < PCM_MIN_SAMPLE_RATE || rate > PCM_MAX_SAMPLE_RATE) {
      return {
        ok: false,
        error: `sampleRate must be an integer between ${PCM_MIN_SAMPLE_RATE} and ${PCM_MAX_SAMPLE_RATE}`,
      }
    }
    parsed.sampleRate = rate
  }

  return parsed
}

/**
 * Strip markdown so the synthesized speech doesn't read out backticks,
 * asterisks, list markers, etc. Kept here (not in core) because it's purely
 * a UX concern for the web/Telegram callers — the core synthesizer takes
 * the text it's given.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function createTtsRouter(): Router {
  const router = Router()
  router.use(jwtMiddleware)

  /**
   * POST /api/tts
   * Generate speech from text using the saved settings.
   * Body: { text: string, voice?: string, format?: TtsResponseFormat, sampleRate?: number }
   *
   * `format` overrides the saved response format for this call; without it an
   * `Accept` header naming a concrete audio type decides; without that the
   * saved setting stands. `sampleRate` only applies to WAV from a PCM
   * provider (Gemini, Deepgram) and is reported back in `X-Tts-Sample-Rate`
   * when it was actually applied.
   */
  router.post('/', async (req: AuthenticatedRequest, res) => {
    const ttsSettings = loadTtsSettings()
    if (!ttsSettings.enabled) {
      res.status(403).json({ error: 'TTS is not enabled. Enable it in Settings → Text-to-Speech.' })
      return
    }

    const body = req.body as TtsRequestBody
    if (!body.text || typeof body.text !== 'string') {
      res.status(400).json({ error: 'text is required' })
      return
    }

    const cleanText = stripMarkdown(body.text)
    if (!cleanText) {
      res.status(400).json({ error: 'text is empty after stripping markdown' })
      return
    }

    // Character limit to prevent abuse (100K chars ≈ $1.50)
    if (cleanText.length > 100_000) {
      res.status(400).json({ error: 'text exceeds maximum length of 100,000 characters' })
      return
    }

    const audioOptions = parseTtsAudioOptions(body, req.get('accept'))
    if (!audioOptions.ok) {
      res.status(400).json({ error: audioOptions.error })
      return
    }

    const wantedFormat = audioOptions.format ?? ttsSettings.responseFormat
    try {
      // Streaming path: headers go out before the first sample exists, and
      // every chunk the endpoint produces leaves immediately. That is the
      // whole point for a device that starts playing on chunk one.
      if (shouldStreamTts(ttsSettings.provider, wantedFormat)) {
        const stream = await synthesizeTtsStream(cleanText, {
          voice: body.voice,
          format: audioOptions.format,
          sampleRate: audioOptions.sampleRate,
        })
        if (stream) {
          res.setHeader('Content-Type', stream.contentType)
          res.setHeader('Content-Disposition', `inline; filename="speech.${stream.extension}"`)
          if (stream.sampleRate) res.setHeader('X-Tts-Sample-Rate', String(stream.sampleRate))
          res.setHeader('X-Tts-Source', stream.source)
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader(
            'Access-Control-Expose-Headers',
            'Content-Disposition, X-Tts-Sample-Rate, X-Tts-Source',
          )
          res.flushHeaders()
          await pipeline(stream.stream, res)
          return
        }
      }

      const result = await synthesizeTts(cleanText, {
        voice: body.voice,
        format: audioOptions.format,
        sampleRate: audioOptions.sampleRate,
      })
      res.setHeader('Content-Type', result.contentType)
      res.setHeader('Content-Length', result.audio.length)
      res.setHeader('Content-Disposition', `inline; filename="speech.${result.extension}"`)
      if (result.sampleRate) res.setHeader('X-Tts-Sample-Rate', String(result.sampleRate))
      if (result.source) res.setHeader('X-Tts-Source', result.source)
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Tts-Sample-Rate, X-Tts-Source')
      res.send(result.audio)
    } catch (err) {
      if (res.headersSent) {
        // A stream that dies after the headers cannot become a JSON error.
        // Tearing the connection down is the only honest signal left.
        console.warn(`[tts] stream aborted after headers: ${(err as Error).message}`)
        res.destroy()
        return
      }
      if (err instanceof TtsFormatError) {
        res.status(400).json({ error: err.message })
        return
      }
      res.status(500).json({ error: `TTS generation failed: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/tts/preview
   * Preview TTS so the user can test before saving. Works even when TTS is
   * globally disabled.
   *
   * Body: { text: string, voice?: string, format?: TtsResponseFormat,
   *         sampleRate?: number, settings?: Partial<TtsSettings> }
   *
   * `settings` is the unsaved form laid over the stored settings for this one
   * call (admin only, because the stored settings are admin only too; a
   * non-admin sending it gets 403, not a silent ignore). `format`/`Accept`
   * work exactly like on `POST /api/tts` so a browser that cannot decode the
   * saved container can still hear the voice.
   */
  router.post('/preview', async (req: AuthenticatedRequest, res) => {
    const body = req.body as TtsRequestBody & { settings?: unknown }

    if (!body.text || typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json({ error: 'text is required' })
      return
    }

    const cleanText = stripMarkdown(body.text).slice(0, 1000) // 1K-char preview cap
    if (!cleanText) {
      res.status(400).json({ error: 'text is empty' })
      return
    }

    const overrides = parsePreviewSettings(body.settings)
    if (!overrides.ok) {
      res.status(400).json({ error: overrides.error })
      return
    }
    if (overrides.settings && req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required to preview unsaved TTS settings' })
      return
    }

    const audioOptions = parseTtsAudioOptions(body, req.get('accept'))
    if (!audioOptions.ok) {
      res.status(400).json({ error: audioOptions.error })
      return
    }

    try {
      const result = await synthesizeTts(cleanText, {
        voice: body.voice,
        format: audioOptions.format,
        sampleRate: audioOptions.sampleRate,
        // Without a form to lay over, the preview still has to play while the
        // feature is switched off (that is the point of a preview).
        settings: overrides.settings ?? { enabled: true },
      })
      res.setHeader('Content-Type', result.contentType)
      res.setHeader('Content-Length', result.audio.length)
      res.setHeader('Content-Disposition', `inline; filename="preview.${result.extension}"`)
      if (result.sampleRate) res.setHeader('X-Tts-Sample-Rate', String(result.sampleRate))
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Tts-Sample-Rate')
      res.send(result.audio)
    } catch (err) {
      if (err instanceof TtsFormatError) {
        res.status(400).json({ error: err.message })
        return
      }
      res.status(500).json({ error: `TTS preview failed: ${(err as Error).message}` })
    }
  })

  /**
   * GET /api/tts/catalog
   * Everything a client needs to render the TTS settings form without
   * hardcoding the lists: providers, formats per provider, static model and
   * voice catalogs, and the configured provider accounts that can back a TTS
   * provider (id/name/type only, never a key). Deepgram and Mistral voices
   * stay dynamic (`/api/deepgram/models`, `/api/tts/voices`).
   */
  router.get('/catalog', (req: AuthenticatedRequest, res) => {
    // Provider accounts are admin territory (`/api/providers` is admin only),
    // so a normal user gets the static lists and an empty account list. The
    // keys stay encrypted: this route never needs them.
    let accounts: Array<{ id: string; name: string; providerType: string; ttsProvider: TtsProvider }> = []
    try {
      const file = req.user?.role === 'admin' ? loadProviders() : { providers: [] }
      accounts = file.providers.flatMap((p) => {
        const ttsProvider = ACCOUNT_TYPE_TO_TTS[p.providerType ?? ''] ?? ACCOUNT_TYPE_TO_TTS[p.provider ?? '']
        return ttsProvider
          ? [{ id: p.id, name: p.name, providerType: p.providerType ?? p.provider ?? '', ttsProvider }]
          : []
      })
    } catch {
      accounts = []
    }
    res.json({
      providers: SETTINGS_TTS_PROVIDERS,
      formats: SETTINGS_TTS_RESPONSE_FORMATS,
      formatsByProvider: Object.fromEntries(
        SETTINGS_TTS_PROVIDERS.map(p => [p, [...TTS_PROVIDER_FORMATS[p]]]),
      ),
      openai: {
        models: SETTINGS_TTS_OPENAI_MODELS,
        voices: SETTINGS_TTS_OPENAI_VOICES,
      },
      gemini: {
        models: SETTINGS_TTS_GEMINI_MODELS,
        voices: SETTINGS_TTS_GEMINI_VOICES,
        defaultModel: DEFAULT_TTS_GEMINI_MODEL,
        defaultVoice: DEFAULT_TTS_GEMINI_VOICE,
      },
      accounts,
    })
  })

  /**
   * GET /api/tts/settings
   * Returns current TTS settings so the frontend can check if TTS is enabled.
   */
  router.get('/settings', (_req: AuthenticatedRequest, res) => {
    const ttsSettings = loadTtsSettings()
    res.json(ttsSettings)
  })

  /**
   * GET /api/tts/voices
   * Fetch available Mistral voices via Mistral's /v1/audio/voices endpoint.
   * Returns an empty list for any other provider (OpenAI/Deepgram have static
   * voice catalogs; the UI lists them inline / fetches them via the Deepgram
   * models endpoint).
   */
  router.get('/voices', async (_req: AuthenticatedRequest, res) => {
    const ttsSettings = loadTtsSettings()
    if (ttsSettings.provider !== 'mistral') {
      res.json({ voices: [] })
      return
    }

    try {
      const file = loadProvidersDecrypted()
      const provider
        = (ttsSettings.providerId && file.providers.find(p => p.id === ttsSettings.providerId))
        || file.providers.find(p => p.providerType === 'mistral' || p.provider === 'mistral')
        || file.providers.find(p => p.baseUrl?.includes('api.mistral.ai'))
      if (!provider) {
        res.json({ voices: [] })
        return
      }

      const apiKey = await getApiKeyForProvider(provider)
      const baseUrl = (provider.baseUrl || 'https://api.mistral.ai')
        .replace(/\/+$/, '')
        .replace(/\/v1$/, '')
      const url = `${baseUrl}/v1/audio/voices?limit=100`

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!response.ok) {
        res.json({ voices: [] })
        return
      }

      const data = await response.json() as {
        items?: Array<{ id: string; name: string; languages?: string[]; user_id?: string | null }>
      }
      const voices = (data.items ?? []).map(v => ({
        id: v.id,
        name: v.name,
        languages: v.languages ?? [],
        isPreset: !v.user_id || v.user_id === 'preset',
      }))
      res.json({ voices })
    } catch {
      res.json({ voices: [] })
    }
  })

  return router
}
