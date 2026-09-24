/**
 * capture-split.ts: split-on-intake (plan 2026-09-24). A dictated capture that
 * mixes several unrelated matters is cut into topic parts BEFORE the router
 * runs, so every matter gets its own strand and its own decision.
 *
 * Two model stages, both validated in code:
 *
 *  1. {@link splitCapture} classifies every numbered sentence into exactly one
 *     topic. The answer is validated (every id 1..n exactly once), a rejected
 *     answer is echoed back up to {@link SPLIT_REPAIR_ATTEMPTS} times, and the
 *     result is then post processed deterministically: topics below two
 *     sentences are folded into their neighbour and a multi topic answer whose
 *     `splitConfidence` is under {@link SPLIT_MIN} collapses back into one
 *     part. The model proposes, the code decides.
 *  2. {@link consolidatePart} rewrites the sentences of ONE part into readable
 *     text without summarising. Parts run in parallel, and a failed
 *     consolidation degrades to the verbatim sentences of that part: a capture
 *     must never be lost because stage 2 was unavailable.
 *
 * A single part carries the ORIGINAL capture text verbatim, so a capture about
 * one matter behaves exactly as it did before this module existed.
 *
 * The prompts and the segmentation are the ones measured in the spike
 * (`/data/memory/plans/2026-09-24-split-spike/report.md`): 12 of 12 real
 * single topic dictations stayed unsplit, synthetic interleaves reached
 * 89.5 to 100 percent sentence accuracy.
 */
import { captureLanguage } from './capture-router.js'
import type { CaptureLanguage } from './capture-router.js'
import { loadConfig, warnConfigReadFailed } from './config.js'
import { completeSimple } from './pi-models.js'
import { buildRouterModel, resolveRouterChain } from './router-model.js'
import type { ResolvedRouterModel } from './router-model.js'
import { resolveBackgroundReasoning } from './thinking-level.js'

/**
 * Below this `splitConfidence` a multi topic answer is discarded and the
 * capture is filed as one. Splitting a coherent note costs the user a
 * conversation torn in half; a missed split costs one manual move.
 */
export const SPLIT_MIN = 0.7

/** Shortest text a non voice capture needs before a split is even attempted. */
export const DEFAULT_SPLIT_MIN_CHARS = 400

/** A topic below this many sentences is never a thread of its own. */
export const SPLIT_MIN_SENTENCES_PER_TOPIC = 2

export const SPLIT_REPAIR_ATTEMPTS = 3

/** Longest sentence run that is kept whole before discourse markers are used. */
const LONG_RUN_CHARS = 260

export const STAGE1_SYSTEM_PROMPT = `You split a dictated voice note into topics. The speaker rambles and jumps between subjects, so a topic's sentences may be scattered across the whole note. You receive the note as numbered sentences and answer with ONE JSON object, no prose, no fences.

Schema:
{
  "topics": [ { "id": "A", "title": string, "sentenceIds": number[] } ],
  "uncertain": [ { "sentenceId": number, "alternativeTopic": string, "confidence": number } ],
  "splitConfidence": number,
  "rationale": string
}

Rules:
- A topic is a distinct MATTER the speaker would handle in a separate conversation: a different project, a different decision, a different person or problem, with no shared outcome. The test for a split: would the user want these handled in separate threads, never in one reply? If one part is the concept, another the name, another the roadmap, the tech basis or the hardware of the SAME undertaking, that is ONE topic. Enumerated sub-points ("first, second, third") of one request are ONE topic. Background, motivation, examples and meta talk about one matter belong to that matter.
- Be conservative. A note about one thing gets exactly one topic with all sentences, and most notes are about one thing. Only split when a reader would say "these are unrelated matters that happen to share a recording". Splitting a coherent note is the expensive mistake; a missed split is cheap.
- Topics may be interleaved: the speaker can return to a topic several times. Assign each sentence by what it is about, not by its position.
- Every sentence id appears in exactly one topic's "sentenceIds". No sentence is dropped, none is duplicated. Meta talk ("do you understand my idea", "let me know what you think", greetings) goes to the topic it sits next to, usually the previous sentence's topic.
- A sentence that bridges two topics ("and that ties in with the roof") belongs to the topic it mostly talks about; list it in "uncertain" with the other topic as alternativeTopic.
- "confidence" in "uncertain" is your certainty for the CHOSEN topic, 0..1. Only list sentences below 0.7. Usually empty.
- "splitConfidence": when you return more than one topic, your probability 0..1 that the user really wants them as separate threads. Below 0.7 the split is discarded and the note is filed as one. With one topic, 1.
- "title": at most 60 characters, same language as the note, names the subject, not the request.
- "rationale": one sentence, same language as the note, naming what makes the topics unrelated (or why it is one).`

