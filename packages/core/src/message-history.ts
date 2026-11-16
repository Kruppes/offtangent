import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'

/**
 * Tool-use / tool-result boundary invariant enforcement for the in-memory
 * agent history.
 *
 * ## Why this exists
 *
 * Every provider (Anthropic, OpenAI/Kimi, …) rejects a message history in
 * which a `tool_result` block has no matching `tool_use` block in the previous
 * message — or in which a `tool_use` block never gets a following `tool_result`.
 * When that happens the session wedges on EVERY subsequent turn until the
 * context is cleared:
 *
 *   400 messages.0.content.0: unexpected `tool_use_id` found in `tool_result`
 *   blocks: toolu_XXX. Each `tool_result` block must have a corresponding
 *   `tool_use` block in the previous message.
 *
 * ## How the orphan appears (root cause, 2026-08-17)
 *
 * We drive the bare pi-agent `Agent` class, whose `state.messages` only ever
 * grows by push and is reset only via `= []` — so WE never create an orphan.
 * The orphan is created downstream, inside pi-ai's `transformMessages`
 * (`dist/api/transform-messages.js`): its second pass DROPS any assistant
 * message whose `stopReason` is `"error"` or `"aborted"`
 * (`if (assistantMsg.stopReason === "error" || "aborted") continue;`) but
 * KEEPS the `toolResult` messages those tool calls produced. A watchdog abort,
 * a mid-stream provider failure after a tool ran, or a context-limit error
 * mid-turn therefore leaves a `toolResult` message whose originating `toolCall`
 * block was thrown away. If that survivor sits at the front of the history it
 * becomes `messages.0` — the exact 400 above.
 *
 * pi-ai only synthesizes results for TRAILING dangling tool calls; it does not
 * drop LEADING orphan tool results. This module closes that gap for our
 * runtime while remaining a pure, dependency-free function that is trivially
 * testable and upstream-PR-friendly.
 *
 * ## Message model (pi SDK)
 *
 * At the `AgentMessage` level a tool call is a *content block*
 * (`{ type: "toolCall", id }`) inside an `assistant` message, while a tool
 * result is its own message (`{ role: "toolResult", toolCallId }`). The
 * invariant we enforce:
 *
 *  - Every `toolResult` message must be matched by a `toolCall` block in a
 *    PRECEDING assistant message (contiguously, i.e. reachable across the
 *    batch of tool results for the same assistant turn).
 *  - Every `toolCall` block must be matched by a FOLLOWING `toolResult`
 *    message.
 *  - A tool_use / tool_result pair is atomic: a trim never splits it.
 *
 * The OpenAI dialect uses the same shape in this SDK (`toolCallId` is the
 * cross-dialect join key — mirrors the detection in `isCorruptedContextError`),
 * so a single pass covers both providers.
 */

function isAssistant(msg: AgentMessage): msg is AssistantMessage {
  return (msg as { role?: string }).role === 'assistant'
}

function isToolResult(msg: AgentMessage): msg is ToolResultMessage {
  return (msg as { role?: string }).role === 'toolResult'
}

/** Collect the ids of all `toolCall` blocks in an assistant message. */
function toolCallIdsOf(msg: AssistantMessage): string[] {
  const content = msg.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    if (block && (block as { type?: string }).type === 'toolCall') {
      const id = (block as ToolCall).id
      if (id) ids.push(id)
    }
  }
  return ids
}

/** True if an assistant message carries at least one `toolCall` block. */
function hasToolCall(msg: AssistantMessage): boolean {
  return toolCallIdsOf(msg).length > 0
}

/**
 * Drop the `toolCall` content blocks with the given ids from an assistant
 * message, keeping every other block. Returns the possibly-rewritten message,
 * or `null` if removing those blocks would leave the message with no content
 * at all (in which case the whole message should be dropped).
 */
function stripToolCallBlocks(msg: AssistantMessage, dropIds: Set<string>): AssistantMessage | null {
  const content = Array.isArray(msg.content) ? msg.content : []
  const kept = content.filter(block => {
    if (block && (block as { type?: string }).type === 'toolCall') {
      return !dropIds.has((block as ToolCall).id)
    }
    return true
  })
  if (kept.length === 0) return null
  if (kept.length === content.length) return msg
  return { ...msg, content: kept }
}

