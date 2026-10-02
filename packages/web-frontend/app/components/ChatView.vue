<template>
  <!-- Chat and canvas share one row: on a wide window the canvas is a side
       panel next to the chat, on a narrow one it slides over it (SPEC 2.8/2.9).
       The chat column keeps `min-w-0` so a wide canvas shrinks it instead of
       pushing it out of the viewport. -->
  <div class="relative flex h-full overflow-hidden">
  <div
    class="relative flex min-w-0 flex-1 flex-col overflow-hidden"
    @dragenter.prevent="handleDragEnter"
    @dragover.prevent="handleDragOver"
    @dragleave.prevent="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <!-- Drag & drop overlay -->
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isDraggingFiles"
        class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      >
        <div class="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.06] px-10 py-8 text-primary">
          <AppIcon name="paperclip" class="h-10 w-10" />
          <p class="text-sm font-medium">{{ $t('chat.dropFilesHere') }}</p>
        </div>
      </div>
    </Transition>
    <ChatToolbar :bound-to-thread="boundToThread" :session-resetting="sessionResetting" @stop="handleStop" @new-session="handleNewSession" />

    <!-- Session binding failed: the thread cannot be opened at all, so we show
         a dedicated state with a way back instead of a chat bubble. -->
    <div v-if="sessionError" class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <AppIcon name="warning" class="h-10 w-10 text-destructive/70" />
      <div class="max-w-sm space-y-1">
        <p class="text-sm font-semibold text-foreground">{{ $t('threads.sessionErrorTitle') }}</p>
        <p class="text-sm text-muted-foreground">{{ sessionErrorText }}</p>
      </div>
      <Button class="min-h-[44px] gap-2" @click="$emit('back')">
        <AppIcon name="arrowLeft" class="h-4 w-4" />
        {{ $t('threads.backToInbox') }}
      </Button>
    </div>

    <ChatMessageList v-else :rows="transcriptRows" :state="contentState" @retry="reloadHistory" />

    <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="translate-y-2 opacity-0" enter-to-class="translate-y-0 opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="translate-y-0 opacity-100" leave-to-class="translate-y-2 opacity-0">
      <button v-if="!isNearBottom" class="absolute bottom-28 right-6 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-overlay" @click="jumpToBottom">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
    </Transition>

    <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="translate-y-2 opacity-0" enter-to-class="translate-y-0 opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="translate-y-0 opacity-100" leave-to-class="translate-y-2 opacity-0">
      <div v-if="ttsError" class="absolute bottom-24 left-1/2 z-10 w-[min(92%,32rem)] -translate-x-1/2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-overlay">
        <div class="flex items-start gap-2">
          <div class="flex-1">
            <div class="font-medium">{{ $t('chat.ttsErrorTitle') }}</div>
            <div class="mt-0.5 break-words text-destructive/90">{{ ttsError }}</div>
          </div>
          <button type="button" class="shrink-0 rounded p-0.5 text-destructive/70 hover:text-destructive" :title="$t('chat.ttsErrorDismiss')" @click="clearTtsError">
            <AppIcon name="x" size="sm" />
          </button>
        </div>
      </div>
    </Transition>

    <!-- What works for this strand right now: the running turn plus every
         delegated task and sub-task, recursively (SPEC 10.x). Sits directly
         above the composer so it is in view without scrolling. -->
    <TurnProgressStatus v-if="!sessionError" :strand-id="boundSessionId" />

    <ChatComposer v-if="!sessionError" />
  </div>
    <StrandCanvas :strand-id="boundSessionId" />
  </div>
</template>

<script setup lang="ts">
import { groupTranscript, transcriptState } from './content/transcript'
import type { ChatMessage } from '~/composables/useChat'
import { setSecretChipTooltip } from '~/utils/secretHandles'
import StrandCanvas from './StrandCanvas.vue'
import { useStrandCanvas } from '~/composables/useStrandCanvas'
import type { ArtifactRef } from '~/api/artifacts'
import { provideChatView } from '~/composables/chat/chatViewContext'
import { useChatActions } from '~/composables/chat/useChatActions'
import { useChatFilters } from '~/composables/chat/useChatFilters'
import { useChatScroll } from '~/composables/chat/useChatScroll'
import { useComposerDraft } from '~/composables/chat/useComposerDraft'
import { useFileDrop } from '~/composables/chat/useFileDrop'
import { useMessageSegments } from '~/composables/chat/useMessageSegments'
import { useSpeakerPersona } from '~/composables/chat/useSpeakerPersona'
import { useTaskReports } from '~/composables/chat/useTaskReports'
import { useThinkingLevel } from '~/composables/chat/useThinkingLevel'
import { useToggleSet } from '~/composables/chat/useToggleSet'
import ChatToolbar from './chat/ChatToolbar.vue'
import ChatMessageList from './chat/ChatMessageList.vue'
import ChatComposer from './chat/ChatComposer.vue'

/*
 * The chat surface. Used in two modes:
 *   - bound to a thread (`threadSessionId` set): history is loaded for exactly
 *     that session and every send carries its id;
 *   - legacy (no props): the backend picks the session, exactly as before
 *     threads existed.
 *
 * This file wires the session (useChat) to its parts and shares the state
 * they need through `provideChatView`: the toolbar, the transcript
 * (ChatMessageList → ChatMessageRow → bubble / cards) and the composer.
 */
const props = defineProps<{
  threadSessionId?: string | null
  threadAgentId?: string | null
}>()