export const STAGE2_SYSTEM_PROMPT = `You consolidate the sentences of ONE topic from a dictated voice note into a readable text. You get only the sentences that belong to this topic, in the order they were spoken, and answer with the consolidated text only: no heading, no preamble, no JSON, no fences.

Rules:
- Keep every statement, question, number, name and condition. Nothing is summarised away, nothing is added, nothing is interpreted. The result is roughly as long as the input minus fillers.
- First person, the speaker's voice, the speaker's language and wording wherever possible. Reorder only where scattered fragments of the same point read better together. Keep the speaker's own order otherwise.
- Remove fillers, false starts and verbatim repetitions ("also, also", "ich meine", "ähm", "genau").
- When the speaker corrects themself, keep both: state the final position and mention what was considered first in one short clause. Never silently drop the discarded thought.
- Questions and requests to the assistant stay questions and requests, in the speaker's words.
- Do not answer the questions. Do not add advice, structure headings or bullet points unless the speaker enumerated.`

export const SPLIT_TITLE_MAX = 60

export interface CaptureSplitSettings {
  /** Master switch (`settings.json` -> `captures.splitOnIntake`). */
  splitOnIntake: boolean
  /** Shortest non voice capture that is considered (`captures.splitMinChars`). */
  splitMinChars: number
}

interface CapturesSettingsBlock {
  captures?: { splitOnIntake?: unknown; splitMinChars?: unknown }
}

export function loadCaptureSplitSettings(): CaptureSplitSettings {
  let block: CapturesSettingsBlock['captures']
  try {
    block = loadConfig<CapturesSettingsBlock>('settings.json').captures
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
  }
  const rawChars = block?.splitMinChars
  const minChars = typeof rawChars === 'number' && Number.isFinite(rawChars) && rawChars >= 0
    ? Math.trunc(rawChars)
    : DEFAULT_SPLIT_MIN_CHARS
  return {
    splitOnIntake: block?.splitOnIntake === undefined ? true : block.splitOnIntake === true,
    splitMinChars: minChars,
  }
}

/**
 * Is this capture long enough (or spoken) to be worth two model calls? A
 * dictation is always considered, typed text only from `splitMinChars` on.
 */
export function isSplitEligible(
  capture: { kind: string; text: string },
  settings: CaptureSplitSettings = loadCaptureSplitSettings(),
): boolean {
  if (!settings.splitOnIntake) return false
  if (capture.kind === 'voice') return true
  return capture.text.trim().length >= settings.splitMinChars
}

/**
 * Sentences of a capture. The leading voice marker is stripped for
 * segmentation only; the stored capture text is never touched.
 *
 * Whisper sometimes forgets punctuation for a whole paragraph, so a run longer
 * than {@link LONG_RUN_CHARS} is broken at discourse markers as well. Without
 * that, one 900 character "sentence" would be the smallest unit the split
 * could work with.
 */
