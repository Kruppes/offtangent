/**
 * voice-note.ts: the spoken version of one finished assistant answer.
 *
 * A voice note is NOT the read-aloud feature. Read aloud speaks whatever
 * `settings.tts` points at and streams the bytes to the caller; a voice note
 * is a small audio file that is stored as an upload and hangs on the message
 * itself (`chat_messages.metadata.voiceNote`), so it survives a reload and can
 * be played like any other attachment.
 *
 * The route is CONFIGURABLE (`settings.tts.voiceNote`) and inherits every
 * unset field from the read-aloud configuration — see `voice-note-config.ts`.
 * Synthesis goes through the read-aloud dispatcher (`tts.ts`), so every
 * provider adapter and every credential lookup exists exactly once.
 *
 * Pipeline, in one place:
 *
 *   1. {@link buildVoiceNoteScript} turns the written answer into spoken text.
 *      With `rewrite: true` (default) that is the summary pipeline in voice
 *      message style; with `rewrite: false` it is the deterministic cleanup
 *      (strip markdown, drop code/tables/urls, cap at a sentence boundary)
 *      and costs no model call at all.
 *   2. {@link synthesizeVoiceNoteAudio} speaks it over the effective route:
 *      chunks at paragraph/sentence boundaries, synthesized in parallel,
 *      joined with a short pause and a small fade at every chunk edge so no
 *      join clicks.
 *   3. WAV (what we ask every provider for) is encoded to Ogg/Opus
 *      (`ogg-opus.ts`); a provider that can only deliver another container
 *      keeps it, and the note carries that `mimeType`. The bytes are stored as
 *      an ordinary upload (`uploads.ts`) and served by `/api/uploads`.
 *
 * {@link speakVoiceNote} is the deterministic entry point of the
 * `send_voice_message` tool: it speaks EXACTLY the text it is given, never
 * rewrites, and refuses a text over the configured cap.
 */

import { decodeWavToPcm, encodeOggOpus, normalizePcm, type PcmAudio } from './ogg-opus.js'
import type { GeminiTtsUsage } from './gemini-tts.js'
import { SpeechSummaryEmptyError, summarizeForSpeech, type SpeechSummaryResult } from './speech-summary.js'
import {
  cleanSpokenText,
  limitSpokenSentencesDetailed,
  sanitizeSpeechSource,
  detectSpeechLanguage,
} from './speech-text.js'
import { chunkTextForTts, loadTtsSettings, synthesizeTts } from './tts.js'
import type { TtsSettings } from './tts.js'
import {
  VOICE_NOTE_DEFAULT_MAX_CHARS,
  resolveVoiceNoteConfig,
  ttsSettingsForVoiceNote,
  type EffectiveVoiceNoteConfig,
} from './voice-note-config.js'
import type { TtsResponseFormat } from './contracts/settings.js'
import { saveUpload, type UploadDescriptor } from './uploads.js'
import { getVoiceRepliesEnabled } from './user-settings.js'
import type { Database } from './database.js'
import type { SpeechLanguage } from './speech-text.js'

/**
 * `audio/ogg` is what the app plays for every other voice attachment, and what
 * the encoder produces. Only a provider that cannot deliver WAV makes a note
 * carry a different type.
 */
export const VOICE_NOTE_MIME_TYPE = 'audio/ogg'

/**
 * Default character cap, used when `tts.voiceNote.maxChars` is unset. Lives in
 * `voice-note-config.ts`; re-exported here because this is where callers of
 * the pipeline look for it.
 */
export const VOICE_NOTE_MAX_CHARS = VOICE_NOTE_DEFAULT_MAX_CHARS
/**
 * Sentence cap for the rewritten text. The read-aloud summary allows 6; a
 * voice note may tell a longer story, and the character budget above is the
 * real limit. The prompt asks for short sentences, so this sits well above
 * what the budget can hold (1300 characters are ~20 sentences of 65) — at 20
 * the sentence cap cut notes the character budget would have kept.
 */
