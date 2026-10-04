/**
 * eco-policy.ts: the opt-in Eco request view (plan 2026-10-04-eco-implementation).
 *
 * Eco is NOT a second compactor. It is one more pure stage inside the single
 * pre-send hook (`transformContext` in agent-runtime.ts), active only for a
 * strand whose owner switched Eco on. It runs before EVERY LLM request —
 * including each iteration of a tool loop — and returns the VIEW that goes to
 * the provider. The agent transcript is never mutated, so no tool runs twice
 * and the stored tool results (as the tool returned them, possibly already
 * capped by the tool itself) stay in the transcript and the database.
 *
 * Budget, honestly computed:
 *
 *   inputBudget = operativeContext − outputReserve − safetyMargin
 *
 * - operativeContext: the context window declared for the model in the
 *   provider config (for a local runner that is the runner's loaded
 *   `num_ctx`, e.g. Ollama `/api/ps` context_length). Never the architecture
 *   maximum of the weights. Missing → a conservative fallback.
 * - outputReserve: the `maxTokens` the request actually carries. pi-ai sends
 *   `options.maxTokens ?? model.maxTokens` (clamped by pi-ai to the window),
 *   OpenAI-compatible runners count reasoning/thinking inside that same
 *   completion budget and the Anthropic path caps base+thinking at
 *   model.maxTokens, so model.maxTokens bounds answer AND thinking. pi-ai
 *   additionally clamps the sent limit to (window - prompt estimate - 4096).
 *   The reserve is min(maxTokens, window/2) and Eco SETS it as the request's
 *   options.maxTokens, with the effective window (incl. an observed runner
 *   limit) as the model window the SDK clamps against (B1, review ac775c50:
 *   applyEcoStreamLimits in eco-mode-store.ts, wired in buildStreamFn). The
 *   SDK clamps can only lower that value, so wire <= reserve.
 *   (Incident 2026-10-04: the runner reported a PROMPT of 41501 tokens
 *   against n_ctx 40960 — the prompt alone overflowed, output not counted.)
 * - safetyMargin: max(1024, 10 % of the window) because the estimate below is
 *   a conservative calibration, not a tokenizer.
 *
 * The estimate is chars/3 (not the chars/4 of the strand window) plus a small
 * per-message overhead, and it counts the system prompt and the tool schemas,
 * which the strand window ignores.
 *
 * Reduction order, each step only while still over budget:
 *   1. Typed compact views for tool results OLDER than the current tool batch:
 *      deterministic header (tool, call id, status, exit code, size), every
 *      error/failure line, lines with URLs, then the exact head and tail of
 *      the raw text. Never a paraphrase. Errors keep their full message.
 *   2. Drop the oldest atomic segments (an assistant message together with
 *      all of its tool results) between the pinned head (system + first user
 *      message) and the protected tail (last user message onwards).
 *   3. Compact the current batch with a tighter cap.
 *   If the view still does not fit, NOTHING is sent: the caller throws a
 *   typed EcoBudgetError (fail closed) with an actionable message.
 *
 * Safety contract (review 5c5f47a6): a tool result is only shortened or
 * dropped when its ORIGINAL is already persisted and a session-scoped
 * recall reference exists. Without that reference it stays in full; if the
 * request then does not fit, Eco refuses instead of cutting. A compact view
 * is NOT a fact guarantee (head/tail/key lines are heuristics): it carries an
 * explicit loss marker and the recall reference. User messages and the
 * current user turn are never dropped; dropped tool calls stay listed in a
 * side-effect ledger (tool, call id, status, recall id).
 *
 * Deterministic on purpose: the same transcript gives the same view, so the
 * prompt prefix stays byte-stable between calls and the prompt cache holds.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { sanitizeHistoryBoundaries } from './message-history.js'

/** Fallback when a model declares no context window: small on purpose. */
export const ECO_FALLBACK_CONTEXT_WINDOW = 8192
/** Fallback output reserve when a model declares no maxTokens. */
export const ECO_FALLBACK_OUTPUT_RESERVE = 2048
/** Conservative chars-per-token calibration (code/JSON/non-latin text run denser than prose). */
export const ECO_CHARS_PER_TOKEN = 3
/** Upper bounds for the side-effect ledger note (fixed text + per-entry framing incl. recall id). */
const LEDGER_HEADER_CHARS = 600
const LEDGER_ENTRY_BASE_CHARS = 64
/** Per-message framing overhead (role tags, separators) in tokens. */
export const ECO_MESSAGE_OVERHEAD = 8
/** Per-tool framing on the wire beyond the serialized schema, in tokens. */
export const ECO_TOOL_SCHEMA_OVERHEAD = 16
/** Token cost charged for one image block. */
export const ECO_IMAGE_TOKENS = 1500