export function segmentSentences(text: string): string[] {
  const cleaned = text.replace(/^🎤 Voice:\s*/u, '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return []
  const rough = cleaned.split(/(?<=[.!?])\s+(?=\S)/u).map(s => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const sentence of rough) {
    if (sentence.length <= LONG_RUN_CHARS) {
      out.push(sentence)
      continue
    }
    const pieces = sentence.split(/\s+(?=(?:und dann|und eventuell|und zwar|also|aber|und dass|genau|das heißt|außerdem|dann)\b)/iu)
    let buffer = ''
    for (const piece of pieces) {
      if (buffer && `${buffer} ${piece}`.length > LONG_RUN_CHARS) {
        out.push(buffer.trim())
        buffer = piece
      } else {
        buffer = buffer ? `${buffer} ${piece}` : piece
      }
    }
    if (buffer.trim()) out.push(buffer.trim())
  }
  return out
}

export interface SplitTopic {
  id: string
  title: string
  sentenceIds: number[]
}

export interface SplitUncertainty {
  sentenceId: number
  alternativeTopic: string
  confidence: number
}

export interface Stage1Answer {
  topics: SplitTopic[]
  uncertain: SplitUncertainty[]
  splitConfidence: number
  rationale: string
}

/** One model call of a split stage: system prompt plus one user message. */
export type SplitCompletion = (systemPrompt: string, userPrompt: string) => Promise<string>

export interface CaptureSplitOptions {
  /** Chain override (tests, preview). Defaults to the configured router chain. */
  chain?: ResolvedRouterModel[]
  /** Model call override (tests), same role as `RunRouterOptions.complete`. */
  complete?: SplitCompletion
  settings?: CaptureSplitSettings
}

function stripFences(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return fenced[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}

export type ParseStage1Result =
  | { ok: true; answer: Stage1Answer }
  | { ok: false; error: string }

function cleanTitle(raw: unknown, fallback: string): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  return (text || fallback).slice(0, SPLIT_TITLE_MAX)
}

/**
 * Strict parse and validation of a stage 1 answer: every sentence id has to
 * appear exactly once, because a dropped sentence is lost text and a
 * duplicated one is text filed twice.
 */
export function parseStage1Answer(text: string, sentenceCount: number): ParseStage1Result {
  let raw: unknown
  try {
    raw = JSON.parse(stripFences(text))
  } catch {
    return { ok: false, error: 'not JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'not an object' }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.topics) || obj.topics.length === 0) return { ok: false, error: 'no topics' }

  const topics: SplitTopic[] = []
  const owner = new Map<number, string>()
  for (const [index, entry] of obj.topics.entries()) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, error: `topic ${index + 1} is not an object` }
    const t = entry as Record<string, unknown>
    const id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : String.fromCharCode(65 + index)
    if (!Array.isArray(t.sentenceIds)) return { ok: false, error: `topic ${id} without sentenceIds` }
    const ids: number[] = []
    for (const value of t.sentenceIds) {
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > sentenceCount) {
        return { ok: false, error: `sentence id ${String(value)} out of range 1..${sentenceCount}` }
      }
      const sentenceId = value as number
      if (owner.has(sentenceId)) {
        return { ok: false, error: `sentence ${sentenceId} in topics ${owner.get(sentenceId)} and ${id}` }
      }
      owner.set(sentenceId, id)
      ids.push(sentenceId)
    }
    topics.push({ id, title: cleanTitle(t.title, `Topic ${id}`), sentenceIds: ids.sort((a, b) => a - b) })
  }
  const missing: number[] = []
  for (let i = 1; i <= sentenceCount; i += 1) if (!owner.has(i)) missing.push(i)
  if (missing.length > 0) return { ok: false, error: `sentences not assigned: ${missing.join(', ')}` }

  const uncertain: SplitUncertainty[] = []
  if (Array.isArray(obj.uncertain)) {
    for (const entry of obj.uncertain) {
      if (typeof entry !== 'object' || entry === null) continue
      const u = entry as Record<string, unknown>
      if (!Number.isInteger(u.sentenceId)) continue
      uncertain.push({
        sentenceId: u.sentenceId as number,
        alternativeTopic: typeof u.alternativeTopic === 'string' ? u.alternativeTopic : '',
        confidence: typeof u.confidence === 'number' ? u.confidence : 0,
      })
    }
  }

  const rawConfidence = obj.splitConfidence
  const splitConfidence = topics.length === 1
    ? 1
    : typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0
  return {
    ok: true,
    answer: {
      topics,
      uncertain,
      splitConfidence,
      rationale: typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 400) : '',
    },
  }
}

export function buildStage1UserPrompt(sentences: string[]): string {
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return `Split this voice note into topics.\n\n${numbered}\n\nAnswer with the JSON object only.`
}

/** Same shape as `buildRepairPrompt` in capture-router.ts: task, rejected answer, demand. */
export function buildStage1RepairPrompt(userPrompt: string, rejected: string, error: string, sentenceCount: number): string {
  return `${userPrompt}

Your previous answer was rejected (${error}):
${rejected.slice(0, 2000)}

Reply again with exactly one valid JSON object where every sentence id 1..${sentenceCount} appears exactly once.`
}

export interface Stage1Outcome {
  answer: Stage1Answer
  attempts: number
  notes: string[]
}

/**
 * Stage 1: assign every sentence to a topic. Throws only when every attempt
 * failed; the caller then files the capture as one part.
 */
export async function splitCapture(sentences: string[], complete: SplitCompletion): Promise<Stage1Outcome> {
  const notes: string[] = []
  const base = buildStage1UserPrompt(sentences)
  let prompt = base
  let lastError = 'no answer'
  for (let attempt = 1; attempt <= SPLIT_REPAIR_ATTEMPTS; attempt += 1) {
    let text: string
    try {
      text = await complete(STAGE1_SYSTEM_PROMPT, prompt)
    } catch (err) {
      lastError = (err as Error).message
      notes.push(`split stage 1 attempt ${attempt} failed: ${lastError}`)
      continue
    }
    const parsed = parseStage1Answer(text, sentences.length)
    if (parsed.ok) return { answer: parsed.answer, attempts: attempt, notes }
    lastError = parsed.error
    notes.push(`split stage 1 attempt ${attempt} rejected: ${parsed.error}`)
    prompt = buildStage1RepairPrompt(base, text, parsed.error, sentences.length)
  }
  throw new Error(`split stage 1 failed after ${SPLIT_REPAIR_ATTEMPTS} attempts: ${lastError}`)
}

