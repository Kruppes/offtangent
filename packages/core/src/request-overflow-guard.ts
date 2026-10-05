/**
 * request-overflow-guard.ts — universal pre-send context-overflow guard for
 * Normal AND Eco (plan 2026-10-05-real-eco, M4). Wired exactly once, in
 * `buildStreamFn` (provider-config.ts), the per-request function both the
 * interactive AgentRuntime and the TaskRunner hand to pi-agent-core.
 *
 * Invariants (cache safety):
 * - It never edits history, system prompt, tool schemas, model id, thinking
 *   level or reasoning fields. A request that is not refused and for which no
 *   lower window was LEARNED from a provider error is passed to the SDK with
 *   the very same model/context/options objects (wire byte-identical).
 * - Output upper bound = what pi-ai really sends, computed with pi-ai's own
 *   exported option functions (clamp + thinking adjust), never a naive
 *   `model.maxTokens` subtraction (the SDK lowers max_tokens itself).
 * - Estimates are chars-based and honest about it: conservative chars/3 and
 *   the SDK's own optimistic estimate (measured usage + chars/4). A request is
 *   refused before sending only when BOTH say the pure input alone exceeds the
 *   operative window. The gray zone is sent; the provider decides.
 * - A provider overflow error teaches the window for the exact
 *   provider/model/baseUrl key; at most ONE transparent retry happens inside
 *   the same stream call (before any event was forwarded: no tool ran, no
 *   history changed) and only when the learned window changes the request.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createAssistantMessageEventStream, isContextOverflow } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Context, Model, Api, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { adjustMaxTokensForThinking, clampMaxTokensToContext, clampThinkingBudgetToAnswerRoom, thinkingBudgetForLevel } from '@earendil-works/pi-ai/api/simple-options'
import { clampThinkingLevel } from '@earendil-works/pi-ai/models'
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate'

/** Marker on every refusal/explanation this guard writes; never parsed as provider evidence. */
export const CONTEXT_GUARD_MARKER = '[context-guard]'
export const CONSERVATIVE_CHARS_PER_TOKEN = 3
const OPTIMISTIC_CHARS_PER_TOKEN = 4
const MESSAGE_FRAMING_TOKENS = 8
const IMAGE_CHARS = 4800

type AnyModel = Model<Api>
type StreamFn = (model: AnyModel, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream

// ---------------------------------------------------------------- observed limits

export interface ObservedLimit { tokens: number; source: string; at: number }

/**
 * Learned windows, keyed by sha256(provider|modelId|baseUrl). Process-wide
 * (cross-session), lower-only, and PERSISTED to
 * `<DATA_DIR>/config/observed-context-limits.json` so a restart does not
 * forget them (otherwise every restart would pay one more HTTP 400 per model
 * before the guard is effective again). Entries older than
 * OBSERVED_LIMIT_TTL_MS are ignored on load: a local server may be restarted
 * with a larger `-c`/`--max-model-len` under the same id+url, and a stale
 * lower value must not refuse valid requests forever.
 */
export const OBSERVED_LIMIT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Plausible bounds for a provider-reported window; anything outside is never learned. */
export const MIN_LEARNABLE_WINDOW = 1024
export const MAX_LEARNABLE_WINDOW = 16_777_216
/**
 * Closed set of `source` labels that may be persisted. Never upstream text,
 * never prompt/URL data: the label only names the trusted grammar that matched.
 */
export const OVERFLOW_SOURCES = [
  'openai:max-context-length',
  'vllm:max-tokens-too-large',
  'vllm:prompt-longer-than-max-model-len',
  'anthropic:prompt-too-long',
  'anthropic:exceed-context-limit',
  'llamacpp:exceed-context-size',
  'ollama:prompt-too-long',
  'manual',
  'legacy',
] as const
export type OverflowSource = typeof OVERFLOW_SOURCES[number]
const SOURCE_SET: ReadonlySet<string> = new Set(OVERFLOW_SOURCES)
const sanitizeSource = (s: unknown, fallback: OverflowSource): OverflowSource =>
  typeof s === 'string' && SOURCE_SET.has(s) ? s as OverflowSource : fallback
export const isLearnableWindow = (t: unknown): t is number =>
  typeof t === 'number' && Number.isInteger(t) && t >= MIN_LEARNABLE_WINDOW && t <= MAX_LEARNABLE_WINDOW

const observedLimits = new Map<string, ObservedLimit>()
let observedLoadedFrom: string | null = null

export function observedLimitsFilePath(): string {
  return path.join(process.env.DATA_DIR ?? '/data', 'config', 'observed-context-limits.json')
}

/**
 * Lazily (re)loads the persisted store whenever DATA_DIR points to a new file.
 * Never throws. Migration: files written by the first M4 build stored raw
 * upstream error text in `source` and accepted any positive window; on load
 * every entry is re-validated (window bounds, integer, key shape), unknown
 * sources become `legacy`, and the file is rewritten when anything changed so
 * no upstream text stays on disk.
 */
function ensureObservedLoaded(): void {
  const file = observedLimitsFilePath()
  if (observedLoadedFrom === file) return
  observedLoadedFrom = file
  observedLimits.clear()
  let raw: { version?: number; limits?: Record<string, Partial<ObservedLimit>> } | null = null
  try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return /* missing or unreadable: start empty */ }
  let dirty = false
  const now = Date.now()
  const entries = raw && typeof raw === 'object' && raw.limits && typeof raw.limits === 'object' ? Object.entries(raw.limits) : []
  if (!raw || typeof raw !== 'object' || raw.version !== 2) dirty = true
  for (const [k, v] of entries) {
    if (!/^[0-9a-f]{32}$/.test(k) || !v || typeof v !== 'object' || !isLearnableWindow(v.tokens)
      || typeof v.at !== 'number' || !Number.isFinite(v.at) || now - v.at > OBSERVED_LIMIT_TTL_MS) { dirty = true; continue }
    const source = sanitizeSource(v.source, 'legacy')
    if (source !== v.source) dirty = true
    observedLimits.set(k, { tokens: v.tokens, source, at: v.at })
  }
  if (dirty) persistObserved()
}

