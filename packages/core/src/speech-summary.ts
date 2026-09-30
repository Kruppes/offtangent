/**
 * speech-summary.ts: the "summarize aloud" mode of the companion app.
 *
 * A written assistant message is optimized for a screen — headings, tables,
 * paths, hashes. Read out by a voice it is unusable. This module turns one
 * message into 2 to 6 spoken sentences in the language of the source.
 *
 * Shape of the call:
 *
 *  1. {@link sanitizeSpeechSource} strips code, tool output and logs and
 *     flattens tables (speech-text.ts).
 *  2. A message that is short enough after cleaning is returned as it stands —
 *     a summary of four sentences cannot improve on three, and a model call
 *     would only add a second of latency and a chance to lose a detail.
 *  3. Everything longer goes to one fast, cheap model call.
 *  4. {@link cleanSpokenText} runs on the answer no matter what the model
 *     did, so the format rule is enforced by code, not by hope.
 *  5. An answer over the sentence or character budget is NOT cut as a first
 *     resort: a cut drops the end of the content ("four things are needed"
 *     and then silence). The model gets one shortening round with its own
 *     draft and the exact overrun; only an answer that is still too long
 *     after that is cut at a sentence boundary, and that cut is logged.
 *
 * Model policy: a fast model of the Anthropic provider, never a provider the
 * data policy keeps away from personal data on this instance — that question
 * is answered by the ONE gate in `data-policy.ts`, which this module used to
 * mirror with a provider-type list of its own. Failures are NOT masked as an empty
 * answer: the caller gets {@link SpeechSummaryUpstreamError} and turns it
 * into a 502 so the app can say "not right now" instead of reading silence.
 */
import type { Api, Model } from '@earendil-works/pi-ai'
import { loadConfig, warnConfigReadFailed } from './config.js'
import { checkAutomaticModelFor, type ProviderPolicyView } from './data-policy.js'
import { completeSimple } from './pi-models.js'
import { withTimeout } from './promise-utils.js'
import {
  buildModel,
  getApiKeyForProvider,
  getProviderDefaultModel,
  loadProvidersDecrypted,
  type ProviderConfig,
} from './provider-config.js'
import {
  SPEECH_DIRECT_MAX_CHARS,
  SPEECH_MAX_CHARS,
  SPEECH_MAX_SENTENCES,
  SPEECH_SOURCE_CAP,
  cleanSpokenText,
  detectSpeechLanguage,
  limitSpokenSentencesDetailed,
  sanitizeSpeechSourceDetailed,
  type SpeechLanguage,
} from './speech-text.js'

/** Hard timeout for the model call. The app is waiting with a spinner. */
export const SPEECH_SUMMARY_TIMEOUT_MS = 20_000

const ANTHROPIC_PROVIDER_TYPES = new Set(['anthropic', 'anthropic-oauth'])

/**
 * Preferred models, cheapest and fastest first. The summary is a one-shot
 * classification-sized job; the expensive reasoning models are a waste here.
 * Unresolvable entries are skipped, so this list may name models that are not
 * enabled on every instance.
 */
export const SPEECH_SUMMARY_PREFERRED_MODELS = [
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-latest',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
]

export class SpeechSummaryEmptyError extends Error {
  constructor(message = 'Nothing left to speak after cleaning') {
    super(message)
    this.name = 'SpeechSummaryEmptyError'
  }
}

export class SpeechSummaryUpstreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpeechSummaryUpstreamError'
  }
}

export interface SpeechSummaryModelChoice {
  providerId: string
  providerName: string
  modelId: string
  /** `providerId:modelId`, what the log line records. */
  composite: string
  model: Model<Api>
  apiKey: string
}

/**
 * The spoken summary is an AUTOMATIC model choice, so it asks the same gate
 * as the router, the background roles and the fallback. There is no second
 * list here any more: `data-policy.ts` is the single source.
 */
function isForbidden(provider: ProviderConfig, modelId?: string): boolean {
  const model = modelId ?? getProviderDefaultModel(provider)
  return !checkAutomaticModelFor(provider as ProviderPolicyView, model, 'speechSummary').allowed
}

interface SpeechPolicyBlock {
  modelPolicy?: { roles?: { speechSummary?: unknown } }
}

/**
 * Resolve `modelPolicy.roles.speechSummary` against the providers we already
 * hold. Deliberately not routed through `resolveProviderModelInput()`: that
 * helper re-reads `providers.json` from disk, and this decision must be made
 * on exactly the list that was checked against the forbidden providers.
 *
 * Accepted spellings: `modelId`, `providerId:modelId`, `Provider Name:modelId`
 * and a bare provider id/name (its default model).
 */