/** Older tool results above this size are replaced by their compact view. */
export const ECO_COMPACT_THRESHOLD_CHARS = 1500
/** Exact head/tail kept in a compact view of an older result. */
export const ECO_VIEW_HEAD_CHARS = 600
export const ECO_VIEW_TAIL_CHARS = 400
/** Tighter head/tail for the current batch, step 3 only. */
export const ECO_TIGHT_HEAD_CHARS = 2000
export const ECO_TIGHT_TAIL_CHARS = 1500
const MAX_KEY_LINES = 20
const MAX_KEY_LINE_CHARS = 300

export const ECO_VIEW_OPEN = '[eco view'
export const ECO_OMITTED_MARKER = '[eco: '

export interface EcoBudgetInput {
  contextWindow?: number | null
  maxTokens?: number | null
  /** Runtime limit reported by the runner in an earlier overflow error (see parseContextOverflow). */
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
  // the prompt leaves. In Eco the reserve min(declared, window/2) is then
  // SENT as options.maxTokens (applyEcoStreamLimits), so the budget and the
  // wire value are the same number, never a larger SDK-derived one.
  const declaredReserve = positiveInt(model.maxTokens)
  const outputReserve = Math.min(declaredReserve ?? ECO_FALLBACK_OUTPUT_RESERVE, Math.floor(contextWindow / 2))
  const safetyMargin = Math.max(1024, Math.ceil(contextWindow * 0.1))
  const inputBudget = Math.max(0, contextWindow - outputReserve - safetyMargin)
  return { contextWindow, contextFallback: declared === null && observed === null, reserveFallback: declaredReserve === null, outputReserve, safetyMargin, inputBudget }
}

export type EcoRefusalReason =
  | 'no_input_budget'
  | 'fixed_context_too_large'
  | 'current_user_message_too_large'
  | 'current_tool_arguments_too_large'
  | 'current_tool_results_too_large'
  | 'history_not_reducible'
  | 'eco_state_unreadable'
  | 'eco_internal_error'

/** Prefix of every Eco refusal text; the runtime shows it without the "Modellfehler" frame. */
export const ECO_REFUSAL_PREFIX = 'Eco-Modus hat die Anfrage NICHT gesendet'

const REFUSAL_HINT: Record<EcoRefusalReason, string> = {
  no_input_budget: 'Das maxTokens des Modells lässt im Kontextfenster keinen Platz für die Eingabe. Abhilfe: maxTokens des Modells senken oder ein Modell mit größerem Fenster wählen.',
  fixed_context_too_large: 'Systemprompt und Werkzeug-Schemas allein überschreiten das Eingabebudget dieses Modells. Abhilfe: ein Modell mit größerem Kontextfenster oder kleinerem maxTokens wählen oder Eco für diesen Strand ausschalten.',
  current_user_message_too_large: 'Die aktuelle Nachricht ist allein zu groß für das Budget. Abhilfe: Text kürzen oder als Datei hochladen und gezielt lesen lassen, Eco für diesen Strand ausschalten oder ein Modell mit größerem Fenster wählen.',
  current_tool_arguments_too_large: 'Die Werkzeug-Argumente dieses Zuges sind zu groß für das Budget. Abhilfe: Aufgabe in kleinere Schritte teilen oder ein Modell mit größerem Fenster wählen.',
  current_tool_results_too_large: 'Die Werkzeug-Ergebnisse dieses Zuges passen nicht und sind (noch) nicht gespeichert, dürfen also nicht gekürzt werden. Abhilfe: Anfrage wiederholen, gezielter lesen lassen oder Eco ausschalten.',
  history_not_reducible: 'Der bisherige Verlauf passt nicht und enthält Teile ohne gespeicherte Kopie, die Eco nicht verlustfrei kürzen darf. Abhilfe: neuen Strand beginnen, Eco ausschalten oder ein Modell mit größerem Fenster wählen.',
  eco_state_unreadable: 'Der Eco-Schalter dieses Strands konnte nicht gelesen werden. Abhilfe: erneut versuchen; bleibt der Fehler, Datenbank prüfen.',
  eco_internal_error: 'Interner Fehler in der Eco-Aufbereitung. Abhilfe: erneut versuchen oder Eco für diesen Strand ausschalten.',
}

