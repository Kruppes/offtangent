import { nextTick, ref, watch, type Ref } from 'vue'
import type { ChatMessage } from '~/composables/useChat'

const SCROLL_THRESHOLD = 120

/**
 * Follow the newest message while the reader is near the bottom; once they
 * scroll up, stop following and offer a jump back down.
 */
export function useChatScroll(messages: Ref<ChatMessage[]>) {
  const messagesContainer = ref<HTMLDivElement | null>(null)
  const isNearBottom = ref(true)

  function scrollToBottom() { if (messagesContainer.value) messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight }
  function onMessagesScroll() { const el = messagesContainer.value; if (!el) return; isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD }
  function jumpToBottom() { isNearBottom.value = true; nextTick(() => scrollToBottom()) }

  // Older rows put in front ("Load older", the background fill of the initial
  // window) must not move what the reader looks at: keep the distance to the
  // bottom across the prepend. Captured before the DOM update (flush 'pre').
  watch(() => messages.value[0]?.id, (oldest, previous) => {
    const el = messagesContainer.value
    if (!el || isNearBottom.value || oldest === undefined || previous === undefined || oldest >= previous) return
    const fromBottom = el.scrollHeight - el.scrollTop
    nextTick(() => { el.scrollTop = el.scrollHeight - fromBottom })
  }, { flush: 'pre' })
  watch(() => messages.value.length, () => { if (isNearBottom.value) nextTick(() => scrollToBottom()) })
  watch(() => messages.value[messages.value.length - 1]?.content?.length ?? 0, () => { if (isNearBottom.value) nextTick(() => scrollToBottom()) })

  return { messagesContainer, isNearBottom, scrollToBottom, onMessagesScroll, jumpToBottom }
}
