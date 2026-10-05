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
import { createAssistantMessageEventStream, isContextOverflow } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Context, Model, Api, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { adjustMaxTokensForThinking, clampMaxTokensToContext, clampReasoning, clampThinkingBudgetToAnswerRoom, thinkingBudgetForLevel } from '@earendil-works/pi-ai/api/simple-options'
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

/** Learned windows, keyed by sha256(provider|modelId|baseUrl). Process-wide (cross-session), lower-only. */
const observedLimits = new Map<string, ObservedLimit>()

export function modelLimitKey(model: { provider?: unknown; id?: unknown; baseUrl?: unknown }): string {
  return createHash('sha256').update(`${String(model.provider ?? '')}|${String(model.id ?? '')}|${String(model.baseUrl ?? '')}`).digest('hex').slice(0, 32)
}

export function getObservedContextLimit(model: { provider?: unknown; id?: unknown; baseUrl?: unknown }): ObservedLimit | undefined {
  return observedLimits.get(modelLimitKey(model))
}

/** Records a provider-reported window. Only ever lowers a known value. Returns the effective value. */
export function learnContextLimit(model: { provider?: unknown; id?: unknown; baseUrl?: unknown }, tokens: number, source: string): number {
  const key = modelLimitKey(model)
  const prev = observedLimits.get(key)
  if (!Number.isFinite(tokens) || tokens <= 0) return prev?.tokens ?? 0
  const t = Math.floor(tokens)
  if (!prev || t < prev.tokens) observedLimits.set(key, { tokens: t, source: source.slice(0, 300), at: Date.now() })
  return observedLimits.get(key)!.tokens
}

/** Test hook. */
export function resetObservedContextLimits(): void { observedLimits.clear() }

// ---------------------------------------------------------------- provider error parser

export interface ParsedOverflow {
  /** Window the provider reported, if it named one. */
  limit: number | null
  /** Input tokens the provider counted, if it named them. */
  inputTokens: number | null
}

const num = (s: string | undefined): number | null => {
  if (!s) return null
  const n = Number(s.replace(/[,_]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Parses a provider/server overflow error. Returns null for anything that is
 * not an overflow, and ALWAYS null for text written by this guard (marker), so
 * a refusal can never be re-learned as evidence.
 */
export function parseProviderOverflow(text: string | undefined | null): ParsedOverflow | null {
  if (!text || text.includes(CONTEXT_GUARD_MARKER)) return null
  let m: RegExpMatchArray | null
  // OpenAI / vLLM / LiteLLM: "maximum context length is 40960 tokens. However, you requested 61440 tokens (10000 in the messages, 51440 in the completion)"
  if ((m = text.match(/maximum context length is\s+([\d,_]+)\s*tokens?/i))) {
    const input = text.match(/\(([\d,_]+)\s+in the messages/i) ?? text.match(/your (?:prompt|messages?) (?:contains?|resulted in)\s+([\d,_]+)\s+tokens/i)
    return { limit: num(m[1]), inputTokens: num(input?.[1]) }
  }
  // vLLM newer: "This model's maximum context length is …" handled above; "max_model_len" variant
  if ((m = text.match(/max_model_len\s*(?:of|=|is)?\s*([\d,_]+)/i))) return { limit: num(m[1]), inputTokens: null }
  // Anthropic: "prompt is too long: 210000 tokens > 200000 maximum"
  if ((m = text.match(/prompt is too long:\s*([\d,_]+)\s*tokens?\s*>\s*([\d,_]+)/i))) return { limit: num(m[2]), inputTokens: num(m[1]) }
  // Anthropic: "input length and `max_tokens` exceed context limit: 190000 + 21333 > 200000"
  if ((m = text.match(/exceed context limit:\s*([\d,_]+)\s*\+\s*([\d,_]+)\s*>\s*([\d,_]+)/i))) return { limit: num(m[3]), inputTokens: num(m[1]) }
  // llama.cpp server: exceed_context_size_error with n_ctx / n_prompt_tokens
  if (/exceed(?:s|ed)?[_ ]?(?:the )?(?:available )?context[_ ]size/i.test(text) || /exceed_context_size_error/i.test(text)) {
    const ctx = text.match(/"?n_ctx"?\s*[:=]\s*([\d]+)/i)
    const prompt = text.match(/"?n_prompt_tokens"?\s*[:=]\s*([\d]+)/i)
    return { limit: num(ctx?.[1]), inputTokens: num(prompt?.[1]) }
  }
  // Ollama: "prompt too long; exceeded max context length by 123 tokens"
  if (/exceeded max context length/i.test(text)) return { limit: null, inputTokens: null }
  // Generic pi-ai patterns (no number available)
  const probe = { role: 'assistant', stopReason: 'error', errorMessage: text, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } as unknown as AssistantMessage
  try { if (isContextOverflow(probe)) return { limit: null, inputTokens: null } } catch { /* not an overflow */ }
  return null
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
 * functions: buildBaseOptions clamp for every API; Anthropic/Bedrock budget
 * thinking (adjust + clamp + answer room); openai-completions budget field.
 */
export function sdkRequestShape(model: AnyModel, context: Context, options?: SimpleStreamOptions): SdkRequestShape {
  const requested = options?.maxTokens ?? model.maxTokens
  const base = clampMaxTokensToContext(model, context as never, requested)
  const reasoning = options?.reasoning
  const compat = (model as { compat?: Record<string, unknown> }).compat ?? {}
  if (reasoning && (model.api === 'anthropic-messages' || model.api === 'bedrock-converse-stream') && compat.forceAdaptiveThinking !== true) {
    const adjusted = adjustMaxTokensForThinking(base, model.maxTokens, reasoning, options?.thinkingBudgets)
    const maxTokens = clampMaxTokensToContext(model, context as never, adjusted.maxTokens)
    return { maxTokens, thinkingBudget: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)) }
  }
  if (reasoning && reasoning !== ('off' as string) && model.api === 'openai-completions' && model.reasoning) {
    // Budget feeds the budget field AND chat-template kwargs (auto-detected
    // compat), so it is computed whenever reasoning is active.
    const b = clampThinkingBudgetToAnswerRoom(thinkingBudgetForLevel(clampReasoning(reasoning) as never, options?.thinkingBudgets), base)
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
    learnContextLimit(model, parsed.limit, provider)
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