/**
 * Typed fail-closed refusal: thrown from the pre-send hook instead of sending
 * an over-budget or unsafely cut request. Its message is user-facing and
 * deliberately free of provider overflow phrasing, so it is never parsed as a
 * runner overflow (parseContextOverflow) or retried as a transient error.
 */
export class EcoBudgetError extends Error {
  readonly code = 'ECO_BUDGET_REFUSED'
  constructor(
    readonly reason: EcoRefusalReason,
    readonly estimatedTokens: number | null = null,
    readonly inputBudget: number | null = null,
  ) {
    const numbers = estimatedTokens !== null && inputBudget !== null
      ? ` (geschätzt ${estimatedTokens} Tokens, Budget ${inputBudget}; Schätzung chars/3, kein Tokenizer)`
      : ''
    super(`${ECO_REFUSAL_PREFIX}${numbers}. ${REFUSAL_HINT[reason]}`)
    this.name = 'EcoBudgetError'
  }
}

export function isEcoRefusalText(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.startsWith(ECO_REFUSAL_PREFIX)
}

export interface ContextOverflow {
  /** Tokens the runner says the request needed, when stated. */
  requested: number | null
  /** Context limit the runner says it has, when stated. */
  limit: number | null
}

const OVERFLOW_TEXT = /(context (?:length|size|window)|maximum context|prompt is too long|too many tokens|exceeds? the (?:available )?context|context_length_exceeded|n_ctx)/i

/**
 * Recognise a provider/runner context-overflow error and pull the numbers it
 * states. Covers the llama.cpp/Ollama phrasing ("request (41501 tokens)
 * exceeds the available context size (40960 tokens)"), OpenAI
 * ("maximum context length is 40960 tokens … resulted in 41501 tokens") and
 * a bare "41501 > 40960". Returns null for anything else.
 */
export function parseContextOverflow(message: string | null | undefined): ContextOverflow | null {
  if (!message || !OVERFLOW_TEXT.test(message)) return null
  // OpenAI / vLLM state the runner maximum explicitly; that sentence wins over
  // any arithmetic in the same message. vLLM e.g. "This model's maximum
  // context length is 65536 tokens and your request has 24632 input tokens
  // (43148 > 65536 - 24632)" or "… However, you requested 45000 tokens
  // (41000 in the messages, 4000 in the completion)". The LIMIT is only ever
  // the stated maximum, never a requested total.
  const stated = /maximum context length (?:is|of) (\d{3,8})(?: tokens)?|maximum context length \((\d{3,8})(?: tokens)?\)/i.exec(message)
  if (stated) {
    const limit = Number(stated[1] ?? stated[2])
    const req = /resulted in (\d{3,8})|requested (\d{3,8})|request has (\d{3,8}) input tokens|input length \((\d{3,8})\)/i.exec(message)
    return { requested: req ? Number(req[1] ?? req[2] ?? req[3] ?? req[4]) : null, limit }
  }
  const llama = /\((\d{3,8}) tokens\)[^()]*context size \((\d{3,8}) tokens\)/i.exec(message)
  if (llama) return { requested: Number(llama[1]), limit: Number(llama[2]) }
  // Bare "41501 > 40960" only when it is the whole comparison (not the left
  // side of "a > b - c", where b would not be a context limit of its own;
  // the \b stops the digits from backtracking into a shorter bogus number).
  const bare = /\b(\d{3,8})\s*>\s*(\d{3,8})\b(?!\s*[-+])/.exec(message)
  if (bare) return { requested: Number(bare[1]), limit: Number(bare[2]) }
  return { requested: null, limit: null }
}

/**
 * Overflow recovery input: scan the transcript for the newest failed
 * assistant turn whose error is a context overflow. The transcript is only
 * read; the retry is the next request through the same budgeted view, so no
 * tool runs again.
 */
