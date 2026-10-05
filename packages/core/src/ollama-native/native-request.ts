/**
 * Per-request wiring for the native Ollama provider (plan
 * 2026-10-05-ollama-native-context, M2).
 *
 * Runs ONLY for `model.api === 'ollama-chat'`. The shared `/v1` path and its
 * universal guard (`guardStream`) are not touched.
 *
 * One immutable snapshot per request: the strand's context-window choice is
 * read once, the `/api/show` facts are read once (cached), and the SINGLE
 * `decideNumCtx` result decides both `options.num_ctx` and the window the
 * native guard checks. Nothing is shared between requests, so two strands that
 * stream in parallel can never see each other's choice.
 *
 * Native guard (deterministic, native-specific): pi-ai's SDK clamp does not
 * apply to this api (the native stream maps `maxTokens` to `num_predict` only
 * when the caller sets it), so the shared `sdkRequestShape` is NOT used here.
 * - window = decision.guardWindow (effective num_ctx, or the known baseline),
 *   lowered by a learned limit for the same provider/model/baseUrl AND the same
 *   `num_ctx` (an old window learned at another num_ctx never blocks).
 * - unknown window → nothing is checked (honest: state says baseline_unknown).
 * - input alone above the window → refused, nothing sent, history untouched.
 * - an explicit `maxTokens` (num_predict) that does not fit next to the input →
 *   refused; the output budget is never silently reduced, thinking untouched.
 */
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { CONTEXT_GUARD_MARKER, estimateRequest, getObservedContextLimit } from '../request-overflow-guard.js'
import { decideNumCtx, isValidNumCtx, type ContextWindowChoice, type NumCtxDecision, type OllamaModelFacts } from './context-window.js'
import { getOllamaShowFacts } from './show-facts.js'
import { randomUUID } from 'node:crypto'
import { emitProviderPhase } from '../provider-phase.js'
import { beginLocalInference } from '../local-inference-activity.js'
import { formatNativeRequestDiagnostics, summarizeNativeRequest } from './request-diagnostics.js'

type AnyModel = Model<Api>
type Inner = (model: AnyModel, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream

export interface NativeRequestInput {
  /** Read ONCE per request (the current strand / task session row). */
  getContextWindowChoice?: () => ContextWindowChoice
  /** Explicit provider num_ctx (operator setting) — outranks the modelfile. */
  providerNumCtx?: number
  /** Explicit per-model num_ctx baseline (operator setting for this model id). */
  modelNumCtx?: number
  /** Facts loader injection for tests; production uses the cached `/api/show`. */
  loadFacts?: (model: AnyModel) => Promise<OllamaModelFacts>
  /** Observer for tests/diagnostics: the single decision of this request. */
  onDecision?: (d: NumCtxDecision & { window: number | undefined }) => void
  /**
   * Session (strand / task session) this request belongs to. Used only to
   * route first-token phases to that session's turn watchdog
   * (provider-phase.ts) and as a correlation field in the diagnostics line.
   */
  sessionId?: string
  /** Diagnostics sink for tests; production logs to the console. */
  log?: (line: string) => void
}

/**
 * Events that prove the model is producing output (thinking counts). `done` /
 * `error` end the wait through `request_end` instead.
 */
const OUTPUT_EVENTS: ReadonlySet<string> = new Set([
  'text_start', 'text_delta', 'thinking_start', 'thinking_delta', 'toolcall_start', 'toolcall_delta', 'toolcall_end',
])

/** Learned-limit identity for native: provider/model/baseUrl plus the num_ctx dimension. */
export function nativeLimitIdentity(model: { provider?: unknown; id?: unknown; baseUrl?: unknown }, numCtx: number | undefined): { provider?: unknown; id?: unknown; baseUrl: string } {
  return { provider: model.provider, id: model.id, baseUrl: `${String(model.baseUrl ?? '')}#num_ctx=${numCtx ?? 'default'}` }
}

function failStream(model: AnyModel, text: string): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream()
  const msg = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error', errorMessage: text, timestamp: Date.now(),
  } as AssistantMessage
  queueMicrotask(() => { out.push({ type: 'error', reason: 'error', error: msg } as AssistantMessageEvent); out.end(msg) })
  return out
}