export const VOICE_NOTE_MAX_SENTENCES = 40
/** Measured speaking rate of the voice-note voice (26.09.2026: 1254 chars in 72 s). */
export const VOICE_NOTE_CHARS_PER_SECOND = 17
/** Cleaned answers up to this length are spoken as they stand. */
export const VOICE_NOTE_DIRECT_MAX_CHARS = VOICE_NOTE_MAX_CHARS
/** Per-request text size; longer inputs drift in pacing (same value as the read-aloud path). */
export const VOICE_NOTE_CHUNK_CHARS = 1500
/** Silence between two synthesized chunks, in seconds. */
export const VOICE_NOTE_PAUSE_SECONDS = 0.35
/** Fade at both ends of every chunk, in seconds. Removes the edge click. */
export const VOICE_NOTE_FADE_SECONDS = 0.012

/** Whether the spoken text is the answer itself or a summary of it. */
export type VoiceNoteVariant = 'full' | 'summary'

/** The contract object the app renders and plays. */
export interface VoiceNote {
  /** `urlPath` of the stored upload, exactly like any other attachment. */
  url: string
  mimeType: string
  /** Duration of the audio in seconds, one decimal. */
  seconds: number
  /** Length of the spoken text. */
  spokenChars: number
  /** Length of the written answer this was made from. */
  sourceChars: number
  model: string
  voice: string
  /** ISO-8601 UTC. */
  createdAt: string
  /**
   * 'full' when the answer was spoken as-is (no summary model ran);
   * 'summary' when the text was rewritten by a model before synthesis.
   * Absent on notes created before this field was added.
   */
  variant?: VoiceNoteVariant
}

/** No Gemini provider/key on this instance — the caller answers 503. */
export class VoiceNoteUnconfiguredError extends Error {
  constructor(message = 'No Gemini provider with an API key is configured') {
    super(message)
    this.name = 'VoiceNoteUnconfiguredError'
  }
}

/** The voice failed, timed out or answered without audio — the caller answers 502. */
export class VoiceNoteUpstreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoiceNoteUpstreamError'
  }
}

/**
 * The style rules for a voice note. Deliberately different from the read-aloud
 * summary prompt: that one compresses to a headline ("all gates green"), this
 * one keeps the answer, only spoken.
 */
export function buildVoiceNotePrompt(language: SpeechLanguage, maxChars: number = VOICE_NOTE_MAX_CHARS): string {
  const target = language === 'de' ? 'German' : 'English'
  // Aim clearly under the cap: models miscount characters, and every
  // character over the cap costs a shortening round or, failing that, the end
  // of the content.
  const aim = Math.floor(maxChars * 0.75)
  const seconds = Math.max(10, Math.round(aim / VOICE_NOTE_CHARS_PER_SECOND / 5) * 5)
  return [
    'You rewrite a written assistant message as a VOICE MESSAGE that will be spoken by a',
    'text to speech voice and listened to on a phone.',
    '',
    `Answer in ${target}. That is the language of the source message; never switch languages.`,
    '',
    'Rules:',
    '- Short, plain sentences. Speak the way a person leaves a voice message.',
    `- Aim for about ${aim} characters, around ${seconds} seconds. Shorter is fine.`,
    `  ${maxChars} characters is a hard limit: anything beyond it is cut off mid content.`,
    '- Cover the whole message down to its last point. When it does not fit, leave out minor',
    '  details and merge points instead of stopping early.',
    '- Never announce a list or a number of points ("four things are needed") you do not then name.',
    '- No markdown, no headings, no bullet points, no asterisks, no backticks, no tables,',
    '  no code, no urls, no file paths, no commit hashes, no emoji.',
    '- Numbers, units and abbreviations spelled the way they are said out loud.',
    '- Say the outcome first, then the details that matter, then what happens next.',
    '- Condense lists and tables into statements instead of reading out columns.',
    '- Add nothing that is not in the source, and do not mention that this is a voice message.',
    '',
    'Answer with the spoken text and nothing else.',
  ].join('\n')
}

export interface VoiceNoteScriptOptions {
  /** Test seam / policy override, handed to the summary pipeline. */
  summarize?: typeof summarizeForSpeech
  /** The effective route. Defaults to the configuration of this instance. */
  config?: EffectiveVoiceNoteConfig
}

/**
 * The deterministic script: no model, no network, no cost.
 *
 * Strips markdown, drops code blocks, tables, urls and paths (the same rules
 * the rewrite path applies to its input and its output) and cuts at a sentence
 * boundary once the cap is reached. Used when `tts.voiceNote.rewrite` is off
 * and always by {@link speakVoiceNote}.
 */
