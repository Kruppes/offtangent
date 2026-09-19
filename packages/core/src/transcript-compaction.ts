/**
 * transcript-compaction.ts: the strand window mechanism (SPEC 11.3) for agent
 * loops that have no strand — background tasks.
 *
 * The interactive path trims its transcript to a token budget
 * (`trimMessagesToBudget`), renders what fell out as `<earlier_messages>`
 * digest lines and lets the model reload any of them with `recall_message`.
 * The task loop sent the FULL transcript, including every tool result, on
 * every single LLM call: measured amplification 219–246x, up to 721k input
 * tokens per call (token audit 2026-09-17, §3.2).
 *
 * This module answers the same question with the same primitives — the budget
 * walk comes from `strand-context.ts`, the digest format from
 * `message-digest.ts` — and adds the one thing a tool loop needs that a chat
 * turn does not:
 *
 *   **Hysteresis.** A tool loop calls the model many times per "turn". If the
 *   window were re-cut on every call, the prompt prefix would move every call
 *   and the provider prompt cache (93–97 % hit rate here) would be rewritten
 *   constantly. So the cut point is sticky: nothing happens until the window
 *   exceeds `windowTokens`, and a trim then cuts back to `targetTokens`, far
 *   below the trigger. Between two trims the rendered prefix is byte-stable
 *   and only new messages are appended.
 *
 * The compactor never mutates the agent transcript. It produces the VIEW that
 * goes to the model (via pi-agent's `transformContext`), so the task's own
 * result extraction, verification and schema correction still see everything.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { estimateMessageTokens, trimMessagesToBudget } from './strand-context.js'
import { formatMessageDigest, RECALLED_MARKER } from './message-digest.js'
import { sanitizeHistoryBoundaries } from './message-history.js'

export interface TranscriptTrimEvent {
  /** Messages hidden from the model view after this trim, in total. */
  droppedTotal: number
  /** Messages hidden by this trim alone. */
  droppedNow: number
  /** Estimated tokens of the view before the trim. */
  tokensBefore: number
  /** Estimated tokens of the kept window after the trim. */
  tokensAfter: number
}

export interface TranscriptCompactionOptions {
  /** Trim trigger: the verbatim window may grow to this before a trim happens. */
  windowTokens: number
  /** A trim cuts the window back to this. Lower = rarer trims = stabler cache. */
  targetTokens: number
  /** Maximum digest lines rendered for the hidden messages. */
  indexLines: number
  /** Called once per trim, for logging / metrics. */
  onTrim?: (event: TranscriptTrimEvent) => void
}

interface MessageLike {
  role?: string
  content?: unknown
  toolCallId?: string
  toolName?: string
}

function textOf(msg: AgentMessage): string {
  const content = (msg as MessageLike).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') parts.push('[image]')
  }
  return parts.join('\n')
}

function toolCallNames(msg: AgentMessage): string[] {
  const content = (msg as MessageLike).content
  if (!Array.isArray(content)) return []
  const names: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'toolCall' && typeof b.name === 'string') names.push(b.name)
  }
  return names
}

/** Digest line for a message that has no `chat_messages` row to recall. */
function describeWithoutId(msg: AgentMessage): string | null {
  const role = (msg as MessageLike).role
  const text = textOf(msg)
  if (role === 'assistant') {
    const calls = toolCallNames(msg)
    if (text.trim().length === 0) {
      return calls.length > 0 ? `[no-id] assistant called: ${calls.join(', ')}` : null
    }
    const line = formatMessageDigest({ id: 0, role: 'assistant', content: text }).replace(/^\[msg:0\] /, '[no-id] ')
    return calls.length > 0 ? `${line} (called: ${calls.join(', ')})` : line
  }
  if (role === 'toolResult') {
    const name = (msg as MessageLike).toolName ?? 'tool'
    return formatMessageDigest({ id: 0, role: 'tool', content: `${name}: ${text}` }).replace(/^\[msg:0\] /, '[no-id] ')
  }
  if (text.trim().length === 0) return null
  return formatMessageDigest({ id: 0, role: 'user', content: text }).replace(/^\[msg:0\] /, '[no-id] ')
}

export const EARLIER_MESSAGES_OPEN = '<earlier_messages>'
export const EARLIER_MESSAGES_CLOSE = '</earlier_messages>'

/** Copy of a user message with `text` prepended to its first text block. */
function prependText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as MessageLike).content
  if (typeof content === 'string') {
    return { ...(msg as object), content: `${text}\n\n${content}` } as unknown as AgentMessage
  }
  if (Array.isArray(content)) {
    const blocks = content as Array<Record<string, unknown>>
    const idx = blocks.findIndex(b => b && b.type === 'text' && typeof b.text === 'string')
    const next = [...blocks]
    if (idx >= 0) next[idx] = { ...blocks[idx], text: `${text}\n\n${blocks[idx].text as string}` }
    else next.unshift({ type: 'text', text })
    return { ...(msg as object), content: next } as unknown as AgentMessage
  }
  return msg
}