export function findLastContextOverflow(messages: readonly AgentMessage[]): ContextOverflow | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: string }
    if (m.role !== 'assistant' || m.stopReason !== 'error') continue
    const hit = parseContextOverflow(m.errorMessage)
    if (hit) return hit
  }
  return null
}

export function estimateEcoTextTokens(text: string): number {
  return Math.ceil(text.length / ECO_CHARS_PER_TOKEN)
}

/** Conservative estimate of one message as it is replayed to the provider. */
export function estimateEcoMessageTokens(msg: AgentMessage): number {
  const message = msg as { content?: unknown }
  const content = message.content
  let n = ECO_MESSAGE_OVERHEAD
  if (typeof content === 'string') return n + estimateEcoTextTokens(content)
  if (!Array.isArray(content)) return n + estimateEcoTextTokens(JSON.stringify(content ?? ''))
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'image') n += ECO_IMAGE_TOKENS
    else if (b.type === 'text' && typeof b.text === 'string') n += estimateEcoTextTokens(b.text)
    else if (b.type === 'thinking') {
      if (typeof b.thinking === 'string') n += estimateEcoTextTokens(b.thinking)
      if (typeof b.thinkingSignature === 'string') n += estimateEcoTextTokens(b.thinkingSignature)
    } else n += estimateEcoTextTokens(JSON.stringify(b))
  }
  return n
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

interface ToolResultLike {
  role: 'toolResult'
  details?: unknown
  toolCallId?: string
  toolName?: string
  isError?: boolean
  content?: unknown
}

function isToolResult(msg: AgentMessage): msg is AgentMessage & ToolResultLike {
  return (msg as { role?: string }).role === 'toolResult'
}

function toolResultText(msg: ToolResultLike): { text: string; images: number } {
  const content = msg.content
  if (typeof content === 'string') return { text: content, images: 0 }
  if (!Array.isArray(content)) return { text: JSON.stringify(content ?? ''), images: 0 }
  const parts: string[] = []
  let images = 0
  for (const block of content) {
    const b = block as { type?: string; text?: unknown }
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b?.type === 'image') images++
  }
  return { text: parts.join('\n'), images }
}

/** Bound on recall references listed in the omitted-messages note. */

const ERROR_LINE = /\b(error|errors|failed|failure|fatal|exception|traceback|denied|forbidden|not found|panic|exit (?:code|status)|ENOENT|EACCES|ETIMEDOUT|ECONNREFUSED)\b/i
const URL_LINE = /https?:\/\/\S+/
const EXIT_CODE = /\bexit(?:ed)?(?: with)?(?: code| status)?[:= ]\s*(-?\d{1,3})\b/i

function clipLine(line: string): string {
  return line.length > MAX_KEY_LINE_CHARS ? `${line.slice(0, MAX_KEY_LINE_CHARS)}…` : line
}

/**
 * Deterministic typed view of one tool result. Exact head/tail (no paraphrase),
 * all error/URL lines in between, and a header with the facts a later step
 * needs: tool, call id, status, exit code, original size.
 */