export function buildDeterministicVoiceNoteScript(raw: string, maxChars: number): SpeechSummaryResult {
  const sourceChars = typeof raw === 'string' ? raw.length : 0
  const cleaned = cleanSpokenText(sanitizeSpeechSource(raw))
  const limited = limitSpokenSentencesDetailed(cleaned, VOICE_NOTE_MAX_SENTENCES, maxChars)
  const text = limited.text
  if (limited.cut) {
    // No model to ask for a shorter version on this path: the cut is the
    // configured behavior, but the listener still misses the end. Say so.
    console.warn(
      `[voice-note] deterministic script cut to fit: ${limited.charsIn} -> ${text.length} chars, `
      + `${limited.sentencesIn} -> ${limited.sentencesOut} sentences (limit ${maxChars}/${VOICE_NOTE_MAX_SENTENCES})`,
    )
  }
  return {
    text,
    language: detectSpeechLanguage(text || cleaned),
    sourceChars,
    summaryChars: text.length,
    passthrough: true,
    // Never a provider:model pair — this path talks to nobody.
    model: 'deterministic',
    rounds: 0,
    trimmed: limited.cut,
  }
}

/**
 * Turn one written answer into spoken text.
 *
 * With `rewrite` on this is the summary pipeline in voice-message style and
 * throws exactly what it throws (`SpeechSummaryEmptyError` → 400,
 * `SpeechSummaryUpstreamError` → 502), so the route keeps one error contract.
 * With `rewrite` off it is {@link buildDeterministicVoiceNoteScript} and makes
 * zero model calls.
 */
export async function buildVoiceNoteScript(
  raw: string,
  options: VoiceNoteScriptOptions = {},
): Promise<SpeechSummaryResult> {
  const config = options.config ?? loadVoiceNoteConfig()
  if (!config.rewrite) {
    const script = buildDeterministicVoiceNoteScript(raw, config.maxChars)
    if (!script.text) throw new SpeechSummaryEmptyError()
    return script
  }
  const summarize = options.summarize ?? summarizeForSpeech
  return summarize(raw, {
    systemPrompt: language => buildVoiceNotePrompt(language, config.maxChars),
    directMaxChars: config.maxChars,
    maxSentences: VOICE_NOTE_MAX_SENTENCES,
    maxChars: config.maxChars,
  })
}

/**
 * One synthesis call over the effective route. Test seam; the default goes
 * through the read-aloud dispatcher, so every provider adapter and every key
 * lookup exists exactly once.
 */
export type VoiceNoteSynthesizer = (input: {
  text: string
  config: EffectiveVoiceNoteConfig
  format: TtsResponseFormat
}) => Promise<{ audio: Buffer; contentType: string; usage?: GeminiTtsUsage | null }>

export interface VoiceNoteAudioOptions {
  /** Test seam: one synthesis call. */
  synthesize?: VoiceNoteSynthesizer
  /** The effective route. Defaults to the configuration of this instance. */
  config?: EffectiveVoiceNoteConfig
}

export interface VoiceNoteAudio {
  audio: Buffer
  /** What the bytes are; `audio/ogg` unless a provider forced its own container. */
  mimeType: string
  seconds: number
  /** How many synthesis calls the text needed. */
  chunks: number
  /** Provider-reported token counts, or null when the reply carried none. */
  usage: GeminiTtsUsage | null
}

/** Linear fade in/out over `count` samples, in place. Kills the edge click. */
function fadeEdges(samples: Int16Array, count: number): void {
  const n = Math.min(count, Math.floor(samples.length / 2))
  for (let i = 0; i < n; i++) {
    const gain = i / n
    samples[i] = Math.round(samples[i]! * gain)
    samples[samples.length - 1 - i] = Math.round(samples[samples.length - 1 - i]! * gain)
  }
}

/** Read the effective voice-note route of this instance. */
export function loadVoiceNoteConfig(readAloud: TtsSettings = loadTtsSettings()): EffectiveVoiceNoteConfig {
  return resolveVoiceNoteConfig(readAloud)
}

/**
 * A provider that is missing, disabled or has no key is a configuration
 * problem (503); everything else is an outage of the voice (502). The
 * dispatcher reports both as plain `Error`, so the message decides.
 */