function persistObserved(): void {
  const file = observedLimitsFilePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    const limits: Record<string, ObservedLimit> = {}
    for (const [k, v] of observedLimits) limits[k] = { tokens: v.tokens, source: sanitizeSource(v.source, 'manual'), at: v.at }
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, limits }, null, 2) + '\n', 'utf-8')
    fs.renameSync(tmp, file)
  } catch { /* persistence is best effort; the in-memory value still applies */ }
}

export function modelLimitKey(model: { provider?: unknown; id?: unknown; baseUrl?: unknown }): string {
  return createHash('sha256').update(`${String(model.provider ?? '')}|${String(model.id ?? '')}|${String(model.baseUrl ?? '')}`).digest('hex').slice(0, 32)
}

export function getObservedContextLimit(model: { provider?: unknown; id?: unknown; baseUrl?: unknown }): ObservedLimit | undefined {
  ensureObservedLoaded()
  const v = observedLimits.get(modelLimitKey(model))
  if (v && Date.now() - v.at > OBSERVED_LIMIT_TTL_MS) return undefined
  return v
}

/**
 * Records a provider-reported window. Only ever lowers a known value; values
 * outside [MIN_LEARNABLE_WINDOW, MAX_LEARNABLE_WINDOW] or non-integers are
 * ignored. `source` must be one of OVERFLOW_SOURCES (anything else is stored
 * as `manual`). Returns the effective value (0 when none).
 */
export function learnContextLimit(model: { provider?: unknown; id?: unknown; baseUrl?: unknown }, tokens: number, source: OverflowSource | string): number {
  ensureObservedLoaded()
  const key = modelLimitKey(model)
  const prev = getObservedContextLimit(model)
  if (!isLearnableWindow(tokens)) return prev?.tokens ?? 0
  if (!prev || tokens < prev.tokens) {
    observedLimits.set(key, { tokens, source: sanitizeSource(source, 'manual'), at: Date.now() })
    persistObserved()
  }
  return observedLimits.get(key)!.tokens
}

/** Test hook: clears memory AND the persisted file. */
export function resetObservedContextLimits(): void {
  observedLimits.clear()
  observedLoadedFrom = observedLimitsFilePath()
  try { fs.rmSync(observedLimitsFilePath(), { force: true }) } catch { /* ignore */ }
}

/** Test hook: simulates a process restart (drops memory only; next access reloads the file). */
export function reloadObservedContextLimitsForTest(): void {
  observedLimits.clear()
  observedLoadedFrom = null
}

