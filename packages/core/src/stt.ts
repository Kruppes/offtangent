import { loadConfig, ensureConfigTemplates } from './config.js'
import { resolveRoleSpec } from './model-policy.js'
import { loadProvidersDecrypted, getApiKeyForProvider, buildModel, parseProviderModelId, getProviderDefaultModel } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { SttProvider } from './contracts/settings.js'
import { completeSimple } from './pi-models.js'
import { transcribeDeepgram, decryptDeepgramApiKey, DEEPGRAM_DEFAULT_STT_MODEL } from './deepgram.js'

// ── Types ─────────────────────────────────────────────────────────────

export interface SttRewriteSettings {
  enabled: boolean
  providerId: string
}

export interface SttSettings {
  enabled: boolean
  provider: SttProvider
  whisperUrl: string
  providerId: string
  openaiModel: string
  ollamaModel: string
  deepgramModel: string
  deepgramLanguage: string
  rewrite: SttRewriteSettings
}

export interface TranscribeResult {
  transcript: string
  rewritten?: string
}

export interface TranscribeOptions {
  language?: string
  /** Original filename hint (e.g. 'audio.ogg'). Helps APIs detect the format. */
  filename?: string
}

// ── Load settings ─────────────────────────────────────────────────────

export function loadSttSettings(): SttSettings {
  ensureConfigTemplates()
  const settings = loadConfig<Record<string, unknown>>('settings.json')
  const stt = (settings.stt ?? {}) as Partial<SttSettings>
  const rewrite = (stt.rewrite ?? {}) as Partial<SttRewriteSettings>
  return {
    enabled: stt.enabled ?? false,
    provider: stt.provider ?? 'whisper-url',
    whisperUrl: stt.whisperUrl ?? '',
    providerId: stt.providerId ?? '',
    openaiModel: stt.openaiModel ?? 'whisper-1',
    ollamaModel: stt.ollamaModel ?? '',
    deepgramModel: stt.deepgramModel ?? DEEPGRAM_DEFAULT_STT_MODEL,
    deepgramLanguage: stt.deepgramLanguage ?? '',
    rewrite: {
      enabled: rewrite.enabled ?? false,
      // modelPolicy.roles.sttRewrite wins, `stt.rewrite.providerId` is read through.
      providerId: resolveRoleSpec('sttRewrite', rewrite.providerId ?? ''),
    },
  }
}

/**
 * Read the (possibly encrypted) Deepgram API key from `settings.json`. The
 * value is decrypted on read so callers always see plaintext. Returns an
 * empty string when the key is unset.
 *
 * STT and TTS keep separate keys. Canonical storage paths:
 *   - STT: `settings.stt.deepgramApiKey`
 *   - TTS: `settings.tts.deepgramApiKey`
 */
export function loadDeepgramApiKey(scope: 'stt' | 'tts' = 'stt'): string {
  ensureConfigTemplates()
  const settings = loadConfig<Record<string, unknown>>('settings.json')
  const block = (settings[scope] ?? {}) as { deepgramApiKey?: unknown }
  const raw = typeof block.deepgramApiKey === 'string' ? block.deepgramApiKey : ''
  return raw ? decryptDeepgramApiKey(raw) : ''
}

// ── Whisper URL provider ──────────────────────────────────────────────

export async function transcribeWhisperUrl(
  buffer: Buffer,
  url: string,
  language?: string,
  filename?: string,
): Promise<string> {
  const formData = new FormData()
  formData.append('file', new Blob([buffer]), filename ?? 'audio.webm')
  formData.append('response_format', 'text')
  if (language) {
    formData.append('language', language)
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      body: formData,
    })
  } catch (err) {
    throw new Error(`Whisper URL request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error')
    throw new Error(`Whisper URL returned HTTP ${response.status}: ${errorText}`)
  }

  const text = await response.text()
  return text.trim()
}

// ── OpenAI Whisper provider ───────────────────────────────────────────

/**
 * Find the configured provider for STT by providerId.
 */
function findSttProvider(providerId: string): ProviderConfig | null {
  const file = loadProvidersDecrypted()
  return file.providers.find(p => p.id === providerId) ?? null
}

export async function transcribeOpenAi(
  buffer: Buffer,
  providerId: string,
  model: string,
  language?: string,
  filename?: string,
): Promise<string> {
  const provider = findSttProvider(providerId)
  if (!provider) {
    throw new Error(`OpenAI STT provider not found: ${providerId}. Check Settings → Speech-to-Text.`)
  }

  const apiKey = await getApiKeyForProvider(provider)
  const rawBaseUrl = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  // Strip /v1 suffix to avoid double /v1/v1/ path
  const cleanBase = rawBaseUrl.replace(/\/v1$/, '')
  const url = `${cleanBase}/v1/audio/transcriptions`

  const formData = new FormData()
  formData.append('file', new Blob([buffer]), filename ?? 'audio.webm')
  formData.append('model', model)
  formData.append('response_format', 'text')
  if (language) {
    formData.append('language', language)
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    })
  } catch (err) {
    throw new Error(`OpenAI STT request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error')
    throw new Error(`OpenAI STT returned HTTP ${response.status}: ${errorText}`)
  }

  const text = await response.text()
  return text.trim()
}

// ── Ollama provider ───────────────────────────────────────────────────