const UNCONFIGURED_MESSAGE = /not configured|no api key|api key|not enabled|disabled|no .*provider/i

function classifySynthesisError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (UNCONFIGURED_MESSAGE.test(message)) return new VoiceNoteUnconfiguredError(message)
  return new VoiceNoteUpstreamError(message)
}

/** MIME type for a container the provider delivered instead of WAV. */
function mimeTypeForFormat(format: TtsResponseFormat, contentType: string): string {
  const reported = contentType.split(';')[0]?.trim().toLowerCase()
  if (reported && reported !== 'application/octet-stream') return reported
  const known: Record<string, string> = {
    mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac',
    flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/L16',
  }
  return known[format] ?? 'application/octet-stream'
}

/**
 * Speak `text` over the effective route and return playable bytes.
 *
 * Chunks are synthesized in parallel (the text is already short, and a voice
 * note that takes 40 seconds to appear is useless), then joined in order with
 * {@link VOICE_NOTE_PAUSE_SECONDS} of silence between them. That joining needs
 * samples, so WAV is what we ask for wherever a provider supports it. A
 * provider that can only deliver a compressed container is spoken in ONE call
 * and its bytes are stored as they are, with the matching `mimeType`.
 *
 * @throws VoiceNoteUnconfiguredError  provider/key missing (-> 503)
 * @throws VoiceNoteUpstreamError      the voice failed (-> 502)
 */
export async function synthesizeVoiceNoteAudio(
  text: string,
  options: VoiceNoteAudioOptions = {},
): Promise<VoiceNoteAudio> {
  const trimmed = text.trim()
  if (!trimmed) throw new VoiceNoteUpstreamError('Nothing to speak')

  const config = options.config ?? loadVoiceNoteConfig()
  const synthesize = options.synthesize ?? defaultVoiceNoteSynthesizer
  const format = config.format

  if (format !== 'wav') {
    // No sample access: one call, bytes as they come.
    let result: Awaited<ReturnType<VoiceNoteSynthesizer>>
    try {
      result = await synthesize({ text: trimmed, config, format })
    } catch (err) {
      throw classifySynthesisError(err)
    }
    if (!result.audio?.length) throw new VoiceNoteUpstreamError('The voice returned no audio')
    return {
      audio: result.audio,
      mimeType: mimeTypeForFormat(format, result.contentType),
      // Without samples the duration can only be estimated from the text
      // (~14 spoken characters per second).
      seconds: Math.round((trimmed.length / 14) * 10) / 10,
      chunks: 1,
      usage: result.usage ?? null,
    }
  }

  const chunks = chunkTextForTts(trimmed, VOICE_NOTE_CHUNK_CHARS)
  // Provider-reported token counts, summed over the chunks. Stays null when
  // the reply carries no usage block, and the caller falls back to an estimate.
  let usage: GeminiTtsUsage | null = null
  const collectUsage = (part: GeminiTtsUsage): void => {
    usage = usage
      ? {
        promptTokens: usage.promptTokens + part.promptTokens,
        completionTokens: usage.completionTokens + part.completionTokens,
      }
      : { ...part }
  }
  let parts: PcmAudio[]
  try {
    parts = await Promise.all(chunks.map(async chunk => {
      const result = await synthesize({ text: chunk, config, format })
      if (result.usage) collectUsage(result.usage)
      // Gemini ships WAV with a C2PA chunk in front of the samples; the
      // decoder walks the chunk list and takes only `data`.
      return decodeWavToPcm(result.audio)
    }))
  } catch (err) {
    throw classifySynthesisError(err)
  }

  const first = parts[0]
  if (!first || first.samples.length === 0) {
    throw new VoiceNoteUpstreamError('The voice returned no audio')
  }
  for (const part of parts) {
    if (part.sampleRate !== first.sampleRate || part.channels !== first.channels) {
      throw new VoiceNoteUpstreamError('The voice mixed audio formats in one note')
    }
  }

  const fadeSamples = Math.round(first.sampleRate * VOICE_NOTE_FADE_SECONDS) * first.channels
  const pauseSamples = Math.round(first.sampleRate * VOICE_NOTE_PAUSE_SECONDS) * first.channels
  const total = parts.reduce((sum, part) => sum + part.samples.length, 0)
    + pauseSamples * Math.max(0, parts.length - 1)
  const joined = new Int16Array(total)
  let cursor = 0
  for (const [index, part] of parts.entries()) {
    if (index > 0) cursor += pauseSamples // zero-filled: the pause
    fadeEdges(part.samples, fadeSamples)
    joined.set(part.samples, cursor)
    cursor += part.samples.length
  }

  const pcm: PcmAudio = {
    samples: normalizePcm(joined),
    sampleRate: first.sampleRate,
    channels: first.channels,
  }
  const audio = await encodeOggOpus(pcm)
  const frames = joined.length / first.channels
  return {
    audio,
    mimeType: VOICE_NOTE_MIME_TYPE,
    seconds: Math.round((frames / first.sampleRate) * 10) / 10,
    chunks: chunks.length,
    usage,
  }
}