// ---------------------------------------------------------------- provider error parser

export interface ParsedOverflow {
  /** Window the provider reported (validated, learnable), or null when it named none. */
  limit: number | null
  /** Input tokens the provider counted, if it named them. */
  inputTokens: number | null
  /** Fixed label of the trusted grammar that matched (persistable). */
  source: OverflowSource
}

const MAX_COUNT = 1_000_000_000
const int = (s: string | undefined): number | null => {
  if (s === undefined || !/^\d{1,10}$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n <= MAX_COUNT ? n : null
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The provider's OWN error object of a parsed error body: the Anthropic
 * envelope `{type:"error",error:{…}}`, the OpenAI body `{error:{…}}`, or the
 * object itself (pi-ai's openai-completions adapter already serializes
 * `body.error`; vLLM returns a flat `{object:"error",message,…}`). If its
 * `message` is itself one complete JSON object (a proxy that re-wrapped the
 * upstream envelope), that nested envelope is decoded once more. User-facing
 * echo fields (`detail`, `input`, arrays, quoted fragments) are never read.
 */
function ownErrorObject(body: unknown, depth = 0): Record<string, unknown> | null {
  if (!isObj(body)) return null
  const own = isObj(body.error) ? body.error : body
  const msg = own.message
  if (depth < 1 && typeof msg === 'string' && /^\{[\s\S]*\}$/.test(msg.trim())) {
    try { return ownErrorObject(JSON.parse(msg), depth + 1) } catch { return null }
  }
  return own
}

/**
 * Anchored grammars over the provider's own `message`. Each grammar fixes
 * where every number comes from and checks the overflow DIRECTION the message
 * asserts (requested/input > window, input + output > window). Note: for an
 * input overflow the input is legitimately LARGER than the window (vLLM
 * "requested 41501 tokens in the messages" with window 40960) — such a
 * message is learned; a message claiming an overflow that its own numbers
 * contradict is not.
 */
function parseOwnMessage(msg: string): { limit: number; inputTokens: number | null; source: OverflowSource } | null {
  let m: RegExpMatchArray | null
  // OpenAI / vLLM (OpenAI-compatible server)
  if ((m = msg.match(/^This model's maximum context length is (\d+) tokens\.? (?:However, )?(.*)$/s))) {
    const limit = int(m[1])
    const rest = m[2]
    if (limit === null) return null
    let r: RegExpMatchArray | null
    // "you requested R tokens (I in the messages, [F in the functions, ]O in the completion)"
    if ((r = rest.match(/^you requested (\d+) tokens \((\d+) in the messages, (?:(\d+) in the functions, )?(\d+) in the completion\)/))) {
      const req = int(r[1]), i = int(r[2]), f = r[3] === undefined ? 0 : int(r[3]), o = int(r[4])
      if (req === null || i === null || f === null || o === null || req <= limit || req !== i + f + o) return null
      return { limit, inputTokens: i + f, source: 'openai:max-context-length' }
    }
    // "you requested I tokens in the messages" / "your messages resulted in I tokens" / "your request has I input tokens"
    if ((r = rest.match(/^(?:you requested (\d+) tokens in the messages|your messages resulted in (\d+) tokens|your request has (\d+) input tokens)\b/))) {
      const i = int(r[1] ?? r[2] ?? r[3])
      if (i === null || i <= limit) return null
      return { limit, inputTokens: i, source: 'openai:max-context-length' }
    }
    return null
  }
  // vLLM: "'max_tokens' or 'max_completion_tokens' is too large: O. This model's maximum context length is N tokens and your request has I input tokens (O > N - I)."
  if ((m = msg.match(/^'max_tokens' or 'max_completion_tokens' is too large: (\d+)\. This model's maximum context length is (\d+) tokens and your request has (\d+) input tokens\b/))) {
    const o = int(m[1]), limit = int(m[2]), i = int(m[3])
    if (o === null || limit === null || i === null || i + o <= limit) return null
    return { limit, inputTokens: i, source: 'vllm:max-tokens-too-large' }
  }
  // vLLM V1: "The prompt (length I) is longer than the maximum model length of N."
  if ((m = msg.match(/^The (?:decoder )?prompt \(length (\d+)\) is longer than the maximum model length of (\d+)\b/))) {
    const i = int(m[1]), limit = int(m[2])
    if (i === null || limit === null || i <= limit) return null
    return { limit, inputTokens: i, source: 'vllm:prompt-longer-than-max-model-len' }
  }
  // Anthropic: "prompt is too long: I tokens > N maximum"
  if ((m = msg.match(/^prompt is too long: (\d+) tokens > (\d+) maximum$/))) {
    const i = int(m[1]), limit = int(m[2])
    if (i === null || limit === null || i <= limit) return null
    return { limit, inputTokens: i, source: 'anthropic:prompt-too-long' }
  }
  // Anthropic: "input length and `max_tokens` exceed context limit: I + O > N, decrease input length or `max_tokens` and try again"
  if ((m = msg.match(/^input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)(?:,|$)/))) {
    const i = int(m[1]), o = int(m[2]), limit = int(m[3])
    if (i === null || o === null || limit === null || i + o <= limit) return null
    return { limit, inputTokens: i, source: 'anthropic:exceed-context-limit' }
  }
  return null
}

/**
 * Parses a provider overflow error AS SERIALIZED BY pi-ai 1.0.0 — and only a
 * trusted one. Measured over a fake HTTP server (see
 * request-overflow-guard.security.test.ts):
 *   openai-completions: `"<status>: <JSON of body.error ?? body>"`, or
 *                       `"<status> <raw text>"` when the body is not JSON
 *   anthropic-messages: `"<status> <JSON envelope>"`
 * Requirements: the WHOLE string is `400|413`, optional colon, one JSON
 * object; the provider's own error object matches an anchored grammar (or the
 * llama.cpp typed integer fields); the window is an integer in
 * [MIN_LEARNABLE_WINDOW, MAX_LEARNABLE_WINDOW]. Anything else — no status,
 * 429/5xx, plain text, echoed diagnostics inside other fields — returns null:
 * the original provider error passes through unchanged and NOTHING is learned
 * (a false negative costs one visible error; a false positive would poison a
 * shared, persisted window for 7 days).
 * ALWAYS null for text written by this guard (marker).
 */
export function parseProviderOverflow(text: string | undefined | null): ParsedOverflow | null {
  if (!text || text.includes(CONTEXT_GUARD_MARKER)) return null
  const env = text.match(/^(400|413):? (\{[\s\S]*\})$/)
  if (!env) return null
  let body: unknown
  try { body = JSON.parse(env[2]) } catch { return null }
  const own = ownErrorObject(body)
  if (!own) return null
  // llama.cpp server: typed integer fields of its own error object.
  if (own.type === 'exceed_context_size_error') {
    const ctx = own.n_ctx, prompt = own.n_prompt_tokens
    if (typeof ctx !== 'number' || typeof prompt !== 'number' || !Number.isSafeInteger(prompt) || prompt < 0 || prompt > MAX_COUNT) return null
    if (!isLearnableWindow(ctx) || prompt < ctx) return null
    return { limit: ctx, inputTokens: prompt, source: 'llamacpp:exceed-context-size' }
  }
  const msg = own.message
  if (typeof msg !== 'string' || msg.length > 2000) return null
  // Ollama (OpenAI-compatible endpoint): names no window; nothing is learned.
  if (/^prompt too long; exceeded max context length by \d+ tokens?$/.test(msg)) return { limit: null, inputTokens: null, source: 'ollama:prompt-too-long' }
  const parsed = parseOwnMessage(msg)
  if (!parsed || !isLearnableWindow(parsed.limit)) return null
  return parsed
}

/**
 * Turn-retry classification only (never used to learn): a context overflow is
 * deterministic, so a 4xx (not 429) whose text pi-ai classifies as overflow is
 * not retried. 429/5xx keep the normal transient classification even if their
 * text mentions context lengths.
 */
export function isDeterministicOverflowError(text: string | undefined | null): boolean {
  if (!text) return false
  if (text.includes(CONTEXT_GUARD_MARKER) || parseProviderOverflow(text) !== null) return true
  const status = text.match(/^(\d{3})(?!\d)/)
  if (!status || !status[1].startsWith('4') || status[1] === '429') return false
  const probe = { role: 'assistant', stopReason: 'error', errorMessage: text, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } as unknown as AssistantMessage
  try { return isContextOverflow(probe) } catch { return false }
}

// ---------------------------------------------------------------- estimates

function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content as Array<Record<string, unknown>>) {
    if (b.type === 'text') n += String(b.text ?? '').length
    else if (b.type === 'thinking') n += String(b.thinking ?? '').length
    else if (b.type === 'image') n += IMAGE_CHARS
    else if (b.type === 'toolCall') n += String(b.name ?? '').length + JSON.stringify(b.arguments ?? {}).length
    else n += JSON.stringify(b).length
  }
  return n
}

export interface RequestEstimate {
  /** System prompt + tool schemas, chars/3. */
  fixedConservative: number
  /** Everything, chars/3 + framing. Safety estimate, not a tokenizer. */
  conservative: number
  /** The SDK's own estimate (measured last usage + chars/4 tail) + chars/4 system/tools when no usage. */
  optimistic: number
  /** Tokens the provider measured for the prefix (last assistant usage), 0 if none. */
  measuredPrefix: number
}

export function estimateRequest(context: Context): RequestEstimate {
  const sysChars = (context.systemPrompt ?? '').length
  const toolChars = (context.tools ?? []).reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length, 0)
  const fixedConservative = Math.ceil((sysChars + toolChars) / CONSERVATIVE_CHARS_PER_TOKEN) + (context.tools?.length ?? 0) * 16
  let messages = 0
  for (const m of context.messages) messages += Math.ceil(contentChars((m as { content: unknown }).content) / CONSERVATIVE_CHARS_PER_TOKEN) + MESSAGE_FRAMING_TOKENS
  let sdk = { tokens: 0, usageTokens: 0 }
  try { sdk = estimateContextTokens(context as never) } catch { /* keep zeros */ }
  const optimistic = sdk.usageTokens > 0 ? sdk.tokens : sdk.tokens + Math.ceil((sysChars + toolChars) / OPTIMISTIC_CHARS_PER_TOKEN)
  return { fixedConservative, conservative: fixedConservative + messages, optimistic, measuredPrefix: sdk.usageTokens }
}

// ---------------------------------------------------------------- SDK request shape

export interface SdkRequestShape {
  /** max_tokens (or equivalent) pi-ai will put on the wire. */
  maxTokens: number
  /** Thinking/reasoning budget pi-ai will send, undefined when none. */
  thinkingBudget: number | undefined
}

/**
 * Mirrors the streamSimple option path of pi-ai 1.0.0 using its OWN exported
 * functions, in the SDK's order:
 * - every API: buildBaseOptions clamp (`clampMaxTokensToContext`).
 * - anthropic-messages / bedrock: `!reasoning` → no thinking; adaptive
 *   (`compat.forceAdaptiveThinking`) → effort only, base max_tokens, no
 *   budget; otherwise adjust + clamp + answer room (budget thinking).
 * - openai-completions: `clampThinkingLevel(model, reasoning)` FIRST (a level
 *   the model maps to null, e.g. `minimal`, is remapped by the SDK to the next
 *   supported one, e.g. `low` = 2048), `off` → none, then the budget the SDK
 *   derives (`resolveClampedThinkingBudget`: ceiling = max_tokens on the wire
 *   when set, else model.maxTokens).
 */
export function sdkRequestShape(model: AnyModel, context: Context, options?: SimpleStreamOptions): SdkRequestShape {
  const requested = options?.maxTokens ?? model.maxTokens
  const base = clampMaxTokensToContext(model, context as never, requested)
  const reasoning = options?.reasoning
  const compat = (model as { compat?: Record<string, unknown> }).compat ?? {}
  if (model.api === 'anthropic-messages' || model.api === 'bedrock-converse-stream') {
    if (!reasoning || compat.forceAdaptiveThinking === true) return { maxTokens: base, thinkingBudget: undefined }
    const adjusted = adjustMaxTokensForThinking(base, model.maxTokens, reasoning, options?.thinkingBudgets)
    const maxTokens = clampMaxTokensToContext(model, context as never, adjusted.maxTokens)
    return { maxTokens, thinkingBudget: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)) }
  }
  if (model.api === 'openai-completions') {
    const level = reasoning ? clampThinkingLevel(model, reasoning) : undefined
    const effort = level === 'off' ? undefined : level
    if (!effort || !model.reasoning) return { maxTokens: base, thinkingBudget: undefined }
    // Budget feeds the budget field AND chat-template kwargs (auto-detected
    // compat). Ceiling: max_tokens is only put on the wire when truthy.
    const ceiling = base ? base : model.maxTokens
    const b = clampThinkingBudgetToAnswerRoom(thinkingBudgetForLevel(effort as never, options?.thinkingBudgets), ceiling)
    return { maxTokens: base, thinkingBudget: b > 0 ? b : undefined }
  }
  return { maxTokens: base, thinkingBudget: undefined }
}