export interface SanitizeResult {
  /** History with orphaned tool_use / tool_result blocks removed. */
  messages: AgentMessage[]
  /** True when the input violated the boundary invariant (something dropped). */
  dropped: boolean
  /**
   * Structural, secret-free breadcrumbs describing what was removed. Contains
   * only message roles, block types and tool-call ids — NEVER any content
   * text (avoids leaking secrets into logs).
   */
  drops: string[]
}

/**
 * Return a copy of `messages` with any tool_use / tool_result boundary
 * violation removed, plus a structural (secret-free) description of what was
 * dropped. A valid history is returned unchanged (no false positives).
 *
 * Algorithm (single forward pass + one pre-pass):
 *
 *  1. Match every `toolResult` message to the nearest preceding assistant
 *     `toolCall` block with the same id. A `toolResult` with no matching
 *     preceding call is a LEADING orphan → drop it.
 *  2. Match every assistant `toolCall` block to a following `toolResult`. A
 *     call with no result is a TRAILING dangling call → drop that block (and
 *     the whole assistant message if it becomes empty).
 *
 * Pairs stay atomic: because we drop the *unmatched* side only, a surviving
 * pair (call + result both present) is always kept together.
 */
export function sanitizeHistoryBoundaries(messages: readonly AgentMessage[]): SanitizeResult {
  const drops: string[] = []

  // --- Pass 1: which tool-call ids actually have a matching result, and
  // which tool-result messages have a matching preceding call. ---
  //
  // We walk forward tracking the ids of tool calls emitted so far. A
  // toolResult whose id was NOT emitted by any earlier assistant message is a
  // leading orphan.
  const emittedCallIds = new Set<string>()
  const resolvedCallIds = new Set<string>() // calls that got a result
  const orphanResultIndexes = new Set<number>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (isAssistant(msg)) {
      for (const id of toolCallIdsOf(msg)) emittedCallIds.add(id)
    } else if (isToolResult(msg)) {
      const id = msg.toolCallId
      if (id && emittedCallIds.has(id)) {
        resolvedCallIds.add(id)
      } else {
        // No preceding tool_use for this result → leading orphan.
        orphanResultIndexes.add(i)
        drops.push(`toolResult#${i}(id=${id ?? 'none'}): no preceding tool_use`)
      }
    }
  }

  // --- Pass 2: build the sanitized list, dropping orphan results and
  // unmatched (trailing dangling) tool-call blocks. ---
  const result: AgentMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (orphanResultIndexes.has(i)) {
      // Leading orphan tool_result — drop entirely.
      continue
    }

    if (isAssistant(msg) && hasToolCall(msg)) {
      const danglingIds = toolCallIdsOf(msg).filter(id => !resolvedCallIds.has(id))
      if (danglingIds.length > 0) {
        const rewritten = stripToolCallBlocks(msg, new Set(danglingIds))
        if (rewritten === null) {
          // Message was nothing but dangling tool calls → drop the message.
          drops.push(`assistant#${i}: dropped (only dangling tool_use ${danglingIds.join(',')})`)
          continue
        }
        if (rewritten !== msg) {
          drops.push(`assistant#${i}: stripped dangling tool_use ${danglingIds.join(',')}`)
        }
        result.push(rewritten)
        continue
      }
    }

    result.push(msg)
  }

  return { messages: result, dropped: drops.length > 0, drops }
}

/** Upper bound of a structure string in logs and `turn_error` metadata (review F3). */
export const MAX_STRUCTURE_CHARS = 1500

/**
 * Structural summary of a message history for diagnostic logging. Emits only
 * roles, block types, stop reasons and tool-call ordinals — never content
 * text and never a provider tool-call id (review F3: ids are model output and
 * may echo anything). Each distinct id becomes `#n` in order of first
 * appearance, so call/result pairs stay visible. The string is capped at
 * `MAX_STRUCTURE_CHARS`: the newest messages are kept, the oldest are folded
 * into a count.
 *
 * Example: `user | assistant[text,toolCall#1] | toolResult#1 | assistant[text]`
 */