function resolveSpec(providers: ProviderConfig[], spec: string): { provider: ProviderConfig; modelId: string } | null {
  const findProvider = (key: string): ProviderConfig | undefined => providers.find(
    p => p.id === key || p.name.toLowerCase() === key.toLowerCase(),
  )
  const findModel = (provider: ProviderConfig, modelId: string): string | undefined =>
    (provider.enabledModels ?? []).find(m => m.toLowerCase() === modelId.toLowerCase())

  const colon = spec.indexOf(':')
  if (colon > 0) {
    const provider = findProvider(spec.slice(0, colon))
    const modelId = provider ? findModel(provider, spec.slice(colon + 1)) : undefined
    if (provider && modelId) return { provider, modelId }
  }
  for (const provider of providers) {
    const modelId = findModel(provider, spec)
    if (modelId) return { provider, modelId }
  }
  const provider = findProvider(spec)
  if (provider) return { provider, modelId: getProviderDefaultModel(provider) }
  return null
}

/** Optional escape hatch: `modelPolicy.roles.speechSummary` in settings.json. */
function configuredSpec(): string | null {
  try {
    const raw = loadConfig<SpeechPolicyBlock>('settings.json').modelPolicy?.roles?.speechSummary
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
    return null
  }
}

function pick(providers: ProviderConfig[]): { provider: ProviderConfig; modelId: string } | null {
  const anthropic = providers.filter(p => ANTHROPIC_PROVIDER_TYPES.has(p.providerType) && !isForbidden(p))

  for (const wanted of SPEECH_SUMMARY_PREFERRED_MODELS) {
    for (const provider of anthropic) {
      const match = (provider.enabledModels ?? []).find(m => m.toLowerCase() === wanted)
      if (match && !isForbidden(provider, match)) return { provider, modelId: match }
    }
  }

  // No preferred model is enabled: take the cheapest enabled Anthropic model.
  let cheapest: { provider: ProviderConfig; modelId: string; cost: number } | null = null
  for (const provider of anthropic) {
    for (const modelId of provider.enabledModels ?? []) {
      if (isForbidden(provider, modelId)) continue
      let cost = Number.POSITIVE_INFINITY
      try {
        cost = buildModel(provider, modelId).cost?.input ?? Number.POSITIVE_INFINITY
      } catch {
        // A custom model without catalog metadata simply has no price here.
      }
      if (!cheapest || cost < cheapest.cost) cheapest = { provider, modelId, cost }
    }
  }
  if (cheapest) return { provider: cheapest.provider, modelId: cheapest.modelId }

  // Last resort: the instance default, as long as it is an allowed provider.
  const file = loadProvidersDecrypted()
  const active = providers.find(p => p.id === file.activeProvider)
  if (active && !isForbidden(active)) {
    const modelId = file.activeModel ?? getProviderDefaultModel(active)
    if (!isForbidden(active, modelId)) return { provider: active, modelId }
  }
  return null
}

/**
 * Resolve the model for one summary call. `null` means "no allowed model on
 * this instance" and is treated as an upstream failure by the caller.
 */
export async function resolveSpeechSummaryModel(): Promise<SpeechSummaryModelChoice | null> {
  let providers: ProviderConfig[]
  try {
    providers = loadProvidersDecrypted().providers
  } catch (err) {
    console.warn(`[speech-summary] Cannot read providers: ${(err as Error).message}`)
    return null
  }

  let chosen: { provider: ProviderConfig; modelId: string } | null = null

  const spec = configuredSpec()
  if (spec) {
    const resolved = resolveSpec(providers, spec)
    if (resolved && !isForbidden(resolved.provider, resolved.modelId)) {
      chosen = resolved
    } else {
      console.warn(`[speech-summary] Configured model "${spec}" is not usable here, falling back`)
    }
  }

  chosen ??= pick(providers)
  if (!chosen) return null

  try {
    return {
      providerId: chosen.provider.id,
      providerName: chosen.provider.name,
      modelId: chosen.modelId,
      composite: `${chosen.provider.id}:${chosen.modelId}`,
      model: buildModel(chosen.provider, chosen.modelId),
      apiKey: await getApiKeyForProvider(chosen.provider),
    }
  } catch (err) {
    console.warn(`[speech-summary] Cannot build model ${chosen.provider.id}:${chosen.modelId}: ${(err as Error).message}`)
    return null
  }
}