// ---------------------------------------------------------------- decision

export type GuardDecision =
  | { kind: 'send'; model: AnyModel; overridden: boolean; window: number | null; estimate: RequestEstimate }
  | { kind: 'refuse'; reason: 'input_exceeds_window' | 'reserve_needs_reasoning_change'; window: number; windowSource: 'declared' | 'observed'; estimate: RequestEstimate; message: string }

function positive(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null
}

const ADVICE = 'Nothing was sent and no history was changed. Start a new strand (or let a task continue in a fresh one) or switch to a model with a larger context window.'

export function decideRequest(model: AnyModel, context: Context, options?: SimpleStreamOptions): GuardDecision {
  const estimate = estimateRequest(context)
  const declared = positive(model.contextWindow)
  const observed = getObservedContextLimit(model)?.tokens ?? null
  const window = declared !== null && observed !== null ? Math.min(declared, observed) : (observed ?? declared)
  if (window === null) return { kind: 'send', model, overridden: false, window: null, estimate }
  const windowSource: 'declared' | 'observed' = observed !== null && (declared === null || observed < declared) ? 'observed' : 'declared'
  const nums = `estimated input ${estimate.optimistic}–${estimate.conservative} tokens (chars/4 incl. ${estimate.measuredPrefix} measured prefix tokens … chars/3 safety estimate, not a tokenizer count) vs ${windowSource} context window ${window} tokens`
  if (estimate.optimistic > window && estimate.conservative > window) {
    return { kind: 'refuse', reason: 'input_exceeds_window', window, windowSource, estimate,
      message: `${CONTEXT_GUARD_MARKER} Request not sent: the conversation alone no longer fits the model's context window (${nums}). ${ADVICE}` }
  }
  if (windowSource === 'observed') {
    const lowered = { ...model, contextWindow: window } as AnyModel
    const before = sdkRequestShape(model, context, options)
    const after = sdkRequestShape(lowered, context, options)
    if (before.maxTokens === after.maxTokens && before.thinkingBudget === after.thinkingBudget) {
      return { kind: 'send', model, overridden: false, window, estimate }
    }
    if (before.thinkingBudget === after.thinkingBudget) {
      // Single budget: the SDK's own clamp now runs against the learned window.
      return { kind: 'send', model: lowered, overridden: true, window, estimate }
    }
    if (estimate.optimistic + before.maxTokens <= window) return { kind: 'send', model, overridden: false, window, estimate }
    return { kind: 'refuse', reason: 'reserve_needs_reasoning_change', window, windowSource, estimate,
      message: `${CONTEXT_GUARD_MARKER} Request not sent: input plus the output/thinking budget the SDK would request (${before.maxTokens} tokens, thinking ${before.thinkingBudget}) exceed the learned context window (${nums}); fitting it would require changing the thinking budget, which this guard never does. Lower the thinking level, start a new strand or switch to a larger-context model.` }
  }
  return { kind: 'send', model, overridden: false, window, estimate }
}