/**
 * Budget-bounded model view of one long-running agent transcript.
 *
 * One instance belongs to one agent (it keeps the cut position and the id
 * mapping), and it survives pause/resume with that agent.
 */
export class TranscriptCompactor {
  private readonly options: TranscriptCompactionOptions
  /** Number of leading messages hidden from the model. Only ever grows (per transcript). */
  private cut = 0
  /** Rendered digest for the hidden prefix. Rebuilt only on a trim → stable prefix. */
  private digest: string | null = null
  private digestTimestamp = Date.now()
  private lastSeenLength = 0
  private trims = 0
  /** `chat_messages.id` per transcript message object (assistant rows). */
  private idByMessage = new WeakMap<object, number>()
  /** `chat_messages.id` per tool call id (tool result rows). */
  private idByToolCallId = new Map<string, number>()

  constructor(options: TranscriptCompactionOptions) {
    this.options = options
  }

  /** Register the persisted row of an assistant message so it stays recallable. */
  noteMessageId(message: object, id: number): void {
    if (id > 0) this.idByMessage.set(message, id)
  }

  /** Register the persisted row of a tool result so it stays recallable. */
  noteToolResultId(toolCallId: string, id: number): void {
    if (toolCallId && id > 0) this.idByToolCallId.set(toolCallId, id)
  }

  private resolveId(msg: AgentMessage): number | undefined {
    const direct = this.idByMessage.get(msg as object)
    if (direct !== undefined) return direct
    const toolCallId = (msg as MessageLike).toolCallId
    if (typeof toolCallId === 'string') return this.idByToolCallId.get(toolCallId)
    return undefined
  }

  /** Current cut position and trim count (metrics / tests). */
  stats(): { hiddenMessages: number; trims: number } {
    return { hiddenMessages: this.cut, trims: this.trims }
  }

  /**
   * The model view of `messages`: `[digest of the hidden prefix, ...window]`.
   *
   * Returns the input unchanged while everything still fits the budget.
   */
  compact(messages: readonly AgentMessage[]): AgentMessage[] {
    // A transcript that got shorter than our cut position was reset or
    // replaced — start over rather than hide the wrong messages.
    if (messages.length < this.lastSeenLength || this.cut > messages.length) {
      this.cut = 0
      this.digest = null
    }
    this.lastSeenLength = messages.length

    const window = messages.slice(this.cut)
    const windowTokens = window.reduce((n, m) => n + estimateMessageTokens(m), 0)

    if (windowTokens > this.options.windowTokens) {
      const trimmed = trimMessagesToBudget(window, this.options.targetTokens)
      if (trimmed.startIndex > 0) {
        const previousCut = this.cut
        this.cut += trimmed.startIndex
        this.trims++
        this.rebuildDigest(messages)
        this.options.onTrim?.({
          droppedTotal: this.cut,
          droppedNow: this.cut - previousCut,
          tokensBefore: windowTokens,
          tokensAfter: trimmed.keptTokens,
        })
      }
    }

    if (this.cut === 0 || this.digest === null) return [...messages]

    const kept = sanitizeHistoryBoundaries(messages.slice(this.cut)).messages
    const header = {
      role: 'user',
      content: this.digest,
      timestamp: this.digestTimestamp,
    } as unknown as AgentMessage

    // Never produce two user messages in a row: providers differ on whether
    // they merge or reject that. When the window opens on a user message the
    // digest goes INTO it.
    if (kept.length > 0 && (kept[0] as MessageLike).role === 'user') {
      return [prependText(kept[0], this.digest), ...kept.slice(1)]
    }
    return [header, ...kept]
  }

  /** Render the hidden prefix as digest lines. Called only when the cut moves. */
  private rebuildDigest(messages: readonly AgentMessage[]): void {
    const hidden = messages.slice(0, this.cut)
    const lines: string[] = []
    for (const msg of hidden) {
      const id = this.resolveId(msg)
      if (id !== undefined) {
        const role = (msg as MessageLike).role
        const text = textOf(msg)
        if (role === 'toolResult') {
          const name = (msg as MessageLike).toolName ?? 'tool'
          lines.push(formatMessageDigest({ id, role: 'tool', content: `${name}: ${text}` }))
        } else {
          lines.push(formatMessageDigest({ id, role: role === 'user' ? 'user' : 'assistant', content: text }))
        }
        continue
      }
      const fallback = describeWithoutId(msg)
      if (fallback) lines.push(fallback)
    }

    const shown = lines.slice(-Math.max(1, this.options.indexLines))
    const omitted = lines.length - shown.length
    this.digest = [
      EARLIER_MESSAGES_OPEN,
      `${RECALLED_MARKER} ${hidden.length} earlier messages of this task are no longer in your context. ` +
        'Lines with an id can be reloaded verbatim with recall_message(message_id); lines marked [no-id] are gone. ' +
        'Your task description in the system prompt is unchanged.',
      ...(omitted > 0 ? [`(${omitted} oldest not listed)`] : []),
      ...shown,
      EARLIER_MESSAGES_CLOSE,
    ].join('\n')
    this.digestTimestamp = Date.now()
  }
}