/**
 * The real synthesizer: the read-aloud dispatcher with the voice-note route
 * laid over the stored settings. Credentials come from the provider registry
 * via `providerId`, exactly like read aloud — there is no second key path.
 */
const defaultVoiceNoteSynthesizer: VoiceNoteSynthesizer = async ({ text, config, format }) => {
  const settings = ttsSettingsForVoiceNote(loadTtsSettings(), config)
  const result = await synthesizeTts(text, { format, settings })
  // The dispatcher reports token counts only where the provider sends them
  // (Gemini today); everything else keeps the estimate path.
  return { audio: result.audio, contentType: result.contentType, usage: result.usage ?? null }
}

export interface CreateVoiceNoteOptions extends VoiceNoteScriptOptions, VoiceNoteAudioOptions {
  /** Test seam: where the finished audio is stored. */
  store?: (audio: Buffer, fileName: string) => UploadDescriptor
  /** Test seam for `createdAt`. */
  now?: () => Date
  /** Goes into the file name, so a note is recognizable on disk. */
  fileNameHint?: string
  /** Owner of the stored upload row (audit trail only). */
  userId?: number | null
  /** Strand the stored upload belongs to (audit trail only). */
  sessionId?: string | null
}

export interface CreatedVoiceNote {
  voiceNote: VoiceNote
  upload: UploadDescriptor
  /** What the script step did, for the log line. */
  script: SpeechSummaryResult
  chunks: number
  /**
   * Token counts as the provider reported them. Null when the reply carried
   * no usage block — the accounting row then falls back to the estimate of
   * {@link estimateVoiceNoteUsage}.
   */
  usage?: GeminiTtsUsage | null
}