export function describeHistoryStructure(messages: readonly AgentMessage[]): string {
  const ordinals = new Map<string, number>()
  const ref = (id: unknown): string => {
    if (typeof id !== 'string' || id.length === 0) return '#none'
    let n = ordinals.get(id)
    if (n === undefined) { n = ordinals.size + 1; ordinals.set(id, n) }
    return `#${n}`
  }
  const safeWord = (s: unknown, fallback: string): string =>
    typeof s === 'string' && /^[A-Za-z_]{1,24}$/.test(s) ? s : fallback
  const parts = messages.map(msg => {
    const role = safeWord((msg as { role?: string }).role, 'unknown')
    if (role === 'assistant' && Array.isArray((msg as AssistantMessage).content)) {
      const blocks = (msg as AssistantMessage).content.map(block => {
        const type = safeWord((block as { type?: string }).type, '?')
        if (type === 'toolCall') return `toolCall${ref((block as ToolCall).id)}`
        return type
      })
      const stop = (msg as AssistantMessage).stopReason
      return `assistant[${blocks.join(',')}]${stop ? `(${safeWord(stop, '?')})` : ''}`
    }
    if (role === 'toolResult') {
      return `toolResult${ref((msg as ToolResultMessage).toolCallId)}`
    }
    if (role === 'user') {
      if (isWindowOpener(msg)) return 'user(opener)'
      return isWireUser(msg) ? 'user' : 'user(blank)'
    }
    if (role === 'system') {
      // A mid-conversation system message that adds or removes tools becomes
      // its own wire message on Anthropic; where it lands matters (http_400
      // incident 2026-11-12). Counts only, no names or text.
      const sys = msg as { toolsAdded?: unknown[]; toolsRemoved?: unknown[] }
      const added = Array.isArray(sys.toolsAdded) ? sys.toolsAdded.length : 0
      const removed = Array.isArray(sys.toolsRemoved) ? sys.toolsRemoved.length : 0
      return added || removed ? `system[tools+${added}-${removed}]` : 'system'
    }
    return role
  })
  const full = parts.join(' | ')
  if (full.length <= MAX_STRUCTURE_CHARS) return full
  // Keep the newest messages (where the boundary problems live).
  const tail: string[] = []
  let used = 0
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].length > 200 ? `${parts[i].slice(0, 200)}…` : parts[i]
    if (used + p.length + 3 > MAX_STRUCTURE_CHARS - 40) break
    tail.unshift(p)
    used += p.length + 3
  }
  return `…(${parts.length - tail.length} older messages) | ${tail.join(' | ')}`
}

/**
 * True when the provider conversion keeps this user message on the wire.
 * pi-ai 1.5.2 (`anthropic-messages.js` convertMessages) drops a user message
 * whose string content is blank, and drops blank text blocks; a user message
 * left with no block is dropped entirely (an empty content array as well).
 * A window that "opens on a user
 * message" only counts when that message survives (review B2).
 */
export function isWireUser(msg: AgentMessage | undefined): boolean {
  const m = msg as { role?: string; content?: unknown } | undefined
  if (!m || m.role !== 'user') return false
  if (typeof m.content === 'string') return m.content.trim().length > 0
  // Only shapes the conversion is known to drop count as missing. Any other
  // content shape keeps the pre-fix behaviour (counts as a user message), so
  // the repair never fabricates an opener for a shape it does not understand.
  if (!Array.isArray(m.content)) return true
  return m.content.some(block => {
    if (!block || typeof block !== 'object') return false
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text') return typeof b.text === 'string' && b.text.trim().length > 0
    return true // image and other non-text blocks are kept by the conversion
  })
}

/**
 * Fixed head of every fabricated window opener (http_400 incident
 * 2026-11-12). A statement, no instruction (review F4).
 */
export const WINDOW_OPENER_TEXT =
  '[window_opener] Earlier messages of this conversation are outside the model window.'

/** Hard cap of the user text excerpt carried by an opener (review B1). */
export const WINDOW_OPENER_EXCERPT_CHARS = 2000

