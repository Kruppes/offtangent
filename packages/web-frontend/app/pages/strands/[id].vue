<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import StrandDetailHeader from '~/features/strands/StrandDetailHeader.vue'
import StrandContextPanel from '~/features/strands/StrandContextPanel.vue'
import type { StrandDetail } from '~/features/strands/detailApi'
import { useThreads } from '~/features/threads/composables/useThreads'
import { useShellLayout } from '~/composables/useShellLayout'
import { useStrandCanvas } from '~/composables/useStrandCanvas'
import { onShortcut } from '~/composables/useShortcuts'
import { CONTEXT_WIDTH } from '~/utils/shellLayout'
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
onUnmounted(() => { activeThreadId.value = null })
function backToInbox() { void router.push('/strands') }
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
function closeContext() {
  if (inline.value) shell.setContextOpen(threadId.value, false)
  else sheetOpen.value = false
}
onShortcut('context.toggle', toggleContext)
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 overflow-hidden">
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <StrandDetailHeader :key="threadId" :strand-id="threadId" :show-back="shell.tier.value === 'one'" @back="backToInbox" @updated="updated" @deleted="deleted">
        <template #actions>
          <button type="button" data-testid="context-toggle"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="contextOpen ? 'bg-accent text-foreground' : ''"
            :aria-label="$t('shell.contextToggle')" :aria-pressed="contextOpen" aria-controls="strand-context-column" @click="toggleContext">
            <AppIcon name="panelRight" />
          </button>
        </template>
      </StrandDetailHeader>
      <div class="min-h-0 flex-1">
        <ChatView :key="threadId" :thread-session-id="threadId" :thread-agent-id="thread?.agentId ?? null" @back="backToInbox" />
      </div>
    </div>
    <aside v-if="inline && inlineOpen" id="strand-context-column" data-testid="context-column" data-placement="inline"
      class="shrink-0 border-l border-border bg-background" :style="{ width: `${CONTEXT_WIDTH}px` }" aria-labelledby="strand-context-title">
      <StrandContextPanel :strand-id="threadId" :strand="thread" @close="closeContext" />
    </aside>
    <DialogRoot v-if="!inline" :open="sheetOpen" @update:open="sheetOpen = $event">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-40 bg-scrim" />
        <DialogContent id="strand-context-column" data-testid="context-column" data-placement="overlay" :aria-describedby="undefined"
          class="fixed inset-y-0 right-0 z-50 w-[min(20rem,100vw)] border-l border-border bg-background shadow-overlay focus:outline-none">
          <DialogTitle class="sr-only">{{ $t('shell.context') }}</DialogTitle>
          <StrandContextPanel :strand-id="threadId" :strand="thread" @close="closeContext" />
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>

<style scoped>
/* Keep the existing conversation intact; only bring its legacy hit areas up
   to the shell's accessibility baseline while W4 owns content changes. */
:deep(button), :deep(textarea), :deep(select) {
  min-height: 44px;
  min-width: 44px;
}
</style>
