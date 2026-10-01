import type { ComputedRef } from 'vue'
import type { ChatMessage } from '~/composables/useChat'
import { useInteractions } from '~/composables/useInteractions'

/**
 * Interactive blocks of assistant messages (SPEC 7.4c): which card a message
 * carries, what stays in its bubble, and whether the card counts as answered.
 * Parsing is defensive: a broken block degrades to text, it never breaks the
 * renderer.
 */
export function useMessageSegments(visibleMessages: ComputedRef<ChatMessage[]>) {
  const { segmentsOf } = useInteractions()
  const segmentCache = new Map<string, ReturnType<typeof segmentsOf>>()

  function messageSegments(msg: ChatMessage) {
    const content = msg.content ?? ''
    const cached = segmentCache.get(content)
    if (cached) return cached
    const segments = segmentsOf(content)
    // The template asks several times per message (card? text? bubble body?);
    // parsing once per distinct content keeps that free and hands out stable
    // array identities.
    if (segmentCache.size > 200) segmentCache.clear()
    segmentCache.set(content, segments)
    return segments
  }

  /** The one card of an assistant message, or null (the parser allows only one). */
  function interactionCard(msg: ChatMessage) {
    if (msg.role !== 'assistant') return null
    for (const segment of messageSegments(msg)) if (segment.type === 'block') return segment.block
    return null
  }

  /** Everything of an assistant message that stays inside the bubble. */
  function messageTextSegments(msg: ChatMessage) {
    return messageSegments(msg).filter(segment => segment.type === 'text')
  }

  /**
   * Does the bubble carry anything at all next to the card? A message that is
   * nothing but a card gets the speaker line and the card — an empty bubble
   * above it would be one box too many.
   */
  function hasBubbleBody(msg: ChatMessage): boolean {
    if (messageTextSegments(msg).some(segment => segment.text.trim().length > 0)) return true
    return !!msg.attachments?.length || !!msg.artifacts?.length || !!msg.streaming
  }

  /**
   * A free text answer is an ordinary user message, so it leaves no trace in
   * `interactionAnswers`. Any later user message means the question was dealt
   * with in the chat, and the card renders closed instead of inviting a second
   * answer to a turn that has long moved on.
   */
  function answeredElsewhere(index: number): boolean {
    const rows = visibleMessages.value
    for (let i = index + 1; i < rows.length; i++) {
      if (rows[i]?.role === 'user') return true
    }
    return false
  }

  return { interactionCard, messageTextSegments, hasBubbleBody, answeredElsewhere }
}
