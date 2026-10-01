import { computed, ref } from 'vue'
import type { ChatAttachment } from '~/composables/useChat'

/**
 * What the user is composing: the text, picked files and kept dictation
 * recordings. Owned by the chat view (which sends it) and shown by the
 * composer (which edits it).
 */
export function useComposerDraft() {
  const inputText = ref('')
  const pendingFiles = ref<File[]>([])
  /** Kept dictation recordings (already stored on the server), sent with the message. */
  const pendingAudio = ref<Array<{ attachment: ChatAttachment; durationMs: number }>>([])
  const inputRef = ref<HTMLTextAreaElement | null>(null)
  // True when there's text or pending files — drives mic↔send swap on mobile
  const hasText = computed(() => inputText.value.trim().length > 0 || pendingFiles.value.length > 0 || pendingAudio.value.length > 0)

  function addFiles(files: File[]) { pendingFiles.value = [...pendingFiles.value, ...files] }
  function removePendingFile(index: number) { pendingFiles.value.splice(index, 1) }
  function removePendingAudio(index: number) { pendingAudio.value = pendingAudio.value.filter((_, i) => i !== index) }
  function autoResize() { const el = inputRef.value; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 150) + 'px' }
  function clear() {
    inputText.value = ''
    pendingFiles.value = []
    pendingAudio.value = []
    if (inputRef.value) inputRef.value.style.height = 'auto'
  }

  return { inputText, pendingFiles, pendingAudio, inputRef, hasText, addFiles, removePendingFile, removePendingAudio, autoResize, clear }
}

export type ComposerDraft = ReturnType<typeof useComposerDraft>
