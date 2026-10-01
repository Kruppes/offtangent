import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import type { DictationResult, useStt } from '~/composables/useStt'
import { insertAtCursor, isDictationShortcut } from '~/utils/dictation'
import type { ComposerDraft } from './useComposerDraft'

/** Number of level bars the dictation bar draws. */
export const DICTATION_LEVEL_BARS = 24

/**
 * Dictation in the composer (click to start, click / Ctrl+M / Done to
 * finish). The phase logic is the pure reducer in utils/dictation.ts; useStt
 * owns the microphone. The text goes in at the caret and is never sent
 * automatically; a kept recording becomes a pending audio chip.
 */
export function useComposerDictation(draft: ComposerDraft, stt: ReturnType<typeof useStt>, t: (key: string) => string) {
  const { inputText, inputRef, pendingAudio } = draft
  const phase = stt.phase
  /** Caret of the textarea when the dictation started (focus moves to the bar). */
  let selection: { start: number; end: number } | null = null
  const announcement = ref('')
  const micLabel = computed(() => phase.value === 'recording' ? t('chat.dictation.stop') : phase.value === 'transcribing' ? t('chat.dictation.transcribing') : t('chat.dictation.start'))

  function rememberSelection() {
    const el = inputRef.value
    selection = el && typeof el.selectionStart === 'number'
      ? { start: el.selectionStart, end: el.selectionEnd ?? el.selectionStart }
      : { start: inputText.value.length, end: inputText.value.length }
  }

  async function start() {
    rememberSelection()
    announcement.value = ''
    await stt.start()
  }

  function apply(result: DictationResult | null) {
    if (!result) return
    if (result.audio) pendingAudio.value = [...pendingAudio.value, { attachment: result.audio, durationMs: result.durationMs }]
    if (!result.text) return
    const at = selection ?? { start: inputText.value.length, end: inputText.value.length }
    const { value, caret } = insertAtCursor(inputText.value, result.text, at.start, at.end)
    inputText.value = value
    selection = { start: caret, end: caret }
    announcement.value = t('chat.dictation.inserted')
    nextTick(() => {
      const el = inputRef.value
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
      draft.autoResize()
    })
  }

  async function finish() { apply(await stt.stop()) }
  async function retry() { apply(await stt.retry()) }

  function cancel() {
    stt.cancel()
    announcement.value = t('chat.dictation.cancelled')
    nextTick(() => inputRef.value?.focus())
  }

  function dismiss() {
    stt.dismiss()
    nextTick(() => inputRef.value?.focus())
  }

  async function toggle() {
    if (phase.value === 'recording') await finish()
    else if (phase.value === 'idle' || phase.value === 'error') await start()
  }

  // Esc cancels a running recording even when the focus has left the composer.
  function handleGlobalEscape(event: KeyboardEvent) {
    if (event.key === 'Escape' && (phase.value === 'recording' || phase.value === 'starting')) {
      event.preventDefault()
      cancel()
    }
  }
  watch(phase, (next) => {
    if (typeof window === 'undefined') return
    if (next === 'recording' || next === 'starting') window.addEventListener('keydown', handleGlobalEscape)
    else window.removeEventListener('keydown', handleGlobalEscape)
  })
  onUnmounted(() => { if (typeof window !== 'undefined') window.removeEventListener('keydown', handleGlobalEscape) })

  /** Ctrl+M toggles, Esc cancels — only while the composer is the active area. */
  function handleComposerAreaKeydown(event: KeyboardEvent) {
    if (!stt.sttEnabled.value) return
    if (isDictationShortcut(event)) {
      event.preventDefault()
      void toggle()
      return
    }
    if (event.key === 'Escape' && (phase.value === 'recording' || phase.value === 'starting')) {
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
  }

  return { announcement, micLabel, finish, retry, cancel, dismiss, toggle, handleComposerAreaKeydown }
}