export function buildSpeechSummaryPrompt(language: SpeechLanguage): string {
  const target = language === 'de' ? 'German' : 'English'
  return [
    'You rewrite a written assistant message so it can be READ ALOUD by a text to speech voice.',
    '',
    `Answer in ${target}. That is the language of the source message; never switch languages.`,
    '',
    'Rules:',
    '- 2 to 6 sentences, between 15 and 45 seconds of speech. Never longer.',
    '- Spoken prose only. No markdown, no headings, no bullet points, no asterisks, no underscores,',
    '  no backticks, no pipes, no tables, no urls, no file paths, no commit hashes, no emoji,',
    '  no bracketed asides like "(see above)".',
    '- Say the outcome first, then what the listener has to know, then the next action if there is one.',
    '- Condense tables and lists into statements. Never read out columns of numbers; say what they mean',
    '  ("all gates green", "two of five failed") instead.',
    '- Keep concrete facts that matter (what was decided, what broke, what is due next).',
    '- Cover the whole message. When it does not fit, leave out minor details instead of stopping early;',
    '  never announce a list or a number of points you do not then name.',
    '- Add nothing that is not in the source, and do not comment on the summary itself.',
    `- The source may be truncated after ${SPEECH_SOURCE_CAP} characters; summarize what you are given.`,
    '',
    'Answer with the spoken text and nothing else.',
  ].join('\n')
}

/** One model call: the spoken text and the model that produced it. */
export type SpeechSummaryCompletion = (input: {
  systemPrompt: string
  userPrompt: string
}) => Promise<{ text: string; model: string }>

async function defaultCompletion(
  input: { systemPrompt: string; userPrompt: string },
): Promise<{ text: string; model: string }> {
  const choice = await resolveSpeechSummaryModel()
  if (!choice) throw new SpeechSummaryUpstreamError('No allowed summary model is configured')
  const response = await withTimeout(
    completeSimple(choice.model, {
      systemPrompt: input.systemPrompt,
      messages: [{ role: 'user' as const, content: input.userPrompt, timestamp: Date.now() }],
    }, { apiKey: choice.apiKey }),
    SPEECH_SUMMARY_TIMEOUT_MS,
    'Speech summary',
  )
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw new SpeechSummaryUpstreamError(response.errorMessage ?? response.stopReason)
  }
  const text = response.content
    .filter(item => item.type === 'text')
    .map(item => (item as { type: 'text'; text: string }).text)
    .join('')
    .trim()
  return { text, model: choice.composite }
}

export interface SpeechSummaryResult {
  /** Ready to speak: plain prose, no markup, 2 to 6 sentences. */
  text: string
  language: SpeechLanguage
  /** Length of the raw source message, before any cleaning. */
  sourceChars: number
  /** Length of `text`. */
  summaryChars: number
  /** True when the cleaned source was short enough to be spoken as it stands. */
  passthrough: boolean
  /** `providerId:modelId` of the call, `passthrough` when no model ran. */
  model: string
  /** Model calls made: 0 on passthrough, 2 when the answer needed shortening. */
  rounds?: number
  /**
   * Length of the first model answer after cleaning, when it was over the
   * budget and a shortening round ran. Absent otherwise.
   */
  draftChars?: number
  /**
   * True when the final text still had to be cut to fit: content the source
   * had is missing from the end. Always logged.
   */
  trimmed?: boolean
}