/**
 * Private flag of a fabricated opener (review F5). It is a property of the
 * in-memory message, never part of its text: no provider converter reads it
 * (they all map role and content explicitly), and a real user message that
 * happens to start with `[window_opener]` is not mistaken for one.
 */
const OPENER_FLAG = 'windowOpener'

/** True for a fabricated opener inserted by `openWindowOnUser`. */
export function isWindowOpener(msg: AgentMessage | undefined): boolean {
  const m = msg as { role?: string; [OPENER_FLAG]?: unknown } | undefined
  return !!m && m.role === 'user' && m[OPENER_FLAG] === true
}

function userText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => (b as { text: string }).text)
    .join('\n')
}

/**
 * Build a fabricated opener. With `turnUser` (the real user message that
 * started the turn) it carries a text-only excerpt of that message, at most
 * `WINDOW_OPENER_EXCERPT_CHARS` characters; images and attachments never
 * travel. Pure: the same input gives the same bytes (prompt cache).
 */
export function makeWindowOpener(turnUser?: AgentMessage, timestamp = 0): AgentMessage {
  let text = WINDOW_OPENER_TEXT
  const raw = turnUser ? userText(turnUser).trim() : ''
  if (raw.length > 0) {
    let excerpt = raw.slice(0, WINDOW_OPENER_EXCERPT_CHARS)
    // Never end on half of a surrogate pair.
    if (excerpt.length > 0 && /[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1)
    const scope = excerpt.length < raw.length
      ? `its first ${excerpt.length} of ${raw.length} characters, text only`
      : 'text only'
    text = `${WINDOW_OPENER_TEXT} The turn below started with this user message (${scope}):\n\n${excerpt}`
  }
  return { role: 'user', content: [{ type: 'text', text }], timestamp, [OPENER_FLAG]: true } as unknown as AgentMessage
}

/** Largest opener `makeWindowOpener` can build; its size is reserved in the budget. */
export function maxWindowOpener(): AgentMessage {
  return makeWindowOpener({ role: 'user', content: 'x'.repeat(WINDOW_OPENER_EXCERPT_CHARS + 1), timestamp: 0 } as unknown as AgentMessage)
}

export interface OpenWindowResult {
  messages: AgentMessage[]
  /** True when an opener was inserted. */
  repaired: boolean
  /** The opener carries an excerpt of the real user message that started the turn. */
  fromEarlierUser: boolean
}

/**
 * Make the first non-system message of a provider window a user message
 * that survives the provider conversion (`isWireUser`; http_400 incident
 * 2026-11-12, review B2). Anthropic rejects a request whose first message is
 * a system message that holds tool blocks, and pi-ai flushes a deferred tool
 * declaration directly in front of the next assistant message — so a window
 * that opens on an assistant or tool message, or on a blank user message
 * that the conversion drops, wedges the strand on every turn.
 *
 * The opener goes directly in front of that first non-system message, so the
 * leading system messages (prompt, tool declarations) keep their place. It is
 * always a fabricated, bounded opener (`makeWindowOpener`): with `turnUser`
 * it carries a capped text excerpt of it; when `turnUser` is itself an opener
 * it is reused as is (same object, same bytes on every later trim). A window
 * without any non-system message, or one that already opens on a wire user
 * message, is returned unchanged (same array).
 */
export function openWindowOnUser(messages: AgentMessage[], turnUser?: AgentMessage): OpenWindowResult {
  const first = messages.findIndex(m => (m as { role?: string }).role !== 'system')
  if (first === -1 || isWireUser(messages[first])) {
    return { messages, repaired: false, fromEarlierUser: false }
  }
  const timestamp = (messages[first] as { timestamp?: number }).timestamp
    ?? (turnUser as { timestamp?: number } | undefined)?.timestamp
    ?? 0
  const opener = turnUser && isWindowOpener(turnUser)
    ? turnUser
    : makeWindowOpener(turnUser && isWireUser(turnUser) ? turnUser : undefined, timestamp)
  return {
    messages: [...messages.slice(0, first), opener, ...messages.slice(first)],
    repaired: true,
    fromEarlierUser: turnUser !== undefined && (isWindowOpener(turnUser) || isWireUser(turnUser)),
  }
}
