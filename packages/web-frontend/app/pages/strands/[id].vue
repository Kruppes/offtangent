<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import StrandDetailHeader from '~/features/strands/StrandDetailHeader.vue'
import StrandDock from '~/features/strands/StrandDock.vue'
import StrandRunningHint from '~/features/strands/StrandRunningHint.vue'
import StrandActivityProbe from '~/features/threads/components/StrandActivityProbe.vue'
import DockSeparator from '~/components/shell/DockSeparator.vue'
import { countLive } from '~/features/threads/taskActivity'
import type { StrandDetail } from '~/features/strands/detailApi'
import { useThreads } from '~/features/threads/composables/useThreads'
import { useShellLayout } from '~/composables/useShellLayout'
import { useStrandCanvas } from '~/composables/useStrandCanvas'
import { onShortcut } from '~/composables/useShortcuts'
import { dockMaxWidth, inlineDockWidth } from '~/utils/shellLayout'
import { dockWidthBounds, runningHint } from '~/utils/strandDock'
import { useStrandDock } from '~/composables/useStrandDock'
import ContextRing from '~/components/context/ContextRing.vue'
import StrandContextDetails from '~/components/context/StrandContextDetails.vue'
import { useStrandContext } from '~/composables/useStrandContext'
import { formatTokens, gaugePercent } from '~/utils/contextGauge'
import { overviewQueryOf } from '~/utils/strandOverview'
import { useMessageAnchor } from '~/composables/useMessageAnchor'
const route = useRoute()
const router = useRouter()
const threadId = computed(() => String(route.params.id ?? ''))
const thread = ref<StrandDetail | null>(null)
const { threads, activeThreadId } = useThreads()
const shell = useShellLayout()
const canvas = useStrandCanvas(() => threadId.value || null)
/** Context sheet below the three-column width; always starts closed. */
const sheetOpen = ref(false)
watch(threadId, id => { thread.value = null; activeThreadId.value = id; sheetOpen.value = false }, { immediate: true })
// W5b: a recalled-message link jumps inside this strand; the overlay sheet
// would cover the target, so it closes (the inline dock stays).
watch(() => route.hash, hash => { if (hash && !inline.value) sheetOpen.value = false })
onUnmounted(() => { activeThreadId.value = null })
function backToInbox() { void router.push({ path: '/strands', query: overviewQueryOf(route.query) }) }
function updated(value: StrandDetail) {
  if (value.id !== threadId.value) return
  thread.value = value
  const index = threads.value.findIndex(entry => entry.id === value.id)
  if (index >= 0) threads.value[index] = value
}
function deleted(id: string) {
  threads.value = threads.value.filter(entry => entry.id !== id)
  if (id === threadId.value) backToInbox()
}

// Context column: inline beside the conversation when the conversation keeps
// its reading width, otherwise a sheet over it. Inline state is remembered
// per strand; the sheet always starts closed.
const inline = computed(() => shell.contextPlacement.value === 'inline')
const inlineOpen = computed(() => inline.value && shell.contextOpen(threadId.value, canvas.views.value.length > 0))
const contextOpen = computed(() => (inline.value ? inlineOpen.value : sheetOpen.value))
function toggleContext() {
  if (inline.value) shell.setContextOpen(threadId.value, !inlineOpen.value)
  else sheetOpen.value = !sheetOpen.value
}
const contextToggleRef = ref<HTMLButtonElement | null>(null)
function closeContext() {
  // W6b: the close button disappears with the dock; hand the keyboard focus
  // back to the toggle that opened it instead of dropping it on <body>.
  const hadFocus = !!document.activeElement?.closest('[data-testid="strand-dock"]')
  if (inline.value) shell.setContextOpen(threadId.value, false)
  else sheetOpen.value = false
  if (hadFocus) void nextTick(() => contextToggleRef.value?.focus())
}
onShortcut('context.toggle', toggleContext)

// Dock (W4c): width by the handle on its left edge, never past what the
// conversation's reading measure leaves (`dockMaxWidth`).
const dock = useStrandDock()
const dockBounds = computed(() => dockWidthBounds(dockMaxWidth(shell.width.value, shell.sidebarWidth.value)))
const dockWidth = computed(() => inlineDockWidth(dock.state.value.width, shell.width.value, shell.sidebarWidth.value))

// Anti-freeze signal while the dock is closed: the strand head says what runs.
const chat = useChat()
// W5b: `#msg-<id>` opens the strand at that message (search, recalled,
// lineage), once this strand's history is loaded.
useMessageAnchor(() => route.hash, () => threadId.value,
  () => chat.boundSessionId.value === threadId.value && !chat.loadingHistory.value)
// W6c: a file dragged onto the strand header or the dock lands in the
// composer too (ChatView's own drop logic), instead of the browser opening
// the file in the tab. Drags inside the chat column are already handled there.
type FileDropHandlers = Record<'handleDragEnter' | 'handleDragOver' | 'handleDragLeave' | 'handleDrop', (event: DragEvent) => void>
const chatView = ref<{ fileDrop: FileDropHandlers } | null>(null)
const dropHandler = { dragenter: 'handleDragEnter', dragover: 'handleDragOver', dragleave: 'handleDragLeave', drop: 'handleDrop' } as const
function forwardFileDrag(event: DragEvent) {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('[data-file-drop-zone]')) return
  const name = dropHandler[event.type as keyof typeof dropHandler]
  if (name) chatView.value?.fileDrop[name](event)
}
const turnRunning = computed(() => chat.sessionActivity.value[threadId.value]?.state === 'running'
  || (chat.boundSessionId.value === threadId.value && chat.isStreaming.value))