export interface SummarizeForSpeechOptions {
  /** Test seam and policy override for the single model call. */
  complete?: SpeechSummaryCompletion
  /**
   * Style of the rewrite. Defaults to {@link buildSpeechSummaryPrompt} (the
   * read-aloud short form); the voice-note path hands in its own rules.
   */
  systemPrompt?: (language: SpeechLanguage) => string
  /** Cleaned sources up to this length are spoken as they stand. */
  directMaxChars?: number
  /** Sentence cap applied to the model's answer. */
  maxSentences?: number
  /** Character cap applied to the model's answer. */
  maxChars?: number
  /**
   * Ask the model for a shorter complete version when its answer is over the
   * budget, instead of cutting it (default true). Costs one more call, and
   * only when the first answer overran.
   */
  shortenOnOverflow?: boolean
  /** Log sink for overruns and cuts. Defaults to `console`. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void }
}

/**
 * Character length the shortening round asks for: clearly under the hard cap,
 * so a model that overshoots its own count by a few percent still fits.
 */
export function speechShortenTarget(maxChars: number): number {
  return Math.floor(maxChars * 0.8)
}

/** The user turn of the shortening round: the model's own draft and the exact overrun. */
export function buildSpeechShortenPrompt(input: {
  source: string
  draft: string
  draftSentences: number
  maxChars: number
  maxSentences: number
}): string {
  const target = speechShortenTarget(input.maxChars)
  return [
    `<message>\n${input.source}\n</message>`,
    '',
    `<draft>\n${input.draft}\n</draft>`,
    '',
    `The draft above is ${input.draft.length} characters and ${input.draftSentences} sentences long.`,
    `The hard limit is ${input.maxChars} characters and ${input.maxSentences} sentences;`,
    'everything beyond it would be cut off in the middle of the content.',
    `Write a new, COMPLETE spoken version of the message of at most ${target} characters`,
    `and at most ${input.maxSentences} sentences, following the same rules.`,
    'Cover every part of the message down to the end: drop minor details, merge points, shorten sentences.',
    'Never announce a list or a number of points you do not then name.',
    'Answer with the spoken text and nothing else.',
  ].join('\n')
}

/**
 * Turn one raw message into spoken text.
 *
 * @throws SpeechSummaryEmptyError  nothing left after cleaning (-> 400 empty)
 * @throws SpeechSummaryUpstreamError  model unavailable, timed out, or
 *         answered with nothing usable (-> 502 upstream)
 */
export async function summarizeForSpeech(
  raw: string,
  options: SummarizeForSpeechOptions = {},
): Promise<SpeechSummaryResult> {
  const sourceChars = typeof raw === 'string' ? raw.length : 0
  const { text: source, hadTable } = sanitizeSpeechSourceDetailed(raw)
  const direct = cleanSpokenText(source)
  if (!direct) throw new SpeechSummaryEmptyError()

  const language = detectSpeechLanguage(direct)

  // A short message is spoken as it stands — unless it carried a table, whose
  // flattened rows would be read out as columns of numbers.
  if (direct.length <= (options.directMaxChars ?? SPEECH_DIRECT_MAX_CHARS) && !hadTable) {
    return {
      text: direct,
      language,
      sourceChars,
      summaryChars: direct.length,
      passthrough: true,
      model: 'passthrough',
      rounds: 0,
      trimmed: false,
    }
  }

  const complete = options.complete ?? defaultCompletion
  const maxSentences = options.maxSentences ?? SPEECH_MAX_SENTENCES
  const maxChars = options.maxChars ?? SPEECH_MAX_CHARS
  const logger = options.logger ?? { info: (msg: string) => console.log(msg), warn: (msg: string) => console.warn(msg) }
  const systemPrompt = (options.systemPrompt ?? buildSpeechSummaryPrompt)(language)

  const call = async (userPrompt: string): Promise<{ text: string; model: string }> => {
    try {
      return await complete({ systemPrompt, userPrompt })
    } catch (err) {
      if (err instanceof SpeechSummaryUpstreamError) throw err
      throw new SpeechSummaryUpstreamError((err as Error).message)
    }
  }

  const answer = await call(`<message>\n${source}\n</message>`)
  let model = answer.model
  let rounds = 1
  let draftChars: number | undefined
  let limited = limitSpokenSentencesDetailed(cleanSpokenText(answer.text), maxSentences, maxChars)

  if (limited.cut && options.shortenOnOverflow !== false) {
    const draft = cleanSpokenText(answer.text)
    draftChars = draft.length
    logger.info(
      `[speech-summary] answer over budget (${limited.charsIn} chars, ${limited.sentencesIn} sentences; `
      + `limit ${maxChars}/${maxSentences}), asking ${model} for a shorter complete version`,
    )
    try {
      const shorter = await call(buildSpeechShortenPrompt({
        source,
        draft,
        draftSentences: limited.sentencesIn,
        maxChars,
        maxSentences,
      }))
      const retry = limitSpokenSentencesDetailed(cleanSpokenText(shorter.text), maxSentences, maxChars)
      rounds = 2
      // Take the second answer when it is usable. When it is still too long,
      // it is at least closer to the budget, so its cut loses less.
      if (retry.text && (!retry.cut || retry.charsIn < limited.charsIn)) {
        limited = retry
        model = shorter.model
      }
    } catch (err) {
      // The first answer is still good; a failed shortening round only means
      // it gets cut below. Never turn that into a failed voice.
      logger.warn(`[speech-summary] shortening round failed: ${(err as Error).message}`)
    }
  }

  if (limited.cut) {
    logger.warn(
      `[speech-summary] spoken text cut to fit: ${limited.charsIn} -> ${limited.text.length} chars, `
      + `${limited.sentencesIn} -> ${limited.sentencesOut} sentences (limit ${maxChars}/${maxSentences}, `
      + `${rounds} round(s), ${model}); the end of the content is not spoken`,
    )
  }

  const spoken = limited.text
  if (!spoken) {
    // An empty answer is a failure of the call, not an empty message: the
    // source had content, so saying "empty" here would blame the user.
    throw new SpeechSummaryUpstreamError('The summary model returned no usable text')
  }

  return {
    text: spoken,
    language,
    sourceChars,
    summaryChars: spoken.length,
    passthrough: false,
    model,
    rounds,
    ...(draftChars !== undefined ? { draftChars } : {}),
    trimmed: limited.cut,
  }
}