// ---------------------------------------------------------------- stream wrapper

function errorMessageFor(model: AnyModel, text: string): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error', errorMessage: text, timestamp: Date.now(),
  } as AssistantMessage
}

function refusalStream(model: AnyModel, text: string): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream()
  const msg = errorMessageFor(model, text)
  queueMicrotask(() => { out.push({ type: 'error', reason: 'error', error: msg } as AssistantMessageEvent); out.end(msg) })
  return out
}

export interface GuardStats { refused: number; retried: number; learned: number }
export const guardStats: GuardStats = { refused: 0, retried: 0, learned: 0 }

/**
 * Wraps the final SDK call. `inner` receives exactly the objects it would
 * have received without the guard unless a learned window applies.
 */
export function guardStream(inner: StreamFn): StreamFn {
  return (model, context, options) => {
    let decision: GuardDecision
    try { decision = decideRequest(model, context, options) } catch { return inner(model, context, options) }
    if (decision.kind === 'refuse') { guardStats.refused++; return refusalStream(model, decision.message) }
    const first = inner(decision.model, context, options)
    const out = createAssistantMessageEventStream()
    void pump(first, out, model, context, options, decision, inner)
    return out
  }
}

async function pump(src: AssistantMessageEventStream, out: AssistantMessageEventStream, model: AnyModel, context: Context, options: SimpleStreamOptions | undefined, decision: Extract<GuardDecision, { kind: 'send' }>, inner: StreamFn): Promise<void> {
  const held: AssistantMessageEvent[] = []
  let forwarding = false
  try {
    for await (const ev of src) {
      if (forwarding) { out.push(ev); continue }
      if (ev.type === 'start') { held.push(ev); continue }
      if (ev.type === 'error') {
        const errText = ev.error?.errorMessage ?? ''
        const parsed = parseProviderOverflow(errText)
        if (parsed) {
          const recovered = handleOverflow(model, context, options, decision, parsed, errText)
          if (recovered.kind === 'retry') {
            guardStats.retried++
            // The retry is final: overridden=true disables a second retry; its
            // overflow (if any) becomes the typed fail-fast message.
            const second = inner(recovered.model, context, options)
            await pump(second, out, model, context, options, { ...decision, model: recovered.model, overridden: true }, inner)
            return
          }
          out.push({ type: 'error', reason: ev.reason, error: { ...ev.error, errorMessage: recovered.message } } as AssistantMessageEvent)
          out.end()
          return
        }
      }
      forwarding = true
      for (const h of held) out.push(h)
      held.length = 0
      out.push(ev)
    }
    for (const h of held) out.push(h)
    out.end()
  } catch (err) {
    out.push({ type: 'error', reason: 'error', error: errorMessageFor(model, err instanceof Error ? err.message : String(err)) } as AssistantMessageEvent)
    out.end()
  }
}

