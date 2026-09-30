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

/**
 * Structural, secret-free summary of a message history for diagnostic logging.
 * Emits only roles, block types and tool ids — never any content text.
 *
 * Example: `user | assistant[text,toolCall:toolu_1] | toolResult:toolu_1 | assistant[text]`
 */
export function describeHistoryStructure(messages: readonly AgentMessage[]): string {
  return messages
    .map(msg => {
      const role = (msg as { role?: string }).role ?? 'unknown'
      if (role === 'assistant' && Array.isArray((msg as AssistantMessage).content)) {
        const blocks = (msg as AssistantMessage).content.map(block => {
          const type = (block as { type?: string }).type ?? '?'
          if (type === 'toolCall') return `toolCall:${(block as ToolCall).id}`
          return type
        })
        const stop = (msg as AssistantMessage).stopReason
        return `assistant[${blocks.join(',')}]${stop ? `(${stop})` : ''}`
      }
      if (role === 'toolResult') {
        return `toolResult:${(msg as ToolResultMessage).toolCallId}`
      }
      return role
    })
    .join(' | ')
}
