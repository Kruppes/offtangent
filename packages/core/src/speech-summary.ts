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
 *
 * Model policy: a fast model of the Anthropic provider, never a provider that
 * is off limits for personal data on this instance (see
 * {@link FORBIDDEN_PROVIDER_TYPES}). Failures are NOT masked as an empty
 * answer: the caller gets {@link SpeechSummaryUpstreamError} and turns it
 * into a 502 so the app can say "not right now" instead of reading silence.
 */
import type { Api, Model } from '@earendil-works/pi-ai'
import { loadConfig, warnConfigReadFailed } from './config.js'
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
  SPEECH_SOURCE_CAP,
  cleanSpokenText,
  detectSpeechLanguage,
  limitSpokenSentences,
  sanitizeSpeechSourceDetailed,
  type SpeechLanguage,
} from './speech-text.js'

/** Hard timeout for the model call. The app is waiting with a spinner. */
export const SPEECH_SUMMARY_TIMEOUT_MS = 20_000

/**
 * Provider types that must never see a private message of this instance.
 * Mirrors the `AUTO_FORBIDDEN_PROVIDER_TYPES` rule of the model resolution
 * (model-resolution.ts) and adds the `zai-coding` spelling of the union type.
 */
export const FORBIDDEN_PROVIDER_TYPES = new Set([
  'zai', 'zai-coding', 'zai-coding-plan', 'moonshot', 'kimi', 'kimi-coding',
])

/** Belt and braces: a renamed provider or a model id that gives it away. */
const FORBIDDEN_NAME = /(moonshot|kimi|z\.?ai|glm)/i

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

function isForbidden(provider: ProviderConfig, modelId?: string): boolean {
  if (FORBIDDEN_PROVIDER_TYPES.has(provider.providerType)) return true
  if (FORBIDDEN_NAME.test(provider.name)) return true
  if (modelId && FORBIDDEN_NAME.test(modelId)) return true
  return false
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
}

export interface SummarizeForSpeechOptions {
  /** Test seam and policy override for the single model call. */
  complete?: SpeechSummaryCompletion
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
  if (direct.length <= SPEECH_DIRECT_MAX_CHARS && !hadTable) {
    return {
      text: direct,
      language,
      sourceChars,
      summaryChars: direct.length,
      passthrough: true,
      model: 'passthrough',
    }
  }

  const complete = options.complete ?? defaultCompletion
  let answer: { text: string; model: string }
  try {
    answer = await complete({
      systemPrompt: buildSpeechSummaryPrompt(language),
      userPrompt: `<message>\n${source}\n</message>`,
    })
  } catch (err) {
    if (err instanceof SpeechSummaryUpstreamError) throw err
    throw new SpeechSummaryUpstreamError((err as Error).message)
  }

  const spoken = limitSpokenSentences(cleanSpokenText(answer.text))
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
    model: answer.model,
  }
}
