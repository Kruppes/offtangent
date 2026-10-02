import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { useStt } from '~/composables/useStt'
import { isDictationShortcut } from '~/utils/dictation'
import { appendTranscript, markAfterEdit, markAfterTranscript } from './captureDictation'

/**
 * Dictation for the capture box on Home (W5d).
 *
 * Reuses the chat composer's pieces — `useStt` for microphone and upload,
 * `DictationBar` for the visible state — with one difference: the recording is
 * transcribed WITHOUT `keepAudio`, so the server writes no file and the capture
 * never carries audio. The transcript is appended to the box, editable, and is
 * never sent on its own; `dictated` tells the send to mark the capture.
 *
 * `announcement` is an i18n key (empty when nothing is to be announced); the
 * template renders it in a polite live region.
 */
export function useCaptureDictation(text: Ref<string>, textarea: Ref<HTMLTextAreaElement | null>) {
  const stt = useStt({ keepAudio: false })
  const dictated = ref(false)
  const announcement = ref('')
  const phase = stt.phase

  // Emptying the box completely starts over as a typed capture.
  watch(text, (value) => { dictated.value = markAfterEdit(dictated.value, value) })

  const micLabel = computed(() => phase.value === 'recording'
    ? 'capture.dictation.stop'
    : phase.value === 'transcribing' ? 'capture.dictation.transcribing' : 'capture.dictation.start')

  function focusEnd() {
    void nextTick(() => {
      const el = textarea.value
      // Guarded: under SSR and in the unit renderer this is not a DOM node.
      if (!el || typeof el.focus !== 'function') return
      el.focus()
      el.selectionStart = el.selectionEnd = el.value.length
    })
  }

  function apply(result: { text: string } | null) {
    if (!result || !result.text.trim()) return
    text.value = appendTranscript(text.value, result.text)
    dictated.value = markAfterTranscript(dictated.value, result.text)
    announcement.value = 'capture.dictation.inserted'
    focusEnd()
  }

  async function start() {
    announcement.value = ''
    await stt.start()
  }
  async function finish() { apply(await stt.stop()) }
  async function retry() { apply(await stt.retry()) }
  function cancel() {
    stt.cancel()
    announcement.value = 'capture.dictation.cancelled'
    focusEnd()
  }
  function dismiss() {
    stt.dismiss()
    focusEnd()
  }
  async function toggle() {
    if (phase.value === 'recording') await finish()
    else if (phase.value === 'idle' || phase.value === 'error') await start()
  }

  /** Ctrl+M toggles, Esc cancels a running recording — only inside the capture form. */
  function handleKeydown(event: KeyboardEvent) {
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

  return {
    sttEnabled: stt.sttEnabled,
    fetchSttSettings: stt.fetchSttSettings,
    phase,
    error: stt.error,
    canRetry: stt.canRetry,
    elapsedMs: stt.elapsedMs,
    levels: stt.levels,
    busy: stt.busy,
    dictated,
    announcement,
    micLabel,
    toggle,
    finish,
    retry,
    cancel,
    dismiss,
    handleKeydown,
  }
}
