/**
 * eco-policy.ts: display-only context budget for the Eco status card
 * (plan 2026-10-05-real-eco). It is NOT applied to requests: real Eco never
 * refuses, cuts or re-renders already-sent context and never changes
 * maxTokens/thinking/window. It only freezes NEW tool results smaller at
 * creation (eco-tool-freeze.ts). The previous request-view/admission stage
 * (buildEcoView, renderEcoToolView, EcoBudgetError) was removed with it.
 *
 *   inputBudget = operativeContext − outputReserve − safetyMargin   (estimate)
 */

/** Fallback when a model declares no context window: small on purpose. */
export const ECO_FALLBACK_CONTEXT_WINDOW = 8192
/** Fallback output reserve when a model declares no maxTokens. */
export const ECO_FALLBACK_OUTPUT_RESERVE = 2048
/** Conservative chars-per-token calibration (code/JSON/non-latin text run denser than prose). */
export const ECO_CHARS_PER_TOKEN = 3
/** Per-message framing overhead (role tags, separators) in tokens. */
export const ECO_MESSAGE_OVERHEAD = 8
/** Per-tool framing on the wire beyond the serialized schema, in tokens. */
export const ECO_TOOL_SCHEMA_OVERHEAD = 16

export interface EcoBudgetInput {
  contextWindow?: number | null
  maxTokens?: number | null
  /** Runtime limit reported by the runner in an earlier overflow error. */
  observedContextLimit?: number | null
}

export interface EcoBudget {
  /** True when no maxTokens was declared and ECO_FALLBACK_OUTPUT_RESERVE was used. */
  reserveFallback?: boolean
  /** Operative context the budget is derived from. */
  contextWindow: number
  /** True when the model declared no window and the fallback was used. */
  contextFallback: boolean
  outputReserve: number
  safetyMargin: number
  /** What the prompt (system + tools + messages) may cost. */
  inputBudget: number
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

export function resolveEcoBudget(model: EcoBudgetInput): EcoBudget {
  const declared = positiveInt(model.contextWindow)
  const observed = positiveInt(model.observedContextLimit)
  // A limit the runner itself reported in an overflow error is evidence; it
  // can only LOWER the operative window, never raise it above the declared one.
  const base = declared ?? ECO_FALLBACK_CONTEXT_WINDOW
  const contextWindow = observed !== null ? Math.min(base, observed) : base
  // The reserve follows the SDK's real request semantics: pi-ai sends
  // max_tokens = min(options.maxTokens ?? model.maxTokens,
  //                  contextWindow - estimate(chars/4) - 4096)
  // (simple-options.ts clampMaxTokensToContext, used by every streamSimple
  // API incl. openai-completions). So a declared maxTokens >= the window is
  // never actually requested in full: the request limit shrinks to the room
  // the prompt leaves. Display only: real Eco never changes the request's
  // maxTokens, thinking or window (plan 2026-10-05-real-eco).
  const declaredReserve = positiveInt(model.maxTokens)
  const outputReserve = Math.min(declaredReserve ?? ECO_FALLBACK_OUTPUT_RESERVE, Math.floor(contextWindow / 2))
  const safetyMargin = Math.max(1024, Math.ceil(contextWindow * 0.1))
  const inputBudget = Math.max(0, contextWindow - outputReserve - safetyMargin)
  return { contextWindow, contextFallback: declared === null && observed === null, reserveFallback: declaredReserve === null, outputReserve, safetyMargin, inputBudget }
}

export function estimateEcoTextTokens(text: string): number {
  return Math.ceil(text.length / ECO_CHARS_PER_TOKEN)
}

/** System prompt + tool schemas: sent with every request, invisible to the transcript window. */
export function estimateEcoFixedTokens(systemPrompt: string | undefined, tools: readonly unknown[] | undefined): number {
  let n = systemPrompt ? estimateEcoTextTokens(systemPrompt) + ECO_MESSAGE_OVERHEAD : 0
  for (const tool of tools ?? []) {
    const t = tool as { name?: unknown; description?: unknown; parameters?: unknown }
    // Provider wire format wraps each schema ({"type":"function","function":{…}}
    // or Anthropic's input_schema); charge that framing on top of the schema.
    n += estimateEcoTextTokens(JSON.stringify({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) + ECO_TOOL_SCHEMA_OVERHEAD
  }
  return n
}