function handleOverflow(model: AnyModel, context: Context, options: SimpleStreamOptions | undefined, decision: Extract<GuardDecision, { kind: 'send' }>, parsed: ParsedOverflow, providerText: string): { kind: 'retry'; model: AnyModel } | { kind: 'fail'; message: string } {
  const provider = providerText.slice(0, 600)
  const declared = positive(model.contextWindow)
  const noWindow = declared === null ? ' The model declares no valid context window, so nothing could be checked before sending.' : ''
  if (parsed.limit !== null) {
    learnContextLimit(model, parsed.limit, parsed.source)
    guardStats.learned++
  }
  const measured = parsed.inputTokens !== null ? `provider measured ${parsed.inputTokens} input tokens` : 'provider did not report the input size'
  const limitText = parsed.limit !== null ? `provider-reported window ${parsed.limit} tokens` : 'provider named no window'
  if (parsed.limit !== null && !decision.overridden) {
    const inputFits = parsed.inputTokens === null || parsed.inputTokens < parsed.limit
    if (inputFits && decideRequest(model, context, options).kind === 'send') {
      // Single budget: the retry hands the SDK the learned window, reduced by
      // the tokenizer gap the provider just measured (its input count minus
      // the SDK's own estimate), so pi-ai's ONE clamp produces max_tokens.
      // Never a second budget, never a reasoning-field change.
      let sdkEstimate = 0
      try { sdkEstimate = estimateContextTokens(context as never).tokens } catch { /* 0 */ }
      const gap = parsed.inputTokens !== null ? Math.max(0, parsed.inputTokens - sdkEstimate) : 0
      const learned = getObservedContextLimit(model)?.tokens ?? parsed.limit
      const retryWindow = Math.min(learned, parsed.limit - gap)
      const sent = sdkRequestShape(decision.model, context, options)
      const lowered = { ...model, contextWindow: retryWindow } as AnyModel
      const next = sdkRequestShape(lowered, context, options)
      const inputPlusOut = (parsed.inputTokens ?? decision.estimate.optimistic) + next.maxTokens
      if (retryWindow > 0 && next.maxTokens < sent.maxTokens && next.thinkingBudget === sent.thinkingBudget && inputPlusOut <= parsed.limit) {
        return { kind: 'retry', model: lowered }
      }
    }
  }
  return { kind: 'fail', message: `${CONTEXT_GUARD_MARKER} Context window exceeded (${limitText}; ${measured}; local estimate ${decision.estimate.optimistic}–${decision.estimate.conservative} tokens). ${ADVICE}${noWindow} Provider error: ${provider}` }
}