defineEmits<{ back: [] }>()
const boundToThread = computed(() => !!props.threadSessionId)
const { t } = useI18n()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
const thinking = useThinkingLevel(isAdmin)
const avatar = useUserAvatar()

// The markdown renderer is a module and cannot reach i18n itself, so the chip
// tooltip is installed from here and kept in sync with the active locale.
watchEffect(() => setSecretChipTooltip(t('chat.secretChipTooltip')))
const persona = useSpeakerPersona(() => props.threadAgentId, () => t('w4Content.assistant'))

const {
  messages,
  connectionStatus,
  isStreaming,
  loadingHistory,
  queuePosition,
  sessionError,
  boundSessionId,
  boundAgentId,
  sessionActivity,
  connect,
  disconnect,
  sendMessage,
  newSession,
  stopTask,
  resolvePicker,
  submitChatAction,
  openThread,
  leaveThread,
  loadRecentHistory,
} = useChat()

// The strand header resolves its persona independently of history loading.
watch(() => props.threadAgentId, agentId => {
  if (boundSessionId.value === props.threadSessionId) boundAgentId.value = agentId ?? null
})

const filters = useChatFilters()
const filteredMessages = computed(() => messages.value.filter(filters.isVisible))
const transcriptRows = computed(() => groupTranscript(filteredMessages.value))
const historyError = ref(false)
const contentState = computed(() => transcriptState(!!historyError.value, loadingHistory.value, messages.value.length))
const turnActive = computed(() => isStreaming.value || (!!boundSessionId.value && sessionActivity.value[boundSessionId.value]?.state === 'running'))

const sessionErrorText = computed(() => {
  switch (sessionError.value) {
    case 'session_not_found': return t('threads.sessionErrorNotFound')
    case 'session_agent_mismatch': return t('threads.sessionErrorAgentMismatch')
    case 'session_forbidden': return t('threads.sessionErrorForbidden')
    default: return ''
  }
})

const { interactionCard, messageTextSegments, hasBubbleBody, answeredElsewhere } = useMessageSegments(filteredMessages)

/**
 * Free text from a card. It goes out through the ordinary composer send path
 * (`useChat().sendMessage`), so the backend sees a plain user message and the
 * composer keeps whatever the user had typed there.
 */
async function handleOwnAnswer(text: string) {
  const value = text.trim()
  if (!value || connectionStatus.value !== 'connected') return
  await sendMessage(value)
}

const canvas = useStrandCanvas(() => boundSessionId.value ?? null)

/** Tapping the one line opens the canvas on exactly that revision. */
function openCanvasAt(artifact: ArtifactRef): void {
  if (!artifact.viewKey) return
  canvas.open(artifact.viewKey, artifact.revision ?? undefined)
}

const { pendingChatActions, handleChatAction, handlePickerSelect } = useChatActions(messages, submitChatAction, resolvePicker)

const tts = useTts()
const { error: ttsError, clearError: clearTtsError } = tts
const stt = useStt()
const draft = useComposerDraft()
const scroll = useChatScroll(messages)
const { isNearBottom, jumpToBottom, scrollToBottom } = scroll
const { isDraggingFiles, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useFileDrop(draft.addFiles)

provideChatView({
  filters, scroll, draft, thinking, stt, tts, isAdmin, user, avatar,
  taskReports: useTaskReports(() => t('chat.taskResult.empty')),
  isStreaming, connectionStatus, queuePosition, boundSessionId, turnActive,
  persona,
  expandedTools: useToggleSet<string>(),
  expandedThinking: useToggleSet<string>(),
  expandedInjections: useToggleSet<number>(),
  expandedSummaries: useToggleSet<string>(),
  pendingChatActions,
  interactionCard, messageTextSegments, hasBubbleBody, answeredElsewhere, handleOwnAnswer,
  handleChatAction, handlePickerSelect, openCanvasAt, sendMessage,
})

// History must be in place before the socket opens: connecting attaches to a
// still-running turn and replays it, and a later history load would wipe that
// replayed tail. A failed history load must never keep the socket closed —
// chatting still works, the transcript just starts empty.
onMounted(async () => {
  await reloadHistory()
  connect()
  await Promise.all([tts.fetchTtsSettings(), stt.fetchSttSettings(), thinking.load()])
})
onUnmounted(() => {
  disconnect()
  if (boundToThread.value) leaveThread()
  tts.stop()
  stt.cleanup()
})
watch(() => messages.value.length, () => {
  // Reset sessionResetting flag when a divider appears (session_end received)
  const last = messages.value[messages.value.length - 1]
  if (last?.role === 'divider') sessionResetting.value = false
})
/**
 * (Re)load the transcript. In thread mode this binds the chat to the thread's
 * session; in legacy mode it loads the newest page across all sessions.
 * A failed load never blocks the socket — chatting still works, the transcript
 * just starts empty and offers a retry.
 */
async function reloadHistory() {
  historyError.value = false
  try {
    if (props.threadSessionId) {
      await openThread(props.threadSessionId, props.threadAgentId ?? null)
    } else {
      await loadRecentHistory()
    }
  } catch (err) {
    console.error('[chat] history load failed:', err)
    historyError.value = true
  } finally {
    nextTick(() => scrollToBottom())
  }
}
const sessionResetting = ref(false)
function handleNewSession() {
  if (sessionResetting.value) return
  sessionResetting.value = true
  newSession()
}
function handleStop() { stopTask() }
</script>