/** Store finished audio as an upload and describe it as a {@link VoiceNote}. */
function storeVoiceNoteAudio(
  spoken: VoiceNoteAudio,
  script: SpeechSummaryResult,
  config: EffectiveVoiceNoteConfig,
  options: CreateVoiceNoteOptions,
): CreatedVoiceNote {
  const extension = spoken.mimeType === VOICE_NOTE_MIME_TYPE ? 'ogg' : (MIME_EXTENSIONS[spoken.mimeType] ?? 'bin')
  const store = options.store ?? ((audio, fileName) => saveUpload({
    buffer: audio,
    originalName: fileName,
    mimeType: spoken.mimeType,
    // Same bucket every outgoing file of the web channel lands in.
    source: 'web',
    userId: options.userId ?? null,
    sessionId: options.sessionId ?? null,
  }))
  const hint = (options.fileNameHint ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  const upload = store(spoken.audio, `voice-note${hint ? `-${hint}` : ''}.${extension}`)

  return {
    voiceNote: {
      url: upload.urlPath,
      mimeType: spoken.mimeType,
      seconds: spoken.seconds,
      spokenChars: script.text.length,
      sourceChars: script.sourceChars,
      model: config.model || config.provider,
      voice: config.voice,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      // 'full' only when no summary model ran AND nothing was cut: a
      // deterministic script that hit the cap is not the whole answer.
      variant: script.passthrough && !script.trimmed ? 'full' : 'summary',
    },
    upload,
    script,
    chunks: spoken.chunks,
    usage: spoken.usage,
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/L16': 'pcm',
}

/**
 * The whole pipeline: written answer in, stored voice note out. Rewrites the
 * answer first when the configuration asks for it. Persisting the note on a
 * message is the caller's job ({@link storeVoiceNote}).
 */
export async function createVoiceNote(
  raw: string,
  options: CreateVoiceNoteOptions = {},
): Promise<CreatedVoiceNote> {
  const config = options.config ?? loadVoiceNoteConfig()
  const script = await buildVoiceNoteScript(raw, { ...options, config })
  const spoken = await synthesizeVoiceNoteAudio(script.text, { ...options, config })
  return storeVoiceNoteAudio(spoken, script, config, options)
}

/** A text that is longer than the configured cap — the tool refuses it. */
export class VoiceNoteTooLongError extends Error {
  constructor(public readonly chars: number, public readonly maxChars: number) {
    super(`The text is ${chars} characters long, the limit for a voice message is ${maxChars}. `
      + 'Shorten it and call the tool again.')
    this.name = 'VoiceNoteTooLongError'
  }
}

/**
 * Speak EXACTLY this text. The deterministic entry point behind the
 * `send_voice_message` tool: markdown is stripped, nothing is summarized,
 * nothing is rewritten, and no model is called — whatever
 * `tts.voiceNote.rewrite` says. A text over the cap is refused instead of
 * being silently cut, because the caller wrote it and has to decide what goes.
 *
 * @throws VoiceNoteTooLongError       over `maxChars` (-> tool error)
 * @throws SpeechSummaryEmptyError     nothing speakable left
 * @throws VoiceNoteUnconfiguredError / VoiceNoteUpstreamError  as above
 */
export async function speakVoiceNote(
  text: string,
  options: CreateVoiceNoteOptions = {},
): Promise<CreatedVoiceNote> {
  const config = options.config ?? loadVoiceNoteConfig()
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) throw new SpeechSummaryEmptyError()
  if (raw.length > config.maxChars) throw new VoiceNoteTooLongError(raw.length, config.maxChars)

  const spokenText = cleanSpokenText(sanitizeSpeechSource(raw))
  if (!spokenText) throw new SpeechSummaryEmptyError()
  const script: SpeechSummaryResult = {
    text: spokenText,
    language: detectSpeechLanguage(spokenText),
    sourceChars: raw.length,
    summaryChars: spokenText.length,
    passthrough: true,
    model: 'deterministic',
  }
  const spoken = await synthesizeVoiceNoteAudio(script.text, { ...options, config })
  return storeVoiceNoteAudio(spoken, script, config, options)
}

// ── Persistence ───────────────────────────────────────────────────────

/**
 * The text that was actually spoken, stored next to the note
 * (`metadata.voiceNoteScript`). Without it a note that ends too early cannot
 * be told apart: was the script short, or did the voice stop?
 */
export interface VoiceNoteScriptRecord {
  text: string
  /** `providerId:modelId` of the rewrite, `passthrough` or `deterministic`. */
  model: string
  passthrough: boolean
  /** Model calls: 0 without rewrite, 2 when a shortening round ran. */
  rounds: number
  /** First model answer length when it was over the budget. */
  draftChars?: number
  /** True when the final script still had to be cut: the end is not spoken. */
  trimmed: boolean
}

/** The storable record of one script step. */
export function voiceNoteScriptRecord(script: SpeechSummaryResult): VoiceNoteScriptRecord {
  return {
    text: script.text,
    model: script.model,
    passthrough: script.passthrough,
    rounds: script.rounds ?? (script.passthrough ? 0 : 1),
    ...(script.draftChars !== undefined ? { draftChars: script.draftChars } : {}),
    trimmed: script.trimmed ?? false,
  }
}

/**
 * Merge `voiceNote` into an existing metadata document WITHOUT losing what is
 * already there (`files` of an attachment, `kind: 'thinking'`, task injection
 * markers, …). Metadata that is not a JSON object is replaced — there is
 * nothing to keep — and that case is logged by the caller.
 */
export function mergeVoiceNoteMetadata(
  existing: string | null | undefined,
  note: VoiceNote,
  script?: VoiceNoteScriptRecord | null,
): string {
  let base: Record<string, unknown> = {}
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>
      }
    } catch {
      // Unparseable metadata: keep the voice note rather than the garbage.
    }
  }
  // A new note replaces the old script too: a stale transcript next to a
  // fresh note would describe audio that no longer exists.
  const { voiceNoteScript: _stale, ...rest } = base
  return JSON.stringify(script ? { ...rest, voiceNote: note, voiceNoteScript: script } : { ...rest, voiceNote: note })
}

