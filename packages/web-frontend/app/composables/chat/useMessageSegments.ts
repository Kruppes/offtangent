import type { ComputedRef } from 'vue'
import type { ChatMessage } from '~/composables/useChat'
import { useInteractions } from '~/composables/useInteractions'
import { cardClosedByTable, type InteractionTableStatus } from '~/composables/useInteractionTable'
import { inlineArtifactCount, splitArtifactFences } from '~/utils/inlineArtifacts'

/**
 * Interactive blocks of assistant messages (SPEC 7.4c): which card a message
 * carries, what stays in its bubble, and whether the card counts as answered.
 * Parsing is defensive: a broken block degrades to text, it never breaks the
 * renderer.
 */
export function useMessageSegments(
  visibleMessages: ComputedRef<ChatMessage[]>,
  /** S1-A: the state of a card in the `interactions` table (`useInteractionTable().statusOf`). */
  interactionStatus: (messageId: number | string | undefined, blockId: string) => InteractionTableStatus | null = () => null,
) {
  const { segmentsOf, reportInteractionEvent } = useInteractions()
  const segmentCache = new Map<string, ReturnType<typeof segmentsOf>>()

  /**
   * The markdown of the bubble. An ```html / ```svg block that became an
   * inline artifact is shown once, as the running artifact below the text
   * (with its source one click away), not a second time as a code block.
   */
  function bodyText(msg: ChatMessage): string {
    const content = msg.content ?? ''
    if (msg.role !== 'assistant') return content
    return splitArtifactFences(content, inlineArtifactCount(msg.artifacts)).text
  }

  /** Source of the inline artifacts of a message, by inline index. */
  function artifactFences(msg: ChatMessage) {
    if (msg.role !== 'assistant') return []
    return splitArtifactFences(msg.content ?? '', inlineArtifactCount(msg.artifacts)).fences
  }

  function messageSegments(msg: ChatMessage) {
    const content = bodyText(msg)
    const streaming = msg.streaming === true
    const key = `${streaming ? 's' : 'f'}:${content}`
    const cached = segmentCache.get(key)
    if (cached) return cached
    const segments = segmentsOf(content, { streaming })
    // The template asks several times per message (card? text? bubble body?);
    // parsing once per distinct content keeps that free and hands out stable
    // array identities.
    if (segmentCache.size > 200) segmentCache.clear()
    segmentCache.set(key, segments)
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
    return messageSegments(msg).flatMap(segment => segment.type === 'text' ? [segment] : [])
  }

  /**
   * A card fence that is still streaming (S0-B/QW1): the bubble shows a
   * placeholder card instead of the growing JSON. Counted once per message.
   */
  function hasPendingCard(msg: ChatMessage, index: number): boolean {
    if (msg.role !== 'assistant' || !msg.streaming) return false
    const pending = messageSegments(msg).some(segment => segment.type === 'pending')
    // The live message object is replaced on every chunk, so the key is its
    // place in the transcript, not its identity.
    const key = `${msg.timestamp ?? ''}#${index}`
    if (pending && !pendingCardsSeen.has(key)) {
      if (pendingCardsSeen.size > 500) pendingCardsSeen.clear()
      pendingCardsSeen.add(key)
      reportInteractionEvent('stream_placeholder')
    }
    return pending
  }
  const pendingCardsSeen = new Set<string>()

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
   * S1-A: whether a card is drawn closed as "skipped" comes from the server's
   * `interactions` table ONLY (superseded, expired, dismissed). The stale rule
   * B4 is applied there, at write time — the `user_continued` trigger, the
   * newer-question supersede and the one-time backfill — so the web client no
   * longer re-derives it from the message text. A card the table does not
   * know yet stays open; the server answers 409/410 if it is closed.
   */
  function cardSkipped(index: number): boolean {
    const row = visibleMessages.value[index]
    if (!row) return false
    const card = interactionCard(row)
    if (!card) return false
    const status = interactionStatus(row.id, card.id)
    const skipped = cardClosedByTable(status)
    // Counted once per persisted card and page life: history reloads replace
    // the row objects, so the key is the row id, not the object.
    if (status === 'superseded' && typeof row.id === 'number' && !skippedCardsSeen.has(row.id)) {
      skippedCardsSeen.add(row.id)
      reportInteractionEvent('superseded')
    }
    return skipped
  }
  const skippedCardsSeen = new Set<number>()

  return { interactionCard, messageTextSegments, hasBubbleBody, hasPendingCard, cardSkipped, artifactFences }
}