/**
 * A topic of a single sentence is never a thread of its own: fold it into the
 * topic of the nearest preceding sentence (the following one when it is the
 * first). Deterministic, in code, because the model has no reason to be
 * consistent about one-liners.
 */
export function mergeTinyTopics(topics: SplitTopic[]): SplitTopic[] {
  const tiny = topics.filter(t => t.sentenceIds.length < SPLIT_MIN_SENTENCES_PER_TOPIC)
  if (tiny.length === 0 || tiny.length === topics.length) return topics
  const owner = new Map<number, SplitTopic>()
  for (const topic of topics) for (const id of topic.sentenceIds) owner.set(id, topic)
  const survivors = topics.filter(t => !tiny.includes(t))
  const maxId = Math.max(...topics.flatMap(t => t.sentenceIds))
  for (const topic of tiny) {
    const id = topic.sentenceIds[0]
    let target: SplitTopic | undefined
    for (let j = id - 1; j >= 1 && !target; j -= 1) {
      const candidate = owner.get(j)
      if (candidate && survivors.includes(candidate)) target = candidate
    }
    for (let j = id + 1; j <= maxId && !target; j += 1) {
      const candidate = owner.get(j)
      if (candidate && survivors.includes(candidate)) target = candidate
    }
    (target ?? survivors[0]).sentenceIds.push(id)
  }
  return survivors.map(t => ({ ...t, sentenceIds: [...t.sentenceIds].sort((a, b) => a - b) }))
}

export function buildStage2UserPrompt(title: string, sentences: string[]): string {
  return `Topic: ${title}\n\nSentences of this topic, in spoken order:\n${sentences.join('\n')}`
}

/**
 * Stage 2: one part's sentences into readable text. A part of a single
 * sentence is returned verbatim, because there is nothing to consolidate and a
 * model call could only change it.
 */
export async function consolidatePart(title: string, sentences: string[], complete: SplitCompletion): Promise<string> {
  if (sentences.length <= 1) return sentences.join(' ').trim()
  const text = await complete(STAGE2_SYSTEM_PROMPT, buildStage2UserPrompt(title, sentences))
  const cleaned = text.trim()
  if (!cleaned) throw new Error('stage 2 returned an empty text')
  return cleaned
}

export interface CapturePart {
  index: number
  title: string
  sentenceIds: number[]
  text: string
}

export interface CaptureSplit {
  parts: CapturePart[]
  splitConfidence: number
  rationale: string
  /** True when the model proposed a split that the confidence gate discarded. */
  gated: boolean
  /** `providerId:modelId` of the stage 1 model, `none` when no split was run. */
  model: string
  latencyMs: number
  /** Non fatal problems (repair retries, consolidation fallbacks). */
  notes: string[]
}

/** The single part every non split capture gets: the original text, verbatim. */
export function singlePartSplit(text: string, rationale: string, extra: Partial<CaptureSplit> = {}): CaptureSplit {
  return {
    parts: [{ index: 0, title: '', sentenceIds: [], text }],
    splitConfidence: 1,
    rationale,
    gated: false,
    model: 'none',
    latencyMs: 0,
    notes: [],
    ...extra,
  }
}

async function defaultCompletion(chain: ResolvedRouterModel[], systemPrompt: string, userPrompt: string): Promise<string> {
  for (const entry of chain) {
    const handle = await buildRouterModel(entry)
    if (!handle) continue
    const response = await completeSimple(handle.model, {
      systemPrompt,
      messages: [{ role: 'user' as const, content: userPrompt, timestamp: Date.now() }],
    }, {
      apiKey: handle.apiKey,
      reasoning: resolveBackgroundReasoning(),
    })
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new Error(response.errorMessage ?? response.stopReason)
    }
    return response.content
      .filter(item => item.type === 'text')
      .map(item => (item as { type: 'text'; text: string }).text)
      .join('')
      .trim()
  }
  throw new Error('no split model available')
}