export async function transcribeOllama(
  buffer: Buffer,
  providerId: string,
  model: string,
  language?: string,
): Promise<string> {
  const provider = findSttProvider(providerId)
  if (!provider) {
    throw new Error(`Ollama STT provider not found: ${providerId}. Check Settings → Speech-to-Text.`)
  }

  // Strip /v1 suffix to get Ollama's native base URL
  const rawBaseUrl = (provider.baseUrl || 'http://localhost:11434').replace(/\/+$/, '')
  const ollamaBase = rawBaseUrl.replace(/\/v1$/, '')
  const url = `${ollamaBase}/api/chat`

  const base64Audio = buffer.toString('base64')
  const effectiveModel = model || 'whisper'

  const prompt = language
    ? `Transcribe this audio. The language is ${language}. Return only the transcribed text, nothing else.`
    : 'Transcribe this audio. Return only the transcribed text, nothing else.'

  const body = {
    model: effectiveModel,
    messages: [
      {
        role: 'user',
        content: prompt,
        images: [base64Audio],
      },
    ],
    stream: false,
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`Ollama STT request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error')
    throw new Error(`Ollama STT returned HTTP ${response.status}: ${errorText}`)
  }

  const data = await response.json() as { message?: { content?: string } }
  const transcript = data?.message?.content
  if (!transcript) {
    throw new Error('Ollama STT returned no transcript content.')
  }

  return transcript.trim()
}

// ── Rewrite ───────────────────────────────────────────────────────────

const REWRITE_SYSTEM_PROMPT = [
  'You are a transcript editor. Clean up the following dictated text.',
  '- Remove filler words (um, uh, like, you know, basically, well, so, etc.)',
  '- Remove false starts and repeated words or phrases',
  '- Fix grammar and punctuation',
  '- Preserve the complete meaning, intent, and tone',
  '- Do NOT add, summarize, or reinterpret the content',
  '- Output ONLY the cleaned text, nothing else',
].join('\n')

export async function rewriteTranscript(
  transcript: string,
  rawProviderId: string,
): Promise<string> {
  const { providerId, modelId } = parseProviderModelId(rawProviderId)
  const provider = findSttProvider(providerId)
  if (!provider) {
    throw new Error(`Rewrite provider not found: ${providerId}. Check Settings → Speech-to-Text.`)
  }

  const apiKey = await getApiKeyForProvider(provider)
  const model = buildModel(provider, modelId ?? getProviderDefaultModel(provider))

  const response = await completeSimple(model, {
    systemPrompt: REWRITE_SYSTEM_PROMPT,
    messages: [
      { role: 'user' as const, content: transcript, timestamp: Date.now() },
    ],
  }, { apiKey })

  const text = response.content
    .filter(c => c.type === 'text')
    .map(c => (c as { type: 'text'; text: string }).text)
    .join('')
    .trim()

  if (!text) {
    throw new Error('Rewrite returned no content.')
  }

  return text
}

// ── Language code resolution ──────────────────────────────────────────

/**
 * Map full language names (as stored in settings.json) to ISO-639-1 codes
 * expected by the Whisper API.
 */
const LANGUAGE_TO_ISO: Record<string, string> = {
  english: 'en',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  russian: 'ru',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
}

/**
 * Resolve a language setting value to a Whisper-compatible ISO-639-1 code.
 * If the value is already a 2-3 letter code, return it as-is.
 * If it's a full name (e.g. "German"), map it to the code (e.g. "de").
 */
function resolveLanguageCode(lang: string | undefined): string | undefined {
  if (!lang) return undefined
  // Already an ISO code (2-3 chars)?
  if (lang.length <= 3) return lang.toLowerCase()
  return LANGUAGE_TO_ISO[lang.toLowerCase()]
}

// ── Dispatcher ────────────────────────────────────────────────────────

export async function transcribeAudio(
  buffer: Buffer,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const settings = loadSttSettings()

  if (!settings.enabled) {
    throw new Error('STT is not enabled. Enable it in Settings → Speech-to-Text.')
  }

  // Resolve full language names (e.g. "German") to ISO codes (e.g. "de")
  const language = resolveLanguageCode(options.language)

  let transcript: string
  switch (settings.provider) {
    case 'whisper-url': {
      if (!settings.whisperUrl) {
        throw new Error('Whisper URL is not configured. Set it in Settings → Speech-to-Text.')
      }
      transcript = await transcribeWhisperUrl(buffer, settings.whisperUrl, language, options.filename)
      break
    }
    case 'openai': {
      if (!settings.providerId) {
        throw new Error('OpenAI STT provider is not configured. Select a provider in Settings → Speech-to-Text.')
      }
      transcript = await transcribeOpenAi(buffer, settings.providerId, settings.openaiModel, language, options.filename)
      break
    }
    case 'ollama': {
      if (!settings.providerId) {
        throw new Error('Ollama STT provider is not configured. Select a provider in Settings → Speech-to-Text.')
      }
      transcript = await transcribeOllama(buffer, settings.providerId, settings.ollamaModel, language)
      break
    }
    case 'deepgram': {
      const apiKey = loadDeepgramApiKey()
      if (!apiKey) {
        throw new Error('Deepgram API key is not configured. Set it in Settings → Speech-to-Text.')
      }
      // Per-STT language override wins over the global agent language so
      // multilingual setups (Telegram in DE, agent in EN) keep working.
      const deepgramLanguage = settings.deepgramLanguage || language
      transcript = await transcribeDeepgram(buffer, apiKey, {
        model: settings.deepgramModel,
        language: deepgramLanguage,
      })
      break
    }
    default:
      throw new Error(`Unknown STT provider: ${settings.provider}`)
  }

  // Optional LLM-based rewriting
  if (settings.rewrite.enabled && settings.rewrite.providerId) {
    try {
      const rewritten = await rewriteTranscript(transcript, settings.rewrite.providerId)
      return { transcript, rewritten }
    } catch (err) {
      // Rewrite failure is non-fatal — return raw transcript
      console.warn(`[stt] Rewrite failed, returning raw transcript: ${(err as Error).message}`)
      return { transcript }
    }
  }

  return { transcript }
}