export function renderEcoToolView(msg: ToolResultLike, headChars: number, tailChars: number, recallId?: number): string | null {
  const { text, images } = toolResultText(msg)
  if (text.length <= headChars + tailChars + 200 && images === 0) return null
  const lines = text.split('\n')
  const exit = EXIT_CODE.exec(text)?.[1]
  const header = [
    `${ECO_VIEW_OPEN} of tool result`,
    `tool=${msg.toolName ?? 'unknown'}`,
    `call=${msg.toolCallId ?? 'unknown'}`,
    `status=${msg.isError ? 'error' : 'ok'}`,
    ...(exit !== undefined ? [`exit=${exit}`] : []),
    `stored=${text.length} chars/${lines.length} lines`,
    ...(toolCapped(msg) ? [`tool_capped=true${toolCapTotal(msg)}`] : []),
    ...(images > 0 ? [`images=${images} omitted`] : []),
  ].join(' · ') + ']'
  const head = text.slice(0, headChars)
  const tail = text.length > headChars ? text.slice(Math.max(headChars, text.length - tailChars)) : ''
  // Key lines only from the hidden middle: head and tail are already exact.
  const middleStart = head.length
  const middleEnd = text.length - tail.length
  const keyLines: string[] = []
  if (middleEnd > middleStart) {
    for (const line of text.slice(middleStart, middleEnd).split('\n')) {
      if (keyLines.length >= MAX_KEY_LINES) break
      if (ERROR_LINE.test(line) || URL_LINE.test(line)) keyLines.push(clipLine(line))
    }
  }
  const out = [header, '--- head (exact) ---', head]
  if (keyLines.length > 0) out.push('--- key lines from the omitted middle (exact) ---', ...keyLines)
  if (tail) out.push(`--- tail (exact, ${middleEnd - middleStart} chars omitted before) ---`, tail)
  // Reload path: recall_message is scoped to the caller's user and persona
  // and pages with `offset`, so the STORED result (as the tool returned it,
  // possibly tool-capped) stays reachable without a
  // second execution of a tool that may have side effects.
  // Callers only render a view when a recall reference exists (safety
  // contract above); without one there is no view at all.
  if (recallId === undefined) return null
  out.push(`[eco: LOSSY view. Head/tail/key lines are a heuristic, values in the omitted middle (numbers, ids, paths) may be missing here. `
    + `The stored result is message ${recallId}: call recall_message with message_id=${recallId} and part="result" (page with offset) for the exact text instead of re-running the tool`
    + (toolCapped(msg) ? '. Note: the tool itself already capped this output before it was stored; the stored text is that capped output, not the raw output' : '')
    + ']')
  return out.join('\n')
}

function toolCapped(msg: ToolResultLike): boolean {
  const d = msg.details as { truncated?: unknown } | undefined
  return !!d && typeof d === 'object' && d.truncated === true
}

function toolCapTotal(msg: ToolResultLike): string {
  const d = msg.details as { totalChars?: unknown } | undefined
  return d && typeof d.totalChars === 'number' ? ` raw_total=${d.totalChars} chars` : ''
}

function withViewText(msg: AgentMessage & ToolResultLike, view: string): AgentMessage {
  return { ...msg, content: [{ type: 'text', text: view }] } as AgentMessage
}

export interface EcoViewInput {
  messages: readonly AgentMessage[]
  budget: EcoBudget
  /** System prompt + tool schemas, from estimateEcoFixedTokens. 0 when the system prompt is a message. */
  fixedTokens: number
  /** Persisted chat row of a tool result (by tool call id), for recall_message references. */
  resolveRecallId?: (toolCallId: string) => number | undefined
}

export interface EcoViewResult {
  messages: AgentMessage[]
  changed: boolean
  tokensBefore: number
  tokensAfter: number
  compacted: number
  dropped: number
  /** Large tool results left in full because no recall reference exists. */
  unrecallable: number
  /** Dropped tool calls listed in the side-effect ledger note. */
  ledger: number
  /** No safe view fits; `messages` is the untouched input and MUST NOT be sent. */
  degraded: boolean
  refusal: EcoRefusalReason | null
}

function sumTokens(messages: readonly AgentMessage[], fixed: number): number {
  let n = fixed
  for (const m of messages) n += estimateEcoMessageTokens(m)
  return n
}

/** Index of the first message of the current tool batch (the last assistant message), or messages.length. */
function currentBatchStart(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string }).role === 'assistant') return i
    if ((messages[i] as { role?: string }).role === 'user') return i + 1
  }
  return 0
}

function lastUserIndex(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if ((messages[i] as { role?: string }).role === 'user') return i
  return -1
}

/**
 * Build the Eco request view. Pure: no I/O, the input array and its messages
 * are never mutated. Returns `refusal` (and the unchanged input) when no safe
 * view fits; the caller must then refuse the request (EcoBudgetError).
 */