/** Read the voice note back out of a metadata document; `null` when there is none. */
export function readVoiceNoteMetadata(existing: string | null | undefined): VoiceNote | null {
  if (!existing) return null
  try {
    const parsed = JSON.parse(existing) as { voiceNote?: unknown }
    const note = parsed?.voiceNote
    if (!note || typeof note !== 'object') return null
    const candidate = note as Partial<VoiceNote>
    if (typeof candidate.url !== 'string' || !candidate.url) return null
    return candidate as VoiceNote
  } catch {
    return null
  }
}

/** Write the note onto the message row, keeping every other metadata key. */
export function storeVoiceNote(
  db: Database,
  messageId: number,
  note: VoiceNote,
  script?: VoiceNoteScriptRecord | null,
): void {
  const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(messageId) as
    { metadata: string | null } | undefined
  db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?')
    .run(mergeVoiceNoteMetadata(row?.metadata ?? null, note, script), messageId)
}

/**
 * Turn-local note for the agent while automatic voice replies are on.
 *
 * Goes into the USER turn (see `agent.ts`), never into the system prompt: the
 * system prompt is the cached prefix shared by every turn, and a per-user
 * flag in there would invalidate that cache.
 *
 * Returns null when the switch is off, when the user is unknown, or when the
 * settings table cannot be read — the hint is a convenience, never a reason
 * for a turn to fail.
 */
export function voiceReplyHintFor(db: Database, userId: number | null): string | null {
  if (userId === null) return null
  try {
    if (!getVoiceRepliesEnabled(db, userId)) return null
  } catch {
    return null
  }
  return VOICE_REPLY_TURN_HINT
}

/** The exact wording of {@link voiceReplyHintFor}. */
export const VOICE_REPLY_TURN_HINT = [
  '<voice_reply>',
  'A spoken version of your written answer is generated automatically by the',
  'server after this turn. Do not record, synthesize or send a voice message,',
  'audio file or any other spoken version yourself, and do not call the',
  'send_voice_message tool — the answer is already being spoken.',
  '</voice_reply>',
].join('\n')

/**
 * Measured rate of the TTS model: roughly 40 audio tokens per spoken second
 * (24.09.2026). Used for the accounting row, not for the audio itself.
 */
export const VOICE_NOTE_AUDIO_TOKENS_PER_SECOND = 40
/** Rough text-token rate of the prompt side (~4 characters per token). */
export const VOICE_NOTE_CHARS_PER_TOKEN = 4
/**
 * USD per 1M tokens, [valid until, input, output]. The introductory price
 * doubles on 2027-01-01, so the table carries both rows instead of a constant
 * that silently becomes wrong.
 */
export const VOICE_NOTE_PRICES: ReadonlyArray<{ until: string; input: number; output: number }> = [
  { until: '2026-12-31', input: 0.5, output: 6 },
  { until: '9999-12-31', input: 1, output: 12 },
]

/** USD for a known pair of token counts, at the price valid on `now`. */
export function voiceNoteCostUsd(promptTokens: number, completionTokens: number, now?: Date): number {
  const day = (now ?? new Date()).toISOString().slice(0, 10)
  const price = VOICE_NOTE_PRICES.find(entry => day <= entry.until)
    ?? VOICE_NOTE_PRICES[VOICE_NOTE_PRICES.length - 1]!
  return Math.round(((promptTokens * price.input + completionTokens * price.output) / 1e6) * 1e6) / 1e6
}

/** What one voice note cost, estimated from its text and its duration. */
export function estimateVoiceNoteUsage(input: {
  spokenChars: number
  seconds: number
  now?: Date
}): { promptTokens: number; completionTokens: number; estimatedCost: number } {
  const promptTokens = Math.ceil(input.spokenChars / VOICE_NOTE_CHARS_PER_TOKEN)
  const completionTokens = Math.round(input.seconds * VOICE_NOTE_AUDIO_TOKENS_PER_SECOND)
  return {
    promptTokens,
    completionTokens,
    estimatedCost: voiceNoteCostUsd(promptTokens, completionTokens, input.now),
  }
}
