import { ref, type Ref } from 'vue'
import type { ChatMessage, useChat } from '~/composables/useChat'

type Chat = ReturnType<typeof useChat>

/** Approval buttons and slash-command pickers in the transcript. */
export function useChatActions(messages: Ref<ChatMessage[]>, submitChatAction: Chat['submitChatAction'], resolvePicker: Chat['resolvePicker']) {
  /** Message ids with an in-flight action click, so buttons can't be double-fired. */
  const pendingChatActions = ref<Set<string>>(new Set())

  async function handleChatAction(messageId: string, actionId: string) {
    if (pendingChatActions.value.has(messageId)) return
    pendingChatActions.value = new Set(pendingChatActions.value).add(messageId)
    try {
      await submitChatAction(messageId, actionId)
    } finally {
      const updated = new Set(pendingChatActions.value)
      updated.delete(messageId)
      pendingChatActions.value = updated
    }
  }

  /**
   * Map a clicked picker option back to the position of its message inside
   * `messages.value`. We can't use the row index directly because the
   * display filters drop e.g. tool calls / task injections, so its indices
   * don't line up with the underlying array.
   */
  function handlePickerSelect(msg: ChatMessage, command: string) {
    const idx = messages.value.indexOf(msg)
    if (idx === -1) return
    resolvePicker(idx, command)
  }

  return { pendingChatActions, handleChatAction, handlePickerSelect }
}
