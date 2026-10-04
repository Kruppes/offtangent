/**
 * eco-policy.ts: the opt-in Eco request view (plan 2026-10-04-eco-implementation).
 *
 * Eco is NOT a second compactor. It is one more pure stage inside the single
 * pre-send hook (`transformContext` in agent-runtime.ts), active only for a
 * strand whose owner switched Eco on. It runs before EVERY LLM request —
 * including each iteration of a tool loop — and returns the VIEW that goes to
 * the provider. The agent transcript is never mutated, so no tool runs twice
 * and the raw results stay in the transcript and the database.
 *
 * Budget, honestly computed:
 *
 *   inputBudget = operativeContext − outputReserve − safetyMargin
 *
 * - operativeContext: the context window declared for the model in the
 *   provider config (for a local runner that is the runner's loaded
 *   `num_ctx`, e.g. Ollama `/api/ps` context_length). Never the architecture
 *   maximum of the weights. Missing → a conservative fallback.
 * - outputReserve: the model's `maxTokens`. OpenAI-compatible runners count
 *   reasoning/thinking tokens inside the same completion budget, so the
 *   reserve covers thinking too. (Diagnosis 2026-10-04: 41501 > 40960 with a
 *   ~33k prompt and 8192 maxTokens — nobody reserved the output.)
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
 *   3. Compact the current batch with a tighter cap. If the view still does
 *      not fit, it is sent anyway and flagged `degraded`: the provider's own
 *      error stays visible instead of facts silently vanishing.
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
/** Per-message framing overhead (role tags, separators) in tokens. */
export const ECO_MESSAGE_OVERHEAD = 8
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
}

export interface EcoBudget {
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
  const contextWindow = declared ?? ECO_FALLBACK_CONTEXT_WINDOW
  // A maxTokens at or above the window would leave no room for any prompt;
  // cap the reserve at half the window so the request stays possible.
  const outputReserve = Math.min(positiveInt(model.maxTokens) ?? ECO_FALLBACK_OUTPUT_RESERVE, Math.floor(contextWindow / 2))
  const safetyMargin = Math.max(1024, Math.ceil(contextWindow * 0.1))
  const inputBudget = Math.max(0, contextWindow - outputReserve - safetyMargin)
  return { contextWindow, contextFallback: declared === null, outputReserve, safetyMargin, inputBudget }
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
    n += estimateEcoTextTokens(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }))
  }
  return n
}

interface ToolResultLike {
  role: 'toolResult'
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
export function renderEcoToolView(msg: ToolResultLike, headChars: number, tailChars: number): string | null {
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
    `original=${text.length} chars/${lines.length} lines`,
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
  out.push('[eco: the full result is unchanged in the transcript and database; repeat the call or re-read the source if you need more]')
  return out.join('\n')
}

function withViewText(msg: AgentMessage & ToolResultLike, view: string): AgentMessage {
  return { ...msg, content: [{ type: 'text', text: view }] } as AgentMessage
}

export interface EcoViewInput {
  messages: readonly AgentMessage[]
  budget: EcoBudget
  /** System prompt + tool schemas, from estimateEcoFixedTokens. 0 when the system prompt is a message. */
  fixedTokens: number
}

export interface EcoViewResult {
  messages: AgentMessage[]
  changed: boolean
  tokensBefore: number
  tokensAfter: number
  compacted: number
  dropped: number
  /** The view still exceeds the budget after every step. */
  degraded: boolean
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
 * are never mutated.
 */
export function buildEcoView(input: EcoViewInput): EcoViewResult {
  const { budget, fixedTokens } = input
  let messages = input.messages.slice()
  const tokensBefore = sumTokens(messages, fixedTokens)
  const base = { tokensBefore, compacted: 0, dropped: 0 }
  if (tokensBefore <= budget.inputBudget) {
    return { messages, changed: false, tokensAfter: tokensBefore, degraded: false, ...base }
  }

  // Step 1: compact every tool result older than the current batch. All of
  // them, not "just enough": a result's view must not depend on how large
  // the newest message is, or the prefix would move on every call.
  const batchStart = currentBatchStart(messages)
  let compacted = 0
  messages = messages.map((m, i) => {
    if (i >= batchStart || !isToolResult(m)) return m
    const { text } = toolResultText(m)
    if (text.length < ECO_COMPACT_THRESHOLD_CHARS) return m
    const view = renderEcoToolView(m, ECO_VIEW_HEAD_CHARS, ECO_VIEW_TAIL_CHARS)
    if (!view) return m
    compacted++
    return withViewText(m, view)
  })
  let tokens = sumTokens(messages, fixedTokens)

  // Step 2: drop the oldest atomic segments between the pinned head and the
  // protected tail (last user message onwards). A segment starts at a user or
  // assistant message and carries every toolResult that follows it, so a
  // tool call never loses its result (or vice versa).
  let dropped = 0
  if (tokens > budget.inputBudget) {
    const firstUser = messages.findIndex(m => (m as { role?: string }).role === 'user')
    const pinnedUser = lastUserIndex(messages)
    let cut = firstUser >= 0 ? firstUser + 1 : Math.max(0, messages.findIndex(m => (m as { role?: string }).role !== 'system'))
    const drop = new Set<number>()
    while (tokens > budget.inputBudget && cut < batchStart) {
      let end = cut + 1
      while (end < batchStart && isToolResult(messages[end])) end++
      if (cut !== pinnedUser) {
        for (let i = cut; i < end; i++) {
          tokens -= estimateEcoMessageTokens(messages[i])
          drop.add(i)
        }
      }
      cut = end
    }
    dropped = drop.size
    if (dropped > 0) {
      const noteText = `${ECO_OMITTED_MARKER}${dropped} older messages are omitted from this request to fit the local context budget; they are unchanged in the transcript]`
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

  // Step 3: tighter views for the current batch. Errors and key lines survive
  // inside the view; the header marks the result as shortened.
  if (tokens > budget.inputBudget) {
    const start = currentBatchStart(messages)
    messages = messages.map((m, i) => {
      if (i < start || !isToolResult(m)) return m
      const view = renderEcoToolView(m, ECO_TIGHT_HEAD_CHARS, ECO_TIGHT_TAIL_CHARS)
      if (!view) return m
      compacted++
      return withViewText(m, view)
    })
    tokens = sumTokens(messages, fixedTokens)
  }

  // Structural net: the drop walk keeps pairs intact, this proves it.
  const sanitized = sanitizeHistoryBoundaries(messages).messages
  const tokensAfter = sumTokens(sanitized, fixedTokens)
  return {
    messages: sanitized,
    changed: true,
    tokensBefore,
    tokensAfter,
    compacted,
    dropped,
    degraded: tokensAfter > budget.inputBudget,
  }
}