const liveTasks = computed(() => countLive(chat.strandTasks.value[threadId.value]))
const hint = computed(() => runningHint(contextOpen.value, turnRunning.value, liveTasks.value))
function openActivity() {
  dock.setSectionOpen('activity', true)
  if (inline.value) shell.setContextOpen(threadId.value, true)
  else sheetOpen.value = true
}

// Context ring in the header (N2): the gauge of the last request, re-read
// whenever the strand's activity moves (a finished turn) or the panel opens.
const { t } = useI18n()
const strandContext = useStrandContext(() => threadId.value || null)
strandContext.watchGauge()
const lastActivity = computed(() => threads.value.find(entry => entry.id === threadId.value)?.lastActivity ?? null)
watch(lastActivity, (now, before) => { if (before && now !== before) strandContext.refreshGauge() })
watch(contextOpen, open => { if (open) strandContext.refreshGauge() })
const headerGauge = computed(() => {
  const state = strandContext.gauge()
  return state.status === 'ready' ? state.data : null
})
const ringLabel = computed(() => {
  const percent = gaugePercent(headerGauge.value?.ratio ?? null)
  return percent === null
    ? t('w4b.context.ringUnknown')
    : t('w4b.context.ringLabel', { percent, window: formatTokens(headerGauge.value?.contextWindow ?? null) })
})
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 overflow-hidden"
    @dragenter="forwardFileDrag" @dragover="forwardFileDrag" @dragleave="forwardFileDrag" @drop="forwardFileDrag">
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <StrandDetailHeader :key="threadId" :strand-id="threadId" :show-back="shell.tier.value === 'one'" @back="backToInbox" @updated="updated" @deleted="deleted">
        <template #actions>
          <StrandRunningHint :hint="hint" @open="openActivity" />
          <button ref="contextToggleRef" type="button" data-testid="context-toggle"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="contextOpen ? 'bg-accent text-foreground' : ''"
            :aria-label="headerGauge ? `${$t('shell.contextToggle')} · ${ringLabel}` : $t('shell.contextToggle')" :aria-pressed="contextOpen" :aria-controls="contextOpen ? 'strand-context-column' : undefined" @click="toggleContext">
            <ContextRing v-if="headerGauge" :ratio="headerGauge.ratio" :label="ringLabel" :size="26" aria-hidden="true" />
            <AppIcon v-else name="panelRight" />
          </button>
        </template>
      </StrandDetailHeader>
      <div class="min-h-0 flex-1">
        <ChatView ref="chatView" :key="threadId" :thread-session-id="threadId" :thread-agent-id="thread?.agentId ?? null" @back="backToInbox" />
      </div>
    </div>
    <aside v-if="inline && inlineOpen" id="strand-context-column" data-testid="context-column" data-placement="inline"
      class="relative shrink-0 border-l border-border bg-background" :style="{ width: `${dockWidth}px` }" aria-labelledby="strand-context-title">
      <DockSeparator orientation="vertical" :value="dockWidth" :min="dockBounds.min" :max="dockBounds.max" :label="$t('shell.dockResize')"
        controls="strand-context-column" @update="dock.setWidth($event)" @reset="dock.resetWidth()" />
      <StrandDock :strand-id="threadId" :strand="thread" :turn-running="turnRunning" resizable @close="closeContext">
        <template #context-extra><StrandContextDetails :strand-id="threadId" :project-id="thread?.projectId ?? null" /></template>
      </StrandDock>
    </aside>
    <DialogRoot v-if="!inline" :open="sheetOpen" @update:open="sheetOpen = $event">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-40 bg-scrim" />
        <DialogContent id="strand-context-column" data-testid="context-column" data-placement="overlay" :aria-describedby="undefined"
          class="fixed inset-y-0 right-0 z-50 w-[min(20rem,100vw)] border-l border-border bg-background shadow-overlay focus:outline-none">
          <DialogTitle class="sr-only">{{ $t('shell.dock') }}</DialogTitle>
          <StrandDock :strand-id="threadId" :strand="thread" :turn-running="turnRunning" :resizable="false" @close="closeContext">
            <template #context-extra><StrandContextDetails :strand-id="threadId" :project-id="thread?.projectId ?? null" /></template>
          </StrandDock>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
    <!-- Dock closed: keep the task tree current for the head's hint. -->
    <StrandActivityProbe v-if="!contextOpen" :strand-id="threadId || null" />
  </div>
</template>

<style scoped>
/* W5b: the message a link pointed at is marked briefly after the jump. */
:deep([data-anchored='true']) {
  border-radius: 0.75rem;
  outline: 2px solid hsl(var(--primary) / 0.6);
  outline-offset: 4px;
}

/* Keep the existing conversation intact; only bring its legacy hit areas up
   to the shell's accessibility baseline while W4 owns content changes. */
:deep(button), :deep(textarea), :deep(select) {
  min-height: 44px;
  min-width: 44px;
}
</style>