/** The model that answered, for the record on every part's decision row. */
function chainLabel(options: CaptureSplitOptions, chain: ResolvedRouterModel[]): string {
  if (options.complete) return 'stub'
  return chain[0]?.composite ?? 'none'
}

/**
 * Run the whole split for one capture text. Never throws: every failure path
 * degrades to the single part with the original text, which is exactly today's
 * behaviour.
 */
export async function runCaptureSplit(text: string, options: CaptureSplitOptions = {}): Promise<CaptureSplit> {
  const startedAt = Date.now()
  const sentences = segmentSentences(text)
  if (sentences.length < 2 * SPLIT_MIN_SENTENCES_PER_TOPIC) {
    return singlePartSplit(text, 'too few sentences to split')
  }
  const chain = options.chain ?? resolveRouterChain()
  if (!options.complete && chain.length === 0) {
    return singlePartSplit(text, 'split unavailable: no model', { notes: ['split chain has no available entry'] })
  }
  const complete: SplitCompletion = options.complete
    ?? ((systemPrompt, userPrompt) => defaultCompletion(chain, systemPrompt, userPrompt))
  const model = chainLabel(options, chain)

  let stage1: Stage1Outcome
  try {
    stage1 = await splitCapture(sentences, complete)
  } catch (err) {
    return singlePartSplit(text, 'split unavailable', {
      model,
      latencyMs: Date.now() - startedAt,
      notes: [(err as Error).message],
    })
  }
  const notes = [...stage1.notes]
  const merged = mergeTinyTopics(stage1.answer.topics)
  if (merged.length !== stage1.answer.topics.length) {
    notes.push(`merged ${stage1.answer.topics.length - merged.length} tiny topic(s) into their neighbour`)
  }
  const gated = merged.length > 1 && stage1.answer.splitConfidence < SPLIT_MIN
  if (gated) {
    notes.push(`splitConfidence ${stage1.answer.splitConfidence.toFixed(2)} below ${SPLIT_MIN}, filed as one`)
  }
  if (merged.length <= 1 || gated) {
    return singlePartSplit(text, stage1.answer.rationale, {
      splitConfidence: stage1.answer.splitConfidence,
      gated,
      model,
      latencyMs: Date.now() - startedAt,
      notes,
    })
  }

  const parts = await Promise.all(merged.map(async (topic, index): Promise<CapturePart> => {
    const ids = [...topic.sentenceIds].sort((a, b) => a - b)
    const own = ids.map(id => sentences[id - 1])
    try {
      return { index, title: topic.title, sentenceIds: ids, text: await consolidatePart(topic.title, own, complete) }
    } catch (err) {
      notes.push(`part ${index} consolidation failed (${(err as Error).message}), kept the sentences verbatim`)
      return { index, title: topic.title, sentenceIds: ids, text: own.join(' ') }
    }
  }))

  return {
    parts,
    splitConfidence: stage1.answer.splitConfidence,
    rationale: stage1.answer.rationale,
    gated: false,
    model,
    latencyMs: Date.now() - startedAt,
    notes,
  }
}

/**
 * The part a chat message belongs to, as stored in `chat_messages.metadata`
 * under `capturePart`. Only written for a capture that really has parts.
 */
export interface CapturePartRef {
  index: number
  count: number
  captureId: string
}

/**
 * The one line a part message carries into the persona's context. Without it
 * the persona reads a fragment as the whole utterance and answers a note that
 * was never asked in isolation. Never stored in `chat_messages.content`: the
 * row holds the consolidated part text, the line is added where the context is
 * assembled.
 */
export function capturePartContextLine(part: CapturePartRef, language: CaptureLanguage): string {
  const position = `${part.index + 1}`
  return language === 'en'
    ? `[Part ${position} of ${part.count} of a voice note; original: capture ${part.captureId}]`
    : `[Teil ${position} von ${part.count} einer Sprachnotiz; Original: capture ${part.captureId}]`
}

/** The part line plus the part text, the form the persona sees. */
export function withCapturePartPrefix(content: string, part: CapturePartRef): string {
  if (part.count < 2) return content
  return `${capturePartContextLine(part, captureLanguage(content))}\n${content}`
}

/** Read the `capturePart` marker out of a `chat_messages.metadata` value. */
export function parseCapturePartRef(metadata: string | null | undefined): CapturePartRef | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { capturePart?: Partial<CapturePartRef> } | null
    const part = parsed?.capturePart
    if (!part || typeof part.index !== 'number' || typeof part.count !== 'number' || typeof part.captureId !== 'string') {
      return null
    }
    return { index: part.index, count: part.count, captureId: part.captureId }
  } catch {
    return null
  }
}