/** Decide the native request: returns the options to send, or a refusal text. */
export function decideNativeRequest(
  model: AnyModel,
  context: Context,
  options: SimpleStreamOptions | undefined,
  choice: ContextWindowChoice,
  facts: OllamaModelFacts,
): { kind: 'send'; options: SimpleStreamOptions | undefined; decision: NumCtxDecision; window: number | undefined } | { kind: 'refuse'; message: string; decision: NumCtxDecision; window: number } {
  const decision = decideNumCtx({ nativeProvider: true, choice, facts })
  const learned = decision.guardWindow !== undefined
    ? getObservedContextLimit(nativeLimitIdentity(model, decision.numCtx ?? decision.guardWindow))?.tokens
    : undefined
  const window = decision.guardWindow !== undefined && learned !== undefined ? Math.min(decision.guardWindow, learned) : decision.guardWindow
  // Unchanged options object when nothing is overridden: no-choice requests stay identical.
  // Native thinking contract: only when /api/show advertises thinking.values.
  const extra: Record<string, unknown> = {}
  if (decision.numCtx !== undefined) extra.ollamaNumCtx = decision.numCtx
  if (facts.thinkValues !== undefined) extra.ollamaThinkValues = facts.thinkValues
  const sendOptions = Object.keys(extra).length > 0 ? ({ ...(options ?? {}), ...extra } as SimpleStreamOptions) : options
  if (window === undefined) return { kind: 'send', options: sendOptions, decision, window }
  const estimate = estimateRequest(context)
  const nums = `estimated input ${estimate.optimistic}–${estimate.conservative} tokens (chars/4 … chars/3 safety estimate, not a tokenizer count) vs native Ollama window ${window} tokens (num_ctx ${decision.numCtx ?? 'not overridden'}, state ${decision.state})`
  if (estimate.optimistic > window && estimate.conservative > window) {
    return { kind: 'refuse', decision, window, message: `${CONTEXT_GUARD_MARKER} Request not sent: the conversation alone no longer fits the native Ollama context window (${nums}). Nothing was sent and no history was changed. Choose a larger context window for this strand, start a new strand or switch models.` }
  }
  const maxTokens = options?.maxTokens
  if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0 && estimate.optimistic + maxTokens > window) {
    return { kind: 'refuse', decision, window, message: `${CONTEXT_GUARD_MARKER} Request not sent: input plus the requested output budget (num_predict ${maxTokens}) exceed the native Ollama context window (${nums}); the output budget is never reduced silently. Choose a larger context window or start a new strand.` }
  }
  return { kind: 'send', options: sendOptions, decision, window }
}

/**
 * Stream wrapper: snapshot → facts → single decision → guard → inner call.
 * Events of the inner stream are forwarded unchanged.
 */
export function streamNativeOllama(inner: Inner, model: AnyModel, context: Context, options: SimpleStreamOptions | undefined, input: NativeRequestInput): AssistantMessageEventStream {
  let choice: ContextWindowChoice = null
  try { choice = input.getContextWindowChoice?.() ?? null } catch { choice = null }
  const out = createAssistantMessageEventStream()
  void (async () => {
    try {
      const loaded = input.loadFacts
        ? await input.loadFacts(model)
        : (await getOllamaShowFacts(model.baseUrl, model.id, { signal: options?.signal })).facts
      const facts: OllamaModelFacts = { ...loaded }
      if (isValidNumCtx(input.providerNumCtx)) facts.providerNumCtx = input.providerNumCtx
      if (isValidNumCtx(input.modelNumCtx)) facts.modelNumCtx = input.modelNumCtx
      const decided = decideNativeRequest(model, context, options, choice, facts)
      input.onDecision?.({ ...decided.decision, window: decided.window })
      if (decided.kind === 'refuse') {
        for await (const ev of failStream(model, decided.message)) out.push(ev)
        out.end()
        return
      }
      const requestId = randomUUID().slice(0, 8)
      const estimatedInputTokens = estimateRequest(context).conservative
      const log = input.log ?? ((line: string) => console.log(line))
      try {
        log(formatNativeRequestDiagnostics({
          requestId, sessionId: input.sessionId, provider: model.provider, model: model.id,
          numCtx: decided.decision.numCtx, numCtxState: decided.decision.state,
          think: (decided.options as { reasoning?: unknown } | undefined)?.reasoning,
          estimatedInputTokens, diag: summarizeNativeRequest(context),
        }))
      } catch { /* diagnostics never break a request */ }
      const sentAt = Date.now()
      let firstAt: number | undefined
      emitProviderPhase(input.sessionId, { phase: 'awaiting_first_token', requestId, estimatedInputTokens })
      // Background work (summary, health check) on the same server+model waits
      // while this lease (plus a short linger) is held — see local-inference-activity.ts.
      const releaseInference = beginLocalInference(model.baseUrl, model.id)
      // Without a done/error event (inner threw) the request failed.
      let end: 'done' | 'error' | 'canceled' = 'error'
      try {
        for await (const ev of inner(model, context, decided.options)) {
          if (firstAt === undefined && OUTPUT_EVENTS.has(ev.type)) {
            firstAt = Date.now()
            emitProviderPhase(input.sessionId, { phase: 'first_token', requestId, elapsedMs: firstAt - sentAt })
          }
          if (ev.type === 'done') end = 'done'
          if (ev.type === 'error') {
            end = ev.reason === 'aborted' || options?.signal?.aborted ? 'canceled' : 'error'
          }
          if (ev.type === 'done' || ev.type === 'error') {
            const msg = (ev.type === 'done' ? ev.message : ev.error) as { usage?: { input?: number; output?: number; cacheRead?: number }; stopReason?: string }
            log(`[native-diag] req=${requestId} end=${ev.type} reason=${msg?.stopReason ?? '-'} first_output_ms=${firstAt === undefined ? '-' : firstAt - sentAt} `
              + `total_ms=${Date.now() - sentAt} prompt_tokens=${msg?.usage?.input ?? '-'} output_tokens=${msg?.usage?.output ?? '-'}`)
          }
          out.push(ev)
        }
      } finally {
        releaseInference()
        if (end === 'error' && options?.signal?.aborted) end = 'canceled'
        emitProviderPhase(input.sessionId, { phase: 'request_end', requestId, end })
      }
      out.end()
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      const fail = failStream(model, text)
      for await (const ev of fail) out.push(ev)
      out.end()
    }
  })()
  return out
}
