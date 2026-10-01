import { ref, watch } from 'vue'
import type { ChatMessage } from '~/composables/useChat'

/** Same key as before the split, so stored display choices survive it. */
const FILTER_STORAGE_KEY = 'axiom-chat-filters'

interface StoredFilters {
  showToolCalls?: boolean
  showInjections?: boolean
  showSessionSummaries?: boolean
  showThinking?: boolean
}

function loadFilters(): StoredFilters | null {
  try {
    const stored = localStorage.getItem(FILTER_STORAGE_KEY)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return null
}

/**
 * The display filters of the chat toolbar, persisted in localStorage, plus
 * the predicate that applies them to the transcript.
 */
export function useChatFilters() {
  const saved = loadFilters()
  const showToolCalls = ref<boolean>(saved?.showToolCalls ?? true)
  const showInjections = ref<boolean>(saved?.showInjections ?? false)
  const showSessionSummaries = ref<boolean>(saved?.showSessionSummaries ?? false)
  // Thinking blocks default to visible (but collapsed) — mirrors TaskViewer behaviour.
  const showThinking = ref<boolean>(saved?.showThinking ?? true)

  watch([showToolCalls, showInjections, showSessionSummaries, showThinking], () => {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
      showToolCalls: showToolCalls.value,
      showInjections: showInjections.value,
      showSessionSummaries: showSessionSummaries.value,
      showThinking: showThinking.value,
    }))
  })

  function isVisible(msg: ChatMessage): boolean {
    if (!showToolCalls.value && msg.role === 'tool' && msg.toolData) return false
    if (!showInjections.value && msg.role === 'system' && (msg.isTaskResult || msg.isTaskStatusUpdate)) return false
    if (!showThinking.value && msg.isThinking) return false
    return true
  }

  return { showToolCalls, showInjections, showSessionSummaries, showThinking, isVisible }
}

export type ChatFilters = ReturnType<typeof useChatFilters>
