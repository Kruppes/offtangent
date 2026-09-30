<script setup lang="ts">
import StrandDetailHeader from '~/features/strands/StrandDetailHeader.vue'
import type { StrandDetail } from '~/features/strands/detailApi'
import { useThreads } from '~/features/threads/composables/useThreads'
const route = useRoute()
const router = useRouter()
const threadId = computed(() => String(route.params.id ?? ''))
const thread = ref<StrandDetail | null>(null)
const { threads, activeThreadId } = useThreads()
watch(threadId, id => { thread.value = null; activeThreadId.value = id }, { immediate: true })
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
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <StrandDetailHeader :key="threadId" :strand-id="threadId" @back="backToInbox" @updated="updated" @deleted="deleted" />
    <div class="min-h-0 flex-1">
      <ChatView :key="threadId" :thread-session-id="threadId" :thread-agent-id="thread?.agentId ?? null" @back="backToInbox" />
    </div>
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