export function buildEcoView(input: EcoViewInput): EcoViewResult {
  const { budget, fixedTokens } = input
  const recallIdOf = (m: ToolResultLike): number | undefined => {
    if (!input.resolveRecallId || typeof m.toolCallId !== 'string' || !m.toolCallId) return undefined
    try {
      const id = input.resolveRecallId(m.toolCallId)
      return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined
    } catch {
      return undefined
    }
  }
  const original = input.messages
  let messages = original.slice()
  const tokensBefore = sumTokens(messages, fixedTokens)
  const base = { tokensBefore, compacted: 0, dropped: 0, unrecallable: 0, ledger: 0 }
  if (tokensBefore <= budget.inputBudget) {
    return { messages, changed: false, tokensAfter: tokensBefore, degraded: false, refusal: null, ...base }
  }
  if (budget.inputBudget <= 0) {
    return { messages: original.slice(), changed: false, tokensAfter: tokensBefore, degraded: true, refusal: 'no_input_budget', ...base }
  }

  const batchStart = currentBatchStart(messages)
  const pinnedUser = lastUserIndex(messages)
  const unrecallable = new Set<string>()
  const noteUnrecallable = (m: ToolResultLike, i: number) => unrecallable.add(m.toolCallId ?? `#${i}`)

  // Step 1: compact every tool result older than the current batch — only
  // when its original is persisted (recall reference). All of them, not
  // "just enough": a result's view must not depend on how large the newest
  // message is, or the prefix would move on every call.
  let compacted = 0
  messages = messages.map((m, i) => {
    if (i >= batchStart || !isToolResult(m)) return m
    const { text, images } = toolResultText(m)
    if (text.length < ECO_COMPACT_THRESHOLD_CHARS && images === 0) return m
    const id = recallIdOf(m)
    if (id === undefined) { noteUnrecallable(m, i); return m }
    const view = renderEcoToolView(m, ECO_VIEW_HEAD_CHARS, ECO_VIEW_TAIL_CHARS, id)
    if (!view) return m
    compacted++
    return withViewText(m, view)
  })
  let tokens = sumTokens(messages, fixedTokens)

  // Step 2: drop the oldest atomic segments (an assistant message with all of
  // its tool results) after the pinned head and BEFORE the current user
  // message. User messages are never dropped, the current user turn is never
  // touched, and a segment is only dropped when every tool result in it has a
  // recall reference. Every dropped tool call stays in the side-effect ledger.
  let dropped = 0
  let ledgerCount = 0
  if (tokens > budget.inputBudget) {
    const firstUser = messages.findIndex(m => (m as { role?: string }).role === 'user')
    // Older batches of the CURRENT user turn (an agentic tool loop) are
    // droppable too — otherwise a long single-turn loop could never fit —
    // but only with their full ledger entry (marked "current turn") so the
    // side effects of this turn can never be forgotten and redone. The
    // current batch itself is never dropped.
    const stop = batchStart
    let cut = firstUser >= 0 ? firstUser + 1 : Math.max(0, messages.findIndex(m => (m as { role?: string }).role !== 'system'))
    const drop = new Set<number>()
    while (tokens > budget.inputBudget && cut < stop) {
      let end = cut + 1
      while (end < stop && isToolResult(messages[end])) end++
      const role = (messages[cut] as { role?: string }).role
      // Only tool-call segments are droppable: a pure-text assistant answer
      // has no recall reference here, so it is kept.
      let safe = role === 'assistant' && end > cut + 1
      for (let i = cut + 1; safe && i < end; i++) {
        if (recallIdOf(messages[i] as ToolResultLike) === undefined) { safe = false; noteUnrecallable(messages[i] as ToolResultLike, i) }
      }
      if (safe) {
        // The ledger note grows with every dropped call; count its cost while
        // dropping, or the final view overshoots and is wrongly refused.
        if (drop.size === 0) tokens += Math.ceil(LEDGER_HEADER_CHARS / ECO_CHARS_PER_TOKEN)
        for (let i = cut; i < end; i++) {
          tokens -= estimateEcoMessageTokens(messages[i])
          const m = messages[i] as ToolResultLike
          if (isToolResult(messages[i])) tokens += Math.ceil((LEDGER_ENTRY_BASE_CHARS + (m.toolName?.length ?? 4) + (m.toolCallId?.length ?? 1)) / ECO_CHARS_PER_TOKEN)
          drop.add(i)
        }
      }
      cut = end
    }
    dropped = drop.size
    if (dropped > 0) {
      // Side-effect ledger: EVERY dropped tool call (no cap), so what already
      // happened can never be "forgotten" and redone.
      const ledger: string[] = []
      let droppedText = 0
      for (const i of [...drop].sort((a, b) => a - b)) {
        const m = messages[i] as AgentMessage & ToolResultLike
        if (isToolResult(m)) {
          ledger.push(`${m.toolName ?? 'tool'} call=${m.toolCallId ?? '?'} status=${m.isError ? 'error' : 'ok'} recall=${recallIdOf(m)}${i > pinnedUser ? ' (current turn)' : ''}`)
        } else if (assistantHasText(m)) droppedText++
      }
      ledgerCount = ledger.length
      const noteText = `${ECO_OMITTED_MARKER}${dropped} older messages are NOT in this request (local budget). `
        + (droppedText > 0 ? `LOSS: ${droppedText} of them carried assistant text next to the tool calls; that text is not in this request. ` : '')
        + (ledger.length > 0
          ? `Already executed tool calls — do NOT repeat them; exact results via recall_message(message_id=<recall>, part="result"): ${ledger.join('; ')}.`
          : '')
        + ']'
      const noteAt = pinnedUser >= 0 && !drop.has(pinnedUser) ? pinnedUser : firstUser
      messages = messages
        .map((m, i) => {
          if (i !== noteAt) return m
          const c = (m as { content?: unknown }).content
          const content = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []
          return { ...m, content: [{ type: 'text', text: noteText }, ...content] } as AgentMessage
        })
        .filter((_, i) => !drop.has(i))
      tokens = sumTokens(messages, fixedTokens)
    }
  }

  // Step 3: tighter views for the current batch, again only with a recall
  // reference. Errors and key lines survive inside the view; the header
  // marks the result as shortened.
  if (tokens > budget.inputBudget) {
    const start = currentBatchStart(messages)
    messages = messages.map((m, i) => {
      if (i < start || !isToolResult(m)) return m
      const id = recallIdOf(m)
      if (id === undefined) { noteUnrecallable(m, i); return m }
      const view = renderEcoToolView(m, ECO_TIGHT_HEAD_CHARS, ECO_TIGHT_TAIL_CHARS, id)
      if (!view) return m
      compacted++
      return withViewText(m, view)
    })
    tokens = sumTokens(messages, fixedTokens)
  }

  // Structural net: the drop walk keeps pairs intact, this proves it.
  const sanitized = sanitizeHistoryBoundaries(messages).messages
  const tokensAfter = sumTokens(sanitized, fixedTokens)
  const stats = { tokensBefore, compacted, dropped, unrecallable: unrecallable.size, ledger: ledgerCount }
  if (tokensAfter <= budget.inputBudget) {
    return { messages: sanitized, changed: true, tokensAfter, degraded: false, refusal: null, ...stats }
  }
  return { messages: original.slice(), changed: false, tokensAfter, degraded: true, refusal: classifyRefusal(sanitized, fixedTokens, budget.inputBudget), ...stats }
}

function assistantHasText(m: AgentMessage): boolean {
  const c = (m as { content?: unknown }).content
  if (typeof c === 'string') return c.trim().length > 0
  return Array.isArray(c) && c.some(b => (b as { type?: string; text?: string }).type === 'text' && !!(b as { text?: string }).text?.trim())
}

/** Why a view could not be made to fit: the irreducible current turn first. */
function classifyRefusal(messages: readonly AgentMessage[], baseFixedTokens: number, inputBudget: number): EcoRefusalReason {
  const userAt = lastUserIndex(messages)
  // A system prompt that travels as a 'system' message is fixed context too
  // (Eco never shortens it); counting it as history would blame the
  // transcript for a refusal the system prompt + tool schemas caused.
  let fixedTokens = baseFixedTokens
  for (const m of messages) if ((m as { role?: string }).role === 'system') fixedTokens += estimateEcoMessageTokens(m)
  if (fixedTokens >= inputBudget * 0.9) return 'fixed_context_too_large'
  if (userAt >= 0 && fixedTokens + estimateEcoMessageTokens(messages[userAt]) > inputBudget) return 'current_user_message_too_large'
  let args = 0
  let results = 0
  for (let i = Math.max(0, userAt + 1); i < messages.length; i++) {
    const m = messages[i]
    if (isToolResult(m)) results += estimateEcoMessageTokens(m)
    else if ((m as { role?: string }).role === 'assistant') args += estimateEcoMessageTokens(m)
  }
  const room = inputBudget - fixedTokens - (userAt >= 0 ? estimateEcoMessageTokens(messages[userAt]) : 0)
  if (args > room / 2 && args >= results) return 'current_tool_arguments_too_large'
  if (results > room / 2) return 'current_tool_results_too_large'
  return 'history_not_reducible'
}
